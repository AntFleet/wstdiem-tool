import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import type { AppConfig } from "../types/domain.js";
import type { RouteQuoteClient } from "../loop/routeQuote.js";
import { selectBestRpcEndpoint } from "./rpc.js";

export async function createViemRouteQuoteClient(config: AppConfig): Promise<RouteQuoteClient | null> {
  if (config.rpc.primaryUrl === null && config.rpc.fallbackUrls.length === 0) {
    return null;
  }
  const selection = await selectBestRpcEndpoint(config);
  const client = createPublicClient({
    chain: base,
    transport: http(selection.url, { timeout: config.rpc.timeoutMs }),
  });
  return {
    async getBlockNumber() {
      return client.getBlockNumber();
    },
    async readContract(args) {
      return client.readContract({
        address: args.address,
        abi: args.abi,
        functionName: args.functionName,
        args: args.args,
      });
    },
  };
}
