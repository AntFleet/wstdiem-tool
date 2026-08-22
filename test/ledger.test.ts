import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { renderDiemLedgerTable, stringifyJson } from "../src/cli/output.js";
import {
  assertNoForbiddenSettlementKeys,
} from "../src/metrics/flows.js";
import {
  REQUIRED_BUCKET_IDS,
  buildDiemLedger,
  buildLedgerBuckets,
  buildLedgerLiveness,
  classifyLiveness,
  computeCapacityUtilization,
  dailyFromWindow,
  ownerHeadlineAmount,
  LIVENESS_THRESHOLDS,
  type LedgerLiveState,
  type LedgerObservations,
} from "../src/metrics/ledger.js";
import { makeEmptySnapshot, WAD } from "../src/metrics/math.js";
import { Storage } from "../src/storage/sqlite.js";
import type { Address, StoredInferenceCredit, StoredInferenceSettlement } from "../src/types/domain.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const ADAPTER = "0x00000000000000000000000000000000000000aa" as Address;

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function credit(
  ts: number,
  amount: bigint,
  kind: StoredInferenceCredit["kind"] = "DIEMCredited",
): StoredInferenceCredit {
  return {
    txHash: `0x${ts.toString(16).padStart(8, "0")}`,
    logIndex: 0,
    blockNumber: 1n,
    timestamp: ts,
    kind,
    adapter: ADAPTER,
    amountDiem: amount,
  };
}

function settlement(
  ts: number,
  kind: StoredInferenceSettlement["kind"],
  usdc?: bigint,
  diemOut?: bigint,
): StoredInferenceSettlement {
  return {
    txHash: `0x${(ts + 1).toString(16).padStart(8, "0")}`,
    logIndex: 1,
    blockNumber: 1n,
    timestamp: ts,
    kind,
    adapter: ADAPTER,
    usdcAmount: usdc,
    diemOut,
  };
}

function emptyLive(): LedgerLiveState {
  return {
    vaultTotalAssets: null,
    vaultTotalSupply: null,
    vaultNav: null,
    vaultReason: "unread",
    morphoSupply: null,
    morphoBorrow: null,
    morphoBorrowShares: null,
    morphoReason: "unread",
    curveDiemLeg: null,
    curveWstDiemLeg: null,
    curveWstDiemLegInDiem: null,
    curveReason: "unread",
    owner: {
      configured: false,
      morphoExpected: false,
      address: null,
      walletWstDiem: null,
      walletValueDiem: null,
      collateralWstDiem: null,
      borrowedDiem: null,
      reason: "position.owner not configured",
    },
    adapters: [],
    blockNumber: null,
    blockTimestamp: null,
    getDyQuotedAt: null,
  };
}

function observations(over: Partial<LedgerObservations> = {}): LedgerObservations {
  const now = 2_000_000;
  return {
    nowSeconds: now,
    windowHours: 24,
    credits: [],
    settlements: [],
    latestSnapshot: null,
    lastHarvestAt: null,
    lastCreditEventAt: null,
    lastDiemCreditedAt: null,
    lastYieldRoutedAt: null,
    lastSettlementReceivedAt: null,
    firstSeenBlock: null,
    creditUsdPerDiemPerDay: 1,
    configAdapters: [],
    live: null,
    rpcConfigured: false,
    ...over,
  };
}

