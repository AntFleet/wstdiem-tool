/**
 * SPEC010 acceptance criteria — unlevered owner readout + position-safety exit model.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { missingDeploymentKeys } from "../src/config/load.js";
import { buildLoopReadiness, isContractRevert } from "../src/loop/readiness.js";
import { evaluateReadinessAlerts } from "../src/monitor/readinessAlerts.js";
import { classifyMonitoringOutcome, isMonitorAssessed } from "../src/cli/exitCode.js";
import { renderOwnerReadinessRow, renderLoopReadinessTable } from "../src/cli/output.js";
import { WAD } from "../src/metrics/math.js";
import type { Address, AppConfig, Hex } from "../src/types/domain.js";
import type { LoopSimulationClient } from "../src/loop/simulator.js";

const owner = "0x0000000000000000000000000000000000000009" as const;
const loopExecutor = "0x0000000000000000000000000000000000000004" as const;
const routerAddress = "0x74ad4532133Ba538945a5371D249560E66CC7c71" as const;

function contractRevert(message: string): Error {
  const err = new Error(message);
  err.name = "ExecutionRevertedError";
  return err;
}

function transportError(message: string): Error {
  const err = new Error(message);
  err.name = "HttpRequestError";
  return err;
}

interface Spec010MockOptions {
  curveLiquid?: boolean;
  marketSupply?: bigint;
  collateral?: bigint;
  borrowShares?: bigint;
  walletWstDiem?: bigint;
  vaultNav?: bigint;
  authorized?: boolean;
  hasExecutorCode?: boolean;
  noVaultCode?: boolean;
  executorReadReverts?: boolean;
  /** Per-function mixed executor failures: revert vs transport. */
  executorMixed?: Record<string, "revert" | "transport">;
  positionReadReverts?: boolean;
  marketReadReverts?: boolean;
  positionShapeBad?: boolean;
  marketIdNull?: boolean;
  transportOn?: string;
  loopExecutor?: Address | null;
}

class Spec010Client implements LoopSimulationClient {
  constructor(private readonly options: Spec010MockOptions = {}) {}

  async getBlockNumber(): Promise<bigint> {
    return 999n;
  }

  async getChainId(): Promise<number> {
    return 8453;
  }

  async getCode(address: Address): Promise<Hex> {
    if (
      this.options.noVaultCode &&
      address.toLowerCase() === DEFAULT_CONFIG.contracts.inferenceVault?.toLowerCase()
    ) {
      return "0x";
    }
    if (this.options.hasExecutorCode === false) {
      const exec = this.options.loopExecutor ?? loopExecutor;
      if (exec !== null && address.toLowerCase() === exec.toLowerCase()) {
        return "0x";
      }
    }
    return "0x01";
  }

