import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { erc20TransferEventAbi } from "../src/abi/erc20.js";
import { feeRouterHarvestEventAbis } from "../src/abi/feeRouter.js";
import {
  INITIAL_BACKFILL_LOOKBACK_BLOCKS,
  REORG_SAFETY_OVERLAP_BLOCKS,
  backfillCreditAndHarvestEvents,
  type BackfillBlock,
  type BackfillClient,
  type BackfillLog,
  type BackfillStorage,
} from "../src/metrics/backfill.js";
import { WAD } from "../src/metrics/math.js";
import type { Address, AppConfig, Hex, StoredCreditEvent, StoredHarvestEvent } from "../src/types/domain.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";

const DIEM = "0x0000000000000000000000000000000000000001";
const FEE_ROUTER = "0x0000000000000000000000000000000000000002";
const INFERENCE_VAULT = "0x0000000000000000000000000000000000000003";
const OTHER = "0x0000000000000000000000000000000000000004";

class MemoryBackfillStorage implements BackfillStorage {
  readonly meta = new Map<string, string>();
  readonly creditEvents: StoredCreditEvent[] = [];
  readonly harvestEvents: StoredHarvestEvent[] = [];
  readonly inferenceCredits: import("../src/types/domain.js").StoredInferenceCredit[] = [];
  readonly inferenceSettlements: import("../src/types/domain.js").StoredInferenceSettlement[] = [];

  getMeta(key: string): string | null {
    return this.meta.get(key) ?? null;
  }

  setMeta(key: string, value: string): void {
    this.meta.set(key, value);
  }

  insertCreditEvent(event: StoredCreditEvent): void {
    this.creditEvents.push(event);
  }

  insertHarvestEvent(event: StoredHarvestEvent): void {
    this.harvestEvents.push(event);
  }

  insertInferenceCredit(event: import("../src/types/domain.js").StoredInferenceCredit): void {
    this.inferenceCredits.push(event);
  }

  insertInferenceSettlement(event: import("../src/types/domain.js").StoredInferenceSettlement): void {
    this.inferenceSettlements.push(event);
  }
}

class FailingCreditStorage extends MemoryBackfillStorage {
  insertCreditEvent(_event: StoredCreditEvent): void {
    throw new Error("sqlite busy");
  }
}

class MemoryBackfillClient implements BackfillClient {
  constructor(
    private readonly logs: BackfillLog[],
    private readonly timestamps: Record<string, number>,
    private readonly failBlocks = new Set<bigint>(),
  ) {}

  async getLogs(args: { address: Address; fromBlock: bigint; toBlock: bigint }): Promise<BackfillLog[]> {
    return this.logs.filter(
      (log) =>
        log.address.toLowerCase() === args.address.toLowerCase() &&
        log.blockNumber >= args.fromBlock &&
        log.blockNumber <= args.toBlock,
    );
  }

  async getBlock(args: { blockNumber: bigint }): Promise<BackfillBlock> {
    if (this.failBlocks.has(args.blockNumber)) {
      throw new Error("block read failed");
    }
    return { timestamp: this.timestamps[args.blockNumber.toString()] ?? Number(args.blockNumber) };
  }
}

function completeConfig(): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    contracts: {
      ...DEFAULT_CONFIG.contracts,
      diem: DIEM,
      feeRouter: FEE_ROUTER,
      inferenceVault: INFERENCE_VAULT,
    },
  };
}

