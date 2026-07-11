import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import {
  assertFromChainCompatibleOptions,
  buildFromChainSizingReport,
  loadVaultApyWindow,
  MIN_VAULT_APY_WINDOW_SAMPLES,
  seedFromChain,
  type FromChainExplicitFlags,
  type FromChainSeedClient,
  type VaultApyWindowStore,
} from "../src/loop/fromChainSeed.js";
import { perSecWadToAprBps } from "../src/loop/morphoRate.js";
import { renderLoopSizingTable } from "../src/cli/output.js";
import { buildLoopSizingReport } from "../src/loop/sizing.js";
import { buildLoopSizingScenarios } from "../src/loop/sizingScenarios.js";
import type { CreditWindowSample, VaultAssetWindowSample } from "../src/metrics/collector.js";
import { WAD } from "../src/metrics/math.js";
import type { Address, AppConfig, Hex } from "../src/types/domain.js";

const NO_EXPLICIT: FromChainExplicitFlags = {
  rateAtTargetApyBps: false,
  morphoSupplyDiem: false,
  morphoExistingBorrowDiem: false,
};

/** The verified 2026-07-11 on-chain per-second WAD reading (rateAtTarget => 217 bps). */
const LIVE_RATE_AT_TARGET_PER_SEC_WAD = 686_605_546n;

interface MockOptions {
  chainId?: number;
  latestBlock?: bigint;
  rateAtTargetPerSecWad?: bigint;
  marketSupply?: bigint;
  marketBorrow?: bigint;
  revertFunction?: string;
  getChainIdThrows?: boolean;
  codelessAddresses?: Address[];
  // Part B-1 curve reads. `curveDiemBalance` = balances(0); `curveWstDiemBalance` = balances(1)
  // raw shares. `vaultNavBps` sets the wstDIEM→DIEM NAV: convertToAssets(x) = x × nav/10000,
  // convertToShares(x) = x × 10000/nav (default 10000 = identity, so existing tests are unchanged).
  // `getDyOutRateBps` sets get_dy(dx) = convertToAssets(dx) × rate/10000 — 10000 (default) is a
  // lossless quote (0 bps impact regardless of NAV), lower values model a real exit price impact.
  curveDiemBalance?: bigint;
  curveWstDiemBalance?: bigint;
  vaultNavBps?: number;
  getDyOutRateBps?: number;
  // Part B-2 vault reads used by `collectVaultMetrics` (block-pinning EXEMPT). `vaultAsset` must
  // equal DIEM for `validity.vault` to hold; leaving it unset returns the zero address (a mismatch
  // → validity.vault false, no current sample appended).
  vaultAsset?: Address;
  vaultTotalAssets?: bigint;
  vaultTotalSupply?: bigint;
}

const DEFAULT_CURVE_LEG_RAW = 1_000_000n * WAD;

class MockSeedClient implements FromChainSeedClient {
  readonly readBlockNumbers: Array<bigint | undefined> = [];
  readonly readFunctions: string[] = [];
  /** Every `dx` (wstDIEM shares) passed to `get_dy`, to prove the exit is share-denominated. */
  readonly readGetDyDx: bigint[] = [];

  constructor(private readonly options: MockOptions = {}) {}

  async getChainId(): Promise<number> {
    if (this.options.getChainIdThrows) {
      throw new Error("rpc down");
    }
    return this.options.chainId ?? 8453;
  }

  async getBlockNumber(): Promise<bigint> {
    return this.options.latestBlock ?? 999n;
  }

  async getCode(address: Address): Promise<Hex> {
    const codeless = this.options.codelessAddresses?.some(
      (entry) => entry.toLowerCase() === address.toLowerCase(),
    );
    return codeless ? "0x" : "0x01";
  }

  async readContract(args: {
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }): Promise<unknown> {
    this.readBlockNumbers.push(args.blockNumber);
    this.readFunctions.push(args.functionName);
    if (args.functionName === this.options.revertFunction) {
      throw new Error(`forced ${args.functionName} revert`);
    }
    if (args.functionName === "rateAtTarget") {
      return this.options.rateAtTargetPerSecWad ?? LIVE_RATE_AT_TARGET_PER_SEC_WAD;
    }
    if (args.functionName === "market") {
      return [
        this.options.marketSupply ?? 2_000n * WAD,
        0n,
        this.options.marketBorrow ?? 500n * WAD,
        0n,
        0n,
        0n,
      ];
    }
    if (args.functionName === "balances") {
      const index = BigInt(args.args?.[0] as bigint);
      return index === 0n
        ? (this.options.curveDiemBalance ?? DEFAULT_CURVE_LEG_RAW)
        : (this.options.curveWstDiemBalance ?? DEFAULT_CURVE_LEG_RAW);
    }
    // NAV-aware conversions (default nav 10000 = identity). convertToAssets values shares in DIEM;
    // convertToShares inverts it. A non-identity nav makes shares ≠ assets, so a regression that
    // fed the DIEM notional straight into get_dy's dx (skipping convertToShares) would be caught.
    const navBps = BigInt(this.options.vaultNavBps ?? 10_000);
    if (args.functionName === "convertToAssets") {
      return (BigInt(args.args?.[0] as bigint) * navBps) / 10_000n;
    }
    if (args.functionName === "convertToShares") {
      return (BigInt(args.args?.[0] as bigint) * 10_000n) / navBps;
    }
    if (args.functionName === "get_dy") {
      const dx = BigInt(args.args?.[2] as bigint);
      this.readGetDyDx.push(dx);
      // Quote in DIEM: value the wstDIEM dx at NAV, then apply the exit rate. Keeps priceImpact =
      // (10000 - getDyOutRateBps) bps independent of NAV, so rate-based assertions are stable.
      const expectedDiemOut = (dx * navBps) / 10_000n;
      return (expectedDiemOut * BigInt(this.options.getDyOutRateBps ?? 10_000)) / 10_000n;
    }
    // Part B-2 vault reads (collectVaultMetrics). Only reached when a store is supplied.
    if (args.functionName === "asset") {
      return this.options.vaultAsset ?? ZERO_ADDRESS;
    }
    if (args.functionName === "totalAssets") {
      return this.options.vaultTotalAssets ?? 0n;
    }
    if (args.functionName === "totalSupply") {
      return this.options.vaultTotalSupply ?? 0n;
    }
    throw new Error(`unexpected readContract ${args.functionName}`);
  }
}

function baseConfig(): AppConfig {
  return DEFAULT_CONFIG;
}