describe("DIEM capacity utilization", () => {
  it("returns n/a when the denominator is unavailable", () => {
    const result = computeCapacityUtilization({
      windowHours: 24,
      windowDiemCredited: 10n * WAD,
      vaultStakedDiem: null,
      unroutedUsdc: 0n,
      hasKeeperCadenceEvidence: true,
      creditUsdPerDiemPerDay: 1,
      windowUsdcSettledAsReported: 0n,
      windowDiemFromYieldRouted: 0n,
    });
    expect(result.status).toBe("n/a");
    expect(result.ratioBps).toBeNull();
    expect(result.reason).toMatch(/denominator-unavailable/);
    expect(result.numeratorTrustTier).toBe(1);
    expect(result.tier2Context.trustTier).toBe(2);
    expect(result.decisionSupportOnly).toBe(true);
    expect(result.notAdvice).toBe(true);
  });

  it("returns n/a when vault-staked DIEM is zero", () => {
    const result = computeCapacityUtilization({
      windowHours: 24,
      windowDiemCredited: WAD,
      vaultStakedDiem: 0n,
      unroutedUsdc: 0n,
      hasKeeperCadenceEvidence: true,
      creditUsdPerDiemPerDay: 1,
      windowUsdcSettledAsReported: 0n,
      windowDiemFromYieldRouted: 0n,
    });
    expect(result.status).toBe("n/a");
    expect(result.ratioBps).toBeNull();
  });

  it("computes ratio only from compatible 18-dec DIEM units (not USDC)", () => {
    // 72h window, 3 DIEM credited, 100 DIEM staked → daily num 1, util 1%.
    const result = computeCapacityUtilization({
      windowHours: 72,
      windowDiemCredited: 3n * WAD,
      vaultStakedDiem: 100n * WAD,
      unroutedUsdc: 0n,
      hasKeeperCadenceEvidence: true,
      creditUsdPerDiemPerDay: 1,
      windowUsdcSettledAsReported: 1_000_000n * 50n, // 50 USDC 6-dec — must not enter the ratio
      windowDiemFromYieldRouted: 9n * WAD,
    });
    expect(result.status).toBe("ok");
    expect(result.ratioBps).toBe(100);
    expect(result.numeratorSource).toBe("DIEMCredited");
    expect(result.numeratorTrustLabel).toBe("tier1-diem-credited-chain-proven");
    expect(result.tier2Context.trustLabel).toBe("tier2-usdc-settled-as-reported");
    expect(result.tier2Context.windowUsdcSettledAsReported).toBe((1_000_000n * 50n).toString());
    expect(result.denominatorDailyDiem).toBe((100n * WAD).toString());
    expect(dailyFromWindow(3n * WAD, 72 * 3600)).toBe(1n * WAD);
  });

  it("preserves Tier 1 vs Tier 2 labels on utilization", () => {
    const result = computeCapacityUtilization({
      windowHours: 72,
      windowDiemCredited: WAD,
      vaultStakedDiem: 81n * WAD,
      unroutedUsdc: 2_000_000n,
      hasKeeperCadenceEvidence: true,
      creditUsdPerDiemPerDay: 1,
      windowUsdcSettledAsReported: 5n,
      windowDiemFromYieldRouted: 1n,
    });
    expect(result.numeratorTrustTier).toBe(1);
    expect(result.tier2Context.trustTier).toBe(2);
    expect(result.veniceCreditSemantics).toMatch(/API credit if spent/);
    expect(result.notAYieldPromise).toBe(true);
  });

  it("does not treat zero recent credit as zero demand when unrouted USDC is positive", () => {
    const result = computeCapacityUtilization({
      windowHours: 24,
      windowDiemCredited: 0n,
      vaultStakedDiem: 80n * WAD,
      unroutedUsdc: 1_000_000n,
      hasKeeperCadenceEvidence: true,
      creditUsdPerDiemPerDay: 1,
      windowUsdcSettledAsReported: 1_000_000n,
      windowDiemFromYieldRouted: 0n,
    });
    expect(result.status).toBe("ambiguous");
    expect(result.ratioBps).toBeNull();
    expect(result.reason).toMatch(/not proof of no demand/);
    expect(result.reason).toMatch(/unrouted USDC/);
    expect(result.caveats).toContain("zero-diem-credited-is-not-zero-demand");
  });

  it("does not treat zero recent credit as zero demand when keeper cadence is missing", () => {
    const result = computeCapacityUtilization({
      windowHours: 24,
      windowDiemCredited: 0n,
      vaultStakedDiem: 80n * WAD,
      unroutedUsdc: 0n,
      hasKeeperCadenceEvidence: false,
      creditUsdPerDiemPerDay: 1,
      windowUsdcSettledAsReported: 0n,
      windowDiemFromYieldRouted: 0n,
    });
    expect(result.status).toBe("ambiguous");
    expect(result.ratioBps).toBeNull();
    expect(result.reason).toMatch(/cadence/);
  });

  it("reports ok 0 with lumpy caveat when cadence is present and unrouted USDC is zero", () => {
    const result = computeCapacityUtilization({
      windowHours: 24,
      windowDiemCredited: 0n,
      vaultStakedDiem: 80n * WAD,
      unroutedUsdc: 0n,
      hasKeeperCadenceEvidence: true,
      creditUsdPerDiemPerDay: 1,
      windowUsdcSettledAsReported: 0n,
      windowDiemFromYieldRouted: 0n,
    });
    expect(result.status).toBe("ok");
    expect(result.ratioBps).toBe(0);
    expect(result.caveats).toContain("zero-diem-credited-is-not-proof-of-no-demand");
  });

  it("does not treat partial unrouted USDC as a known zero (ambiguous, not ok/0%)", () => {
    const result = computeCapacityUtilization({
      windowHours: 24,
      windowDiemCredited: 0n,
      vaultStakedDiem: 80n * WAD,
      unroutedUsdc: 0n,
      unroutedIncomplete: true,
      hasKeeperCadenceEvidence: true,
      creditUsdPerDiemPerDay: 1,
      windowUsdcSettledAsReported: 0n,
      windowDiemFromYieldRouted: 0n,
    });
    expect(result.status).toBe("ambiguous");
    expect(result.ratioBps).toBeNull();
    expect(result.reason).toMatch(/incomplete/);
  });
});