function transferLog(args: {
  from: Address;
  to: Address;
  value: bigint;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
}): BackfillLog {
  return {
    address: DIEM,
    blockNumber: args.blockNumber,
    logIndex: args.logIndex,
    transactionHash: args.txHash,
    topics: encodeEventTopics({
      abi: [erc20TransferEventAbi],
      eventName: "Transfer",
      args: { from: args.from, to: args.to },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [args.value]),
  };
}

function vvvHarvestLog(args: {
  vvvIn: bigint;
  diemCredited: bigint;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
}): BackfillLog {
  return {
    address: FEE_ROUTER,
    blockNumber: args.blockNumber,
    logIndex: args.logIndex,
    transactionHash: args.txHash,
    topics: encodeEventTopics({
      abi: feeRouterHarvestEventAbis,
      eventName: "VVVHarvested",
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [args.vvvIn, args.diemCredited]),
  };
}

describe("credit and harvest event backfill", () => {
  it("persists FeeRouter DIEM transfer credits and VVV harvest credits", async () => {
    const storage = new MemoryBackfillStorage();
    const client = new MemoryBackfillClient(
      [
        transferLog({
          from: FEE_ROUTER,
          to: INFERENCE_VAULT,
          value: 5n * WAD,
          blockNumber: 100n,
          logIndex: 1,
          txHash: "0xaaa",
        }),
        transferLog({
          from: OTHER,
          to: INFERENCE_VAULT,
          value: 99n * WAD,
          blockNumber: 101n,
          logIndex: 2,
          txHash: "0xaab",
        }),
        vvvHarvestLog({
          vvvIn: 3n * WAD,
          diemCredited: 7n * WAD,
          blockNumber: 102n,
          logIndex: 3,
          txHash: "0xaac",
        }),
      ],
      { "100": 1_700_000_100, "102": 1_700_000_102 },
    );

    const result = await backfillCreditAndHarvestEvents({
      config: completeConfig(),
      client,
      storage,
      finalizedBlock: 120n,
      fromBlock: 90n,
    });

    expect(result).toMatchObject({
      fromBlock: 90n,
      toBlock: 120n,
      creditEvents: 2,
      harvestEvents: 1,
      readiness: [],
    });
    expect(storage.creditEvents).toEqual([
      {
        txHash: "0xaaa",
        logIndex: 1,
        blockNumber: 100n,
        timestamp: 1_700_000_100,
        source: "diem-transfer",
        amountDiem: 5n * WAD,
      },
      {
        txHash: "0xaac",
        logIndex: 3,
        blockNumber: 102n,
        timestamp: 1_700_000_102,
        source: "vvv-harvest",
        amountDiem: 7n * WAD,
      },
    ]);
    expect(storage.harvestEvents).toEqual([
      {
        txHash: "0xaac",
        logIndex: 3,
        blockNumber: 102n,
        timestamp: 1_700_000_102,
        eventName: "VVVHarvested",
        tokenIn: "VVV",
        amountIn: 3n * WAD,
        amountOut: 7n * WAD,
      },
    ]);
    expect(storage.getMeta("lastProcessedBlock")).toBe("120");
  });

  it("replays a short overlap from the saved cursor for reorg safety", async () => {
    const storage = new MemoryBackfillStorage();
    storage.setMeta("lastProcessedBlock", "200");

    const result = await backfillCreditAndHarvestEvents({
      config: completeConfig(),
      client: new MemoryBackfillClient([], {}),
      storage,
      finalizedBlock: 250n,
    });

    expect(result.fromBlock).toBe(200n - REORG_SAFETY_OVERLAP_BLOCKS);
    expect(result.toBlock).toBe(250n);
    expect(storage.getMeta("lastProcessedBlock")).toBe("250");
  });

  it("uses a bounded initial lookback when no cursor exists", async () => {
    const storage = new MemoryBackfillStorage();

    const result = await backfillCreditAndHarvestEvents({
      config: completeConfig(),
      client: new MemoryBackfillClient([], {}),
      storage,
      finalizedBlock: 400_000n,
    });

    expect(result.fromBlock).toBe(400_000n - INITIAL_BACKFILL_LOOKBACK_BLOCKS);
    expect(result.toBlock).toBe(400_000n);
    expect(storage.getMeta("lastProcessedBlock")).toBe("400000");
  });

  it("does not double-count a VVV harvest when the same transaction has a canonical DIEM transfer", async () => {
    const storage = new MemoryBackfillStorage();
    const client = new MemoryBackfillClient(
      [
        transferLog({
          from: FEE_ROUTER,
          to: INFERENCE_VAULT,
          value: 7n * WAD,
          blockNumber: 100n,
          logIndex: 1,
          txHash: "0xddd",
        }),
        vvvHarvestLog({
          vvvIn: 3n * WAD,
          diemCredited: 7n * WAD,
          blockNumber: 100n,
          logIndex: 2,
          txHash: "0xddd",
        }),
      ],
      { "100": 1_700_000_100 },
    );

    const result = await backfillCreditAndHarvestEvents({
      config: completeConfig(),
      client,
      storage,
      finalizedBlock: 120n,
      fromBlock: 90n,
    });

    expect(result.creditEvents).toBe(1);
    expect(result.harvestEvents).toBe(1);
    expect(storage.creditEvents).toEqual([
      {
        txHash: "0xddd",
        logIndex: 1,
        blockNumber: 100n,
        timestamp: 1_700_000_100,
        source: "diem-transfer",
        amountDiem: 7n * WAD,
      },
    ]);
    expect(storage.harvestEvents).toHaveLength(1);
  });

  it("does not advance the cursor when no backfill targets are configured", async () => {
    const storage = new MemoryBackfillStorage();
    const config = completeConfig();
    config.contracts.feeRouter = null;
    config.contracts.inferenceVault = null;
    config.contracts.venueAdapters = [];

    const result = await backfillCreditAndHarvestEvents({
      config,
      client: new MemoryBackfillClient([], {}),
      storage,
      finalizedBlock: 250n,
    });

    expect(result.creditEvents).toBe(0);
    expect(result.harvestEvents).toBe(0);
    expect(result.inferenceCreditEvents).toBe(0);
    expect(result.readiness[0]).toMatch(/required for event backfill/);
    expect(storage.getMeta("lastProcessedBlock")).toBeNull();
  });

  it("SPEC009 M3: feeRouter null still accrues inference events when vault+adapters set", async () => {
    const ADAPTER = "0x00000000000000000000000000000000000000aa" as Address;
    const storage = new MemoryBackfillStorage();
    const config = completeConfig();
    config.contracts.feeRouter = null;
    config.contracts.venueAdapters = [{ address: ADAPTER, name: "Surplus" }];

    const { inferenceVaultEventAbis } = await import("../src/abi/inferenceVault.js");
    const { inferenceAdapterEventAbis } = await import("../src/abi/inferenceAdapter.js");

    const diemCreditedLog: BackfillLog = {
      address: INFERENCE_VAULT,
      blockNumber: 100n,
      logIndex: 0,
      transactionHash: "0xinf1",
      topics: encodeEventTopics({
        abi: inferenceVaultEventAbis,
        eventName: "DIEMCredited",
        args: { adapter: ADAPTER },
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters([{ type: "uint256" }], [5n * WAD]),
    };
    const settlementLog: BackfillLog = {
      address: ADAPTER,
      blockNumber: 100n,
      logIndex: 1,
      transactionHash: "0xinf1",
      topics: encodeEventTopics({
        abi: inferenceAdapterEventAbis,
        eventName: "SettlementReceived",
      }) as [Hex, ...Hex[]],
      data: encodeAbiParameters([{ type: "uint256" }], [1_000_000n]),
    };

    const result = await backfillCreditAndHarvestEvents({
      config,
      client: new MemoryBackfillClient([diemCreditedLog, settlementLog], { "100": 1_700_000_100 }),
      storage,
      finalizedBlock: 120n,
      fromBlock: 90n,
    });

    expect(result.creditEvents).toBe(0);
    expect(result.harvestEvents).toBe(0);
    expect(result.inferenceCreditEvents).toBe(1);
    expect(result.inferenceSettlementEvents).toBe(1);
    expect(result.readiness.some((r) => r.includes("feeRouter null"))).toBe(true);
    expect(storage.getMeta("lastProcessedBlock")).toBe("120");
    expect(storage.inferenceCredits[0]?.amountDiem).toBe(5n * WAD);
    expect(storage.inferenceSettlements[0]?.usdcAmount).toBe(1_000_000n);
  });

  it("blocks on corrupt cursor metadata instead of skipping history", async () => {
    const storage = new MemoryBackfillStorage();
    storage.setMeta("lastProcessedBlock", "not-a-block");

    const result = await backfillCreditAndHarvestEvents({
      config: completeConfig(),
      client: new MemoryBackfillClient([], {}),
      storage,
      finalizedBlock: 250n,
    });

    expect(result.fromBlock).toBe(0n);
    expect(result.readiness).toEqual(["invalid lastProcessedBlock cursor blocks event backfill: not-a-block"]);
    expect(storage.getMeta("lastProcessedBlock")).toBe("not-a-block");
  });

  it("does not advance the cursor when event reads or writes fail", async () => {
    const log = transferLog({
      from: FEE_ROUTER,
      to: INFERENCE_VAULT,
      value: 5n * WAD,
      blockNumber: 100n,
      logIndex: 1,
      txHash: "0xaaa",
    });
    const readFailureStorage = new MemoryBackfillStorage();
    await expect(
      backfillCreditAndHarvestEvents({
        config: completeConfig(),
        client: new MemoryBackfillClient([log], {}, new Set([100n])),
        storage: readFailureStorage,
        finalizedBlock: 120n,
        fromBlock: 90n,
      }),
    ).rejects.toThrow(/block read failed/);
    expect(readFailureStorage.getMeta("lastProcessedBlock")).toBeNull();

    const writeFailureStorage = new FailingCreditStorage();
    await expect(
      backfillCreditAndHarvestEvents({
        config: completeConfig(),
        client: new MemoryBackfillClient([log], { "100": 1_700_000_100 }),
        storage: writeFailureStorage,
        finalizedBlock: 120n,
        fromBlock: 90n,
      }),
    ).rejects.toThrow(/sqlite busy/);
    expect(writeFailureStorage.getMeta("lastProcessedBlock")).toBeNull();
  });
});
