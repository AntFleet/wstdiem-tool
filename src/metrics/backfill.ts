import { decodeEventLog, toEventHash } from "viem";
import { erc20TransferEventAbi } from "../abi/erc20.js";
import { feeRouterHarvestEventAbis } from "../abi/feeRouter.js";
import { inferenceAdapterEventAbis } from "../abi/inferenceAdapter.js";
import { inferenceVaultEventAbis } from "../abi/inferenceVault.js";
import type {
  Address,
  AppConfig,
  Hex,
  StoredCreditEvent,
  StoredHarvestEvent,
  StoredInferenceCredit,
  StoredInferenceSettlement,
} from "../types/domain.js";

export const REORG_SAFETY_OVERLAP_BLOCKS = 20n;
export const INITIAL_BACKFILL_LOOKBACK_BLOCKS = 302_400n;

const TRANSFER_TOPIC = toEventHash("Transfer(address,address,uint256)");
const HARVEST_TOPICS = new Set<Hex>([
  toEventHash("WETHHarvested(uint256,uint256)"),
  toEventHash("WstDIEMHarvested(uint256)"),
  toEventHash("VVVHarvested(uint256,uint256)"),
]);
const DIEM_CREDITED_TOPIC = toEventHash("DIEMCredited(address,uint256)");
const WSTDIEM_CREDITED_TOPIC = toEventHash("WstDIEMCredited(address,address,uint256,uint256)");
const SETTLEMENT_RECEIVED_TOPIC = toEventHash("SettlementReceived(uint256)");
const YIELD_ROUTED_TOPIC = toEventHash("YieldRouted(uint256,uint256,uint256)");

export interface BackfillLog {
  address: Address;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
  topics: [] | [Hex, ...Hex[]];
  data: Hex;
}

export interface BackfillBlock {
  timestamp: bigint | number;
}