describe("liveness classification", () => {
  const now = 1_000_000;

  it("classifies fresh / stale / lagging deterministically", () => {
    expect(
      classifyLiveness({
        nowSeconds: now,
        observedAt: now - 10,
        freshSeconds: 60,
        staleSeconds: 300,
      }).status,
    ).toBe("fresh");
    expect(
      classifyLiveness({
        nowSeconds: now,
        observedAt: now - 120,
        freshSeconds: 60,
        staleSeconds: 300,
      }).status,
    ).toBe("stale");
    expect(
      classifyLiveness({
        nowSeconds: now,
        observedAt: now - 400,
        freshSeconds: 60,
        staleSeconds: 300,
      }).status,
    ).toBe("lagging");
  });

  it("classifies unavailable and not_configured without fabricating an age", () => {
    expect(
      classifyLiveness({
        nowSeconds: now,
        observedAt: null,
        freshSeconds: 60,
        staleSeconds: 300,
        unavailableReason: "none",
      }),
    ).toEqual({ status: "unavailable", ageSeconds: null, reason: "none" });
    expect(
      classifyLiveness({
        nowSeconds: now,
        observedAt: null,
        freshSeconds: 60,
        staleSeconds: 300,
        configured: false,
        notConfiguredReason: "no rpc",
      }),
    ).toEqual({ status: "not_configured", ageSeconds: null, reason: "no rpc" });
  });

  it("does not classify missing DIEMCredited as zero demand", () => {
    const live = buildLedgerLiveness({
      nowSeconds: now,
      latestSnapshot: null,
      lastHarvestAt: null,
      lastCreditEventAt: null,
      lastDiemCreditedAt: null,
      lastYieldRoutedAt: null,
      lastSettlementReceivedAt: null,
      live: null,
      rpcConfigured: false,
    });
    expect(live.lastDiemCredited.status).toBe("unavailable");
    expect(live.lastDiemCredited.reason).toMatch(/not zero demand/);
    expect(live.getDyQuote.status).toBe("not_configured");
    expect(live.rpcBlock.status).toBe("not_configured");
    expect(live.sqliteSampling.status).toBe("unavailable");
    expect(live.keeperHarvestCadence.reason).toMatch(/lumpy/);
  });

  it("marks a 6h sampling tick as fresh and a 2d gap as lagging", () => {
    const fresh = classifyLiveness({
      nowSeconds: now,
      observedAt: now - 6 * 3600,
      freshSeconds: LIVENESS_THRESHOLDS.samplingFreshSeconds,
      staleSeconds: LIVENESS_THRESHOLDS.samplingStaleSeconds,
    });
    expect(fresh.status).toBe("fresh");
    const lagging = classifyLiveness({
      nowSeconds: now,
      observedAt: now - 2 * 24 * 3600,
      freshSeconds: LIVENESS_THRESHOLDS.samplingFreshSeconds,
      staleSeconds: LIVENESS_THRESHOLDS.samplingStaleSeconds,
    });
    expect(lagging.status).toBe("lagging");
    expect(lagging.ageSeconds).toBe(2 * 24 * 3600);
  });

  it("classifies vaultSample from sqlite when live vault assets were not read", () => {
    const now = 2_000_000;
    const live = buildLedgerLiveness({
      nowSeconds: now,
      latestSnapshot: {
        timestamp: now - 6 * 3600,
        nav: WAD,
        totalAssetsDiem: 10n * WAD,
        totalSupply: 10n * WAD,
        blockNumber: 1n,
      },
      lastHarvestAt: null,
      lastCreditEventAt: null,
      lastDiemCreditedAt: null,
      lastYieldRoutedAt: null,
      lastSettlementReceivedAt: null,
      live: {
        ...emptyLive(),
        vaultTotalAssets: null,
        blockTimestamp: now - 3,
      },
      rpcConfigured: true,
    });
    expect(live.vaultSample.status).toBe("fresh");
    expect(live.vaultSample.reason).toMatch(/source=sqlite-sample/);
    expect(live.vaultSample.reason).not.toMatch(/source=live-block/);
    expect(live.rpcBlock.status).toBe("fresh");
    expect(live.rpcBlock.reason).toMatch(/RPC header age only/);
  });

  it("keeps rpcBlock fresh from the header even when live collect is null", () => {
    const now = 2_000_000;
    const live = buildLedgerLiveness({
      nowSeconds: now,
      latestSnapshot: null,
      lastHarvestAt: null,
      lastCreditEventAt: null,
      lastDiemCreditedAt: null,
      lastYieldRoutedAt: null,
      lastSettlementReceivedAt: null,
      live: null,
      rpcConfigured: true,
      rpcHeaderTimestamp: now - 3,
    });
    expect(live.rpcBlock.status).toBe("fresh");
    expect(live.vaultSample.status).toBe("unavailable");
  });
});

