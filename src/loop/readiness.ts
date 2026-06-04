import { curvePoolAbi } from "../abi/curvePool.js";
import { inferenceVaultAbi } from "../abi/inferenceVault.js";
import { loopExecutorAbi } from "../abi/loopExecutor.js";
import { morphoAbi } from "../abi/morpho.js";
import { missingDeploymentKeys } from "../config/load.js";
import { computeBorrowedDiem, computeCurvePoolTvlDiem, WAD } from "../metrics/math.js";
import type { Address, AppConfig } from "../types/domain.js";
import { parseMorphoMarket, parseMorphoPosition } from "./preflight.js";
import type { LoopSimulationClient } from "./simulator.js";
import { expectedUniswapV3FlashFee } from "./uniswapV3FlashFee.js";

export interface ReadinessCheck {
  key: string;
  status: "pass" | "fail" | "skip";
  message: string;
}

interface ExecutorFlashConfig {
  factory: Address;
  pool: Address;
  loanToken: Address;
  pairToken: Address;
  feeTier: number;
}

interface ExecutorProtocolConfig {
  morpho: Address;
  curvePool: Address;
  wstDiem: Address;
}

export interface LoopReadinessResult {
  status: "ready" | "blocked";
  blockNumber?: bigint;
  checks: ReadinessCheck[];
  blockers: string[];
  curve?: {
    diemBalance: bigint;
    wstDiemBalance: bigint;
    wstDiemNav: bigint;
    tvlDiem: bigint;
    liquid: boolean;
  };
  morpho?: {
    totalSupplyAssets: bigint;
    totalBorrowAssets: bigint;
    totalBorrowShares: bigint;
    empty: boolean;
  };
  owner?: {
    address: Address;
    collateralWstDiem: bigint;
    borrowShares: bigint;
    borrowedDiem: bigint;
    hasExitPosition: boolean;
    executorAuthorized: boolean | null;
  };
  executor?: {
    address: Address;
    hasCode: boolean;
    canonicalFlashPool?: Address;
    expectedFlashFeeFor50Diem?: bigint;
    loanTokenIsToken0?: boolean;
    flashConfig?: ExecutorFlashConfig;
    protocolConfig?: ExecutorProtocolConfig;
    verified: boolean;
  };
  broadcastAvailable: false;
  auditRequired: true;
}

function check(key: string, status: ReadinessCheck["status"], message: string): ReadinessCheck {
  return { key, status, message };
}

