/**
 * SPEC009 acceptance criteria (§7).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, toEventHash } from "viem";
import { inferenceAdapterEventAbis } from "../src/abi/inferenceAdapter.js";
import { inferenceVaultEventAbis } from "../src/abi/inferenceVault.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { stringifyJson } from "../src/cli/output.js";
import {
  backfillCreditAndHarvestEvents,
  INITIAL_BACKFILL_LOOKBACK_BLOCKS,
  REORG_SAFETY_OVERLAP_BLOCKS,
  decodeAdapterSettlementLog,
  decodeVaultInferenceLog,
  resolveBackfillRange,
  type BackfillClient,
  type BackfillLog,
  type BackfillStorage,
} from "../src/metrics/backfill.js";
import {
  assertNoForbiddenSettlementKeys,
  buildFlowVelocity,
  buildInferenceFlows,
  computeInferenceShareHeadline,
  DEFAULT_INFERENCE_RECONCILE_TOLERANCE_BPS,
  holderDiemFromYieldRouted,
  inferenceAttributableAfterYieldFee,
  realizedConversionDiemPerUsdcWad,
  totalRealizedHolderYieldDiem,
} from "../src/metrics/flows.js";
import { MIN_DEMAND_WINDOW_SAMPLES } from "../src/metrics/demand.js";
import { makeEmptySnapshot, WAD } from "../src/metrics/math.js";
import { Storage } from "../src/storage/sqlite.js";
import type {
  Address,
  AppConfig,
  Hex,
  StoredCreditEvent,
  StoredHarvestEvent,
  StoredInferenceCredit,
  StoredInferenceSettlement,
} from "../src/types/domain.js";

const execFileAsync = promisify(execFile);

const ADAPTER = "0x00000000000000000000000000000000000000aa" as Address;
const X402 = "0x00000000000000000000000000000000000000bb" as Address;
const VAULT = "0x0000000000000000000000000000000000000003" as Address;

class MemoryStorage implements BackfillStorage {
  readonly meta = new Map<string, string>();
  readonly credits: StoredInferenceCredit[] = [];
  readonly settlements: StoredInferenceSettlement[] = [];
  readonly creditEvents: StoredCreditEvent[] = [];
  readonly harvestEvents: StoredHarvestEvent[] = [];

  getMeta(key: string): string | null {
    return this.meta.get(key) ?? null;
  }
  setMeta(key: string, value: string): void {
    this.meta.set(key, value);
  }
  insertCreditEvent(e: StoredCreditEvent): void {
    this.creditEvents.push(e);
  }
  insertHarvestEvent(e: StoredHarvestEvent): void {
    this.harvestEvents.push(e);
  }
  insertInferenceCredit(e: StoredInferenceCredit): void {
    const idx = this.credits.findIndex(
      (c) => c.txHash === e.txHash && c.logIndex === e.logIndex,
    );
    if (idx >= 0) {
      this.credits[idx] = e;
    } else {
      this.credits.push(e);
    }
  }
  insertInferenceSettlement(e: StoredInferenceSettlement): void {
    const idx = this.settlements.findIndex(
      (c) => c.txHash === e.txHash && c.logIndex === e.logIndex,
    );
    if (idx >= 0) {
      this.settlements[idx] = e;
    } else {
      this.settlements.push(e);
    }
  }
}

class MemClient implements BackfillClient {
  constructor(
    private readonly logs: BackfillLog[],
    private readonly timestamps: Record<string, number> = {},
  ) {}
  async getLogs(args: {
    address: Address;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<BackfillLog[]> {
    return this.logs.filter(
      (l) =>
        l.address.toLowerCase() === args.address.toLowerCase() &&
        l.blockNumber >= args.fromBlock &&
        l.blockNumber <= args.toBlock,
    );
  }
  async getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: number }> {
    return {
      timestamp: this.timestamps[args.blockNumber.toString()] ?? Number(args.blockNumber),
    };
  }
}

function diemCreditedLog(args: {
  adapter: Address;
  amount: bigint;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
}): BackfillLog {
  return {
    address: VAULT,
    blockNumber: args.blockNumber,
    logIndex: args.logIndex,
    transactionHash: args.txHash,
    topics: encodeEventTopics({
      abi: inferenceVaultEventAbis,
      eventName: "DIEMCredited",
      args: { adapter: args.adapter },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [args.amount]),
  };
}

function settlementLog(args: {
  adapter: Address;
  amount: bigint;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
}): BackfillLog {
  return {
    address: args.adapter,
    blockNumber: args.blockNumber,
    logIndex: args.logIndex,
    transactionHash: args.txHash,
    topics: encodeEventTopics({
      abi: inferenceAdapterEventAbis,
      eventName: "SettlementReceived",
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [args.amount]),
  };
}

function yieldRoutedLog(args: {
  adapter: Address;
  usdc: bigint;
  diem: bigint;
  operatorShares: bigint;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
}): BackfillLog {
  return {
    address: args.adapter,
    blockNumber: args.blockNumber,
    logIndex: args.logIndex,
    transactionHash: args.txHash,
    topics: encodeEventTopics({
      abi: inferenceAdapterEventAbis,
      eventName: "YieldRouted",
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [args.usdc, args.diem, args.operatorShares],
    ),
  };
}

function wstDiemCreditedLog(args: {
  source: Address;
  recipient: Address;
  diem: bigint;
  shares: bigint;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
}): BackfillLog {
  return {
    address: VAULT,
    blockNumber: args.blockNumber,
    logIndex: args.logIndex,
    transactionHash: args.txHash,
    topics: encodeEventTopics({
      abi: inferenceVaultEventAbis,
      eventName: "WstDIEMCredited",
      args: { source: args.source, recipient: args.recipient },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }],
      [args.diem, args.shares],
    ),
  };
}

describe("SPEC009 §7.1 decode + decimals", () => {
  it("decodes DIEMCredited adapter + 18-dec amount", () => {
    const log = diemCreditedLog({
      adapter: ADAPTER,
      amount: 5n * WAD,
      blockNumber: 1n,
      logIndex: 0,
      txHash: "0xaaa",
    });
    const decoded = decodeVaultInferenceLog(log);
    expect(decoded?.kind).toBe("DIEMCredited");
    expect(decoded?.adapter.toLowerCase()).toBe(ADAPTER.toLowerCase());
    expect(decoded?.amountDiem).toBe(5n * WAD);
  });

  it("decodes SettlementReceived as 6-dec USDC", () => {
    const log = settlementLog({
      adapter: ADAPTER,
      amount: 1_000_000n,
      blockNumber: 1n,
      logIndex: 0,
      txHash: "0xbbb",
    });
    const decoded = decodeAdapterSettlementLog(log, ADAPTER);
    expect(decoded?.kind).toBe("SettlementReceived");
    expect(decoded?.usdcAmount).toBe(1_000_000n);
  });

  it("decimals trap: 1 USDC + 1 DIEM → conversion ≈ 1 DIEM/USDC, not 1e±12", () => {
    const wad = realizedConversionDiemPerUsdcWad(1_000_000n, WAD);
    expect(wad).toBe(WAD); // 1.0 in WAD
    // Off-by-1e12 would be 1e6 or 1e30
    expect(wad).not.toBe(10n ** 6n);
    expect(wad).not.toBe(10n ** 30n);
  });

  it("decodes YieldRouted usdc/diem/operatorShares units", () => {
    const log = yieldRoutedLog({
      adapter: ADAPTER,
      usdc: 2_000_000n,
      diem: 3n * WAD,
      operatorShares: WAD / 10n,
      blockNumber: 1n,
      logIndex: 0,
      txHash: "0xccc",
    });
    const decoded = decodeAdapterSettlementLog(log, ADAPTER);
    expect(decoded?.kind).toBe("YieldRouted");
    expect(decoded?.usdcAmount).toBe(2_000_000n);
    expect(decoded?.diemOut).toBe(3n * WAD);
    expect(decoded?.operatorShares).toBe(WAD / 10n);
  });
});

describe("SPEC009 §7.2 fee decomposition", () => {
  it("holderDiem = diem × (1 − operatorFeeBps/1e4); equals diem − operator take", () => {
    const diemOut = 10n * WAD;
    const operatorFeeBps = 1000; // 10%
    const holder = holderDiemFromYieldRouted(diemOut, operatorFeeBps);
    expect(holder).toBe(9n * WAD);
    const operatorDiem = diemOut - holder;
    expect(operatorDiem).toBe(1n * WAD);
    // Σ DIEMCredited ≠ Σ YieldRouted.diem
    expect(holder).not.toBe(diemOut);
  });

  it("DIEMCredited + WstDIEMCredited.diem ≈ YieldRouted.diem per routeYield", () => {
    const diemOut = 10n * WAD;
    const holder = holderDiemFromYieldRouted(diemOut, 1000);
    const operatorDiem = diemOut - holder;
    expect(holder + operatorDiem).toBe(diemOut);
  });
});

describe("SPEC009 §7.3 inference-share headline + tolerance", () => {
  it("uses S_start not end supply; identity holds on no-rounding synthetic", () => {
    // S_start = 100 WAD shares; ΔNAV = 0.01 WAD → realized = 1 DIEM
    const sStart = 100n * WAD;
    const navStart = WAD;
    const navEnd = WAD + WAD / 100n; // +1%
    const total = totalRealizedHolderYieldDiem(navStart, navEnd, sStart);
    expect(total).toBe(1n * WAD);

    // End supply larger would wrongly inflate if used — prove S_start path:
    const wrongEnd = totalRealizedHolderYieldDiem(navStart, navEnd, 200n * WAD);
    expect(wrongEnd).toBe(2n * WAD);
    expect(total).not.toBe(wrongEnd);

    // 50% inference after 0 fee
    const diemCredited = WAD / 2n;
    const headline = computeInferenceShareHeadline({
      navStart,
      navEnd,
      sStart,
      diemCreditedSum: diemCredited,
      yieldFeeBps: 0,
      treasuryActive: false,
      toleranceBps: DEFAULT_INFERENCE_RECONCILE_TOLERANCE_BPS,
    });
    expect(headline.status).toBe("ok");
    expect(headline.inferenceShareBpsMid).toBe(5000); // 50%
    expect(headline.inferenceSharePctMid).toBe("50.00");
    // Band ±500 bps → 45–55%
    expect(headline.inferenceSharePctLow).toBe("45.00");
    expect(headline.inferenceSharePctHigh).toBe("55.00");
    expect(headline.residualDiem).toBe((WAD / 2n).toString());
  });

  it("applies yieldFeeBps dilution factor when treasury active", () => {
    const sStart = 100n * WAD;
    const navStart = WAD;
    const navEnd = WAD + WAD / 100n;
    const diemCredited = WAD; // would be 100% before fee
    const diluted = inferenceAttributableAfterYieldFee(diemCredited, 500, true);
    expect(diluted).toBe((WAD * 9500n) / 10_000n);
    const headline = computeInferenceShareHeadline({
      navStart,
      navEnd,
      sStart,
      diemCreditedSum: diemCredited,
      yieldFeeBps: 500,
      treasuryActive: true,
      toleranceBps: 500,
    });
    // 0.95 / 1.0 = 95%
    expect(headline.inferenceShareBpsMid).toBe(9500);
  });

  it("fails closed to n/a when treasury active but yieldFeeBps read failed (§5 honesty)", () => {
    const headline = computeInferenceShareHeadline({
      navStart: WAD,
      navEnd: WAD + WAD / 100n,
      sStart: 100n * WAD,
      diemCreditedSum: WAD,
      yieldFeeBps: null, // live read threw
      treasuryActive: true, // ...but the fee IS active → dilution unknown
      toleranceBps: 500,
    });
    // Must NOT silently apply factor 1.0 (which would over-report the share by up to yieldFeeBps).
    expect(headline.status).toBe("n/a");
    expect(headline.reason).toBe("yield-fee-unavailable");
    expect(headline.inferenceShareBpsMid).toBeNull();
  });

  it("null yieldFeeBps is harmless when treasury inactive (no fee applies)", () => {
    const headline = computeInferenceShareHeadline({
      navStart: WAD,
      navEnd: WAD + WAD / 100n,
      sStart: 100n * WAD,
      diemCreditedSum: WAD,
      yieldFeeBps: null,
      treasuryActive: false,
      toleranceBps: 500,
    });
    expect(headline.status).toBe("ok");
    expect(headline.inferenceShareBpsMid).toBe(10_000); // full amount, no dilution
  });

  it("tolerance default is 500 bps; boundary clamp to [0,100]", () => {
    expect(DEFAULT_INFERENCE_RECONCILE_TOLERANCE_BPS).toBe(500);
    expect(DEFAULT_CONFIG.thresholds.inferenceReconcileToleranceBps).toBe(500);
    const headline = computeInferenceShareHeadline({
      navStart: WAD,
      navEnd: WAD + WAD / 100n,
      sStart: 100n * WAD,
      diemCreditedSum: 0n,
      yieldFeeBps: 0,
      treasuryActive: false,
      toleranceBps: 500,
    });
    // 0% mid → low clamps at 0, high at 5%
    expect(headline.inferenceSharePctLow).toBe("0.00");
    expect(headline.inferenceSharePctHigh).toBe("5.00");
  });

  it("honest low inference share when most yield is base-staking", () => {
    const sStart = 100n * WAD;
    const navStart = WAD;
    const navEnd = WAD + WAD / 100n; // 1 DIEM total realized
    const diemCredited = WAD / 20n; // 5% of realized
    const headline = computeInferenceShareHeadline({
      navStart,
      navEnd,
      sStart,
      diemCreditedSum: diemCredited,
      yieldFeeBps: 0,
      treasuryActive: false,
      toleranceBps: 500,
    });
    expect(headline.status).toBe("ok");
    expect(headline.inferenceShareBpsMid).toBe(500); // 5%
    expect(Number(headline.inferenceSharePctMid)).toBeLessThan(10);
  });
});

describe("SPEC009 §7.4 trust-tier labeling", () => {
  it("SettlementReceived never under inference volume/demand keys; DIEMCredited is Tier-1", () => {
    const flows = buildInferenceFlows({
      credits: [
        {
          txHash: "0x1",
          logIndex: 0,
          blockNumber: 10n,
          timestamp: 1000,
          kind: "DIEMCredited",
          adapter: ADAPTER,
          amountDiem: WAD,
        },
      ],
      settlements: [
        {
          txHash: "0x1",
          logIndex: 1,
          blockNumber: 10n,
          timestamp: 1000,
          kind: "SettlementReceived",
          adapter: ADAPTER,
          usdcAmount: 1_000_000n,
        },
      ],
      nowSeconds: 2000,
      windowSeconds: 1500,
      configAdapters: [{ address: ADAPTER, name: "Surplus" }],
      navStart: WAD,
      navEnd: WAD + WAD / 100n,
      sStart: 100n * WAD,
      yieldFeeBps: 0,
      treasuryActive: false,
      firstSeenBlock: 10n,
    });
    expect(flows.available).toBe(true);
    expect(flows.aggregate.diemCredited).toBe(WAD.toString());
    expect(flows.aggregate.usdcSettledAsReported).toBe("1000000");
    expect(flows.adapters[0]?.trustLabels).toContain("tier1-diem-credited-chain-proven");
    expect(flows.adapters[0]?.trustLabels).toContain("usdc-settled-not-inference-volume");
    const json = JSON.parse(stringifyJson(flows)) as Record<string, unknown>;
    expect(json).not.toHaveProperty("inferenceVolume");
    expect(json).not.toHaveProperty("demand");
    expect(json.aggregate).toHaveProperty("usdcSettledAsReported");
    expect(json.aggregate).toHaveProperty("diemCredited");
    expect(() => assertNoForbiddenSettlementKeys(json)).not.toThrow();
  });
});

describe("SPEC009 §7.5 X402 permissionless", () => {
  it("flags unrestricted-path on X402-named adapter settlements", () => {
    const flows = buildInferenceFlows({
      credits: [],
      settlements: [
        {
          txHash: "0x2",
          logIndex: 0,
          blockNumber: 11n,
          timestamp: 1000,
          kind: "SettlementReceived",
          adapter: X402,
          usdcAmount: 5_000_000n,
        },
      ],
      nowSeconds: 2000,
      windowSeconds: 1500,
      configAdapters: [{ address: X402, name: "X402Adapter" }],
      liveMeta: [
        {
          address: X402,
          name: "X402Adapter",
          isVenueAdapter: true,
          operatorFeeBps: 1000,
          unroutedUsdc: 5_000_000n,
        },
      ],
      navStart: null,
      navEnd: null,
      sStart: null,
      yieldFeeBps: null,
      treasuryActive: false,
      firstSeenBlock: 11n,
    });
    const a = flows.adapters.find((x) => x.address.toLowerCase() === X402.toLowerCase());
    expect(a?.trustLabels).toContain("x402-permissionless-settlement-path");
    expect(a?.trustLabels).toContain("unrestricted-path");
    expect(a?.usdcSettledAsReported).toBe("5000000");
  });
});

describe("SPEC009 §7.6 min-events gate", () => {
  it("below MIN_DEMAND_WINDOW_SAMPLES → velocity n/a; raw settlements still shown", () => {
    const settlements: StoredInferenceSettlement[] = [
      {
        txHash: "0x3",
        logIndex: 0,
        blockNumber: 1n,
        timestamp: 1900,
        kind: "SettlementReceived",
        adapter: ADAPTER,
        usdcAmount: 1_000_000n,
      },
    ];
    const v = buildFlowVelocity({
      credits: [],
      settlements,
      nowSeconds: 2000,
      windowSeconds: 500,
      minEvents: MIN_DEMAND_WINDOW_SAMPLES,
    });
    expect(v.status).toBe("n/a");
    expect(v.usdcSettledAsReportedCurrent).toBe("1000000");
    expect(v.currentFlowEventCount).toBe(1);
  });

  it("at threshold → velocity ok (boundary)", () => {
    const settlements: StoredInferenceSettlement[] = [
      {
        txHash: "0x4",
        logIndex: 0,
        blockNumber: 1n,
        timestamp: 1600,
        kind: "SettlementReceived",
        adapter: ADAPTER,
        usdcAmount: 1n,
      },
      {
        txHash: "0x5",
        logIndex: 0,
        blockNumber: 2n,
        timestamp: 1700,
        kind: "SettlementReceived",
        adapter: ADAPTER,
        usdcAmount: 2n,
      },
    ];
    const v = buildFlowVelocity({
      credits: [],
      settlements,
      nowSeconds: 2000,
      windowSeconds: 500,
      minEvents: MIN_DEMAND_WINDOW_SAMPLES,
    });
    expect(MIN_DEMAND_WINDOW_SAMPLES).toBe(2);
    expect(v.currentFlowEventCount).toBe(2);
    expect(v.status).toBe("ok");
  });
});

describe("SPEC009 §7.7–7.9 backfill M3/M4/M5 + reorg", () => {
  function inferenceConfig(): AppConfig {
    return {
      ...DEFAULT_CONFIG,
      contracts: {
        ...DEFAULT_CONFIG.contracts,
        feeRouter: null,
        inferenceVault: VAULT,
        venueAdapters: [{ address: ADAPTER, name: "Surplus" }],
      },
    };
  }

  it("M4: existing cursor → near-tip fromBlock (no 302k lookback)", () => {
    const storage = new MemoryStorage();
    storage.setMeta("lastProcessedBlock", "1000000");
    const range = resolveBackfillRange({
      storage,
      finalizedBlock: 1_000_050n,
    });
    expect(range.fromBlock).toBe(1_000_000n - REORG_SAFETY_OVERLAP_BLOCKS);
    expect(range.fromBlock).toBeGreaterThan(1_000_050n - INITIAL_BACKFILL_LOOKBACK_BLOCKS);
  });

  it("M3: feeRouter null still persists inference events", async () => {
    const storage = new MemoryStorage();
    const logs = [
      diemCreditedLog({
        adapter: ADAPTER,
        amount: 2n * WAD,
        blockNumber: 100n,
        logIndex: 0,
        txHash: "0xaaa",
      }),
      settlementLog({
        adapter: ADAPTER,
        amount: 1_000_000n,
        blockNumber: 100n,
        logIndex: 1,
        txHash: "0xaaa",
      }),
    ];
    const result = await backfillCreditAndHarvestEvents({
      config: inferenceConfig(),
      client: new MemClient(logs, { "100": 1_700_000_100 }),
      storage,
      finalizedBlock: 120n,
      fromBlock: 90n,
    });
    expect(result.inferenceCreditEvents).toBe(1);
    expect(result.inferenceSettlementEvents).toBe(1);
    expect(storage.getMeta("lastProcessedBlock")).toBe("120");
  });

  it("idempotency + reorg: rescan replaces by (tx_hash, log_index), no double-count", async () => {
    const storage = new MemoryStorage();
    const log = diemCreditedLog({
      adapter: ADAPTER,
      amount: WAD,
      blockNumber: 100n,
      logIndex: 0,
      txHash: "0xreorg",
    });
    const client = new MemClient([log], { "100": 1_700_000_100 });
    await backfillCreditAndHarvestEvents({
      config: inferenceConfig(),
      client,
      storage,
      finalizedBlock: 120n,
      fromBlock: 90n,
    });
    // Reorged amount in same key
    const log2 = diemCreditedLog({
      adapter: ADAPTER,
      amount: 3n * WAD,
      blockNumber: 100n,
      logIndex: 0,
      txHash: "0xreorg",
    });
    await backfillCreditAndHarvestEvents({
      config: inferenceConfig(),
      client: new MemClient([log2], { "100": 1_700_000_100 }),
      storage,
      finalizedBlock: 120n,
      fromBlock: 90n,
    });
    expect(storage.credits).toHaveLength(1);
    expect(storage.credits[0]?.amountDiem).toBe(3n * WAD);
  });

  it("SQLite INSERT OR REPLACE is idempotent on (tx_hash, log_index)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wstdiem-inf-"));
    const db = join(dir, "t.sqlite");
    try {
      const store = new Storage(db);
      const event: StoredInferenceCredit = {
        txHash: "0xabc",
        logIndex: 1,
        blockNumber: 10n,
        timestamp: 100,
        kind: "DIEMCredited",
        adapter: ADAPTER,
        amountDiem: WAD,
      };
      store.insertInferenceCredit(event);
      store.insertInferenceCredit({ ...event, amountDiem: 2n * WAD });
      const listed = store.listInferenceCreditsSince(0);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.amountDiem).toBe(2n * WAD);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SPEC009 §7.10 unrouted USDC", () => {
  it("adapter with SettlementReceived, no YieldRouted, holding USDC → non-zero state-fact label", () => {
    const flows = buildInferenceFlows({
      credits: [],
      settlements: [
        {
          txHash: "0xu",
          logIndex: 0,
          blockNumber: 5n,
          timestamp: 1000,
          kind: "SettlementReceived",
          adapter: ADAPTER,
          usdcAmount: 7_000_000n,
        },
      ],
      nowSeconds: 2000,
      windowSeconds: 1500,
      configAdapters: [{ address: ADAPTER }],
      liveMeta: [
        {
          address: ADAPTER,
          name: "Surplus",
          isVenueAdapter: true,
          operatorFeeBps: 1000,
          unroutedUsdc: 7_000_000n,
        },
      ],
      navStart: null,
      navEnd: null,
      sStart: null,
      yieldFeeBps: null,
      treasuryActive: false,
      firstSeenBlock: 5n,
    });
    expect(flows.available).toBe(true);
    expect(flows.aggregate.usdcSettledAsReported).toBe("7000000");
    expect(flows.aggregate.unroutedUsdcTotal).toBe("7000000");
    expect(flows.aggregate.diemCredited).toBe("0");
    expect(flows.caveats.some((c) => c.includes("unrouted-usdc") || c.includes("zero-diem-credited"))).toBe(
      true,
    );
    // Must not report the window as zero-everything collapse
    expect(flows.reason).not.toBe("no-events-no-unrouted-usdc");
  });
});

describe("SPEC009 totalSupply persistence (S_start)", () => {
  it("collector path + sqlite round-trip totalSupply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wstdiem-ts-"));
    const db = join(dir, "t.sqlite");
    try {
      const store = new Storage(db);
      const snap = makeEmptySnapshot(1000);
      snap.nav = WAD + 10n ** 15n;
      snap.vaultTotalAssetsDiem = 100n * WAD;
      snap.totalSupply = 80n * WAD;
      store.insertMetricSnapshot(snap);
      const list = store.listNavSamplesForWindow(900);
      expect(list[0]?.totalSupply).toBe(80n * WAD);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SPEC009 §7.11 CLI --json parity + without --flows unchanged", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function offlineEnv(dbPath: string): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.BASE_RPC_URL;
    delete env.BASE_RPC_URL_FALLBACK_1;
    delete env.BASE_RPC_URL_FALLBACK_2;
    const cfg = join(dirs[dirs.length - 1]!, "config.yaml");
    writeFileSync(
      cfg,
      [
        "storage:",
        `  sqlitePath: "${dbPath}"`,
        "rpc:",
        "  primaryUrl: null",
        "  fallbackUrls: []",
      ].join("\n"),
    );
    return env;
  }

  it("loop demand without --flows has no flows key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wstdiem-cli-demand-"));
    dirs.push(dir);
    const dbPath = join(dir, "t.sqlite");
    const store = new Storage(dbPath);
    const snap = makeEmptySnapshot(Math.floor(Date.now() / 1000) - 86_400);
    snap.nav = WAD;
    snap.vaultTotalAssetsDiem = 10n * WAD;
    snap.totalSupply = 10n * WAD;
    store.insertMetricSnapshot(snap);
    const snap2 = makeEmptySnapshot(Math.floor(Date.now() / 1000));
    snap2.nav = WAD + 10n ** 15n;
    snap2.vaultTotalAssetsDiem = 10n * WAD;
    snap2.totalSupply = 10n * WAD;
    store.insertMetricSnapshot(snap2);
    store.close();

    const env = offlineEnv(dbPath);
    const { stdout } = await execFileAsync(
      "node",
      [
        "--import",
        "tsx",
        "src/cli/index.ts",
        "--config",
        join(dir, "config.yaml"),
        "--json",
        "loop",
        "demand",
        "--window-hours",
        "72",
      ],
      { env, cwd: process.cwd() },
    );
    const parsed = JSON.parse(stdout) as { data?: Record<string, unknown> };
    expect(parsed.data).toBeDefined();
    expect(parsed.data).not.toHaveProperty("flows");
    expect(parsed.data).toHaveProperty("demandKind");
  });

  it("loop demand --flows --json exposes data.flows with string fields", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wstdiem-cli-flows-"));
    dirs.push(dir);
    const dbPath = join(dir, "t.sqlite");
    const now = Math.floor(Date.now() / 1000);
    const store = new Storage(dbPath);
    const snap = makeEmptySnapshot(now - 86_400);
    snap.nav = WAD;
    snap.vaultTotalAssetsDiem = 100n * WAD;
    snap.totalSupply = 100n * WAD;
    store.insertMetricSnapshot(snap);
    const snap2 = makeEmptySnapshot(now);
    snap2.nav = WAD + WAD / 100n;
    snap2.vaultTotalAssetsDiem = 101n * WAD;
    snap2.totalSupply = 100n * WAD;
    store.insertMetricSnapshot(snap2);
    store.insertInferenceCredit({
      txHash: "0xflow1",
      logIndex: 0,
      blockNumber: 99n,
      timestamp: now - 3600,
      kind: "DIEMCredited",
      adapter: ADAPTER,
      amountDiem: WAD / 2n,
    });
    store.insertInferenceSettlement({
      txHash: "0xflow1",
      logIndex: 1,
      blockNumber: 99n,
      timestamp: now - 3600,
      kind: "SettlementReceived",
      adapter: ADAPTER,
      usdcAmount: 1_000_000n,
    });
    store.close();

    const env = offlineEnv(dbPath);
    // Seed venue adapter in config so adapter table can resolve
    writeFileSync(
      join(dir, "config.yaml"),
      [
        "storage:",
        `  sqlitePath: "${dbPath}"`,
        "rpc:",
        "  primaryUrl: null",
        "  fallbackUrls: []",
        "contracts:",
        "  venueAdapters:",
        `    - address: "${ADAPTER}"`,
        '      name: "Surplus"',
      ].join("\n"),
    );

    const { stdout } = await execFileAsync(
      "node",
      [
        "--import",
        "tsx",
        "src/cli/index.ts",
        "--config",
        join(dir, "config.yaml"),
        "--json",
        "loop",
        "demand",
        "--flows",
        "--window-hours",
        "72",
      ],
      { env, cwd: process.cwd() },
    );
    const parsed = JSON.parse(stdout) as {
      data?: {
        flows?: {
          aggregate: {
            diemCredited: string;
            usdcSettledAsReported: string;
          };
          inferenceShare: { inferenceSharePctMid: string | null };
        };
      };
    };
    expect(parsed.data?.flows).toBeDefined();
    expect(typeof parsed.data?.flows?.aggregate.diemCredited).toBe("string");
    expect(typeof parsed.data?.flows?.aggregate.usdcSettledAsReported).toBe("string");
    expect(parsed.data?.flows?.aggregate.diemCredited).toBe((WAD / 2n).toString());
    expect(parsed.data?.flows).not.toHaveProperty("inferenceVolume");
    expect(() => assertNoForbiddenSettlementKeys(parsed.data?.flows)).not.toThrow();
  });
});

describe("topic hashes stable", () => {
  it("event topics match expected signatures", () => {
    expect(toEventHash("DIEMCredited(address,uint256)")).toMatch(/^0x/);
    expect(toEventHash("SettlementReceived(uint256)")).toMatch(/^0x/);
    expect(toEventHash("YieldRouted(uint256,uint256,uint256)")).toMatch(/^0x/);
  });
});
