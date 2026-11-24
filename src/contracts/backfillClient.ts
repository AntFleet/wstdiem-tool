import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import type { AppConfig, Hex } from "../types/domain.js";
import type { BackfillClient, BackfillLog } from "../metrics/backfill.js";
import { selectBestRpcEndpoint } from "./rpc.js";

// Public Base RPCs cap eth_getLogs ranges (publicnode: 50,000 blocks). At 200ms
// blocks a 7-day backfill is ~3M blocks, so requests must be split.
export const MAX_GET_LOGS_RANGE_BLOCKS = 50_000n;

export function splitBlockRange(
  fromBlock: bigint,
  toBlock: bigint,
  maxRange: bigint = MAX_GET_LOGS_RANGE_BLOCKS,
): Array<{ fromBlock: bigint; toBlock: bigint }> {
  if (maxRange <= 0n) {
    throw new Error("maxRange must be positive");
  }
  const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  for (let start = fromBlock; start <= toBlock; start += maxRange) {
    const end = start + maxRange - 1n;
    ranges.push({ fromBlock: start, toBlock: end < toBlock ? end : toBlock });
  }
  return ranges;
}

export async function createViemBackfillClient(config: AppConfig): Promise<BackfillClient | null> {
  if (config.rpc.primaryUrl === null && config.rpc.fallbackUrls.length === 0) {
    return null;
  }
  const selection = await selectBestRpcEndpoint(config);
  const client = createPublicClient({
    chain: base,
    transport: http(selection.url, { timeout: config.rpc.timeoutMs }),
  });
  return {
    async getLogs(args) {
      const logs = [];
      for (const range of splitBlockRange(args.fromBlock, args.toBlock)) {
        logs.push(...(await client.getLogs({ address: args.address, ...range })));
      }
      return logs.flatMap((log) => {
        if (log.blockNumber === null || log.logIndex === null || log.transactionHash === null) {
          return [];
        }
        return [
          {
            address: log.address,
            blockNumber: log.blockNumber,
            logIndex: log.logIndex,
            transactionHash: log.transactionHash,
            topics: [...log.topics] as [] | [Hex, ...Hex[]],
            data: log.data,
          } satisfies BackfillLog,
        ];
      });
    },
    async getBlock(args) {
      return client.getBlock({ blockNumber: args.blockNumber });
    },
  };
}