function addressEqual(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tupleField(value: unknown, index: number, name: string): unknown {
  if (Array.isArray(value)) {
    return value[index];
  }
  if (value && typeof value === "object") {
    return (value as Record<string, unknown>)[name] ?? (value as Record<number, unknown>)[index];
  }
  return undefined;
}

function parseExecutorFlashConfig(value: unknown): ExecutorFlashConfig | null {
  const factory = tupleField(value, 0, "factory");
  const pool = tupleField(value, 1, "pool");
  const loanToken = tupleField(value, 2, "loanToken");
  const pairToken = tupleField(value, 3, "pairToken");
  const feeTier = tupleField(value, 4, "feeTier");
  if (
    typeof factory !== "string" ||
    typeof pool !== "string" ||
    typeof loanToken !== "string" ||
    typeof pairToken !== "string" ||
    feeTier === undefined
  ) {
    return null;
  }
  const parsedFeeTier = Number(feeTier);
  if (!Number.isSafeInteger(parsedFeeTier)) {
    return null;
  }
  return {
    factory: factory as Address,
    pool: pool as Address,
    loanToken: loanToken as Address,
    pairToken: pairToken as Address,
    feeTier: parsedFeeTier,
  };
}

function parseExecutorProtocolConfig(value: unknown): ExecutorProtocolConfig | null {
  const morpho = tupleField(value, 0, "morpho");
  const curvePool = tupleField(value, 1, "curvePool");
  const wstDiem = tupleField(value, 2, "wstDiem");
  if (typeof morpho !== "string" || typeof curvePool !== "string" || typeof wstDiem !== "string") {
    return null;
  }
  return {
    morpho: morpho as Address,
    curvePool: curvePool as Address,
    wstDiem: wstDiem as Address,
  };
}

function pushMismatch(mismatches: string[], name: string, ok: boolean): void {
  if (!ok) {
    mismatches.push(name);
  }
}

export async function buildLoopReadiness(input: {
  config: AppConfig;
  owner?: Address | null;
  client?: LoopSimulationClient;
}): Promise<LoopReadinessResult> {
  const checks: ReadinessCheck[] = [];
  const blockers: string[] = [];
  const config = input.config;
  const owner = input.owner ?? config.position.owner;
  const missing = missingDeploymentKeys(config);

  checks.push(
    check(
      "deployment-config",
      missing.length === 0 ? "pass" : "fail",
      missing.length === 0 ? "required deployment config is present" : `missing: ${missing.join(", ")}`,
    ),
  );
  if (missing.length > 0) {
    blockers.push(`missing deployment config: ${missing.join(", ")}`);
  }

  if (input.client === undefined) {
    checks.push(check("rpc-client", "fail", "live RPC client is required for loop readiness"));
    blockers.push("live RPC client unavailable");
    checks.push(check("audit-gate", "fail", "broadcast remains disabled until production executor audit/review is complete"));
    blockers.push("broadcast disabled pending production executor audit/review");
    return {
      status: "blocked",
      checks,
      blockers,
      broadcastAvailable: false,
      auditRequired: true,
    };
  }

  let blockNumber: bigint | undefined;
  let curve: LoopReadinessResult["curve"];
  let morpho: LoopReadinessResult["morpho"];
  let executor: LoopReadinessResult["executor"];
  let ownerReadiness: LoopReadinessResult["owner"];
  try {
  const chainId = await input.client.getChainId();
  checks.push(
    check(
      "chain-id",
      chainId === config.chainId ? "pass" : "fail",
      chainId === config.chainId ? `chainId ${chainId}` : `unexpected chainId ${chainId}; expected ${config.chainId}`,
    ),
  );
  if (chainId !== config.chainId) {
    blockers.push(`unexpected chainId ${chainId}`);
  }
  blockNumber = await input.client.getBlockNumber();

  if (config.contracts.curvePool === null || config.contracts.inferenceVault === null) {
    checks.push(check("curve-liquidity", "fail", "curvePool and inferenceVault are required"));
    blockers.push("Curve deployment config missing");
  } else {
    const [diemBalance, wstDiemBalance, wstDiemNav] = await Promise.all([
      input.client.readContract({
        address: config.contracts.curvePool,
        abi: curvePoolAbi,
        functionName: "balances",
        args: [0n],
        blockNumber,
      }),
      input.client.readContract({
        address: config.contracts.curvePool,
        abi: curvePoolAbi,
        functionName: "balances",
        args: [1n],
        blockNumber,
      }),
      input.client.readContract({
        address: config.contracts.inferenceVault,
        abi: inferenceVaultAbi,
        functionName: "convertToAssets",
        args: [WAD],
        blockNumber,
      }),
    ]);
    const curveDiemBalance = BigInt(diemBalance as bigint | number | string);
    const curveWstDiemBalance = BigInt(wstDiemBalance as bigint | number | string);
    const nav = BigInt(wstDiemNav as bigint | number | string);
    const tvlDiem = computeCurvePoolTvlDiem(curveDiemBalance, curveWstDiemBalance, nav);
    curve = {
      diemBalance: curveDiemBalance,
      wstDiemBalance: curveWstDiemBalance,
      wstDiemNav: nav,
      tvlDiem,
      liquid: curveDiemBalance > 0n && curveWstDiemBalance > 0n && tvlDiem > 0n,
    };
    checks.push(
      check(
        "curve-liquidity",
        curve.liquid ? "pass" : "fail",
        curve.liquid ? "Curve has DIEM and wstDIEM liquidity" : "Curve DIEM/wstDIEM liquidity is not ready",
      ),
    );
    if (!curve.liquid) {
      blockers.push("Curve DIEM/wstDIEM liquidity is not ready");
    }
  }

  if (config.morpho.marketId === null) {
    checks.push(check("morpho-market-liquidity", "fail", "marketId is required"));
    blockers.push("Morpho marketId missing");
  } else {
    const market = parseMorphoMarket(
      await input.client.readContract({
        address: config.contracts.morphoBlue,
        abi: morphoAbi,
        functionName: "market",
        args: [config.morpho.marketId],
        blockNumber,
      }),
    );
    if (market === null) {
      checks.push(check("morpho-market-liquidity", "fail", "Morpho market returned an unsupported shape"));
      blockers.push("Morpho market state unreadable");
    } else {
      morpho = {
        totalSupplyAssets: market.totalSupplyAssets,
        totalBorrowAssets: market.totalBorrowAssets,
        totalBorrowShares: market.totalBorrowShares,
        empty:
          market.totalSupplyAssets === 0n &&
          market.totalSupplyShares === 0n &&
          market.totalBorrowAssets === 0n &&
          market.totalBorrowShares === 0n,
      };
      checks.push(
        check(
          "morpho-market-liquidity",
          morpho.totalSupplyAssets > 0n ? "pass" : "fail",
          morpho.totalSupplyAssets > 0n ? "Morpho market has DIEM supply assets" : "Morpho market has no DIEM supply assets",
        ),
      );
      if (morpho.totalSupplyAssets === 0n) {
        blockers.push("Morpho market has no DIEM supply assets");
      }
    }
  }

  if (config.contracts.loopExecutor === null) {
    checks.push(check("executor-config", "fail", "loopExecutor is not configured"));
    blockers.push("loopExecutor is not configured");
  } else {
    const code = await input.client.getCode(config.contracts.loopExecutor);
    const hasCode = code !== "0x";
    executor = {
      address: config.contracts.loopExecutor,
      hasCode,
      verified: false,
    };
    if (!hasCode) {
      checks.push(check("executor-config", "fail", "loopExecutor has no deployed code"));
      blockers.push("loopExecutor has no deployed code");
    } else {
      const [canonicalFlashPool, executorFee, loanTokenIsToken0, rawFlashConfig, rawProtocolConfig] = await Promise.all([
        input.client.readContract({
          address: config.contracts.loopExecutor,
          abi: loopExecutorAbi,
          functionName: "canonicalFlashPool",
          blockNumber,
        }),
        input.client.readContract({
          address: config.contracts.loopExecutor,
          abi: loopExecutorAbi,
          functionName: "expectedFlashFee",
          args: [50n * WAD],
          blockNumber,
        }),
        input.client.readContract({
          address: config.contracts.loopExecutor,
          abi: loopExecutorAbi,
          functionName: "loanTokenIsToken0",
          blockNumber,
        }),
        input.client.readContract({
          address: config.contracts.loopExecutor,
          abi: loopExecutorAbi,
          functionName: "flashConfig",
          blockNumber,
        }),
        input.client.readContract({
          address: config.contracts.loopExecutor,
          abi: loopExecutorAbi,
          functionName: "protocolConfig",
          blockNumber,
        }),
      ]);
      const flashConfig = parseExecutorFlashConfig(rawFlashConfig);
      const protocolConfig = parseExecutorProtocolConfig(rawProtocolConfig);
      const configuredFee = expectedUniswapV3FlashFee(50n * WAD, config.flashLoan.feeTier);
      const configuredTokenSide =
        config.flashLoan.loanToken !== null && config.flashLoan.pairToken !== null
          ? config.flashLoan.loanToken.toLowerCase() < config.flashLoan.pairToken.toLowerCase()
          : null;
      const mismatches: string[] = [];
      pushMismatch(
        mismatches,
        "canonicalFlashPool",
        config.flashLoan.pool !== null && addressEqual(canonicalFlashPool as Address, config.flashLoan.pool),
      );
      pushMismatch(
        mismatches,
        "expectedFlashFee",
        configuredFee !== null && BigInt(executorFee as bigint | number | string) === configuredFee,
      );
      pushMismatch(mismatches, "loanTokenIsToken0", configuredTokenSide !== null && Boolean(loanTokenIsToken0) === configuredTokenSide);
      pushMismatch(mismatches, "flashConfig", flashConfig !== null);
      pushMismatch(mismatches, "protocolConfig", protocolConfig !== null);
      if (flashConfig !== null) {
        pushMismatch(
          mismatches,
          "flashConfig.factory",
          config.flashLoan.factory !== null && addressEqual(flashConfig.factory, config.flashLoan.factory),
        );
        pushMismatch(
          mismatches,
          "flashConfig.pool",
          config.flashLoan.pool !== null && addressEqual(flashConfig.pool, config.flashLoan.pool),
        );
        pushMismatch(
          mismatches,
          "flashConfig.loanToken",
          config.flashLoan.loanToken !== null && addressEqual(flashConfig.loanToken, config.flashLoan.loanToken),
        );
        pushMismatch(
          mismatches,
          "flashConfig.pairToken",
          config.flashLoan.pairToken !== null && addressEqual(flashConfig.pairToken, config.flashLoan.pairToken),
        );
        pushMismatch(
          mismatches,
          "flashConfig.feeTier",
          config.flashLoan.feeTier !== null && flashConfig.feeTier === config.flashLoan.feeTier,
        );
      }
      if (protocolConfig !== null) {
        pushMismatch(mismatches, "protocolConfig.morpho", addressEqual(protocolConfig.morpho, config.contracts.morphoBlue));
        pushMismatch(
          mismatches,
          "protocolConfig.curvePool",
          config.contracts.curvePool !== null && addressEqual(protocolConfig.curvePool, config.contracts.curvePool),
        );
        pushMismatch(
          mismatches,
          "protocolConfig.wstDiem",
          config.contracts.inferenceVault !== null && addressEqual(protocolConfig.wstDiem, config.contracts.inferenceVault),
        );
      }
      executor = {
        ...executor,
        canonicalFlashPool: canonicalFlashPool as Address,
        expectedFlashFeeFor50Diem: BigInt(executorFee as bigint | number | string),
        loanTokenIsToken0: Boolean(loanTokenIsToken0),
        flashConfig: flashConfig ?? undefined,
        protocolConfig: protocolConfig ?? undefined,
        verified: mismatches.length === 0,
      };
      checks.push(
        check(
          "executor-config",
          executor.verified ? "pass" : "fail",
          executor.verified
            ? "loopExecutor runtime config matches flash and protocol config"
            : `loopExecutor runtime config mismatch: ${mismatches.join(", ")}`,
        ),
      );
      if (!executor.verified) {
        blockers.push("loopExecutor runtime config mismatch");
      }
    }
  }

  if (owner === null) {
    checks.push(check("owner-position", "skip", "owner not configured; position readiness not checked"));
    blockers.push("owner is not configured");
  } else if (config.morpho.marketId === null || morpho === undefined) {
    checks.push(check("owner-position", "fail", "Morpho market state is required before owner position readiness"));
    blockers.push("owner position cannot be checked without Morpho market state");
  } else {
    const position = parseMorphoPosition(
      await input.client.readContract({
        address: config.contracts.morphoBlue,
        abi: morphoAbi,
        functionName: "position",
        args: [config.morpho.marketId, owner],
        blockNumber,
      }),
    );
    if (position === null) {
      checks.push(check("owner-position", "fail", "Morpho position returned an unsupported shape"));
      blockers.push("owner position state unreadable");
    } else {
      const borrowedDiem = computeBorrowedDiem(
        {
          totalBorrowAssets: morpho.totalBorrowAssets,
          totalBorrowShares: morpho.totalBorrowShares,
        },
        { borrowShares: position.borrowShares },
      );
      let executorAuthorized: boolean | null = null;
      if (config.contracts.loopExecutor !== null) {
        executorAuthorized = Boolean(
          await input.client.readContract({
            address: config.contracts.morphoBlue,
            abi: morphoAbi,
            functionName: "isAuthorized",
            args: [owner, config.contracts.loopExecutor],
            blockNumber,
          }),
        );
      }
      ownerReadiness = {
        address: owner,
        collateralWstDiem: position.collateral,
        borrowShares: position.borrowShares,
        borrowedDiem,
        hasExitPosition: position.collateral > 0n && position.borrowShares > 0n && borrowedDiem > 0n,
        executorAuthorized,
      };
      checks.push(
        check(
          "owner-position",
          ownerReadiness.hasExitPosition ? "pass" : "fail",
          ownerReadiness.hasExitPosition ? "owner has collateral and DIEM debt" : "owner does not have an exit-ready position",
        ),
      );
      if (!ownerReadiness.hasExitPosition) {
        blockers.push("owner does not have an exit-ready position");
      }
      if (config.contracts.loopExecutor === null) {
        checks.push(check("morpho-authorization", "skip", "loopExecutor is not configured; authorization not checked"));
      } else {
        checks.push(
          check(
            "morpho-authorization",
            executorAuthorized === true ? "pass" : "fail",
            executorAuthorized === true ? "owner has authorized loopExecutor" : "owner has not authorized loopExecutor",
          ),
        );
      }
      if (config.contracts.loopExecutor !== null && executorAuthorized !== true) {
        blockers.push("owner has not authorized loopExecutor");
      }
    }
  }
  } catch (error) {
    const message = errorMessage(error);
    checks.push(check("rpc-read", "fail", `live readiness read failed: ${message}`));
    blockers.push(`live readiness read failed: ${message}`);
  }

  checks.push(check("audit-gate", "fail", "broadcast remains disabled until production executor audit/review is complete"));
  blockers.push("broadcast disabled pending production executor audit/review");

  return {
    status: blockers.length === 0 ? "ready" : "blocked",
    blockNumber,
    checks,
    blockers,
    curve,
    morpho,
    owner: ownerReadiness,
    executor,
    broadcastAvailable: false,
    auditRequired: true,
  };
}
