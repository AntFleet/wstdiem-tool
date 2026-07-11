import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import {
  assertFromChainCompatibleOptions,
  buildFromChainSizingReport,
  seedFromChain,
  type FromChainExplicitFlags,
  type FromChainSeedClient,
} from "../src/loop/fromChainSeed.js";
import { perSecWadToAprBps } from "../src/loop/morphoRate.js";
import { renderLoopSizingTable } from "../src/cli/output.js";
import { buildLoopSizingReport } from "../src/loop/sizing.js";
import { buildLoopSizingScenarios } from "../src/loop/sizingScenarios.js";
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
}

class MockSeedClient implements FromChainSeedClient {
  readonly readBlockNumbers: Array<bigint | undefined> = [];

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
