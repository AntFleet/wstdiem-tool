import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildLoopReadiness } from "../src/loop/readiness.js";
import { evaluateReadinessAlerts } from "../src/monitor/readinessAlerts.js";
import { classifyMonitoringOutcome, isMonitorAssessed } from "../src/cli/exitCode.js";
import { renderStatusTable, stringifyJson } from "../src/cli/output.js";
import { makeEmptySnapshot, WAD } from "../src/metrics/math.js";
import type { Address, AppConfig, Hex } from "../src/types/domain.js";
import type { LoopSimulationClient } from "../src/loop/simulator.js";

const owner = "0x0000000000000000000000000000000000000009" as const;
const loopExecutor = "0x0000000000000000000000000000000000000004" as const;
const marketOracle = "0x00000000000000000000000000000000000000AA" as const;

const LLTV_WAD = 860_000_000_000_000_000n; // 0.86e18 (matches DEFAULT_CONFIG.morpho.lltvWad)

function completeConfig(): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    rpc: { ...DEFAULT_CONFIG.rpc, primaryUrl: "https://base.example.invalid" },
    contracts: { ...DEFAULT_CONFIG.contracts, loopExecutor },
    position: { owner },
  };
}

interface RecordedRead {
  functionName: string;
  blockNumber?: bigint;
  address?: Address;
}

interface MockOptions {
  collateral?: bigint;
  borrowShares?: bigint;
  lltvWad?: bigint;
  oraclePrice1e36?: bigint;
  curveLiquid?: boolean;
  readFailureFunction?: string;
}

/**
 * A mock whose dependency reads (curve/vault/morpho/executor/authorization) are all
 * healthy by default, so the only alerts that can fire are the SPEC005 liquidation
 * ones — unless `curveLiquid:false` co-fires an independent `curve_liquidity_empty`
 * CRITICAL (used to prove faults are not masked below 30).
 */
class MockClient implements LoopSimulationClient {
  readonly reads: RecordedRead[] = [];

  constructor(private readonly options: MockOptions = {}) {}

  async getBlockNumber(): Promise<bigint> {
    return 456n;
  }

  async getChainId(): Promise<number> {
    return 8453;
  }

  async getCode(): Promise<Hex> {
    return "0x01";
  }

  async readContract(args: {
    address?: Address;
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }): Promise<unknown> {
    this.reads.push({
      functionName: args.functionName,
      blockNumber: args.blockNumber,
      address: args.address,
    });
    if (args.functionName === this.options.readFailureFunction) {
      throw new Error(`forced ${args.functionName} failure`);
    }
    const borrowShares = this.options.borrowShares ?? 0n;
    const liquid = this.options.curveLiquid ?? true;
    switch (args.functionName) {
      case "balances":
        return liquid ? 1_000n * WAD : 0n;
      case "balanceOf":
        // Unlevered wallet holding is independent of Morpho position (SPEC010).
        return 0n;
      case "convertToAssets": {
        const shares = BigInt((args.args?.[0] as bigint | number | string | undefined) ?? WAD);
        return shares; // 1:1 NAV for tests
      }
      case "asset":
        return DEFAULT_CONFIG.contracts.diem;
      case "totalSupply":
      case "totalAssets":
        return WAD;
      case "market":
        // supply large; borrow assets == borrow shares == position shares → borrowedDiem == shares.
        return [2_000n * WAD, 2_000n * WAD, borrowShares, borrowShares, 0n, 0n];
      case "position":
        return [0n, borrowShares, this.options.collateral ?? 0n];
      case "isAuthorized":
        return true;
      case "canonicalFlashPool":
        return DEFAULT_CONFIG.flashLoan.pool;
      case "expectedFlashFee":
        return (50n * WAD * 10_000n - 1n) / 1_000_000n + 1n;
      case "loanTokenIsToken0":
        return false;
      case "flashConfig":
        return [
          DEFAULT_CONFIG.flashLoan.factory,
          DEFAULT_CONFIG.flashLoan.pool,
          DEFAULT_CONFIG.flashLoan.loanToken,
          DEFAULT_CONFIG.flashLoan.pairToken,
          DEFAULT_CONFIG.flashLoan.feeTier,
        ];
      case "protocolConfig":
        return [
          DEFAULT_CONFIG.contracts.morphoBlue,
          DEFAULT_CONFIG.contracts.curvePool,
          DEFAULT_CONFIG.contracts.inferenceVault,
        ];
      case "idToMarketParams":
        return [
          DEFAULT_CONFIG.contracts.diem,
          DEFAULT_CONFIG.contracts.inferenceVault,
          marketOracle,
          DEFAULT_CONFIG.contracts.adaptiveCurveIrm,
          this.options.lltvWad ?? LLTV_WAD,
        ];
      case "price":
        return this.options.oraclePrice1e36 ?? 0n;
      default:
        throw new Error(`unexpected readContract ${args.functionName}`);
    }
  }