  async readContract(args: {
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }): Promise<unknown> {
    if (args.functionName === this.options.transportOn) {
      throw transportError(`transport ${args.functionName}`);
    }
    const liquid = this.options.curveLiquid ?? false;
    switch (args.functionName) {
      case "balances":
        return liquid ? 1_000n * WAD : 0n;
      case "balanceOf":
        return this.options.walletWstDiem ?? 0n;
      case "convertToAssets": {
        const shares = BigInt((args.args?.[0] as bigint | number | string | undefined) ?? WAD);
        const nav = this.options.vaultNav ?? WAD;
        return (shares * nav) / WAD;
      }
      case "asset":
        return DEFAULT_CONFIG.contracts.diem;
      case "totalSupply":
      case "totalAssets":
        return WAD;
      case "market": {
        if (this.options.marketReadReverts) {
          throw contractRevert("market reverted");
        }
        const supply = this.options.marketSupply ?? 0n;
        const borrowShares = this.options.borrowShares ?? 0n;
        return [supply, supply, borrowShares, borrowShares, 0n, 0n];
      }
      case "position":
        if (this.options.positionReadReverts) {
          throw contractRevert("position reverted");
        }
        if (this.options.positionShapeBad) {
          return { unexpected: true };
        }
        return [
          0n,
          this.options.borrowShares ?? 0n,
          this.options.collateral ?? 0n,
        ];
      case "isAuthorized":
        return this.options.authorized ?? false;
      case "idToMarketParams":
        // Healthy LLTV for levered SPEC005 path (do not fire position_* fault).
        return [
          DEFAULT_CONFIG.contracts.diem,
          DEFAULT_CONFIG.contracts.inferenceVault,
          "0x00000000000000000000000000000000000000AA",
          DEFAULT_CONFIG.contracts.adaptiveCurveIrm,
          860_000_000_000_000_000n,
        ];
      case "price":
        // 1.0e36 oracle → healthy HF for typical AC5 fixture.
        return 10n ** 36n;
      case "canonicalFlashPool":
      case "expectedFlashFee":
      case "loanTokenIsToken0":
      case "flashConfig":
      case "protocolConfig": {
        const mixed = this.options.executorMixed?.[args.functionName];
        if (mixed === "transport") {
          throw transportError(`transport ${args.functionName}`);
        }
        if (mixed === "revert" || this.options.executorReadReverts) {
          throw contractRevert("not a LoopExecutor");
        }
        if (args.functionName === "canonicalFlashPool") return DEFAULT_CONFIG.flashLoan.pool;
        if (args.functionName === "expectedFlashFee") {
          return (50n * WAD * 10_000n - 1n) / 1_000_000n + 1n;
        }
        if (args.functionName === "loanTokenIsToken0") return false;
        if (args.functionName === "flashConfig") {
          return [
            DEFAULT_CONFIG.flashLoan.factory,
            DEFAULT_CONFIG.flashLoan.pool,
            DEFAULT_CONFIG.flashLoan.loanToken,
            DEFAULT_CONFIG.flashLoan.pairToken,
            DEFAULT_CONFIG.flashLoan.feeTier,
          ];
        }
        return [
          DEFAULT_CONFIG.contracts.morphoBlue,
          DEFAULT_CONFIG.contracts.curvePool,
          DEFAULT_CONFIG.contracts.inferenceVault,
        ];
      }
      default:
        throw new Error(`unexpected ${args.functionName}`);
    }
  }

  async simulateContract(): Promise<unknown> {
    return {};
  }

  async estimateContractGas(): Promise<bigint> {
    return 1n;
  }
}

function config(options: Spec010MockOptions = {}): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    rpc: { ...DEFAULT_CONFIG.rpc, primaryUrl: "https://base.example.invalid" },
    contracts: {
      ...DEFAULT_CONFIG.contracts,
      loopExecutor:
        options.loopExecutor === undefined
          ? null
          : options.loopExecutor,
    },
    morpho: {
      ...DEFAULT_CONFIG.morpho,
      marketId: options.marketIdNull ? null : DEFAULT_CONFIG.morpho.marketId,
    },
    position: { owner },
  };
}

async function runMonitor(options: Spec010MockOptions = {}) {
  const cfg = config(options);
  const client = new Spec010Client({ ...options, loopExecutor: cfg.contracts.loopExecutor });
  const readiness = await buildLoopReadiness({
    config: cfg,
    owner,
    client,
    includeLiquidation: true,
  });
  const alerts = evaluateReadinessAlerts(readiness, cfg.thresholds);
  const classification = classifyMonitoringOutcome({
    assessed: isMonitorAssessed(readiness),
    alerts,
  });
  return { readiness, alerts, classification, exitCode: classification.exitCode };
}