const ZERO_ADDRESS = `0x${"0".repeat(40)}` as Address;

/** A client whose every method throws — proves a caller never touched the network. */
class ThrowingSeedClient implements FromChainSeedClient {
  async getChainId(): Promise<number> {
    throw new Error("network touched: getChainId");
  }

  async getBlockNumber(): Promise<bigint> {
    throw new Error("network touched: getBlockNumber");
  }

  async getCode(): Promise<Hex> {
    throw new Error("network touched: getCode");
  }

  async readContract(): Promise<unknown> {
    throw new Error("network touched: readContract");
  }
}

const DAY_SECONDS = 24 * 60 * 60;

/**
 * A fake `VaultApyWindowStore` that builds its samples RELATIVE to the `windowStart` it is called
 * with (which the adapter derives from `Date.now()`), so tests never race the wall clock. Records
 * call counts to prove the adapter is (not) consulted.
 */
class FakeVaultApyStore implements VaultApyWindowStore {
  vaultCalls = 0;
  creditCalls = 0;

  constructor(
    private readonly vaultSamples: (windowStart: number) => VaultAssetWindowSample[],
    private readonly creditSamples: (windowStart: number) => CreditWindowSample[] = () => [],
  ) {}

  listVaultAssetSamplesForWindow(windowStart: number): VaultAssetWindowSample[] {
    this.vaultCalls += 1;
    return this.vaultSamples(windowStart);
  }

  listCreditSamplesSince(ts: number): CreditWindowSample[] {
    this.creditCalls += 1;
    return this.creditSamples(ts);
  }
}

/**
 * A constant-value vault-asset window: an anchor at/before `windowStart` plus `inWindowCount`
 * points across the 7 days, all `assetsDiem`. A constant series makes the time-weighted average
 * exactly `assetsDiem` regardless of spacing — so `computeBaseApy` reduces to `credit/assets ×
 * 365/7`, keeping the magnitude assertions arithmetic-clean.
 */
function constantVaultWindow(
  assetsDiem: bigint,
  inWindowCount: number,
): (windowStart: number) => VaultAssetWindowSample[] {
  return (windowStart: number) => {
    const samples: VaultAssetWindowSample[] = [
      { timestamp: windowStart - 10, totalAssetsDiem: assetsDiem },
    ];
    for (let i = 1; i <= inWindowCount; i += 1) {
      samples.push({ timestamp: windowStart + i * DAY_SECONDS, totalAssetsDiem: assetsDiem });
    }
    return samples;
  };
}