export interface BackfillClient {
  getLogs(args: {
    address: Address;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<BackfillLog[]>;
  getBlock(args: { blockNumber: bigint }): Promise<BackfillBlock>;
}

export interface BackfillStorage {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  insertCreditEvent(event: StoredCreditEvent): void;
  insertHarvestEvent(event: StoredHarvestEvent): void;
  insertInferenceCredit?(event: StoredInferenceCredit): void;
  insertInferenceSettlement?(event: StoredInferenceSettlement): void;
}

export interface BackfillResult {
  fromBlock: bigint;
  toBlock: bigint;
  creditEvents: number;
  harvestEvents: number;
  inferenceCreditEvents: number;
  inferenceSettlementEvents: number;
  readiness: string[];
}

function blockTimestampSeconds(block: BackfillBlock): number {
  return typeof block.timestamp === "bigint" ? Number(block.timestamp) : Number(block.timestamp);
}

async function timestampFor(
  client: BackfillClient,
  cache: Map<bigint, number>,
  blockNumber: bigint,
): Promise<number> {
  const cached = cache.get(blockNumber);
  if (cached !== undefined) {
    return cached;
  }
  const timestamp = blockTimestampSeconds(await client.getBlock({ blockNumber }));
  cache.set(blockNumber, timestamp);
  return timestamp;
}

function decodeTransferCredit(config: AppConfig, log: BackfillLog): { amountDiem: bigint } | null {
  if (config.contracts.feeRouter === null || config.contracts.inferenceVault === null) {
    return null;
  }
  if (log.topics[0] !== TRANSFER_TOPIC) {
    return null;
  }
  const decoded = decodeEventLog({
    abi: [erc20TransferEventAbi],
    data: log.data,
    topics: log.topics,
    strict: false,
  });
  if (decoded.eventName !== "Transfer") {
    return null;
  }
  const args = decoded.args as { from?: Address; to?: Address; value?: bigint };
  if (
    args.from?.toLowerCase() !== config.contracts.feeRouter.toLowerCase() ||
    args.to?.toLowerCase() !== config.contracts.inferenceVault.toLowerCase() ||
    args.value === undefined
  ) {
    return null;
  }
  return { amountDiem: args.value };
}

function decodeHarvest(log: BackfillLog): {
  event: "WETHHarvested" | "WstDIEMHarvested" | "VVVHarvested";
  tokenIn?: string;
  amountIn?: bigint;
  amountOut?: bigint;
  creditDiem?: bigint;
} | null {
  if (log.topics[0] === undefined || !HARVEST_TOPICS.has(log.topics[0])) {
    return null;
  }
  const decoded = decodeEventLog({
    abi: feeRouterHarvestEventAbis,
    data: log.data,
    topics: log.topics,
    strict: false,
  });
  if (decoded.eventName === "WETHHarvested") {
    const args = decoded.args as { wethIn?: bigint; wstDIEMOut?: bigint };
    return {
      event: "WETHHarvested",
      tokenIn: "WETH",
      amountIn: args.wethIn,
      amountOut: args.wstDIEMOut,
    };
  }
  if (decoded.eventName === "WstDIEMHarvested") {
    const args = decoded.args as { amount?: bigint };
    return {
      event: "WstDIEMHarvested",
      tokenIn: "wstDIEM",
      amountIn: args.amount,
    };
  }
  if (decoded.eventName === "VVVHarvested") {
    const args = decoded.args as { vvvIn?: bigint; diemCredited?: bigint };
    return {
      event: "VVVHarvested",
      tokenIn: "VVV",
      amountIn: args.vvvIn,
      amountOut: args.diemCredited,
      creditDiem: args.diemCredited,
    };
  }
  return null;
}

export function decodeVaultInferenceLog(log: BackfillLog): StoredInferenceCredit | null {
  const topic = log.topics[0];
  if (topic === undefined) {
    return null;
  }
  if (topic === DIEM_CREDITED_TOPIC) {
    const decoded = decodeEventLog({
      abi: inferenceVaultEventAbis,
      data: log.data,
      topics: log.topics,
      strict: false,
    });
    if (decoded.eventName !== "DIEMCredited") {
      return null;
    }
    const args = decoded.args as { adapter?: Address; amount?: bigint };
    if (args.adapter === undefined || args.amount === undefined) {
      return null;
    }
    return {
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      timestamp: 0,
      kind: "DIEMCredited",
      adapter: args.adapter,
      amountDiem: args.amount,
    };
  }
  if (topic === WSTDIEM_CREDITED_TOPIC) {
    const decoded = decodeEventLog({
      abi: inferenceVaultEventAbis,
      data: log.data,
      topics: log.topics,
      strict: false,
    });
    if (decoded.eventName !== "WstDIEMCredited") {
      return null;
    }
    const args = decoded.args as {
      source?: Address;
      recipient?: Address;
      diem?: bigint;
      shares?: bigint;
    };
    if (args.source === undefined || args.diem === undefined) {
      return null;
    }
    return {
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      timestamp: 0,
      kind: "WstDIEMCredited",
      adapter: args.source,
      amountDiem: args.diem,
      shares: args.shares,
    };
  }
  return null;
}

export function decodeAdapterSettlementLog(
  log: BackfillLog,
  adapter: Address,
): StoredInferenceSettlement | null {
  const topic = log.topics[0];
  if (topic === undefined) {
    return null;
  }
  if (topic === SETTLEMENT_RECEIVED_TOPIC) {
    const decoded = decodeEventLog({
      abi: inferenceAdapterEventAbis,
      data: log.data,
      topics: log.topics,
      strict: false,
    });
    if (decoded.eventName !== "SettlementReceived") {
      return null;
    }
    const args = decoded.args as { amount?: bigint };
    if (args.amount === undefined) {
      return null;
    }
    return {
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      timestamp: 0,
      kind: "SettlementReceived",
      adapter,
      usdcAmount: args.amount,
    };
  }
  if (topic === YIELD_ROUTED_TOPIC) {
    const decoded = decodeEventLog({
      abi: inferenceAdapterEventAbis,
      data: log.data,
      topics: log.topics,
      strict: false,
    });
    if (decoded.eventName !== "YieldRouted") {
      return null;
    }
    const args = decoded.args as { usdc?: bigint; diem?: bigint; operatorShares?: bigint };
    if (args.usdc === undefined || args.diem === undefined) {
      return null;
    }
    return {
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      timestamp: 0,
      kind: "YieldRouted",
      adapter,
      usdcAmount: args.usdc,
      diemOut: args.diem,
      operatorShares: args.operatorShares,
    };
  }
  return null;
}

/**
 * Resolve the shared lastProcessedBlock cursor with reorg overlap.
 * Does not introduce a second cursor (SPEC009 M4).
 */
export function resolveBackfillRange(input: {
  storage: Pick<BackfillStorage, "getMeta">;
  finalizedBlock: bigint;
  fromBlock?: bigint;
}): {
  fromBlock: bigint;
  toBlock: bigint;
  readiness: string[];
  blocked: boolean;
} {
  const readiness: string[] = [];
  const lastProcessed = input.storage.getMeta("lastProcessedBlock");
  let lastProcessedBlock: bigint | null = null;
  if (lastProcessed !== null) {
    try {
      lastProcessedBlock = BigInt(lastProcessed);
    } catch {
      readiness.push(`invalid lastProcessedBlock cursor ignored: ${lastProcessed}`);
    }
  }
  if (lastProcessed !== null && lastProcessedBlock === null && input.fromBlock === undefined) {
    return {
      fromBlock: 0n,
      toBlock: input.finalizedBlock,
      readiness: [`invalid lastProcessedBlock cursor blocks event backfill: ${lastProcessed}`],
      blocked: true,
    };
  }
  const cursor =
    input.fromBlock ??
    (lastProcessedBlock === null
      ? input.finalizedBlock > INITIAL_BACKFILL_LOOKBACK_BLOCKS
        ? input.finalizedBlock - INITIAL_BACKFILL_LOOKBACK_BLOCKS
        : 0n
      : lastProcessedBlock > REORG_SAFETY_OVERLAP_BLOCKS
        ? lastProcessedBlock - REORG_SAFETY_OVERLAP_BLOCKS
        : 0n);
  const fromBlock = cursor > input.finalizedBlock ? input.finalizedBlock : cursor;
  return { fromBlock, toBlock: input.finalizedBlock, readiness, blocked: false };
}

export async function backfillCreditAndHarvestEvents(input: {
  config: AppConfig;
  client: BackfillClient;
  storage: BackfillStorage;
  finalizedBlock: bigint;
  fromBlock?: bigint;
}): Promise<BackfillResult> {
  const empty = (readiness: string[]): BackfillResult => ({
    fromBlock: 0n,
    toBlock: input.finalizedBlock,
    creditEvents: 0,
    harvestEvents: 0,
    inferenceCreditEvents: 0,
    inferenceSettlementEvents: 0,
    readiness,
  });

  const feeRouter = input.config.contracts.feeRouter;
  const inferenceVault = input.config.contracts.inferenceVault;
  const venueAdapters = input.config.contracts.venueAdapters ?? [];

  // SPEC009 M3: null feeRouter skips ONLY harvest/transfer credit; inference accrues when vault+adapters set.
  const canTransferCredit = feeRouter !== null && inferenceVault !== null;
  const canHarvest = feeRouter !== null;
  const canVaultInference = inferenceVault !== null;
  const canAdapterInference = venueAdapters.length > 0 && inferenceVault !== null;

  if (!canTransferCredit && !canHarvest && !canVaultInference && !canAdapterInference) {
    return empty([
      "feeRouter and/or inferenceVault (+ adapters) required for event backfill",
    ]);
  }

  const range = resolveBackfillRange({
    storage: input.storage,
    finalizedBlock: input.finalizedBlock,
    fromBlock: input.fromBlock,
  });
  if (range.blocked) {
    return empty(range.readiness);
  }
  const readiness = [...range.readiness];
  if (feeRouter === null && (canVaultInference || canAdapterInference)) {
    readiness.push("feeRouter null: skipping harvest/transfer credit scan; inference events still accrue");
  }
  const { fromBlock, toBlock } = range;

  const timestamps = new Map<bigint, number>();
  const transferCredits: StoredCreditEvent[] = [];
  const harvestEventsToInsert: StoredHarvestEvent[] = [];
  const harvestCredits: StoredCreditEvent[] = [];
  const inferenceCredits: StoredInferenceCredit[] = [];
  const inferenceSettlements: StoredInferenceSettlement[] = [];

  if (canTransferCredit) {
    const transferLogs = await input.client.getLogs({
      address: input.config.contracts.diem,
      fromBlock,
      toBlock,
    });
    for (const log of transferLogs) {
      const credit = decodeTransferCredit(input.config, log);
      if (credit === null) {
        continue;
      }
      transferCredits.push({
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        blockNumber: log.blockNumber,
        timestamp: await timestampFor(input.client, timestamps, log.blockNumber),
        source: "diem-transfer",
        amountDiem: credit.amountDiem,
      });
    }
  }

  if (canHarvest && feeRouter !== null) {
    const harvestLogs = await input.client.getLogs({
      address: feeRouter,
      fromBlock,
      toBlock,
    });
    for (const log of harvestLogs) {
      const harvest = decodeHarvest(log);
      if (harvest === null) {
        continue;
      }
      const timestamp = await timestampFor(input.client, timestamps, log.blockNumber);
      harvestEventsToInsert.push({
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        blockNumber: log.blockNumber,
        timestamp,
        eventName: harvest.event,
        tokenIn: harvest.tokenIn,
        amountIn: harvest.amountIn,
        amountOut: harvest.amountOut,
      });
      if (harvest.creditDiem !== undefined) {
        harvestCredits.push({
          txHash: log.transactionHash,
          logIndex: log.logIndex,
          blockNumber: log.blockNumber,
          timestamp,
          source: "vvv-harvest",
          amountDiem: harvest.creditDiem,
        });
      }
    }
  }

  if (canVaultInference && inferenceVault !== null) {
    const vaultLogs = await input.client.getLogs({
      address: inferenceVault,
      fromBlock,
      toBlock,
    });
    for (const log of vaultLogs) {
      const decoded = decodeVaultInferenceLog(log);
      if (decoded === null) {
        continue;
      }
      decoded.timestamp = await timestampFor(input.client, timestamps, log.blockNumber);
      inferenceCredits.push(decoded);
    }
  }

  // Config-seeded adapter set is mandatory (SPEC009 M5) — discovery-only would miss unrouted adapters.
  if (canAdapterInference) {
    for (const entry of venueAdapters) {
      const adapterLogs = await input.client.getLogs({
        address: entry.address,
        fromBlock,
        toBlock,
      });
      for (const log of adapterLogs) {
        const decoded = decodeAdapterSettlementLog(log, entry.address);
        if (decoded === null) {
          continue;
        }
        decoded.timestamp = await timestampFor(input.client, timestamps, log.blockNumber);
        inferenceSettlements.push(decoded);
      }
    }
  }

  const transferCreditTxs = new Set(transferCredits.map((event) => event.txHash.toLowerCase()));
  const dedupedHarvestCredits = harvestCredits.filter(
    (event) => !transferCreditTxs.has(event.txHash.toLowerCase()),
  );

  for (const event of transferCredits) {
    input.storage.insertCreditEvent(event);
  }
  for (const event of harvestEventsToInsert) {
    input.storage.insertHarvestEvent(event);
  }
  for (const event of dedupedHarvestCredits) {
    input.storage.insertCreditEvent(event);
  }
  if (input.storage.insertInferenceCredit !== undefined) {
    for (const event of inferenceCredits) {
      input.storage.insertInferenceCredit(event);
    }
  } else if (inferenceCredits.length > 0) {
    readiness.push("storage missing insertInferenceCredit; inference credits not persisted");
  }
  if (input.storage.insertInferenceSettlement !== undefined) {
    for (const event of inferenceSettlements) {
      input.storage.insertInferenceSettlement(event);
    }
  } else if (inferenceSettlements.length > 0) {
    readiness.push("storage missing insertInferenceSettlement; inference settlements not persisted");
  }

  input.storage.setMeta("lastProcessedBlock", toBlock.toString());
  return {
    fromBlock,
    toBlock,
    creditEvents: transferCredits.length + dedupedHarvestCredits.length,
    harvestEvents: harvestEventsToInsert.length,
    inferenceCreditEvents: inferenceCredits.length,
    inferenceSettlementEvents: inferenceSettlements.length,
    readiness,
  };
}