  async simulateContract(): Promise<unknown> {
    return {};
  }

  async estimateContractGas(): Promise<bigint> {
    return 1n;
  }
}

/** Reproduces the monitor action's pipeline (index.ts): readiness → alerts → classify. */
async function runMonitor(options: MockOptions): Promise<{
  readiness: Awaited<ReturnType<typeof buildLoopReadiness>>;
  alerts: ReturnType<typeof evaluateReadinessAlerts>;
  exitCode: number;
  client: MockClient;
}> {
  const config = completeConfig();
  const client = new MockClient(options);
  const readiness = await buildLoopReadiness({ config, owner, client, includeLiquidation: true });
  const alerts = evaluateReadinessAlerts(readiness, config.thresholds);
  const classification = classifyMonitoringOutcome({
    assessed: isMonitorAssessed(readiness),
    alerts,
  });
  return { readiness, alerts, exitCode: classification.exitCode, client };
}

function alertKeys(alerts: ReturnType<typeof evaluateReadinessAlerts>): string[] {
  return alerts.map((entry) => entry.alertKey);
}

// --- AC1: worked example (§2 anchor) -----------------------------------------

describe("SPEC005 liquidation readout", () => {
  it("AC1: worked example — HF 1.29, headroom 2900 bps, liq price ~0.81395e18", async () => {
    // collateral 10e18, price 1.05e36, debt 7e18, lltv 0.86e18.
    const { readiness } = await runMonitor({
      collateral: 10n * WAD,
      borrowShares: 7n * WAD,
      oraclePrice1e36: 1_050_000_000_000_000_000_000_000_000_000_000_000n, // 1.05e36
    });
    const liq = readiness.liquidation;
    expect(liq).not.toBeNull();
    if (liq === null) throw new Error("liquidation readout missing");
    expect(liq.healthFactor).toBeCloseTo(1.29, 5);
    expect(liq.debtGrowthHeadroomBps).toBe(2900);
    expect(liq.lltvBps).toBe(8600);
    // liquidation price ≈ 0.81395e18
    const liqPrice = liq.liquidationPriceDiemPerWstDiem;
    expect(liqPrice).not.toBeNull();
    if (liqPrice === null) throw new Error("liquidation price missing");
    expect(Number(liqPrice) / Number(WAD)).toBeCloseTo(0.81395, 4);
    expect(Number(liq.oraclePriceDiemPerWstDiem) / Number(WAD)).toBeCloseTo(1.05, 6);
    // Collateral-axis identity (E2): (HF-1)/HF == oracle-price-drop margin, within tolerance.
    const priceDropMargin = (1.05 - Number(liqPrice) / Number(WAD)) / 1.05;
    expect(priceDropMargin).toBeCloseTo((liq.healthFactor - 1) / liq.healthFactor, 3);
  });

  // --- AC2: CRITICAL → 30 ----------------------------------------------------

  it("AC2: HF < 1.40 with a real position → position_health_factor CRITICAL → exit 30", async () => {
    const { alerts, exitCode } = await runMonitor({
      collateral: 10n * WAD,
      borrowShares: 7n * WAD,
      oraclePrice1e36: 1_060_000_000_000_000_000_000_000_000_000_000_000n, // 1.06e36 → HF ≈ 1.30
    });
    expect(alertKeys(alerts)).toContain("position_health_factor");
    expect(alerts.find((a) => a.alertKey === "position_health_factor")?.level).toBe("CRITICAL");
    expect(exitCode).toBe(30);
  });

  // --- AC2b: normal 0 < HF < 1 (liquidatable WITH collateral) ≠ fault sentinel ---

  it("AC2b: 0 < HF < 1 with real collateral → position_health_factor CRITICAL (normal branch, not fault), exit 30", async () => {
    // collateral 10e18, price 0.5e36 (NAV 0.5), debt 7e18, lltv 0.86 → HF ≈ 0.614.
    // Already past liquidation, but collateral > 0 && lltv > 0 && price > 0, so this is the
    // NORMAL branch — a real liquidationPrice + negative headroom + position_health_factor
    // CRITICAL — NOT the collateral===0 fault sentinel. Locks that distinction.
    const { readiness, alerts, exitCode } = await runMonitor({
      collateral: 10n * WAD,
      borrowShares: 7n * WAD,
      oraclePrice1e36: 500_000_000_000_000_000_000_000_000_000_000_000n, // 0.5e36 → HF ≈ 0.614
    });
    expect(readiness.liquidation?.healthFactor).toBeLessThan(1);
    expect(readiness.liquidation?.healthFactor).toBeGreaterThan(0);
    // Normal branch: liquidation price is computed (non-null), headroom is negative.
    expect(readiness.liquidation?.liquidationPriceDiemPerWstDiem).not.toBeNull();
    expect(readiness.liquidation!.debtGrowthHeadroomBps).toBeLessThan(0);
    // Fires the health-factor CRITICAL, NOT the fault alert (proves the normal branch, not the sentinel).
    expect(alerts.find((a) => a.alertKey === "position_health_factor")?.level).toBe("CRITICAL");
    expect(alertKeys(alerts)).not.toContain("position_liquidation_fault");
    expect(exitCode).toBe(30);
  });

  // --- AC3: WARN → 10 --------------------------------------------------------

  it("AC3: HF in [1.40, 1.60) → position_health_factor WARN → exit 10 (not 30)", async () => {
    const { alerts, exitCode } = await runMonitor({
      collateral: 10n * WAD,
      borrowShares: 7n * WAD,
      oraclePrice1e36: 1_221_000_000_000_000_000_000_000_000_000_000_000n, // 1.221e36 → HF ≈ 1.50
    });
    const health = alerts.find((a) => a.alertKey === "position_health_factor");
    expect(health?.level).toBe("WARN");
    expect(exitCode).toBe(10);
  });

  // --- AC4: healthy resting position does NOT alarm (§3.1 calibration guard) --

  it("AC4: resting HF ~1.72 with a position → no position_health_factor alert → exit 0", async () => {
    const { readiness, alerts, exitCode } = await runMonitor({
      collateral: 10n * WAD,
      borrowShares: 7n * WAD,
      oraclePrice1e36: 1_400_000_000_000_000_000_000_000_000_000_000_000n, // 1.40e36 → HF ≈ 1.72
    });
    expect(readiness.liquidation?.healthFactor).toBeCloseTo(1.72, 2);
    expect(alertKeys(alerts)).not.toContain("position_health_factor");
    expect(alertKeys(alerts)).not.toContain("position_liquidation_fault");
    expect(exitCode).toBe(0);
  });

  // --- AC5: debt-free → null, no liquidation alert, not indeterminate --------

  it("AC5: borrowShares 0 → liquidation null, no liquidation alert, still assessed", async () => {
    const { readiness, alerts } = await runMonitor({ collateral: 5n * WAD, borrowShares: 0n });
    expect(readiness.liquidation).toBeNull();
    expect(alertKeys(alerts)).not.toContain("position_health_factor");
    expect(alertKeys(alerts)).not.toContain("position_liquidation_fault");
    expect(isMonitorAssessed(readiness)).toBe(true); // not forced indeterminate
  });

  // --- AC6a: oracle price 0 fault, not masked by a co-fired CRITICAL ---------

  it("AC6a: oraclePrice1e36 === 0 + co-fired curve_liquidity_empty → fault CRITICAL, exit 30", async () => {
    const { readiness, alerts, exitCode } = await runMonitor({
      collateral: 10n * WAD,
      borrowShares: 7n * WAD,
      oraclePrice1e36: 0n,
      curveLiquid: false,
    });
    expect(readiness.liquidation?.liquidationPriceDiemPerWstDiem).toBeNull();
    expect(readiness.liquidation?.oraclePriceDiemPerWstDiem).toBeNull();
    expect(alertKeys(alerts)).toContain("position_liquidation_fault");
    expect(alertKeys(alerts)).toContain("curve_liquidity_empty");
    expect(exitCode).toBe(30); // NOT masked to 20
  });

  // --- AC6b: lltv 0 fault (div-by-zero guard), not masked --------------------

  it("AC6b: lltvWad === 0 + co-fired curve_liquidity_empty → fault CRITICAL, exit 30 (no div-by-zero)", async () => {
    // If the price formula ran on the fault branch, lltvWad*collateral === 0 → bigint/0n
    // throws → rpc-read fail → 20, masking the co-fired CRITICAL. Reaching 30 proves it did not.
    const { readiness, alerts, exitCode } = await runMonitor({
      collateral: 10n * WAD,
      borrowShares: 7n * WAD,
      lltvWad: 0n,
      oraclePrice1e36: 1_050_000_000_000_000_000_000_000_000_000_000_000n,
      curveLiquid: false,
    });
    expect(readiness.liquidation?.liquidationPriceDiemPerWstDiem).toBeNull();
    expect(readiness.liquidation?.lltvBps).toBe(0);
    // rpc-read did NOT fail → the div-by-zero was never reached.
    expect(readiness.checks.some((c) => c.key === "rpc-read" && c.status === "fail")).toBe(false);
    expect(alertKeys(alerts)).toContain("position_liquidation_fault");
    expect(alertKeys(alerts)).toContain("curve_liquidity_empty");
    expect(exitCode).toBe(30);
  });

  // --- AC7: throwing oracle read → rpc-read fail → 20 ------------------------

  it("AC7: oracle.price() throws → rpc-read fail → not assessed → exit 20", async () => {
    const { readiness, exitCode } = await runMonitor({
      collateral: 10n * WAD,
      borrowShares: 7n * WAD,
      readFailureFunction: "price",
    });
    expect(readiness.checks.some((c) => c.key === "rpc-read" && c.status === "fail")).toBe(true);
    expect(isMonitorAssessed(readiness)).toBe(false);
    expect(exitCode).toBe(20);
  });

  // --- AC8: underwater/bad-debt → CRITICAL 30 (from owner reads only) --------

  it("AC8: collateral 0 && borrowShares > 0 → fault CRITICAL, exit 30, no owner-only WARN wins", async () => {
    const { readiness, alerts, exitCode } = await runMonitor({
      collateral: 0n,
      borrowShares: 7n * WAD,
      oraclePrice1e36: 1_050_000_000_000_000_000_000_000_000_000_000_000n,
    });
    expect(readiness.liquidation?.healthFactor).toBe(0);
    expect(readiness.liquidation?.debtGrowthHeadroomBps).toBe(-10000);
    expect(readiness.liquidation?.liquidationPriceDiemPerWstDiem).toBeNull();
    expect(alertKeys(alerts)).toContain("position_liquidation_fault");
    expect(alerts.find((a) => a.alertKey === "position_liquidation_fault")?.level).toBe("CRITICAL");
    // owner_position_missing WARN may co-exist, but CRITICAL wins → 30 (not 10), no throw.
    expect(exitCode).toBe(30);
  });

  // --- AC9: --json parity + bigint string serialization ---------------------

  it("AC9: liquidation bigint prices serialize as strings via stringifyJson", async () => {
    const { readiness } = await runMonitor({
      collateral: 10n * WAD,
      borrowShares: 7n * WAD,
      oraclePrice1e36: 1_050_000_000_000_000_000_000_000_000_000_000_000n,
    });
    const parsed = JSON.parse(stringifyJson({ readiness })) as {
      readiness: {
        liquidation: {
          healthFactor: number;
          debtGrowthHeadroomBps: number;
          lltvBps: number;
          liquidationPriceDiemPerWstDiem: unknown;
          oraclePriceDiemPerWstDiem: unknown;
        };
      };
    };
    const liq = parsed.readiness.liquidation;
    expect(typeof liq.liquidationPriceDiemPerWstDiem).toBe("string");
    expect(typeof liq.oraclePriceDiemPerWstDiem).toBe("string");
    expect(typeof liq.healthFactor).toBe("number");
    expect(typeof liq.debtGrowthHeadroomBps).toBe("number");
    expect(typeof liq.lltvBps).toBe("number");
  });

  // --- AC10: status honesty — HF n/a, never Infinity ------------------------

  it("AC10: renderStatusTable shows 'n/a (run monitor)', never 'HF Infinity'", () => {
    const rendered = renderStatusTable(makeEmptySnapshot(), []);
    expect(rendered).toContain("n/a (run monitor)");
    expect(rendered).not.toContain("HF Infinity");
  });

  // --- AC11: loop readiness untouched — no oracle/lltv read, liquidation null -

  it("AC11: buildLoopReadiness without includeLiquidation issues no oracle/lltv read", async () => {
    const config = completeConfig();
    const client = new MockClient({
      collateral: 10n * WAD,
      borrowShares: 7n * WAD,
      oraclePrice1e36: 1_050_000_000_000_000_000_000_000_000_000_000_000n,
    });
    const readiness = await buildLoopReadiness({ config, owner, client }); // flag OFF
    expect(readiness.liquidation).toBeNull();
    const fns = client.reads.map((r) => r.functionName);
    expect(fns).not.toContain("idToMarketParams");
    expect(fns).not.toContain("price");
    // No new liquidation check row added to the strict-evidence check set.
    expect(readiness.checks.some((c) => c.key.includes("liquidation"))).toBe(false);
  });

  // --- AC12: block-pinning ---------------------------------------------------

  it("AC12: idToMarketParams and oracle price reads are pinned to the position block", async () => {
    const { client } = await runMonitor({
      collateral: 10n * WAD,
      borrowShares: 7n * WAD,
      oraclePrice1e36: 1_050_000_000_000_000_000_000_000_000_000_000_000n,
    });
    const gated = client.reads.filter(
      (r) => r.functionName === "idToMarketParams" || r.functionName === "price",
    );
    expect(gated.length).toBeGreaterThanOrEqual(2);
    expect(gated.every((r) => r.blockNumber === 456n)).toBe(true);
    // Every read in the readiness build is pinned to the same block (no TOCTOU).
    expect(client.reads.every((r) => r.blockNumber === 456n)).toBe(true);
  });
});
