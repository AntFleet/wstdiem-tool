import { curvePoolAbi } from "../abi/curvePool.js";
import { inferenceVaultAbi } from "../abi/inferenceVault.js";
import { loopExecutorAbi } from "../abi/loopExecutor.js";
import { morphoIrmAbi } from "../abi/morphoIrm.js";
import { morphoOracleAbi } from "../abi/morphoOracle.js";
import { morphoAbi } from "../abi/morpho.js";
import { missingDeploymentKeys } from "../config/load.js";
import { computeBorrowedDiem, computeBorrowRate, computeNetApy, computeOracleDeviation, WAD } from "../metrics/math.js";
import type { Address, AppConfig, Hex, MorphoMarket } from "../types/domain.js";
import { expectedUniswapV3FlashFee } from "./uniswapV3FlashFee.js";
import type {
  BaseApyEvidence,
  FlashLoanLiquidityEvidence,
  LoopAction,
  LoopExecutorParams,
  LoopExitParams,
  LoopOpenParams,
  LoopRebalanceParams,
  LoopSafetyEvidence,
  PreflightCheck,
  RouteSlippageEvidence,
} from "./types.js";

export interface ReadMorphoMarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

export interface ReadMorphoPosition {
  borrowShares: bigint;
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
    blockNumber?: bigint;
  }): Promise<unknown>;
}

