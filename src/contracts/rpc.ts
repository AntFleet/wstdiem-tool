import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import type { AppConfig } from "../types/domain.js";

export interface RpcBlockStatus {
  chainId: number;
  blockNumber: bigint;
  blockTimestamp: number;
  rpcName: string;
}

function configuredRpcUrls(config: AppConfig): Array<{ name: string; url: string }> {
  const urls: Array<{ name: string; url: string }> = [];
  if (config.rpc.primaryUrl !== null) {
    urls.push({ name: "primary", url: config.rpc.primaryUrl });
  }
  config.rpc.fallbackUrls.forEach((url, index) => {
    urls.push({ name: `fallback-${index + 1}`, url });
  });
  return urls;
}

function clientFor(url: string, timeoutMs: number) {
  return createPublicClient({
    chain: base,
    transport: http(url, { timeout: timeoutMs }),
  });
}

export async function readBestRpcBlockStatus(config: AppConfig, maxAttempts = 5): Promise<RpcBlockStatus> {
  const urls = configuredRpcUrls(config);
  if (urls.length === 0) {
    throw new Error("No RPC URLs configured");
  }

  const successful: RpcBlockStatus[] = [];
  const failures: string[] = [];
  for (const entry of urls) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const client = clientFor(entry.url, config.rpc.timeoutMs);
        const chainId = await client.getChainId();
        const block = await client.getBlock({ blockTag: "finalized" });
        const timestamp =
          typeof block.timestamp === "bigint" ? Number(block.timestamp) : Number(block.timestamp ?? 0);
        successful.push({
          chainId,
          blockNumber: block.number ?? 0n,
          blockTimestamp: timestamp,
          rpcName: entry.name,
        });
        break;
      } catch (error) {
        if (attempt === maxAttempts) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push(`${entry.name}: ${message}`);
        }
      }
    }
  }

  const matching = successful.filter((result) => result.chainId === config.chainId);
  const candidates = matching.length > 0 ? matching : successful;
  candidates.sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber > b.blockNumber ? -1 : 1));
  const best = candidates[0];
  if (best === undefined) {
    throw new Error(`All RPC reads failed: ${failures.join("; ")}`);
  }
  return best;
}