describe("bucket readout", () => {
  it("includes every required bucket even when live data is unavailable", () => {
    const buckets = buildLedgerBuckets({
      windowHours: 24,
      windowDiemCredited: 0n,
      windowWstDiemCredited: 0n,
      unroutedUsdc: null,
      unroutedReason: "not_configured",
      latestSnapshot: null,
      live: emptyLive(),
    });
    expect(buckets.map((b) => b.id)).toEqual([...REQUIRED_BUCKET_IDS]);
    const unavailable = buckets.filter((b) => b.status !== "ok");
    expect(unavailable.length).toBeGreaterThan(0);
    for (const b of unavailable) {
      expect(b.amount === null || b.status === "not_configured" || b.status === "unavailable").toBe(
        true,
      );
      expect(b.reason).toBeTruthy();
    }
    expect(buckets.find((b) => b.id === "unrouted-usdc-adapters")?.status).toBe("not_configured");
    expect(buckets.find((b) => b.id === "owner-position")?.status).toBe("not_configured");
    expect(buckets.find((b) => b.id === "diem-credited-window")?.status).toBe("ok");
    expect(buckets.find((b) => b.id === "diem-credited-window")?.trustTier).toBe(1);
    expect(buckets.find((b) => b.id === "unrouted-usdc-adapters")?.trustTier).toBe(2);
    expect(buckets.find((b) => b.id === "morpho-supply")?.purpose).not.toBe("collateral");
  });

  it("does not headline a 0n wallet over Morpho collateral/debt", () => {
    const owner = {
      configured: true,
      morphoExpected: true,
      address: "0x0000000000000000000000000000000000000001" as Address,
      walletWstDiem: 0n,
      walletValueDiem: 0n,
      collateralWstDiem: 5n * WAD,
      borrowedDiem: 2n * WAD,
      reason: null,
    };
    expect(ownerHeadlineAmount(owner)).toBeNull();
    const buckets = buildLedgerBuckets({
      windowHours: 24,
      windowDiemCredited: 0n,
      windowWstDiemCredited: 0n,
      unroutedUsdc: null,
      unroutedReason: "not_configured",
      latestSnapshot: null,
      live: {
        ...emptyLive(),
        owner,
      },
    });
    const row = buckets.find((b) => b.id === "owner-position");
    expect(row?.amount).toBeNull();
    expect(row?.extras.collateralWstDiem).toBe((5n * WAD).toString());
    expect(row?.extras.borrowedDiem).toBe((2n * WAD).toString());
    const rendered = renderDiemLedgerTable(
      buildDiemLedger(
        observations({
          latestSnapshot: {
            timestamp: 2_000_000,
            nav: WAD,
            totalAssetsDiem: 80n * WAD,
            totalSupply: 80n * WAD,
            blockNumber: 1n,
          },
          live: { ...emptyLive(), owner },
        }),
      ),
    );
    expect(rendered).toMatch(/Morpho collateral/);
    expect(rendered).toMatch(/Morpho debt/);
    expect(rendered).not.toMatch(/Owner position[^\n]*\n[^\n]*\b0\.000000 DIEM\b/);
  });

  it("does not headline a 0n wallet when Morpho debt is unread", () => {
    const owner = {
      configured: true,
      morphoExpected: true,
      address: "0x0000000000000000000000000000000000000001" as Address,
      walletWstDiem: 0n,
      walletValueDiem: 0n,
      collateralWstDiem: null,
      borrowedDiem: null,
      reason: "Morpho position returned an unsupported shape",
    };
    expect(ownerHeadlineAmount(owner)).toBeNull();
    const buckets = buildLedgerBuckets({
      windowHours: 24,
      windowDiemCredited: 0n,
      windowWstDiemCredited: 0n,
      unroutedUsdc: null,
      unroutedReason: "not_configured",
      latestSnapshot: null,
      live: { ...emptyLive(), owner },
    });
    const row = buckets.find((b) => b.id === "owner-position");
    expect(row?.status).toBe("unavailable");
    expect(row?.amount).toBeNull();
    expect(row?.extras.borrowedDiem).toBe("unread");
    expect(row?.reason).toMatch(/Morpho/);
  });
});