describe("SPEC010 core acceptance", () => {
  it("AC1: unlevered + healthy vault + null executor + drained Curve → exit 10", async () => {
    const { exitCode, readiness, alerts } = await runMonitor({
      walletWstDiem: 10n * WAD,
      borrowShares: 0n,
      collateral: 0n,
      marketSupply: 1n * WAD,
      curveLiquid: false,
      loopExecutor: null,
    });

    expect(readiness.leverage).toBe("unlevered");
    expect(readiness.ownerLeverageUndeterminable).toBe(false);
    expect(alerts.some((a) => a.level === "CRITICAL")).toBe(false);
    expect(alerts.some((a) => a.level === "WARN")).toBe(true);
    expect(exitCode).toBe(10);
  });

  it("AC1 variant: Router address → exit 10 + executor_read_reverted WARN", async () => {
    const { exitCode, alerts, readiness } = await runMonitor({
      walletWstDiem: 10n * WAD,
      borrowShares: 0n,
      collateral: 0n,
      marketSupply: 1n * WAD,
      curveLiquid: false,
      loopExecutor: routerAddress,
      executorReadReverts: true,
    });

    expect(readiness.executor?.readReverted).toBe(true);
    expect(alerts.map((a) => a.alertKey)).toContain("executor_read_reverted");
    expect(alerts.find((a) => a.alertKey === "executor_read_reverted")?.level).toBe("WARN");
    expect(alerts.map((a) => a.alertKey)).not.toContain("executor_config_mismatch");
    expect(exitCode).toBe(10);
  });

  it("AC2: unlevered + empty Morpho → exit 10", async () => {
    const { exitCode, alerts } = await runMonitor({
      walletWstDiem: 5n * WAD,
      borrowShares: 0n,
      collateral: 0n,
      marketSupply: 0n,
      curveLiquid: false,
      loopExecutor: null,
    });

    expect(alerts.find((a) => a.alertKey === "morpho_liquidity_empty")?.level).toBe("WARN");
    expect(exitCode).toBe(10);
  });

  it("AC3: blind (position reverts) → exit 20, owner_unreadable, no downgrade", async () => {
    const { exitCode, alerts, readiness } = await runMonitor({
      walletWstDiem: 5n * WAD,
      positionReadReverts: true,
      marketSupply: 1n * WAD,
      curveLiquid: false,
      loopExecutor: null,
    });

    expect(readiness.leverage).toBe("unknown");
    expect(readiness.ownerLeverageUndeterminable).toBe(true);
    expect(isMonitorAssessed(readiness)).toBe(false);
    expect(alerts.map((a) => a.alertKey)).toContain("owner_unreadable");
    expect(alerts.map((a) => a.alertKey)).not.toContain("owner_missing");
    // Leveraged-exit alerts stay CRITICAL when leverage is unknown.
    expect(alerts.find((a) => a.alertKey === "curve_liquidity_empty")?.level).toBe("CRITICAL");
    expect(exitCode).toBe(20);
  });

  it("AC3 shape-mismatch and marketId:null also blind → 20", async () => {
    const shape = await runMonitor({
      walletWstDiem: WAD,
      positionShapeBad: true,
      marketSupply: 1n * WAD,
      curveLiquid: false,
    });
    expect(shape.exitCode).toBe(20);
    expect(shape.readiness.ownerLeverageUndeterminable).toBe(true);

    const noMarket = await runMonitor({
      walletWstDiem: WAD,
      marketIdNull: true,
      curveLiquid: false,
    });
    expect(noMarket.exitCode).toBe(20);
    expect(noMarket.readiness.ownerLeverageUndeterminable).toBe(true);
  });

  it("AC4: transport error → rpc-read fail → 20; contract revert degrades only", async () => {
    const transport = await runMonitor({
      walletWstDiem: WAD,
      borrowShares: 0n,
      transportOn: "balances",
    });
    expect(transport.readiness.checks.some((c) => c.key === "rpc-read" && c.status === "fail")).toBe(
      true,
    );
    expect(transport.exitCode).toBe(20);

    const revertOnly = await runMonitor({
      walletWstDiem: WAD,
      borrowShares: 0n,
      collateral: 0n,
      marketSupply: 1n * WAD,
      executorReadReverts: true,
      loopExecutor: loopExecutor,
      curveLiquid: true,
    });
    expect(revertOnly.readiness.checks.some((c) => c.key === "rpc-read")).toBe(false);
    expect(revertOnly.readiness.executor?.readReverted).toBe(true);
    expect(revertOnly.readiness.owner?.walletWstDiem).toBe(WAD);
  });

  it("AC5: levered + drained Curve → 30", async () => {
    const { exitCode, alerts } = await runMonitor({
      walletWstDiem: 0n,
      borrowShares: 50n * WAD,
      collateral: 100n * WAD,
      marketSupply: 2_000n * WAD,
      curveLiquid: false,
      loopExecutor: loopExecutor,
      hasExecutorCode: false,
      authorized: true,
    });

    expect(alerts.find((a) => a.alertKey === "curve_liquidity_empty")?.level).toBe("CRITICAL");
    expect(exitCode).toBe(30);
  });

  it("AC6: readReverted ⊕ config_mismatch exclusion", async () => {
    const { alerts } = await runMonitor({
      walletWstDiem: WAD,
      borrowShares: 0n,
      collateral: 0n,
      marketSupply: 1n * WAD,
      loopExecutor: loopExecutor,
      executorReadReverts: true,
    });
    const keys = alerts.map((a) => a.alertKey);
    expect(keys).toContain("executor_read_reverted");
    expect(keys).not.toContain("executor_config_mismatch");
  });

  it("AC7: unlevered wallet readout + render caveat", async () => {
    const wallet = 12n * WAD;
    const { readiness } = await runMonitor({
      walletWstDiem: wallet,
      borrowShares: 0n,
      collateral: 0n,
      marketSupply: 1n * WAD,
      vaultNav: WAD,
      curveLiquid: false,
    });

    expect(readiness.owner?.walletWstDiem).toBe(wallet);
    expect(readiness.owner?.walletValueDiem).toBe(wallet);
    expect(readiness.owner?.borrowShares).toBe(0n);
    const row = renderOwnerReadinessRow(readiness);
    expect(row).toMatch(/holding/);
    expect(row).toMatch(/redemption not currently executable/);
    expect(row).toMatch(/no debt/);
    expect(row).toMatch(/HF n\/a \(unlevered\)/);
    expect(row).not.toMatch(/unavailable/);
  });

  it("AC8: wallet + Morpho revert → wallet shown, position n/a, exit 20", async () => {
    const { readiness, exitCode } = await runMonitor({
      walletWstDiem: 3n * WAD,
      positionReadReverts: true,
      marketSupply: 1n * WAD,
    });

    expect(readiness.owner?.walletWstDiem).toBe(3n * WAD);
    expect(readiness.owner?.borrowShares).toBeNull();
    const row = renderOwnerReadinessRow(readiness);
    expect(row).toMatch(/in-wallet|holding|accounting/);
    expect(row).toMatch(/n\/a/);
    expect(row).not.toBe("unavailable");
    expect(exitCode).toBe(20);
  });

  it("AC8: marketId null still renders wallet", async () => {
    const { readiness } = await runMonitor({
      walletWstDiem: 2n * WAD,
      marketIdNull: true,
    });
    expect(readiness.owner?.walletWstDiem).toBe(2n * WAD);
    expect(renderOwnerReadinessRow(readiness)).not.toBe("unavailable");
  });

  it("AC9: no owner + drained Curve → CRITICAL 30 (no downgrade)", async () => {
    const cfg = {
      ...config({ curveLiquid: false, loopExecutor: null }),
      position: { owner: null as Address | null },
    };
    const client = new Spec010Client({ curveLiquid: false, marketSupply: 0n });
    const readiness = await buildLoopReadiness({
      config: cfg,
      owner: null,
      client,
      includeLiquidation: true,
    });
    const alerts = evaluateReadinessAlerts(readiness, cfg.thresholds);
    const classification = classifyMonitoringOutcome({
      assessed: isMonitorAssessed(readiness),
      alerts,
    });

    expect(readiness.ownerConfigured).toBe(false);
    expect(readiness.leverage).toBe("unknown");
    expect(alerts.find((a) => a.alertKey === "curve_liquidity_empty")?.level).toBe("CRITICAL");
    expect(alerts.map((a) => a.alertKey)).toContain("owner_missing");
    expect(classification.exitCode).toBe(30);
  });

  it("AC10: loopExecutor null not in missingDeploymentKeys", () => {
    expect(DEFAULT_CONFIG.contracts.loopExecutor).toBeNull();
    expect(missingDeploymentKeys(DEFAULT_CONFIG)).not.toContain("loopExecutor");
    expect(missingDeploymentKeys(DEFAULT_CONFIG)).toEqual([]);
  });

  it("AC11: vault no-code → wallet n/a, never ≈ 0 DIEM", async () => {
    const { readiness } = await runMonitor({
      noVaultCode: true,
      borrowShares: 0n,
      collateral: 0n,
      marketSupply: 1n * WAD,
    });
    expect(readiness.owner?.walletWstDiem ?? null).toBeNull();
    expect(readiness.owner?.walletValueDiem ?? null).toBeNull();
    const row = renderOwnerReadinessRow(readiness);
    expect(row).not.toMatch(/≈ 0 DIEM/);
    expect(row).toMatch(/n\/a|no position|unavailable/);
  });

  it("AC12: --json additive fields present; leverage/wallet/readReverted", async () => {
    const { readiness } = await runMonitor({
      walletWstDiem: WAD,
      borrowShares: 0n,
      collateral: 0n,
      marketSupply: 1n * WAD,
      loopExecutor: null,
    });
    expect(readiness).toMatchObject({
      leverage: "unlevered",
      ownerConfigured: true,
      ownerLeverageUndeterminable: false,
    });
    expect(readiness.owner).toMatchObject({
      walletWstDiem: WAD,
      walletValueDiem: WAD,
    });
    // Existing Morpho fields still present when readable.
    expect(readiness.owner?.borrowShares).toBe(0n);
    expect(readiness.owner?.collateralWstDiem).toBe(0n);
  });

  it("isContractRevert discriminates by error name chain, not message", () => {
    const nested = new Error("wrapper");
    nested.name = "ContractFunctionExecutionError";
    const cause = new Error("reverted");
    cause.name = "ExecutionRevertedError";
    (nested as Error & { cause: Error }).cause = cause;
    expect(isContractRevert(nested)).toBe(true);
    expect(isContractRevert(transportError("timeout"))).toBe(false);
    expect(isContractRevert(new Error("ExecutionRevertedError in message only"))).toBe(false);
  });

  it("executor reason surfaces in readiness table", async () => {
    const { readiness } = await runMonitor({
      walletWstDiem: WAD,
      borrowShares: 0n,
      collateral: 0n,
      marketSupply: 1n * WAD,
      loopExecutor: routerAddress,
      executorReadReverts: true,
    });
    const table = renderLoopReadinessTable(readiness);
    expect(table).toMatch(/not a LoopExecutor|flash getters/);
  });

  it("auditor fix: mixed executor revert+transport → rpc-read fail → 20 (not mask)", async () => {
    const { exitCode, readiness } = await runMonitor({
      walletWstDiem: WAD,
      borrowShares: 0n,
      collateral: 0n,
      marketSupply: 1n * WAD,
      curveLiquid: false,
      loopExecutor: loopExecutor,
      executorMixed: {
        canonicalFlashPool: "revert",
        expectedFlashFee: "transport",
        loanTokenIsToken0: "revert",
        flashConfig: "revert",
        protocolConfig: "revert",
      },
    });
    expect(readiness.checks.some((c) => c.key === "rpc-read" && c.status === "fail")).toBe(true);
    expect(readiness.executor?.readReverted).not.toBe(true);
    expect(exitCode).toBe(20);
  });

  it("auditor fix: Morpho market() revert still shows wallet (decoupled)", async () => {
    const { readiness, exitCode } = await runMonitor({
      walletWstDiem: 9n * WAD,
      marketReadReverts: true,
      loopExecutor: null,
    });
    expect(readiness.owner?.walletWstDiem).toBe(9n * WAD);
    expect(readiness.morpho).toBeUndefined();
    expect(readiness.ownerLeverageUndeterminable).toBe(true);
    expect(exitCode).toBe(20);
    expect(renderOwnerReadinessRow(readiness)).not.toBe("unavailable");
  });

  it("auditor fix: auth null renders n/a not affirmative no", async () => {
    const { readiness } = await runMonitor({
      walletWstDiem: 0n,
      borrowShares: 50n * WAD,
      collateral: 100n * WAD,
      marketSupply: 2_000n * WAD,
      curveLiquid: true,
      loopExecutor: null, // auth skipped → null
      authorized: false,
    });
    expect(readiness.owner?.executorAuthorized).toBeNull();
    expect(renderOwnerReadinessRow(readiness)).toMatch(/authorized n\/a/);
    expect(renderOwnerReadinessRow(readiness)).not.toMatch(/authorized no/);
  });
});