describe("loop sizing --from-chain (SPEC003 Part A)", () => {
  // Criterion 1 — durable conversion + a direct read seeds the live rate.
  it("converts the verified per-second WAD reading to 217 bps and seeds it as direct", async () => {
    expect(perSecWadToAprBps(686_605_546n)).toBe(217);

    const { seeds, provenance } = await seedFromChain({
      config: baseConfig(),
      client: new MockSeedClient({
        marketSupply: 2_000n * WAD,
        marketBorrow: 500n * WAD,
      }),
    });

    expect(seeds.rateAtTargetApyBps).toBe(217);
    expect(seeds.morphoSupplyDiem).toBe(2_000n * WAD);
    expect(seeds.morphoExistingBorrowDiem).toBe(500n * WAD);
    expect(provenance.rateAtTargetSource).toBe("direct");
    expect(provenance.authoritative).toBe(true);
    expect(provenance.chainId).toBe(8453);
  });

  // Criterion 2 — rateAtTarget == 0 is fail-closed to the genesis default, NOT clamp-to-10.
  it("treats rateAtTarget == 0 as uninitialized-default (400 bps), not a clamp to 10", async () => {
    const { seeds, provenance } = await seedFromChain({
      config: baseConfig(),
      client: new MockSeedClient({ rateAtTargetPerSecWad: 0n }),
    });

    expect(seeds.rateAtTargetApyBps).toBe(400);
    expect(seeds.rateAtTargetApyBps).not.toBe(10);
    expect(provenance.rateAtTargetSource).toBe("uninitialized-default");
    expect(provenance.authoritative).toBe(false);
    expect(provenance.warnings.join(" ")).toContain("uninitialized");
  });

  // Criterion 3 — non-zero results clamp to [10, 20000] in both directions.
  it("clamps a non-zero rate above the max down to 20000 bps", async () => {
    // A per-second WAD that decodes well above 200% APR.
    const hugePerSecWad = (30_000n * WAD) / (10_000n * 31_536_000n);
    const { seeds, provenance } = await seedFromChain({
      config: baseConfig(),
      client: new MockSeedClient({ rateAtTargetPerSecWad: hugePerSecWad }),
    });

    expect(perSecWadToAprBps(hugePerSecWad)).toBeGreaterThan(20_000);
    expect(seeds.rateAtTargetApyBps).toBe(20_000);
    expect(provenance.rateAtTargetSource).toBe("direct");
    expect(provenance.authoritative).toBe(true);
  });

  it("clamps a non-zero rate below the min up to 10 bps (never absorbing it as 0)", async () => {
    const tinyPerSecWad = (5n * WAD) / (10_000n * 31_536_000n);
    expect(tinyPerSecWad).toBeGreaterThan(0n);
    const { seeds } = await seedFromChain({
      config: baseConfig(),
      client: new MockSeedClient({ rateAtTargetPerSecWad: tinyPerSecWad }),
    });

    expect(seeds.rateAtTargetApyBps).toBe(10);
  });

  // Criterion 4 — fail-closed matrix: RPC down / chainId!=8453 / market revert / supply==0 / marketId null.
  it("fails closed when the RPC is unavailable", async () => {
    await expect(
      seedFromChain({ config: baseConfig(), client: new MockSeedClient({ getChainIdThrows: true }) }),
    ).rejects.toMatchObject({ code: "FROM_CHAIN_SEED_BLOCKED" });
  });

  it("fails closed on the wrong chainId", async () => {
    await expect(
      seedFromChain({ config: baseConfig(), client: new MockSeedClient({ chainId: 1 }) }),
    ).rejects.toMatchObject({ code: "FROM_CHAIN_SEED_BLOCKED" });
  });

  it("fails closed when the market read reverts", async () => {
    await expect(
      seedFromChain({
        config: baseConfig(),
        client: new MockSeedClient({ revertFunction: "market" }),
      }),
    ).rejects.toMatchObject({ code: "FROM_CHAIN_SEED_BLOCKED" });
  });

  it("fails closed when totalSupplyAssets == 0 (empty market)", async () => {
    await expect(
      seedFromChain({
        config: baseConfig(),
        client: new MockSeedClient({ marketSupply: 0n }),
      }),
    ).rejects.toMatchObject({ code: "FROM_CHAIN_SEED_BLOCKED" });
  });

  it("fails closed when marketId is null", async () => {
    const config: AppConfig = { ...baseConfig(), morpho: { ...baseConfig().morpho, marketId: null } };
    await expect(
      seedFromChain({ config, client: new MockSeedClient() }),
    ).rejects.toMatchObject({ code: "FROM_CHAIN_SEED_BLOCKED" });
  });

  // SPEC003 §2 address validation: the AdaptiveCurveIrm and Morpho contracts must be
  // nonzero AND have code before any seed read is attempted.
  it("fails closed with a clear message when the AdaptiveCurveIrm address has no deployed code", async () => {
    const config = baseConfig();
    await expect(
      seedFromChain({
        config,
        client: new MockSeedClient({ codelessAddresses: [config.contracts.adaptiveCurveIrm] }),
      }),
    ).rejects.toMatchObject({
      code: "FROM_CHAIN_SEED_BLOCKED",
      message: `adaptiveCurveIrm address ${config.contracts.adaptiveCurveIrm} has no code`,
    });
  });

  it("fails closed with a clear message when the Morpho Blue address has no deployed code", async () => {
    const config = baseConfig();
    await expect(
      seedFromChain({
        config,
        client: new MockSeedClient({ codelessAddresses: [config.contracts.morphoBlue] }),
      }),
    ).rejects.toMatchObject({
      code: "FROM_CHAIN_SEED_BLOCKED",
      message: `morphoBlue address ${config.contracts.morphoBlue} has no code`,
    });
  });

  it("fails closed when the AdaptiveCurveIrm address is the zero address (no getCode read needed)", async () => {
    const config: AppConfig = {
      ...baseConfig(),
      contracts: { ...baseConfig().contracts, adaptiveCurveIrm: ZERO_ADDRESS },
    };
    await expect(
      seedFromChain({ config, client: new MockSeedClient() }),
    ).rejects.toMatchObject({
      code: "FROM_CHAIN_SEED_BLOCKED",
      message: `adaptiveCurveIrm address ${ZERO_ADDRESS} has no code`,
    });
  });

  // Criterion 7 — the on-chain reads share one pinned block; a planning-block pins to that block.
  it("pins both on-chain reads to the one resolved latest block", async () => {
    const client = new MockSeedClient({ latestBlock: 12_345n });
    await seedFromChain({ config: baseConfig(), client });

    expect(client.readBlockNumbers).toHaveLength(2);
    expect(client.readBlockNumbers.every((block) => block === 12_345n)).toBe(true);
  });

  it("pins both on-chain reads to an explicit planning block", async () => {
    const client = new MockSeedClient({ latestBlock: 12_345n });
    const { provenance } = await seedFromChain({
      config: baseConfig(),
      client,
      planningBlock: 42n,
    });

    expect(provenance.blockNumber).toBe(42n);
    expect(client.readBlockNumbers.every((block) => block === 42n)).toBe(true);
  });

  // Criterion 5 — flat model conflicts with the adaptive-rate seed.
  it("errors on --from-chain with the flat borrow-rate model", async () => {
    await expect(
      buildFromChainSizingReport({
        config: baseConfig(),
        client: new MockSeedClient(),
        options: { borrowRateModel: "flat" },
        explicitFlags: NO_EXPLICIT,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "--from-chain seeds the adaptive rate; pass --borrow-apy-bps for the flat model",
    });
  });

  // Criterion 13 (Part A guard) — the current-zero preset conflicts with seeded supply.
  it("errors on --from-chain with --preset current-zero", async () => {
    await expect(
      buildFromChainSizingReport({
        config: baseConfig(),
        client: new MockSeedClient(),
        options: { preset: "current-zero" },
        explicitFlags: NO_EXPLICIT,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  // Criterion 6 — an explicit flag overrides the chain seed and still marks the field "flag".
  it("lets an explicit --morpho-supply-diem flag override the chain seed", async () => {
    const report = await buildFromChainSizingReport({
      config: baseConfig(),
      client: new MockSeedClient({ marketSupply: 2_000n * WAD }),
      options: { initialDiem: "100", targetLeverage: "1.5", morphoSupplyDiem: "100" },
      explicitFlags: { ...NO_EXPLICIT, morphoSupplyDiem: true },
    });

    expect(report.seedProvenance?.seededFields.morphoSupplyDiem).toBe("flag");
    expect(report.seedProvenance?.seededFields.rateAtTargetApyBps).toBe("chain");
    expect(report.results.every((result) => result.scenario.morphoSupplyDiem === 100n * WAD)).toBe(
      true,
    );
  });

  it("seeds the chain value when the flag is absent", async () => {
    const report = await buildFromChainSizingReport({
      config: baseConfig(),
      client: new MockSeedClient({ marketSupply: 2_000n * WAD, marketBorrow: 500n * WAD }),
      options: { initialDiem: "100", targetLeverage: "1.5", curveDepthDiem: "10000" },
      explicitFlags: NO_EXPLICIT,
    });

    expect(report.seedProvenance?.seededFields.morphoSupplyDiem).toBe("chain");
    expect(report.seedProvenance?.seededFields.morphoExistingBorrowDiem).toBe("chain");
    expect(report.results.every((result) => result.scenario.morphoSupplyDiem === 2_000n * WAD)).toBe(
      true,
    );
    expect(
      report.results.every((result) => result.scenario.morphoExistingBorrowDiem === 500n * WAD),
    ).toBe(true);
    // rateAtTarget 217 seeded (single point), so the adaptive borrow reference reflects it.
    expect(report.results.every((result) => result.scenario.rateAtTargetApyBps === 217)).toBe(true);
  });

  // Criterion 6 (completed) — an explicit --rate-at-target-apy-bps AND an explicit
  // --morpho-existing-borrow-diem each independently override their chain seed, while the
  // unflagged dim (Morpho supply) stays chain-seeded.
  it("lets explicit --rate-at-target-apy-bps and --morpho-existing-borrow-diem flags override their chain seeds", async () => {
    const report = await buildFromChainSizingReport({
      config: baseConfig(),
      client: new MockSeedClient({ marketSupply: 2_000n * WAD, marketBorrow: 500n * WAD }),
      options: {
        initialDiem: "100",
        targetLeverage: "1.5",
        curveDepthDiem: "10000",
        rateAtTargetApyBps: "999",
        morphoExistingBorrowDiem: "42",
      },
      explicitFlags: {
        rateAtTargetApyBps: true,
        morphoSupplyDiem: false,
        morphoExistingBorrowDiem: true,
      },
    });

    expect(report.seedProvenance?.seededFields).toMatchObject({
      rateAtTargetApyBps: "flag",
      morphoExistingBorrowDiem: "flag",
      morphoSupplyDiem: "chain",
    });
    expect(report.results.every((result) => result.scenario.rateAtTargetApyBps === 999)).toBe(true);
    expect(
      report.results.every((result) => result.scenario.morphoExistingBorrowDiem === 42n * WAD),
    ).toBe(true);
    // The unflagged dim is still chain-seeded from the live market read.
    expect(report.results.every((result) => result.scenario.morphoSupplyDiem === 2_000n * WAD)).toBe(
      true,
    );
  });

  // Criterion 8 — a degraded seed demotes the DISPLAYED verdict token, gate status intact.
  it("degrades the verdict token to a candidate when the seed is not authoritative", async () => {
    const report = await buildFromChainSizingReport({
      config: baseConfig(),
      client: new MockSeedClient({ rateAtTargetPerSecWad: 0n, marketSupply: 100_000n * WAD }),
      options: {
        initialDiem: "100",
        targetLeverage: "1.5",
        // rev-2 re-baseline: total 20000 (balanced legs 10000) keeps exit slip at 154 bps < cap
        // so this scenario stays viable and the verdict-token (de)promotion has a viable to act on.
        curveDepthDiem: "20000",
        vaultApyBps: "1500",
      },
      explicitFlags: NO_EXPLICIT,
    });

    expect(report.authoritative).toBe(false);
    // The underlying gate status is untouched — the scenario still evaluates as viable.
    expect(report.summary.viable).toBe(1);
    const viable = report.results.find((result) => result.status === "viable");
    expect(viable).toBeDefined();

    const rendered = renderLoopSizingTable(report);
    expect(rendered).toContain("candidate — unverified seed");
    expect(rendered).toContain("UNVERIFIED SEED");
    expect(rendered).toContain("seeded from block");
  });

  it("keeps the authoritative verdict token when the seed is direct", async () => {
    const report = await buildFromChainSizingReport({
      config: baseConfig(),
      client: new MockSeedClient({ marketSupply: 100_000n * WAD }),
      options: {
        initialDiem: "100",
        targetLeverage: "1.5",
        // rev-2 re-baseline: total 20000 (balanced legs 10000) keeps exit slip at 154 bps < cap
        // so this scenario stays viable and the verdict-token (de)promotion has a viable to act on.
        curveDepthDiem: "20000",
        vaultApyBps: "1500",
      },
      explicitFlags: NO_EXPLICIT,
    });

    expect(report.authoritative).toBe(true);
    const rendered = renderLoopSizingTable(report);
    expect(rendered).not.toContain("candidate — unverified seed");
    expect(rendered).not.toContain("UNVERIFIED SEED");
    expect(rendered).toContain("seeded from block");
  });

  // Criterion 9 — a seeded report still evaluates every gate and keeps the SPEC002 envelope shape.
  it("conforms to the SPEC002 output contract with seeded inputs", async () => {
    const report = await buildFromChainSizingReport({
      config: baseConfig(),
      client: new MockSeedClient({ marketSupply: 2_000n * WAD, marketBorrow: 500n * WAD }),
      options: { initialDiem: "100", targetLeverage: "1.5,2,3", curveDepthDiem: "0,1000,10000" },
      explicitFlags: NO_EXPLICIT,
    });

    expect(report.assumptions).toMatchObject({
      readOnly: true,
      broadcastAvailable: false,
      auditRequired: true,
      borrowRateModel: "adaptive-curve-instantaneous",
    });
    expect(report.results.length).toBeGreaterThan(0);
    for (const result of report.results) {
      // Every economic field is populated even when blocked (SPEC002 §7.3).
      expect(typeof result.positionCollateralDiem).toBe("bigint");
      expect(typeof result.borrowAmountDiem).toBe("bigint");
      expect(typeof result.netApyBps).toBe("number");
      expect(typeof result.postDrawUtilizationBps).toBe("number");
      expect(Array.isArray(result.blockers)).toBe(true);
    }
    expect(report.seedProvenance).toBeDefined();
    expect(report.seedProvenance?.blockNumber).toBe(999n);
  });

  // The offline (non-seeded) render is unchanged — no provenance section leaks in.
  it("does not add a seed-provenance section to an offline report", () => {
    const report = buildLoopSizingReport(
      buildLoopSizingScenarios(baseConfig(), { initialDiem: "100", targetLeverage: "1.5" }),
    );
    const rendered = renderLoopSizingTable(report);
    expect(rendered).not.toContain("Seed provenance");
    expect(rendered).not.toContain("UNVERIFIED SEED");
  });

  // --preset liquidity-sweep is explicitly allowed: the chain-seeded Morpho supply collapses
  // to a single point while curve depth (not seeded by Part A) keeps sweeping.
  it("--preset liquidity-sweep: Morpho supply collapses to the chain seed while curve depth still sweeps", async () => {
    const report = await buildFromChainSizingReport({
      config: baseConfig(),
      client: new MockSeedClient({ marketSupply: 2_000n * WAD, marketBorrow: 500n * WAD }),
      options: { initialDiem: "100", targetLeverage: "1.5", preset: "liquidity-sweep" },
      explicitFlags: NO_EXPLICIT,
    });

    expect(report.seedProvenance?.seededFields.morphoSupplyDiem).toBe("chain");
    const distinctSupply = new Set(report.results.map((result) => result.scenario.morphoSupplyDiem));
    expect(distinctSupply).toEqual(new Set([2_000n * WAD]));

    const distinctCurveDepth = new Set(
      report.results.map(
        (result) => result.scenario.curveDiemLegDiem + result.scenario.curveWstDiemLegDiem,
      ),
    );
    expect(distinctCurveDepth.size).toBeGreaterThan(1);
  });
});

describe("loop sizing --from-chain (SPEC003 Part B-1: curve legs + get_dy exit slippage)", () => {
  // Acceptance 12 — direction-correct: a fat-DIEM-leg pool exiting is NOT over-blocked. A
  // direction-blind `2×min(leg)` heuristic would penalize the tiny wstDIEM leg; the live get_dy
  // quote prices the actual exit and keeps the scenario off the exit-slippage gate.
  it("does not over-block a fat-DIEM-leg exit and sources exit slippage from get_dy", async () => {
    const report = await buildFromChainSizingReport({
      config: baseConfig(),
      client: new MockSeedClient({
        marketSupply: 100_000n * WAD,
        curveDiemBalance: 1_000_000n * WAD, // fat DIEM leg (the leg the exit draws)
        curveWstDiemBalance: 1_000n * WAD, // thin wstDIEM leg
        getDyOutRateBps: 9_950, // a healthy quote: 50 bps exit impact
      }),
      options: { initialDiem: "100", targetLeverage: "1.5", vaultApyBps: "1500" },
      explicitFlags: NO_EXPLICIT,
    });

    expect(report.results).toHaveLength(1);
    const result = report.results[0];
    expect(result.exitSlippageSource).toBe("get_dy");
    // Injected impact is the live 50 bps, well under the 300 bps cap — not over-blocked.
    expect(result.exitSlippageBps).toBe(50);
    expect(result.exitSlippageBps).toBeLessThanOrEqual(result.scenario.maxSlippageBps);
    expect(result.blockers).not.toContain("curve_liquidity_insufficient");
    // The seeded legs are recorded in provenance (DIEM-denominated).
    expect(report.seedProvenance?.curveDiemLegDiem).toBe(1_000_000n * WAD);
    expect(report.seedProvenance?.curveWstDiemLegDiem).toBe(1_000n * WAD);
  });

  // Acceptance 12 — both legs zero → fail-closed (empty pool), no partial report.
  it("fails closed when both Curve legs are zero", async () => {
    await expect(
      buildFromChainSizingReport({
        config: baseConfig(),
        client: new MockSeedClient({
          curveDiemBalance: 0n,
          curveWstDiemBalance: 0n,
        }),
        options: { initialDiem: "100", targetLeverage: "1.5" },
        explicitFlags: NO_EXPLICIT,
      }),
    ).rejects.toMatchObject({ code: "FROM_CHAIN_SEED_BLOCKED" });
  });

  it("fails closed when a Curve balances read reverts", async () => {
    await expect(
      buildFromChainSizingReport({
        config: baseConfig(),
        client: new MockSeedClient({ revertFunction: "balances" }),
        options: { initialDiem: "100", targetLeverage: "1.5" },
        explicitFlags: NO_EXPLICIT,
      }),
    ).rejects.toMatchObject({ code: "FROM_CHAIN_SEED_BLOCKED" });
  });

  // §2 address validation parity — a codeless curvePool fails closed with a clear message
  // (before any balances read) rather than relying on the raw read to revert.
  it("fails closed with a clear message when the curvePool address has no deployed code", async () => {
    const config = baseConfig();
    expect(config.contracts.curvePool).not.toBeNull();
    await expect(
      seedFromChain({
        config,
        client: new MockSeedClient({ codelessAddresses: [config.contracts.curvePool as Address] }),
        seedCurve: true,
      }),
    ).rejects.toMatchObject({
      code: "FROM_CHAIN_SEED_BLOCKED",
      message: `curvePool address ${config.contracts.curvePool} has no code`,
    });
  });

  // §6 imbalance demotion — a > 2:1 pool degrades the verdict token even though its rate seed is a
  // clean direct read (authoritative would otherwise be true).
  it("demotes the verdict when the Curve legs are more than 2:1 imbalanced", async () => {
    const report = await buildFromChainSizingReport({
      config: baseConfig(),
      client: new MockSeedClient({
        marketSupply: 100_000n * WAD,
        curveDiemBalance: 30_000n * WAD,
        curveWstDiemBalance: 10_000n * WAD, // ratio 3:1 > 2.0 threshold (deep enough to stay viable)
      }),
      options: { initialDiem: "100", targetLeverage: "1.5", vaultApyBps: "1500" },
      explicitFlags: NO_EXPLICIT,
    });

    // The rate seed is a clean direct read, so ONLY the imbalance can have flipped this.
    expect(report.seedProvenance?.rateAtTargetSource).toBe("direct");
    expect(report.authoritative).toBe(false);
    expect(report.seedProvenance?.curveImbalanceRatio).toBe(3);
    expect(report.seedProvenance?.warnings.join(" ")).toContain("imbalanced");

    const rendered = renderLoopSizingTable(report);
    expect(rendered).toContain("candidate — unverified seed");
    expect(rendered).toContain("UNVERIFIED SEED");
  });

  it("keeps the verdict authoritative for a balanced pool with a clean rate seed", async () => {
    const report = await buildFromChainSizingReport({
      config: baseConfig(),
      client: new MockSeedClient({ marketSupply: 100_000n * WAD }),
      options: { initialDiem: "100", targetLeverage: "1.5", vaultApyBps: "1500" },
      explicitFlags: NO_EXPLICIT,
    });

    expect(report.authoritative).toBe(true);
    expect(report.seedProvenance?.curveImbalanceRatio).toBe(1);
    expect(report.seedProvenance?.seededFields.curveDepthDiem).toBe("chain");
    const rendered = renderLoopSizingTable(report);
    expect(rendered).not.toContain("candidate — unverified seed");
  });

  // §5 precedence — an explicit curve-leg flag wins: the curve is NOT chain-seeded and NO get_dy
  // quote is injected (mixing a swept/hypothetical leg with one real get_dy would be inconsistent).
  it("does not chain-seed the curve when an explicit --curve-diem-leg flag is given", async () => {
    const client = new MockSeedClient({ marketSupply: 100_000n * WAD });
    const report = await buildFromChainSizingReport({
      config: baseConfig(),
      client,
      options: { initialDiem: "100", targetLeverage: "1.5", curveDiemLeg: "5000" },
      explicitFlags: { ...NO_EXPLICIT, curveDiemLeg: true },
    });

    expect(report.seedProvenance?.seededFields.curveDepthDiem).toBe("flag");
    expect(report.seedProvenance?.curveDiemLegDiem).toBeUndefined();
    // No curve or get_dy read happened, and every scenario keeps the estimate source.
    expect(client.readFunctions).not.toContain("balances");
    expect(client.readFunctions).not.toContain("get_dy");
    expect(report.results.every((result) => result.exitSlippageSource === "estimate")).toBe(true);
  });

  // Criterion 7 (extended to Part B-1) — the curve balances, convertToAssets, convertToShares and
  // get_dy reads all share the one pinned block with the rate/market reads.
  it("pins every curve and get_dy read to the one resolved block", async () => {
    const client = new MockSeedClient({ latestBlock: 7_654n, marketSupply: 100_000n * WAD });
    await buildFromChainSizingReport({
      config: baseConfig(),
      client,
      options: { initialDiem: "100", targetLeverage: "1.5,2" },
      explicitFlags: NO_EXPLICIT,
    });

    // Proves the new reads actually ran (curve legs + a live exit quote) …
    expect(client.readFunctions).toContain("balances");
    expect(client.readFunctions).toContain("convertToShares");
    expect(client.readFunctions).toContain("get_dy");
    // … and every read (Part A + Part B-1) is pinned to the same block.
    expect(client.readBlockNumbers.every((block) => block === 7_654n)).toBe(true);
  });

  // §4.2 memoization — a grid sweeping only leverage (2 distinct position sizes) reads
  // convertToShares/get_dy once per distinct size, not once per scenario.
  it("memoizes the get_dy injection by distinct position size", async () => {
    const client = new MockSeedClient({ marketSupply: 100_000n * WAD });
    await buildFromChainSizingReport({
      config: baseConfig(),
      client,
      // 3 leverages × 1 initial = 3 scenarios, but 3 distinct position sizes here.
      options: { initialDiem: "100", targetLeverage: "1.5,2,3" },
      explicitFlags: NO_EXPLICIT,
    });

    const convertToSharesReads = client.readFunctions.filter(
      (fn) => fn === "convertToShares",
    ).length;
    const getDyReads = client.readFunctions.filter((fn) => fn === "get_dy").length;
    expect(convertToSharesReads).toBe(3);
    expect(getDyReads).toBe(3);
  });

  // §4.2 denomination — the exit sells wstDIEM SHARES, so the amount fed to get_dy must be
  // convertToShares(positionCollateral), NOT the DIEM notional. Under a 2:1 NAV shares ≠ assets,
  // so this fails loudly if a regression ever skips convertToShares and passes the notional.
  it("feeds get_dy the share-denominated exit amount, not the DIEM notional", async () => {
    const client = new MockSeedClient({ marketSupply: 100_000n * WAD, vaultNavBps: 20_000 });
    await buildFromChainSizingReport({
      config: baseConfig(),
      client,
      // position = ceil(100 × 1.5) = 150 DIEM; at a 2:1 NAV that is 75 wstDIEM shares.
      options: { initialDiem: "100", targetLeverage: "1.5", vaultApyBps: "1500" },
      explicitFlags: NO_EXPLICIT,
    });

    expect(client.readGetDyDx).toHaveLength(1);
    // 75 wstDIEM (shares), not 150 (the DIEM notional) — proves convertToShares was applied.
    expect(client.readGetDyDx[0]).toBe(75n * WAD);
  });

  // Acceptance 12 (the actual claim) — the direction-blind leg-aware ESTIMATE would breach the
  // 300 bps cap and block on exit slippage, but the live get_dy quote prices the real exit under
  // the cap, so the verdict flips off the exit-slippage gate.
  it("clears the exit-slippage gate that the leg-aware estimate alone would trip", async () => {
    // Same seeded legs, sized offline WITHOUT a get_dy injection: the estimate blocks.
    const estimateOnly = buildLoopSizingReport(
      buildLoopSizingScenarios(baseConfig(), {
        initialDiem: "100",
        targetLeverage: "1.5",
        curveDiemLeg: "3000", // exit draws this leg: estimate = fee + ratioBps(150, 3000) ≈ 504 bps
        curveWstdiemLeg: "3000",
        morphoSupplyDiem: "100000",
        vaultApyBps: "1500",
      }),
    );
    expect(estimateOnly.results[0].exitSlippageSource).toBe("estimate");
    expect(estimateOnly.results[0].exitSlippageBps).toBeGreaterThan(300);
    expect(estimateOnly.results[0].blockers).toContain("curve_liquidity_insufficient");

    // The same pool via --from-chain, but the live get_dy quote prices the exit at 100 bps.
    const withGetDy = await buildFromChainSizingReport({
      config: baseConfig(),
      client: new MockSeedClient({
        marketSupply: 100_000n * WAD,
        curveDiemBalance: 3_000n * WAD,
        curveWstDiemBalance: 3_000n * WAD,
        getDyOutRateBps: 9_900, // 100 bps exit impact, well under the 300 bps cap
      }),
      options: { initialDiem: "100", targetLeverage: "1.5", vaultApyBps: "1500" },
      explicitFlags: NO_EXPLICIT,
    });
    const result = withGetDy.results[0];
    expect(result.exitSlippageSource).toBe("get_dy");
    expect(result.exitSlippageBps).toBe(100);
    // The gate the estimate tripped is now clear — the live quote rescued the exit.
    expect(result.blockers).not.toContain("curve_liquidity_insufficient");
  });
});

describe("assertFromChainCompatibleOptions (static, pre-network guards)", () => {
  it("throws for --borrow-rate-model flat without needing a client", () => {
    expect(() => assertFromChainCompatibleOptions({ borrowRateModel: "flat" })).toThrowError(
      "--from-chain seeds the adaptive rate; pass --borrow-apy-bps for the flat model",
    );
  });

  it("throws for --preset current-zero without needing a client", () => {
    expect(() => assertFromChainCompatibleOptions({ preset: "current-zero" })).toThrowError(
      /current-zero/,
    );
  });

  it("does NOT throw for --preset liquidity-sweep", () => {
    expect(() => assertFromChainCompatibleOptions({ preset: "liquidity-sweep" })).not.toThrow();
  });

  it("does NOT throw for the default adaptive-curve model / baseline preset", () => {
    expect(() => assertFromChainCompatibleOptions({})).not.toThrow();
  });

  // buildFromChainSizingReport must reject a static conflict BEFORE it ever calls the
  // client — proven by a client whose every method throws if touched.
  it("buildFromChainSizingReport rejects a flat-model conflict before touching the client", async () => {
    await expect(
      buildFromChainSizingReport({
        config: baseConfig(),
        client: new ThrowingSeedClient(),
        options: { borrowRateModel: "flat" },
        explicitFlags: NO_EXPLICIT,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("buildFromChainSizingReport rejects a current-zero preset conflict before touching the client", async () => {
    await expect(
      buildFromChainSizingReport({
        config: baseConfig(),
        client: new ThrowingSeedClient(),
        options: { preset: "current-zero" },
        explicitFlags: NO_EXPLICIT,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("loop sizing --from-chain (SPEC003 Part B-2: vaultApyBps ← 7-day DB window)", () => {
  // Credit samples that sum to 7 DIEM inside the window. With a constant 7300 DIEM asset window,
  // computeBaseApy = (7/7300) × (365/7) = 0.05 exactly → a clean 5% measured APY.
  const fivePercentCredit = (windowStart: number): CreditWindowSample[] => [
    { timestamp: windowStart + DAY_SECONDS, amountDiem: 3n * WAD },
    { timestamp: windowStart + 4 * DAY_SECONDS, amountDiem: 4n * WAD },
  ];

  // Acceptance 10 (direct) — the ×10000 magnitude guard, isolated on the adapter. A measured 5%
  // window → 500 bps. Without the mandatory ×10000 this would be 0 (the 10,000×-too-small bug).
  it("magnitude (acceptance 10, direct): a measured 5% window → vaultApyBps 500 (guards the 10,000× bug)", async () => {
    const config = baseConfig();
    const nowSeconds = 1_000_000;
    const store = new FakeVaultApyStore(constantVaultWindow(7_300n * WAD, 3), fivePercentCredit);
    const client = new MockSeedClient({
      vaultAsset: config.contracts.diem,
      vaultTotalAssets: 7_300n * WAD,
      vaultTotalSupply: 7_300n * WAD,
    });

    const result = await loadVaultApyWindow({ config, client, store, nowSeconds });

    expect(result.source).toBe("measured-7d");
    if (result.source === "measured-7d") {
      expect(result.vaultApyBps).toBe(500);
      expect(result.sampleCount).toBeGreaterThanOrEqual(MIN_VAULT_APY_WINDOW_SAMPLES);
    }
    // vaultApy is block-pinning EXEMPT (§2): none of the vault reads carried a blockNumber.
    expect(client.readBlockNumbers.every((block) => block === undefined)).toBe(true);
  });

  // Acceptance 10 (e2e) — the seeded 500 bps flows into every scenario as measured-7d/authoritative.
  it("magnitude (acceptance 10, e2e): every scenario is seeded vaultApyBps 500 as measured-7d", async () => {
    const config = baseConfig();
    const store = new FakeVaultApyStore(constantVaultWindow(7_300n * WAD, 3), fivePercentCredit);
    const report = await buildFromChainSizingReport({
      config,
      client: new MockSeedClient({
        marketSupply: 100_000n * WAD,
        vaultAsset: config.contracts.diem,
        vaultTotalAssets: 7_300n * WAD,
        vaultTotalSupply: 7_300n * WAD,
      }),
      options: { initialDiem: "100", targetLeverage: "1.5,2" },
      explicitFlags: NO_EXPLICIT,
      store,
    });

    expect(report.seedProvenance?.vaultApySource).toBe("measured-7d");
    expect(report.seedProvenance?.seededFields.vaultApyBps).toBe("chain");
    expect(report.results.every((result) => result.scenario.vaultApyBps === 500)).toBe(true);
    // Clean rate + balanced curve + measured vault → the verdict stays authoritative.
    expect(report.authoritative).toBe(true);
    expect(renderLoopSizingTable(report)).toContain("measured-7d");
  });

  // Acceptance 11 — insufficient history → not-seeded + authoritative:false + sizing CONTINUES on
  // the SPEC002 default (never a 0 seed, never a hard error). The verdict token degrades.
  it("insufficient history (acceptance 11): not-seeded, authoritative false, sizing continues on the default", async () => {
    const config = baseConfig();
    // Empty window → applyYieldWindowMetrics returns the "insufficient history" readiness, no APY.
    const store = new FakeVaultApyStore(() => []);
    const report = await buildFromChainSizingReport({
      config,
      client: new MockSeedClient({ marketSupply: 100_000n * WAD }),
      options: { initialDiem: "100", targetLeverage: "1.5", curveDepthDiem: "20000" },
      explicitFlags: NO_EXPLICIT,
      store,
    });

    expect(report.seedProvenance?.vaultApySource).toBe("not-seeded");
    expect(report.seedProvenance?.seededFields.vaultApyBps).toBe("default");
    expect(report.authoritative).toBe(false);
    // Sizing still ran end-to-end (full report, no throw) and stayed viable.
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.summary.viable).toBe(1);
    // vaultApyBps fell back to the SPEC002 default (1500), NEVER 0 (a 0 blocks every scenario).
    expect(report.results.every((result) => result.scenario.vaultApyBps === 1500)).toBe(true);
    expect(report.results.every((result) => result.scenario.vaultApyBps !== 0)).toBe(true);
    expect(report.seedProvenance?.warnings.join(" ")).toContain(
      "insufficient 7-day vault asset history",
    );

    const rendered = renderLoopSizingTable(report);
    expect(rendered).toContain("candidate — unverified seed");
    expect(rendered).toContain("UNVERIFIED SEED");
    expect(rendered).toContain("not-seeded (using default/grid)");
  });

  // Low-density floor — a full 7-day span with a computable TWA but only 3 points (< 4) is
  // not-seeded. This proves the DENSITY floor gates, not merely the span.
  it("low-density floor: a valid 7-day span with too few samples is not-seeded (proves the floor)", async () => {
    const config = baseConfig();
    // anchor + 1 in-window (2 stored) + the appended current sample = 3 < MIN(4).
    const store = new FakeVaultApyStore(constantVaultWindow(7_300n * WAD, 1));
    const report = await buildFromChainSizingReport({
      config,
      client: new MockSeedClient({
        marketSupply: 100_000n * WAD,
        vaultAsset: config.contracts.diem,
        vaultTotalAssets: 7_300n * WAD,
        vaultTotalSupply: 7_300n * WAD,
      }),
      options: { initialDiem: "100", targetLeverage: "1.5", curveDepthDiem: "20000" },
      explicitFlags: NO_EXPLICIT,
      store,
    });

    expect(report.seedProvenance?.vaultApySource).toBe("not-seeded");
    expect(report.seedProvenance?.seededFields.vaultApyBps).toBe("default");
    expect(report.authoritative).toBe(false);
    // The window was measurable (TWA computed) — DENSITY, not span, gated it.
    expect(report.seedProvenance?.warnings.join(" ")).toContain("sample density");
    expect(report.seedProvenance?.warnings.join(" ")).toContain(`(3/${MIN_VAULT_APY_WINDOW_SAMPLES})`);
    // Fell back to the default, not 0.
    expect(report.results.every((result) => result.scenario.vaultApyBps === 1500)).toBe(true);
  });

  // Precedence — an explicit --vault-apy-bps wins: the adapter is NOT consulted, the field is
  // "flag", and (the JUDGMENT CALL, §6-literal) the un-measured APY demotes the verdict.
  it("precedence: an explicit --vault-apy-bps wins, the adapter is not consulted, and demotes the verdict", async () => {
    const config = baseConfig();
    // A store that WOULD seed cleanly if consulted — proving the flag short-circuits it.
    const store = new FakeVaultApyStore(constantVaultWindow(7_300n * WAD, 5), fivePercentCredit);
    const report = await buildFromChainSizingReport({
      config,
      client: new MockSeedClient({
        marketSupply: 100_000n * WAD,
        vaultAsset: config.contracts.diem,
        vaultTotalAssets: 7_300n * WAD,
        vaultTotalSupply: 7_300n * WAD,
      }),
      options: {
        initialDiem: "100",
        targetLeverage: "1.5",
        vaultApyBps: "800",
        curveDepthDiem: "20000",
      },
      explicitFlags: { ...NO_EXPLICIT, vaultApyBps: true },
      store,
    });

    expect(report.seedProvenance?.seededFields.vaultApyBps).toBe("flag");
    expect(report.seedProvenance?.vaultApySource).toBe("not-seeded");
    // The adapter was never consulted — the operator flag short-circuits the window read.
    expect(store.vaultCalls).toBe(0);
    expect(store.creditCalls).toBe(0);
    // JUDGMENT CALL: an un-measured, operator-supplied APY is not chain-authoritative → demote.
    expect(report.authoritative).toBe(false);
    // The explicit 800 bps flows through the normal SPEC002 path onto every scenario.
    expect(report.results.every((result) => result.scenario.vaultApyBps === 800)).toBe(true);
  });

  // No store — the report is byte-identical to Part B-1: no vault seeding, no vaultApySource, and
  // `authoritative` is exactly what B-1 produced. This guards every existing Part-A/B-1 test.
  it("no store: no vaultApySource and authoritative unchanged from Part B-1", async () => {
    const report = await buildFromChainSizingReport({
      config: baseConfig(),
      client: new MockSeedClient({ marketSupply: 100_000n * WAD }),
      options: { initialDiem: "100", targetLeverage: "1.5", vaultApyBps: "1500" },
      explicitFlags: NO_EXPLICIT,
      // no store supplied
    });

    expect(report.seedProvenance?.vaultApySource).toBeUndefined();
    // A clean rate + balanced curve seed stays authoritative — vault seeding never engaged.
    expect(report.authoritative).toBe(true);
    const rendered = renderLoopSizingTable(report);
    expect(rendered).not.toContain("measured-7d");
    expect(rendered).not.toContain("not-seeded (using default/grid)");
  });

  // §4.3 never-hard-fail: a vault LIVE-read revert (RPC error on totalAssets) must NOT abort the
  // whole command — the rate/Morpho/curve seeds already succeeded. With a rich DB the window still
  // measures-7d from history alone (the failed live read is just a skipped current sample).
  it("does not hard-fail when the vault live read reverts — falls back to the DB-only window", async () => {
    const config = baseConfig();
    const store = new FakeVaultApyStore(constantVaultWindow(7_300n * WAD, 3), fivePercentCredit);
    const report = await buildFromChainSizingReport({
      config,
      client: new MockSeedClient({
        marketSupply: 100_000n * WAD,
        vaultAsset: config.contracts.diem,
        revertFunction: "totalAssets", // the live current-sample read reverts
      }),
      options: { initialDiem: "100", targetLeverage: "1.5" },
      explicitFlags: NO_EXPLICIT,
      store,
    });

    // The command completed (no abort) and measured the APY from the DB history alone.
    expect(report.seedProvenance?.vaultApySource).toBe("measured-7d");
    expect(report.results.every((result) => result.scenario.vaultApyBps === 500)).toBe(true);
  });

  // §4.3 never-hard-fail (demote arm): the same live-read revert with an EMPTY DB demotes to
  // not-seeded + a full report — never an uncaught throw that emits no report at all.
  it("demotes (not aborts) when the vault live read reverts and the DB is empty", async () => {
    const config = baseConfig();
    const store = new FakeVaultApyStore(() => []);
    const report = await buildFromChainSizingReport({
      config,
      client: new MockSeedClient({
        marketSupply: 100_000n * WAD,
        vaultAsset: config.contracts.diem,
        revertFunction: "totalAssets",
      }),
      options: { initialDiem: "100", targetLeverage: "1.5", curveDepthDiem: "20000" },
      explicitFlags: NO_EXPLICIT,
      store,
    });

    expect(report.seedProvenance?.vaultApySource).toBe("not-seeded");
    expect(report.authoritative).toBe(false);
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.results.every((result) => result.scenario.vaultApyBps === 1500)).toBe(true);
  });

  // §6 composition — a get_dy demotion and a vault SUCCESS in the same report: authoritative is the
  // AND of all sources, so vault `measured-7d` must NOT overturn the get_dy-driven `false`.
  it("composes demotions: a get_dy failure keeps authoritative false even when vault APY is measured-7d", async () => {
    const config = baseConfig();
    const store = new FakeVaultApyStore(constantVaultWindow(7_300n * WAD, 3), fivePercentCredit);
    const report = await buildFromChainSizingReport({
      config,
      client: new MockSeedClient({
        marketSupply: 100_000n * WAD,
        vaultAsset: config.contracts.diem,
        vaultTotalAssets: 7_300n * WAD,
        vaultTotalSupply: 7_300n * WAD,
        getDyOutRateBps: 0, // get_dy returns 0 → quoteCurveExitRoute readiness → get_dy demotion
      }),
      options: { initialDiem: "100", targetLeverage: "1.5" },
      explicitFlags: NO_EXPLICIT,
      store,
    });

    // The vault seed succeeded independently…
    expect(report.seedProvenance?.vaultApySource).toBe("measured-7d");
    // …but the get_dy demotion still forces the composite verdict to non-authoritative.
    expect(report.authoritative).toBe(false);
    expect(report.seedProvenance?.warnings.join(" ")).toContain("get_dy");
  });
});
