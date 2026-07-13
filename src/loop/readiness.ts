import { curvePoolAbi } from "../abi/curvePool.js";
import { inferenceVaultAbi } from "../abi/inferenceVault.js";
import { loopExecutorAbi } from "../abi/loopExecutor.js";
import { morphoAbi } from "../abi/morpho.js";
import { morphoOracleAbi } from "../abi/morphoOracle.js";
import { missingDeploymentKeys } from "../config/load.js";
import { computeBorrowedDiem, computeCurvePoolTvlDiem, computeHealthFactor, WAD } from "../metrics/math.js";
import type { Address, AppConfig, Hex } from "../types/domain.js";
import { parseMorphoMarket, parseMorphoMarketParams, parseMorphoPosition } from "./preflight.js";
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

export interface LiquidationReadout {
  healthFactor: number;
  debtGrowthHeadroomBps: number;
  liquidationPriceDiemPerWstDiem: bigint | null;
  oraclePriceDiemPerWstDiem: bigint | null;
  lltvBps: number;
}

export interface LoopReadinessResult {
  status: "ready" | "blocked";
  blockNumber?: bigint;
  liquidation: LiquidationReadout | null;
  checks: ReadinessCheck[];
  blockers: string[];
  vault?: {
    address: Address;
    asset: Address | null;
    totalSupply: bigint;
    totalAssets: bigint;
    wstDiemNav: bigint;
    hasCode: boolean;
    assetMatchesDiem: boolean;
    hasSupply: boolean;
  };
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

function lltvWadToBps(lltvWad: bigint): number {
  return Number((lltvWad * 10_000n) / WAD);
}

/**
 * SPEC005 §2 — live liquidation readout. Fault detection runs BEFORE the price
 * formula so `lltvWad`/`collateral` (both denominators of
 * `liquidationPriceDiemPerWstDiem`) can never divide-by-zero and throw into the
 * `rpc-read` catch (which would mask a CRITICAL as a 20). Branch order is
 * load-bearing: (1) no borrow → null; (2) fault → sentinel readout, no price
 * formula; (3) normal → full readout. The underwater fault (collateral === 0) is
 * sourced from the already-read owner position, independent of the gated reads.
 */
async function buildLiquidationReadout(input: {
  client: LoopSimulationClient;
  config: AppConfig;
  blockNumber: bigint;
  marketId: Hex;
  collateral: bigint;
  borrowShares: bigint;
  borrowedDiem: bigint;
}): Promise<LiquidationReadout | null> {
  const { collateral, borrowShares, borrowedDiem } = input;
  // §2 case 1 — nothing to liquidate.
  if (borrowShares === 0n) {
    return null;
  }
  // §2 case 2 — underwater/bad-debt fault, sourced from owner reads only. No gated
  // read, no price formula (collateral === 0 is the price denominator).
  if (collateral === 0n) {
    return {
      healthFactor: 0,
      debtGrowthHeadroomBps: -10_000,
      liquidationPriceDiemPerWstDiem: null,
      oraclePriceDiemPerWstDiem: null,
      lltvBps: 0,
    };
  }
  const params = parseMorphoMarketParams(
    await input.client.readContract({
      address: input.config.contracts.morphoBlue,
      abi: morphoAbi,
      functionName: "idToMarketParams",
      args: [input.marketId],
      blockNumber: input.blockNumber,
    }),
  );
  if (params === null) {
    // Unreadable market params are genuinely un-assessable → fail-closed via the
    // outer rpc-read catch → indeterminate(20), not a false readout.
    throw new Error("Morpho idToMarketParams returned an unsupported shape");
  }
  const lltvWad = params.lltv;
  const oraclePrice1e36 = BigInt(
    (await input.client.readContract({
      address: params.oracle,
      abi: morphoOracleAbi,
      functionName: "price",
      blockNumber: input.blockNumber,
    })) as bigint | number | string,
  );
  // §2 case 2 — deterministic protocol fault (Morpho values collateral at ~0).
  // MUST precede the price formula: bigint / 0n throws.
  if (lltvWad === 0n || oraclePrice1e36 === 0n) {
    return {
      healthFactor: 0,
      debtGrowthHeadroomBps: -10_000,
      liquidationPriceDiemPerWstDiem: null,
      oraclePriceDiemPerWstDiem: oraclePrice1e36 === 0n ? null : oraclePrice1e36 / WAD,
      lltvBps: lltvWad === 0n ? 0 : lltvWadToBps(lltvWad),
    };
  }
  // §2 case 3 — normal branch (collateral > 0 && lltvWad > 0 && oraclePrice1e36 > 0).
  const collateralValueDiem = (collateral * oraclePrice1e36) / (WAD * WAD);
  const healthFactor = computeHealthFactor(collateralValueDiem, borrowedDiem, lltvWad);
  return {
    healthFactor,
    debtGrowthHeadroomBps: Math.round((healthFactor - 1) * 10_000),
    liquidationPriceDiemPerWstDiem: (borrowedDiem * WAD * WAD) / (lltvWad * collateral),
    oraclePriceDiemPerWstDiem: oraclePrice1e36 / WAD,
    lltvBps: lltvWadToBps(lltvWad),
  };
}

export async function buildLoopReadiness(input: {
  config: AppConfig;
  owner?: Address | null;
  client?: LoopSimulationClient;
  includeLiquidation?: boolean;
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
      missing.length === 0
        ? "required deployment config is present"
        : `missing: ${missing.join(", ")}`,
    ),
  );
  if (missing.length > 0) {
    blockers.push(`missing deployment config: ${missing.join(", ")}`);
  }

