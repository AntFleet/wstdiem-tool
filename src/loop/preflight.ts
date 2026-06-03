import { curvePoolAbi } from "../abi/curvePool.js";
import { inferenceVaultAbi } from "../abi/inferenceVault.js";
import { morphoAbi } from "../abi/morpho.js";
import { missingDeploymentKeys } from "../config/load.js";
import { WAD } from "../metrics/math.js";
import type { Address, AppConfig, Hex } from "../types/domain.js";
import type { LoopAction, LoopExecutorParams, LoopOpenParams, LoopRebalanceParams, PreflightCheck } from "./types.js";

interface ReadMorphoMarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

interface ReadMorphoPosition {
  collateral: bigint;
}

export interface LoopPreflightClient {
  getChainId(): Promise<number>;
  getCode(address: Address): Promise<Hex>;
  readContract(args: {
    address: Address;
    abi: unknown;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

export interface LoopPreflightContext {
  action: LoopAction;
  params: LoopExecutorParams | null;
}

function check(key: string, status: PreflightCheck["status"], message: string): PreflightCheck {
  return { key, status, message };
}

export function hasPreflightFailures(checks: PreflightCheck[]): boolean {
  return checks.some((entry) => entry.status === "fail");
}

export function staticLoopPreflight(config: AppConfig, owner: Address | null): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  const missing = missingDeploymentKeys(config);
  checks.push(
    check(
      "deployment-config",
      missing.length === 0 ? "pass" : "fail",
      missing.length === 0 ? "required deployment config is present" : `missing: ${missing.join(", ")}`,
    ),
  );
  checks.push(
    check("owner", owner === null ? "fail" : "pass", owner === null ? "missing position.owner or --owner" : "owner present"),
  );
  checks.push(
    check(
      "rpc-config",
      config.rpc.primaryUrl !== null || config.rpc.fallbackUrls.length > 0 ? "pass" : "fail",
      config.rpc.primaryUrl !== null || config.rpc.fallbackUrls.length > 0
        ? "at least one RPC URL configured"
        : "missing RPC URL",
    ),
  );
  return checks;
}

function addressEqual(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function parseMorphoMarketParams(value: unknown): ReadMorphoMarketParams | null {
  if (Array.isArray(value) && value.length >= 5) {
    return {
      loanToken: value[0] as Address,
      collateralToken: value[1] as Address,
      oracle: value[2] as Address,
      irm: value[3] as Address,
      lltv: BigInt(value[4] as bigint | number | string),
    };
  }
  if (value && typeof value === "object") {
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.loanToken === "string" &&
      typeof entry.collateralToken === "string" &&
      typeof entry.oracle === "string" &&
      typeof entry.irm === "string" &&
      entry.lltv !== undefined
    ) {
      return {
        loanToken: entry.loanToken as Address,
        collateralToken: entry.collateralToken as Address,
        oracle: entry.oracle as Address,
        irm: entry.irm as Address,
        lltv: BigInt(entry.lltv as bigint | number | string),
      };
    }
  }
  return null;
}

function parseMorphoPosition(value: unknown): ReadMorphoPosition | null {
  if (Array.isArray(value) && value.length >= 3) {
    return {
      collateral: BigInt(value[2] as bigint | number | string),
    };
  }
  if (value && typeof value === "object") {
    const entry = value as Record<string, unknown>;
    if (entry.collateral !== undefined) {
      return {
        collateral: BigInt(entry.collateral as bigint | number | string),
      };
    }
  }
  return null;
}

function numberToWad(value: number): bigint {
  return BigInt(Math.round(value * 1_000_000)) * (WAD / 1_000_000n);
}

function formatPercentWad(value: bigint, precision = 2): string {
  const percent = value * 100n;
  return `${formatWadDecimal(percent, precision)}%`;
}

function formatWadDecimal(value: bigint, precision = 4): string {
  const whole = value / WAD;
  const fraction = (value % WAD).toString().padStart(18, "0").slice(0, precision);
  return `${whole}.${fraction}`;
}

async function checkMorphoMarketParams(config: AppConfig, client: LoopPreflightClient): Promise<PreflightCheck> {
  if (config.morpho.marketId === null || config.contracts.inferenceVault === null || config.contracts.morphoOracle === null) {
    return check(
      "morpho-market-params",
      "fail",
      "marketId, inferenceVault, and morphoOracle are required for Morpho market validation",
    );
  }
  const params = parseMorphoMarketParams(
    await client.readContract({
      address: config.contracts.morphoBlue,
      abi: morphoAbi,
      functionName: "idToMarketParams",
      args: [config.morpho.marketId],
    }),
  );
  if (params === null) {
    return check("morpho-market-params", "fail", "Morpho idToMarketParams returned an unsupported shape");
  }

  const mismatches: string[] = [];
  if (!addressEqual(params.loanToken, config.contracts.diem)) {
    mismatches.push("loanToken");
  }
  if (!addressEqual(params.collateralToken, config.contracts.inferenceVault)) {
    mismatches.push("collateralToken");
  }
  if (!addressEqual(params.oracle, config.contracts.morphoOracle)) {
    mismatches.push("oracle");
  }
  if (!addressEqual(params.irm, config.contracts.adaptiveCurveIrm)) {
    mismatches.push("irm");
  }
  if (params.lltv !== BigInt(config.morpho.lltvWad)) {
    mismatches.push("lltv");
  }
  return check(
    "morpho-market-params",
    mismatches.length === 0 ? "pass" : "fail",
    mismatches.length === 0
      ? "Morpho market params match configured DIEM/wstDIEM market"
      : `Morpho market params mismatch: ${mismatches.join(", ")}`,
  );
}

function projectedHealthFactorWad(input: {
  config: AppConfig;
  action: LoopAction;
  params: LoopExecutorParams | null;
}): bigint | null {
  if (input.params === null) {
    return null;
  }
  const lltv = BigInt(input.config.morpho.lltvWad);
  if (input.action === "rebalance") {
    const params = input.params as LoopRebalanceParams;
    const leverage = params.targetLeverageWad;
    if (leverage <= WAD) {
      return null;
    }
    return (lltv * leverage) / (leverage - WAD);
  }
  if (input.action === "open") {
    const params = input.params as LoopOpenParams;
    const collateralValueDiem = params.initialDiem + params.flashDiem;
    if (params.minBorrowedDiem === 0n) {
      return null;
    }
    return (collateralValueDiem * lltv) / params.minBorrowedDiem;
  }
  return null;
}

function checkProjectedHealthFactor(config: AppConfig, context?: LoopPreflightContext): PreflightCheck {
  if (context === undefined || context.params === null) {
    return check(
      "projected-health-factor",
      "fail",
      "exact LoopExecutor params are required for projected post-loop health factor validation",
    );
  }
  if (context.action === "exit") {
    return check(
      "projected-health-factor",
      "skip",
      "exit projected health factor requires live position unwind sizing before validation",
    );
  }
  const projected = projectedHealthFactorWad({
    config,
    action: context.action,
    params: context.params,
  });
  if (projected === null) {
    return check("projected-health-factor", "fail", "unable to compute projected post-loop health factor");
  }
  const minimum = numberToWad(config.thresholds.minPostLoopHealthFactor);
  return check(
    "projected-health-factor",
    projected >= minimum ? "pass" : "fail",
    projected >= minimum
      ? `projected post-loop HF ${formatWadDecimal(projected)} >= ${config.thresholds.minPostLoopHealthFactor}`
      : `projected post-loop HF ${formatWadDecimal(projected)} below required ${config.thresholds.minPostLoopHealthFactor}`,
  );
}

async function projectedPositionNotionalDiem(input: {
  config: AppConfig;
  owner: Address | null;
  client: LoopPreflightClient;
  context?: LoopPreflightContext;
}): Promise<bigint | null> {
  if (input.context?.action === "open" && input.context.params !== null) {
    const params = input.context.params as LoopOpenParams;
    return params.initialDiem + params.flashDiem;
  }
  if (input.owner === null || input.config.morpho.marketId === null || input.config.contracts.inferenceVault === null) {
    return null;
  }
  const position = parseMorphoPosition(
    await input.client.readContract({
      address: input.config.contracts.morphoBlue,
      abi: morphoAbi,
      functionName: "position",
      args: [input.config.morpho.marketId, input.owner],
    }),
  );
  if (position === null) {
    return null;
  }
  return (await input.client.readContract({
    address: input.config.contracts.inferenceVault,
    abi: inferenceVaultAbi,
    functionName: "convertToAssets",
    args: [position.collateral],
  })) as bigint;
}

async function checkCurveDepth(input: {
  config: AppConfig;
  owner: Address | null;
  client: LoopPreflightClient;
  context?: LoopPreflightContext;
}): Promise<PreflightCheck> {
  if (input.config.contracts.curvePool === null || input.config.contracts.inferenceVault === null) {
    return check("curve-depth", "fail", "curvePool and inferenceVault are required for Curve depth validation");
  }
  const positionNotionalDiem = await projectedPositionNotionalDiem(input);
  if (positionNotionalDiem === null) {
    return check("curve-depth", "fail", "unable to determine projected position notional for Curve depth validation");
  }
  const diemBalance = (await input.client.readContract({
    address: input.config.contracts.curvePool,
    abi: curvePoolAbi,
    functionName: "balances",
    args: [0n],
  })) as bigint;
  const wstDiemBalance = (await input.client.readContract({
    address: input.config.contracts.curvePool,
    abi: curvePoolAbi,
    functionName: "balances",
    args: [1n],
  })) as bigint;
  const wstDiemValue = (await input.client.readContract({
    address: input.config.contracts.inferenceVault,
    abi: inferenceVaultAbi,
    functionName: "convertToAssets",
    args: [wstDiemBalance],
  })) as bigint;
  const curveTvlDiem = diemBalance + wstDiemValue;
  if (curveTvlDiem === 0n) {
    return check("curve-depth", "fail", "Curve depth unavailable because Curve pool TVL is zero");
  }

  const ratioWad = (positionNotionalDiem * WAD) / curveTvlDiem;
  const maxRatioWad = numberToWad(input.config.thresholds.curveDepthCritical);
  return check(
    "curve-depth",
    ratioWad <= maxRatioWad ? "pass" : "fail",
    ratioWad <= maxRatioWad
      ? `projected position is ${formatPercentWad(ratioWad)} of Curve depth`
      : `projected position is ${formatPercentWad(ratioWad)} of Curve depth; max is ${formatPercentWad(maxRatioWad)}`,
  );
}

export async function runLoopPreflight(
  config: AppConfig,
  owner: Address | null,
  client?: LoopPreflightClient,
  context?: LoopPreflightContext,
): Promise<PreflightCheck[]> {
  const checks = staticLoopPreflight(config, owner);
  if (client === undefined || hasPreflightFailures(checks)) {
    checks.push(
      check(
        "onchain-preflight",
        client === undefined ? "skip" : "fail",
        client === undefined
          ? "no preflight client provided; chain/code/contract reads not run"
          : "static preflight failed; on-chain preflight skipped",
      ),
    );
    return checks;
  }

  const chainId = await client.getChainId();
  checks.push(
    check(
      "chain-id",
      chainId === config.chainId ? "pass" : "fail",
      chainId === config.chainId ? `chainId ${chainId}` : `unexpected chainId ${chainId}; expected ${config.chainId}`,
    ),
  );

  const requiredContracts = [
    ["diem", config.contracts.diem],
    ["morphoBlue", config.contracts.morphoBlue],
    ["inferenceVault", config.contracts.inferenceVault],
    ["feeRouter", config.contracts.feeRouter],
    ["curvePool", config.contracts.curvePool],
    ["morphoOracle", config.contracts.morphoOracle],
    ["loopExecutor", config.contracts.loopExecutor],
  ] as const;
  for (const [name, address] of requiredContracts) {
    if (address === null) {
      continue;
    }
    const code = await client.getCode(address);
    checks.push(
      check("contract-code", code === "0x" ? "fail" : "pass", code === "0x" ? `${name} has no code` : `${name} has code`),
    );
  }

  if (config.contracts.inferenceVault !== null) {
    const asset = (await client.readContract({
      address: config.contracts.inferenceVault,
      abi: inferenceVaultAbi,
      functionName: "asset",
    })) as Address;
    checks.push(
      check(
        "vault-asset",
        asset.toLowerCase() === config.contracts.diem.toLowerCase() ? "pass" : "fail",
        asset.toLowerCase() === config.contracts.diem.toLowerCase()
          ? "vault.asset() matches DIEM"
          : `vault.asset() ${asset} does not match DIEM ${config.contracts.diem}`,
      ),
    );
  }

  if (owner !== null && config.contracts.loopExecutor !== null) {
    const authorized = (await client.readContract({
      address: config.contracts.morphoBlue,
      abi: morphoAbi,
      functionName: "isAuthorized",
      args: [owner, config.contracts.loopExecutor],
    })) as boolean;
    checks.push(
      check(
        "morpho-authorization",
        authorized ? "pass" : "fail",
        authorized ? "loopExecutor is authorized by owner" : "owner has not authorized loopExecutor in Morpho",
      ),
    );
  }

  checks.push(await checkMorphoMarketParams(config, client));
  checks.push(checkProjectedHealthFactor(config, context));
  checks.push(await checkCurveDepth({ config, owner, client, context }));

  const unavailableStrategyGates = [
    ["net-apy", "target leverage net APY check is not implemented"],
    ["oracle-deviation", "Morpho oracle deviation check is not implemented"],
    ["route-slippage", "route quote and slippage protection check is not implemented"],
  ] as const;
  for (const [key, message] of unavailableStrategyGates) {
    checks.push(check(key, "fail", message));
  }

  return checks;
}