export interface LoopPreflightContext {
  action: LoopAction;
  params: LoopExecutorParams | null;
  safetyEvidence?: LoopSafetyEvidence;
  planningBlock?: bigint;
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

function isForcedExit(context: LoopPreflightContext): boolean {
  return context.action === "exit" && context.params !== null && (context.params as LoopExitParams).force === true;
}

export function parseMorphoMarketParams(value: unknown): ReadMorphoMarketParams | null {
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

export function parseMorphoPosition(value: unknown): ReadMorphoPosition | null {
  if (Array.isArray(value) && value.length >= 3) {
    return {
      borrowShares: BigInt(value[1] as bigint | number | string),
      collateral: BigInt(value[2] as bigint | number | string),
    };
  }
  if (value && typeof value === "object") {
    const entry = value as Record<string, unknown>;
    if (entry.borrowShares !== undefined && entry.collateral !== undefined) {
      return {
        borrowShares: BigInt(entry.borrowShares as bigint | number | string),
        collateral: BigInt(entry.collateral as bigint | number | string),
      };
    }
  }
  return null;
}

export function parseMorphoMarket(value: unknown): MorphoMarket | null {
  if (Array.isArray(value) && value.length >= 6) {
    return {
      totalSupplyAssets: BigInt(value[0] as bigint | number | string),
      totalSupplyShares: BigInt(value[1] as bigint | number | string),
      totalBorrowAssets: BigInt(value[2] as bigint | number | string),
      totalBorrowShares: BigInt(value[3] as bigint | number | string),
      lastUpdate: BigInt(value[4] as bigint | number | string),
      fee: BigInt(value[5] as bigint | number | string),
    };
  }
  if (value && typeof value === "object") {
    const entry = value as Record<string, unknown>;
    if (
      entry.totalSupplyAssets !== undefined &&
      entry.totalSupplyShares !== undefined &&
      entry.totalBorrowAssets !== undefined &&
      entry.totalBorrowShares !== undefined &&
      entry.lastUpdate !== undefined &&
      entry.fee !== undefined
    ) {
      return {
        totalSupplyAssets: BigInt(entry.totalSupplyAssets as bigint | number | string),
        totalSupplyShares: BigInt(entry.totalSupplyShares as bigint | number | string),
        totalBorrowAssets: BigInt(entry.totalBorrowAssets as bigint | number | string),
        totalBorrowShares: BigInt(entry.totalBorrowShares as bigint | number | string),
        lastUpdate: BigInt(entry.lastUpdate as bigint | number | string),
        fee: BigInt(entry.fee as bigint | number | string),
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

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

async function checkExecutorFlashConfig(
  config: AppConfig,
  client: LoopPreflightClient,
  blockNumber?: bigint,
): Promise<PreflightCheck> {
  if (
    config.contracts.loopExecutor === null ||
    config.flashLoan.provider !== "uniswap-v3" ||
    config.flashLoan.pool === null ||
    config.flashLoan.loanToken === null ||
    config.flashLoan.pairToken === null ||
    config.flashLoan.feeTier === null
  ) {
    return check("executor-flash-config", "fail", "loopExecutor and Uniswap V3 flash-loan config are required");
  }

  const [canonicalFlashPool, executorFee, loanTokenIsToken0] = await Promise.all([
    client.readContract({
      address: config.contracts.loopExecutor,
      abi: loopExecutorAbi,
      functionName: "canonicalFlashPool",
      blockNumber,
    }),
    client.readContract({
      address: config.contracts.loopExecutor,
      abi: loopExecutorAbi,
      functionName: "expectedFlashFee",
      args: [50n * WAD],
      blockNumber,
    }),
    client.readContract({
      address: config.contracts.loopExecutor,
      abi: loopExecutorAbi,
      functionName: "loanTokenIsToken0",
      blockNumber,
    }),
  ]);

  const configuredFee = expectedUniswapV3FlashFee(50n * WAD, config.flashLoan.feeTier);
  const configuredTokenSide = config.flashLoan.loanToken.toLowerCase() < config.flashLoan.pairToken.toLowerCase();
  const mismatches: string[] = [];
  if (!addressEqual(canonicalFlashPool as Address, config.flashLoan.pool)) {
    mismatches.push("canonicalFlashPool");
  }
  if (configuredFee === null || BigInt(executorFee as bigint | number | string) !== configuredFee) {
    mismatches.push("expectedFlashFee");
  }
  if (Boolean(loanTokenIsToken0) !== configuredTokenSide) {
    mismatches.push("loanTokenIsToken0");
  }

  return check(
    "executor-flash-config",
    mismatches.length === 0 ? "pass" : "fail",
    mismatches.length === 0
      ? "loopExecutor flash config matches configured Uniswap V3 provider"
      : `loopExecutor flash config mismatch: ${mismatches.join(", ")}`,
  );
}

async function checkMorphoMarketParams(
  config: AppConfig,
  client: LoopPreflightClient,
  blockNumber?: bigint,
): Promise<PreflightCheck> {
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
      blockNumber,
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
  if (context.action === "open") {
    return check(
      "projected-health-factor",
      "fail",
      "open projected health factor requires verified collateral and debt bound evidence",
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

function targetLeverage(input: LoopPreflightContext): number | null {
  if (input.params === null) {
    return null;
  }
  if (input.action === "rebalance") {
    return Number((input.params as LoopRebalanceParams).targetLeverageWad) / Number(WAD);
  }
  if (input.action === "open") {
    const params = input.params as LoopOpenParams;
    if (params.initialDiem === 0n) {
      return null;
    }
    return Number(params.initialDiem + params.flashDiem) / Number(params.initialDiem);
  }
  return null;
}

function validateBaseApyEvidence(
  config: AppConfig,
  evidence: BaseApyEvidence | undefined,
  planningBlock?: bigint,
): string | null {
  if (evidence === undefined) {
    return "base APY evidence is required for target leverage net APY validation";
  }
  if (!evidence.valid) {
    return "base APY evidence is marked invalid";
  }
  if (evidence.chainId !== config.chainId) {
    return `base APY evidence chainId ${evidence.chainId} does not match config chainId ${config.chainId}`;
  }
  if (!Number.isInteger(evidence.windowSeconds) || evidence.windowSeconds <= 0) {
    return "base APY evidence must include a positive integer windowSeconds";
  }
  if (evidence.blockNumber < 0n) {
    return "base APY evidence blockNumber must be non-negative";
  }
  if (planningBlock !== undefined) {
    if (evidence.blockNumber > planningBlock) {
      return "base APY evidence blockNumber cannot be newer than the planning block";
    }
    const staleBlocks = planningBlock - evidence.blockNumber;
    if (staleBlocks > BigInt(config.execution.maxBaseApyStalenessBlocks)) {
      return `base APY evidence is ${staleBlocks.toString()} blocks old; max is ${config.execution.maxBaseApyStalenessBlocks}`;
    }
  }
  if (!Number.isFinite(evidence.baseApy) || evidence.baseApy < 0) {
    return "base APY evidence must include a finite non-negative baseApy";
  }
  return null;
}

function validateRouteSlippageEvidence(
  config: AppConfig,
  context: LoopPreflightContext,
  evidence: RouteSlippageEvidence | undefined,
): string | null {
  if (evidence === undefined) {
    return "route quote and slippage evidence is required for live loop validation";
  }
  if (evidence.action !== context.action) {
    return `route slippage evidence action ${evidence.action} does not match ${context.action}`;
  }
  if (evidence.chainId !== config.chainId) {
    return `route slippage evidence chainId ${evidence.chainId} does not match config chainId ${config.chainId}`;
  }
  if (evidence.blockNumber < 0n) {
    return "route slippage evidence blockNumber must be non-negative";
  }
  if (!Number.isInteger(evidence.maxSlippageBps) || evidence.maxSlippageBps < 0) {
    return "route slippage evidence must include a non-negative integer maxSlippageBps";
  }
  if (!Number.isFinite(evidence.priceImpactBps) || evidence.priceImpactBps < 0) {
    return "route slippage evidence must include a finite non-negative priceImpactBps";
  }
  if (evidence.maxSlippageBps > config.execution.maxSlippageBps) {
    return `route max slippage ${evidence.maxSlippageBps} bps exceeds configured max ${config.execution.maxSlippageBps} bps`;
  }
  const forcedExit = isForcedExit(context);
  if (!evidence.valid && !forcedExit) {
    return "route slippage evidence is marked invalid";
  }
  if (evidence.priceImpactBps > config.execution.maxCurvePriceImpactBps && !forcedExit) {
    return `route price impact ${evidence.priceImpactBps.toFixed(2)} bps exceeds configured max ${config.execution.maxCurvePriceImpactBps} bps`;
  }
  if (context.params !== null && context.action === "rebalance") {
    const params = context.params as LoopRebalanceParams;
    if (evidence.maxSlippageBps > Number(params.maxSlippageBps)) {
      return `route max slippage ${evidence.maxSlippageBps} bps exceeds executor param ${params.maxSlippageBps.toString()} bps`;
    }
  }
  if (context.params !== null && context.action === "open") {
    const params = context.params as LoopOpenParams;
    if (evidence.priceImpactBps > Number(params.maxCurvePriceImpactBps)) {
      return `route price impact ${evidence.priceImpactBps.toFixed(2)} bps exceeds executor param ${params.maxCurvePriceImpactBps.toString()} bps`;
    }
  }
  return null;
}

function validateFlashLoanLiquidityEvidence(
  config: AppConfig,
  context: LoopPreflightContext,
  evidence: FlashLoanLiquidityEvidence | undefined,
): string | null {
  if (context.action !== "exit") {
    return null;
  }
  if (evidence === undefined) {
    return "flash-loan liquidity evidence is required for live exit validation";
  }
  if (context.params === null) {
    return "exact LoopExecutor params are required for flash-loan liquidity validation";
  }
  const params = context.params as LoopExitParams;
  if (evidence.provider !== "uniswap-v3") {
    return `flash-loan provider ${evidence.provider} is not supported for live exit validation`;
  }
  if (evidence.chainId !== config.chainId) {
    return `flash-loan liquidity evidence chainId ${evidence.chainId} does not match config chainId ${config.chainId}`;
  }
  if (evidence.blockNumber < 0n) {
    return "flash-loan liquidity evidence blockNumber must be non-negative";
  }
  if (context.safetyEvidence?.routeSlippage === undefined) {
    return "route slippage evidence is required for same-block flash-loan liquidity validation";
  }
  if (evidence.blockNumber !== context.safetyEvidence.routeSlippage.blockNumber) {
    return "flash-loan liquidity evidence blockNumber must match route quote blockNumber";
  }
  if (config.flashLoan.factory === null || !addressEqual(evidence.factory, config.flashLoan.factory)) {
    return "flash-loan liquidity factory does not match config";
  }
  if (config.flashLoan.pool === null || !addressEqual(evidence.pool, config.flashLoan.pool)) {
    return "flash-loan liquidity pool does not match config";
  }
  if (!addressEqual(evidence.loanToken, config.contracts.diem)) {
    return "flash-loan liquidity loanToken does not match DIEM";
  }
  if (evidence.requestedLoan !== params.repayAmountDiem) {
    return "flash-loan liquidity requestedLoan does not match repayAmountDiem";
  }
  if (!evidence.valid || evidence.availableLoan < evidence.requestedLoan) {
    return "flash-loan liquidity does not cover requested loan";
  }
  return null;
}

export async function readMorphoMarket(
  config: AppConfig,
  client: LoopPreflightClient,
  blockNumber?: bigint,
): Promise<MorphoMarket | null> {
  if (config.morpho.marketId === null) {
    return null;
  }
  return parseMorphoMarket(
    await client.readContract({
      address: config.contracts.morphoBlue,
      abi: morphoAbi,
      functionName: "market",
      args: [config.morpho.marketId],
      blockNumber,
    }),
  );
}

async function checkNetApy(input: {
  config: AppConfig;
  client: LoopPreflightClient;
  context?: LoopPreflightContext;
}): Promise<PreflightCheck> {
  if (input.context === undefined || input.context.params === null) {
    return check("net-apy", "fail", "exact LoopExecutor params are required for net APY validation");
  }
  const baseApyEvidence = input.context.safetyEvidence?.baseApy;
  const evidenceError = validateBaseApyEvidence(input.config, baseApyEvidence, input.context.planningBlock);
  if (evidenceError !== null || baseApyEvidence === undefined) {
    return check("net-apy", "fail", evidenceError ?? "base APY evidence is required");
  }
  const leverage = targetLeverage(input.context);
  if (leverage === null) {
    return check("net-apy", "fail", "unable to determine target leverage for net APY validation");
  }
  if (input.config.morpho.marketId === null) {
    return check("net-apy", "fail", "marketId is required for borrow-rate validation");
  }
  const market = await readMorphoMarket(input.config, input.client, input.context.planningBlock);
  if (market === null) {
    return check("net-apy", "fail", "Morpho market returned an unsupported shape");
  }
  const marketParams = {
    loanToken: input.config.contracts.diem,
    collateralToken: input.config.contracts.inferenceVault,
    oracle: input.config.contracts.morphoOracle,
    irm: input.config.contracts.adaptiveCurveIrm,
    lltv: BigInt(input.config.morpho.lltvWad),
  };
  if (marketParams.collateralToken === null || marketParams.oracle === null) {
    return check("net-apy", "fail", "inferenceVault and morphoOracle are required for borrow-rate validation");
  }
  const borrowRatePerSecond = (await input.client.readContract({
    address: input.config.contracts.adaptiveCurveIrm,
    abi: morphoIrmAbi,
    functionName: "borrowRateView",
    args: [marketParams, market],
    blockNumber: input.context.planningBlock,
  })) as bigint;
  const borrowRate = computeBorrowRate(borrowRatePerSecond);
  const netApy = computeNetApy(leverage, baseApyEvidence.baseApy, borrowRate);
  const minimum = input.config.thresholds.spreadCriticalNetApy35;
  return check(
    "net-apy",
    netApy > minimum ? "pass" : "fail",
    netApy > minimum
      ? `target ${leverage.toFixed(2)}x net APY ${(netApy * 100).toFixed(2)}% > ${(minimum * 100).toFixed(2)}%`
      : `target ${leverage.toFixed(2)}x net APY ${(netApy * 100).toFixed(2)}% <= required ${(minimum * 100).toFixed(2)}%`,
  );
}

async function projectedPositionNotionalDiem(input: {
  config: AppConfig;
  owner: Address | null;
  client: LoopPreflightClient;
  context?: LoopPreflightContext;
}): Promise<bigint | null> {
  if (input.context?.action !== "rebalance" || input.context.params === null) {
    return null;
  }
  if (input.owner === null || input.config.morpho.marketId === null || input.config.contracts.inferenceVault === null) {
    return null;
  }
  const market = await readMorphoMarket(input.config, input.client, input.context.planningBlock);
  if (market === null) {
    return null;
  }
  const position = parseMorphoPosition(
    await input.client.readContract({
      address: input.config.contracts.morphoBlue,
      abi: morphoAbi,
      functionName: "position",
      args: [input.config.morpho.marketId, input.owner],
      blockNumber: input.context.planningBlock,
    }),
  );
  if (position === null) {
    return null;
  }
  const collateralDiem = (await input.client.readContract({
    address: input.config.contracts.inferenceVault,
    abi: inferenceVaultAbi,
    functionName: "convertToAssets",
    args: [position.collateral],
    blockNumber: input.context.planningBlock,
  })) as bigint;
  const borrowedDiem = computeBorrowedDiem(market, { borrowShares: position.borrowShares });
  if (collateralDiem <= borrowedDiem) {
    return null;
  }
  const equityDiem = collateralDiem - borrowedDiem;
  const targetLeverageWad = (input.context.params as LoopRebalanceParams).targetLeverageWad;
  if (targetLeverageWad <= WAD) {
    return null;
  }
  return (equityDiem * targetLeverageWad) / WAD;
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
    blockNumber: input.context?.planningBlock,
  })) as bigint;
  const wstDiemBalance = (await input.client.readContract({
    address: input.config.contracts.curvePool,
    abi: curvePoolAbi,
    functionName: "balances",
    args: [1n],
    blockNumber: input.context?.planningBlock,
  })) as bigint;
  const wstDiemValue = (await input.client.readContract({
    address: input.config.contracts.inferenceVault,
    abi: inferenceVaultAbi,
    functionName: "convertToAssets",
    args: [wstDiemBalance],
    blockNumber: input.context?.planningBlock,
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

async function checkOracleDeviation(input: {
  config: AppConfig;
  client: LoopPreflightClient;
  context?: LoopPreflightContext;
}): Promise<PreflightCheck> {
  if (input.config.contracts.morphoOracle === null || input.config.contracts.inferenceVault === null) {
    return check("oracle-deviation", "fail", "morphoOracle and inferenceVault are required for oracle deviation validation");
  }
  const onchainOraclePrice = (await input.client.readContract({
    address: input.config.contracts.morphoOracle,
    abi: morphoOracleAbi,
    functionName: "price",
    blockNumber: input.context?.planningBlock,
  })) as bigint;
  const oneWstDiemAssets = (await input.client.readContract({
    address: input.config.contracts.inferenceVault,
    abi: inferenceVaultAbi,
    functionName: "convertToAssets",
    args: [WAD],
    blockNumber: input.context?.planningBlock,
  })) as bigint;
  if (oneWstDiemAssets === 0n) {
    return check("oracle-deviation", "fail", "InferenceVault.convertToAssets(1e18) returned zero");
  }
  const deviation = computeOracleDeviation(onchainOraclePrice, oneWstDiemAssets);
  const maximum = input.config.thresholds.oracleDeviationCritical;
  return check(
    "oracle-deviation",
    deviation <= maximum ? "pass" : "fail",
    deviation <= maximum
      ? `Morpho oracle deviation ${formatPercent(deviation)} <= ${formatPercent(maximum)}`
      : `Morpho oracle deviation ${formatPercent(deviation)} exceeds ${formatPercent(maximum)}`,
  );
}

function checkRouteSlippage(config: AppConfig, context?: LoopPreflightContext): PreflightCheck {
  if (context === undefined || context.params === null) {
    return check("route-slippage", "fail", "exact LoopExecutor params are required for route slippage validation");
  }
  const evidence = context.safetyEvidence?.routeSlippage;
  const evidenceError = validateRouteSlippageEvidence(config, context, evidence);
  if (evidenceError !== null || evidence === undefined) {
    return check("route-slippage", "fail", evidenceError ?? "route quote and slippage evidence is required");
  }
  const forcedExit = isForcedExit(context);
  const forcedPriceOverride = forcedExit && evidence.priceImpactBps > config.execution.maxCurvePriceImpactBps;
  return check(
    "route-slippage",
    "pass",
    forcedPriceOverride
      ? `route price impact ${evidence.priceImpactBps.toFixed(2)} bps exceeds ${config.execution.maxCurvePriceImpactBps} bps cap; force override active`
      : `route price impact ${evidence.priceImpactBps.toFixed(2)} bps within ${config.execution.maxCurvePriceImpactBps} bps cap`,
  );
}

function checkFlashLoanLiquidity(config: AppConfig, context?: LoopPreflightContext): PreflightCheck {
  if (context?.action !== "exit") {
    return check("flash-loan-liquidity", "skip", "flash-loan liquidity is only required for exit");
  }
  const evidence = context.safetyEvidence?.flashLoanLiquidity;
  const evidenceError = validateFlashLoanLiquidityEvidence(config, context, evidence);
  return check(
    "flash-loan-liquidity",
    evidenceError === null ? "pass" : "fail",
    evidenceError === null ? "flash-loan liquidity evidence covers the requested DIEM loan" : evidenceError,
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
  const blockNumber = context?.planningBlock;
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
      blockNumber,
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
      blockNumber,
    })) as boolean;
    checks.push(
      check(
        "morpho-authorization",
        authorized ? "pass" : "fail",
        authorized ? "loopExecutor is authorized by owner" : "owner has not authorized loopExecutor in Morpho",
      ),
    );
  }

  checks.push(await checkMorphoMarketParams(config, client, blockNumber));
  if (context?.action === "exit") {
    checks.push(await checkExecutorFlashConfig(config, client, blockNumber));
    checks.push(
      check(
        "projected-health-factor",
        "skip",
        "exit unwinds the position; post-loop target leverage health-factor check is not applicable",
      ),
    );
    checks.push(
      check("curve-depth", "skip", "exit reduces exposure; projected Curve depth increase check is not applicable"),
    );
    checks.push(check("net-apy", "skip", "exit does not increase leverage; target leverage carry check is not applicable"));
  } else {
    checks.push(checkProjectedHealthFactor(config, context));
    checks.push(await checkCurveDepth({ config, owner, client, context }));
    checks.push(await checkNetApy({ config, client, context }));
  }
  checks.push(await checkOracleDeviation({ config, client, context }));
  checks.push(checkRouteSlippage(config, context));
  checks.push(checkFlashLoanLiquidity(config, context));
  if (context !== undefined && context.action !== "exit") {
    checks.push(
      check(
        "executor-action",
        "fail",
        `LoopExecutor action ${context.action} is unsupported by the deployed exit-only executor`,
      ),
    );
  }

  return checks;
}