describe("buildDiemLedger JSON", () => {
  it("serializes bigints as strings and keeps decision-support flags", () => {
    const now = 2_000_000;
    const result = buildDiemLedger(
      observations({
        nowSeconds: now,
        credits: [credit(now - 3600, 2n * WAD)],
        settlements: [
          settlement(now - 1800, "SettlementReceived", 1_000_000n),
          settlement(now - 900, "YieldRouted", 1_000_000n, 2n * WAD),
        ],
        latestSnapshot: {
          timestamp: now - 100,
          nav: WAD,
          totalAssetsDiem: 50n * WAD,
          totalSupply: 49n * WAD,
          blockNumber: 99n,
        },
        lastHarvestAt: now - 3600,
        lastDiemCreditedAt: now - 3600,
        lastYieldRoutedAt: now - 900,
        lastSettlementReceivedAt: now - 1800,
        live: {
          ...emptyLive(),
          vaultTotalAssets: 50n * WAD,
          vaultTotalSupply: 49n * WAD,
          vaultNav: WAD,
          vaultReason: null,
          morphoSupply: 6n * WAD,
          morphoBorrow: 2n * WAD,
          morphoReason: null,
          curveDiemLeg: 0n,
          curveWstDiemLeg: 0n,
          curveWstDiemLegInDiem: 0n,
          curveReason: null,
          blockNumber: 100n,
          blockTimestamp: now - 5,
          owner: {
            configured: true,
            morphoExpected: true,
            address: "0x0000000000000000000000000000000000000001",
            walletWstDiem: 0n,
            walletValueDiem: 0n,
            collateralWstDiem: 3n * WAD,
            borrowedDiem: WAD,
            reason: null,
          },
        },
        rpcConfigured: true,
      }),
    );

    expect(result.decisionSupportOnly).toBe(true);
    expect(result.notAdvice).toBe(true);
    expect(result.notAYieldPromise).toBe(true);
    expect(result.utilization.numeratorTrustTier).toBe(1);
    expect(result.utilization.tier2Context.trustTier).toBe(2);
    expect(result.buckets.map((b) => b.id)).toEqual([...REQUIRED_BUCKET_IDS]);
    expect(result.liveness.rpcBlock.status).toBe("fresh");
    expect(result.liveness.getDyQuote.status).toBe("not_configured");
    expect(result.utilization.denominatorOrigin).toBe("live");
    expect(result.liveness.vaultSample.reason).toMatch(/source=live-block/);

    const json = stringifyJson(result);
    const parsed = JSON.parse(json) as typeof result;
    expect(typeof parsed.utilization.windowDiemCredited).toBe("string");
    expect(parsed.utilization.windowDiemCredited).toBe((2n * WAD).toString());
    expect(json).not.toMatch(/[0-9]+n/);
    expect(() => assertNoForbiddenSettlementKeys(parsed)).not.toThrow();
    expect(parsed).not.toHaveProperty("inferenceVolume");
    expect(parsed).not.toHaveProperty("inferenceDemand");

    const rendered = renderDiemLedgerTable(result);
    expect(rendered).toMatch(/Decision-support only/i);
    expect(rendered).toMatch(/Venice credit utilization/i);
    expect(rendered).toMatch(/Tier 1/);
    expect(rendered).toMatch(/SettlementReceived/);
    expect(rendered).toMatch(/YieldRouted/);
    expect(rendered).toMatch(/not external demand/);
    expect(rendered).toMatch(/\$0 token yield if unused/);
    expect(rendered).toMatch(/not proof of no demand|lumpy/i);
    expect(rendered.toLowerCase()).not.toContain("inference volume");
    expect(rendered).toMatch(/6-dec raw/);
    expect(rendered).toMatch(/Morpho collateral/);
    expect(rendered).toMatch(/Morpho debt/);
  });

  it("buildDiemLedger: one unread adapter does not unlock ok/0% utilization", () => {
    const now = 2_000_000;
    const result = buildDiemLedger(
      observations({
        nowSeconds: now,
        lastHarvestAt: now - 3600,
        lastYieldRoutedAt: now - 3600,
        latestSnapshot: {
          timestamp: now - 100,
          nav: WAD,
          totalAssetsDiem: 80n * WAD,
          totalSupply: 80n * WAD,
          blockNumber: 1n,
        },
        configAdapters: [
          { address: ADAPTER },
          { address: "0x00000000000000000000000000000000000000bb" as Address },
        ],
        live: {
          ...emptyLive(),
          vaultTotalAssets: 80n * WAD,
          adapters: [
            {
              address: ADAPTER,
              name: "ok",
              isVenueAdapter: true,
              operatorFeeBps: 0,
              unroutedUsdc: 0n,
            },
            {
              address: "0x00000000000000000000000000000000000000bb",
              name: "unread",
              isVenueAdapter: true,
              operatorFeeBps: 0,
              unroutedUsdc: null,
            },
          ],
        },
      }),
    );
    expect(result.utilization.status).toBe("ambiguous");
    expect(result.utilization.ratioBps).toBeNull();
    expect(result.utilization.reason).toMatch(/incomplete/);
    expect(result.utilization.tier2Context.unroutedIncomplete).toBe(true);
    const unrouted = result.buckets.find((b) => b.id === "unrouted-usdc-adapters");
    expect(unrouted?.status).toBe("unavailable");
    expect(unrouted?.reason).toMatch(/partial-sum/);
  });
});