  if (input.client === undefined) {
    checks.push(check("rpc-client", "fail", "live RPC client is required for loop readiness"));
    blockers.push("live RPC client unavailable");
    checks.push(
      check(
        "audit-gate",
        "fail",
        "broadcast remains disabled until production executor audit/review is complete",
      ),
    );
    blockers.push("broadcast disabled pending production executor audit/review");
    return {
      status: "blocked",
      liquidation: null,
      checks,
      blockers,
      broadcastAvailable: false,
      auditRequired: true,
    };
  }

  let blockNumber: bigint | undefined;
  let vault: LoopReadinessResult["vault"];
  let curve: LoopReadinessResult["curve"];
  let morpho: LoopReadinessResult["morpho"];
  let executor: LoopReadinessResult["executor"];
  let ownerReadiness: LoopReadinessResult["owner"];
  let liquidation: LiquidationReadout | null = null;
  try {
    const chainId = await input.client.getChainId();
    checks.push(
      check(
        "chain-id",
        chainId === config.chainId ? "pass" : "fail",
        chainId === config.chainId
          ? `chainId ${chainId}`
          : `unexpected chainId ${chainId}; expected ${config.chainId}`,
      ),
    );
    if (chainId !== config.chainId) {
      blockers.push(`unexpected chainId ${chainId}`);
    }
    blockNumber = await input.client.getBlockNumber();

    if (config.contracts.inferenceVault === null) {
      checks.push(check("vault", "fail", "inferenceVault is required"));
      blockers.push("wstDIEM vault config missing");
    } else {
      const code = await input.client.getCode(config.contracts.inferenceVault);
      const hasCode = code !== "0x";
      if (!hasCode) {
        vault = {
          address: config.contracts.inferenceVault,
          asset: null,
          totalSupply: 0n,
          totalAssets: 0n,
          wstDiemNav: 0n,
          hasCode,
          assetMatchesDiem: false,
          hasSupply: false,
        };
        checks.push(check("vault", "fail", "wstDIEM vault has no deployed code"));
        blockers.push("wstDIEM vault has no deployed code");
      } else {
        const asset = await input.client.readContract({
          address: config.contracts.inferenceVault,
          abi: inferenceVaultAbi,
          functionName: "asset",
          blockNumber,
        });
        const totalSupply = await input.client.readContract({
          address: config.contracts.inferenceVault,
          abi: inferenceVaultAbi,
          functionName: "totalSupply",
          blockNumber,
        });
        const totalAssets = await input.client.readContract({
          address: config.contracts.inferenceVault,
          abi: inferenceVaultAbi,
          functionName: "totalAssets",
          blockNumber,
        });
        const wstDiemNav = await input.client.readContract({
          address: config.contracts.inferenceVault,
          abi: inferenceVaultAbi,
          functionName: "convertToAssets",
          args: [WAD],
          blockNumber,
        });
        const totalSupplyShares = BigInt(totalSupply as bigint | number | string);
        const totalAssetDiem = BigInt(totalAssets as bigint | number | string);
        const nav = BigInt(wstDiemNav as bigint | number | string);
        vault = {
          address: config.contracts.inferenceVault,
          asset: asset as Address,
          totalSupply: totalSupplyShares,
          totalAssets: totalAssetDiem,
          wstDiemNav: nav,
          hasCode,
          assetMatchesDiem: addressEqual(asset as Address, config.contracts.diem),
          hasSupply: totalSupplyShares > 0n && totalAssetDiem > 0n && nav > 0n,
        };
        const vaultReady = vault.assetMatchesDiem && vault.hasSupply;
        checks.push(
          check(
            "vault",
            vaultReady ? "pass" : "fail",
            vaultReady
              ? "wstDIEM vault asset, supply, and NAV are ready"
              : "wstDIEM vault asset, supply, or NAV is not ready",
          ),
        );
        if (!vaultReady) {
          blockers.push("wstDIEM vault is not ready");
        }
      }
    }

    if (config.contracts.curvePool === null || vault === undefined) {
      checks.push(check("curve-liquidity", "fail", "curvePool and inferenceVault are required"));
      blockers.push("Curve deployment config missing");
    } else {
      const diemBalance = await input.client.readContract({
        address: config.contracts.curvePool,
        abi: curvePoolAbi,
        functionName: "balances",
        args: [0n],
        blockNumber,
      });
      const wstDiemBalance = await input.client.readContract({
        address: config.contracts.curvePool,
        abi: curvePoolAbi,
        functionName: "balances",
        args: [1n],
        blockNumber,
      });
      const curveDiemBalance = BigInt(diemBalance as bigint | number | string);
      const curveWstDiemBalance = BigInt(wstDiemBalance as bigint | number | string);
      const nav = vault.wstDiemNav;
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
          curve.liquid
            ? "Curve has DIEM and wstDIEM liquidity"
            : "Curve DIEM/wstDIEM liquidity is not ready",
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
        checks.push(
          check("morpho-market-liquidity", "fail", "Morpho market returned an unsupported shape"),
        );
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
            morpho.totalSupplyAssets > 0n
              ? "Morpho market has DIEM supply assets"
              : "Morpho market has no DIEM supply assets",
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
        const [
          canonicalFlashPool,
          executorFee,
          loanTokenIsToken0,
          rawFlashConfig,
          rawProtocolConfig,
        ] = await Promise.all([
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
          config.flashLoan.pool !== null &&
            addressEqual(canonicalFlashPool as Address, config.flashLoan.pool),
        );
        pushMismatch(
          mismatches,
          "expectedFlashFee",
          configuredFee !== null &&
            BigInt(executorFee as bigint | number | string) === configuredFee,
        );
        pushMismatch(
          mismatches,
          "loanTokenIsToken0",
          configuredTokenSide !== null && Boolean(loanTokenIsToken0) === configuredTokenSide,
        );
        pushMismatch(mismatches, "flashConfig", flashConfig !== null);
        pushMismatch(mismatches, "protocolConfig", protocolConfig !== null);
        if (flashConfig !== null) {
          pushMismatch(
            mismatches,
            "flashConfig.factory",
            config.flashLoan.factory !== null &&
              addressEqual(flashConfig.factory, config.flashLoan.factory),
          );
          pushMismatch(
            mismatches,
            "flashConfig.pool",
            config.flashLoan.pool !== null && addressEqual(flashConfig.pool, config.flashLoan.pool),
          );
          pushMismatch(
            mismatches,
            "flashConfig.loanToken",
            config.flashLoan.loanToken !== null &&
              addressEqual(flashConfig.loanToken, config.flashLoan.loanToken),
          );
          pushMismatch(
            mismatches,
            "flashConfig.pairToken",
            config.flashLoan.pairToken !== null &&
              addressEqual(flashConfig.pairToken, config.flashLoan.pairToken),
          );
          pushMismatch(
            mismatches,
            "flashConfig.feeTier",
            config.flashLoan.feeTier !== null && flashConfig.feeTier === config.flashLoan.feeTier,
          );
        }
        if (protocolConfig !== null) {
          pushMismatch(
            mismatches,
            "protocolConfig.morpho",
            addressEqual(protocolConfig.morpho, config.contracts.morphoBlue),
          );
          pushMismatch(
            mismatches,
            "protocolConfig.curvePool",
            config.contracts.curvePool !== null &&
              addressEqual(protocolConfig.curvePool, config.contracts.curvePool),
          );
          pushMismatch(
            mismatches,
            "protocolConfig.wstDiem",
            config.contracts.inferenceVault !== null &&
              addressEqual(protocolConfig.wstDiem, config.contracts.inferenceVault),
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
      checks.push(
        check("owner-position", "skip", "owner not configured; position readiness not checked"),
      );
      blockers.push("owner is not configured");
    } else if (config.morpho.marketId === null || morpho === undefined) {
      checks.push(
        check(
          "owner-position",
          "fail",
          "Morpho market state is required before owner position readiness",
        ),
      );
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
        checks.push(
          check("owner-position", "fail", "Morpho position returned an unsupported shape"),
        );
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
          hasExitPosition:
            position.collateral > 0n && position.borrowShares > 0n && borrowedDiem > 0n,
          executorAuthorized,
        };
        // SPEC005 §7 — flag-gated live liquidation readout, block-pinned to the same
        // blockNumber as the position/market reads. Off for `loop readiness`.
        if (
          input.includeLiquidation === true &&
          blockNumber !== undefined &&
          config.morpho.marketId !== null
        ) {
          liquidation = await buildLiquidationReadout({
            client: input.client,
            config,
            blockNumber,
            marketId: config.morpho.marketId,
            collateral: position.collateral,
            borrowShares: position.borrowShares,
            borrowedDiem,
          });
        }
        checks.push(
          check(
            "owner-position",
            ownerReadiness.hasExitPosition ? "pass" : "fail",
            ownerReadiness.hasExitPosition
              ? "owner has collateral and DIEM debt"
              : "owner does not have an exit-ready position",
          ),
        );
        if (!ownerReadiness.hasExitPosition) {
          blockers.push("owner does not have an exit-ready position");
        }
        if (config.contracts.loopExecutor === null) {
          checks.push(
            check(
              "morpho-authorization",
              "skip",
              "loopExecutor is not configured; authorization not checked",
            ),
          );
        } else {
          checks.push(
            check(
              "morpho-authorization",
              executorAuthorized === true ? "pass" : "fail",
              executorAuthorized === true
                ? "owner has authorized loopExecutor"
                : "owner has not authorized loopExecutor",
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

  checks.push(
    check(
      "audit-gate",
      "fail",
      "broadcast remains disabled until production executor audit/review is complete",
    ),
  );
  blockers.push("broadcast disabled pending production executor audit/review");

  return {
    status: blockers.length === 0 ? "ready" : "blocked",
    blockNumber,
    liquidation,
    checks,
    blockers,
    vault,
    curve,
    morpho,
    owner: ownerReadiness,
    executor,
    broadcastAvailable: false,
    auditRequired: true,
  };
}