describe("sqlite latest-event helpers", () => {
  it("returns latest harvest / inference timestamps", () => {
    const dir = mkdtempSync(join(tmpdir(), "wstdiem-ledger-db-"));
    dirs.push(dir);
    const store = new Storage(join(dir, "t.sqlite"));
    expect(store.getLatestMetricSnapshotMeta()).toBeNull();
    expect(store.getLatestHarvestTimestamp()).toBeNull();

    const snap = makeEmptySnapshot(1_000);
    snap.nav = WAD;
    snap.vaultTotalAssetsDiem = 10n * WAD;
    snap.totalSupply = 10n * WAD;
    snap.blockNumber = 5n;
    store.insertMetricSnapshot(snap);
    store.insertHarvestEvent({
      txHash: "0xaaa",
      logIndex: 0,
      blockNumber: 1n,
      timestamp: 50,
      eventName: "VVVHarvested",
    });
    store.insertInferenceCredit(credit(80, WAD));
    store.insertInferenceSettlement(settlement(90, "YieldRouted", 1n, WAD));

    const meta = store.getLatestMetricSnapshotMeta();
    expect(meta?.totalAssetsDiem).toBe(10n * WAD);
    expect(store.getLatestHarvestTimestamp()).toBe(50);
    expect(store.getLatestInferenceCreditTimestamp("DIEMCredited")).toBe(80);
    expect(store.getLatestInferenceSettlementTimestamp("YieldRouted")).toBe(90);
    store.close();
  });
});

describe("compiled CLI loop ledger", () => {
  it("emits JSON with stable keys and explicit unavailable buckets offline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wstdiem-cli-ledger-"));
    dirs.push(dir);
    const dbPath = join(dir, "t.sqlite");
    const store = new Storage(dbPath);
    const now = Math.floor(Date.now() / 1000);
    const snap = makeEmptySnapshot(now - 3600);
    snap.nav = WAD;
    snap.vaultTotalAssetsDiem = 80n * WAD;
    snap.totalSupply = 79n * WAD;
    store.insertMetricSnapshot(snap);
    store.close();

    const cfg = join(dir, "config.yaml");
    writeFileSync(
      cfg,
      ["storage:", `  sqlitePath: "${dbPath}"`, "rpc:", "  primaryUrl: null", "  fallbackUrls: []"].join(
        "\n",
      ),
    );
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.BASE_RPC_URL;
    delete env.BASE_RPC_URL_FALLBACK_1;
    delete env.BASE_RPC_URL_FALLBACK_2;

    const { stdout } = await execFileAsync(
      "node",
      ["--import", "tsx", "src/cli/index.ts", "--config", cfg, "--json", "loop", "ledger", "--window-hours", "24"],
      { env, cwd: process.cwd() },
    );
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      command: string;
      data: {
        decisionSupportOnly: boolean;
        notAdvice: boolean;
        utilization: { status: string; numeratorTrustTier: number; tier2Context: { trustTier: number } };
        buckets: Array<{ id: string; status: string }>;
        liveness: { getDyQuote: { status: string }; rpcBlock: { status: string } };
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("loop ledger");
    expect(parsed.data.decisionSupportOnly).toBe(true);
    expect(parsed.data.notAdvice).toBe(true);
    expect(parsed.data.utilization.numeratorTrustTier).toBe(1);
    expect(parsed.data.utilization.tier2Context.trustTier).toBe(2);
    expect(parsed.data.buckets.map((b) => b.id)).toEqual([...REQUIRED_BUCKET_IDS]);
    expect(parsed.data.liveness.getDyQuote.status).toBe("not_configured");
    expect(parsed.data.liveness.rpcBlock.status).toBe("not_configured");
  });
});
