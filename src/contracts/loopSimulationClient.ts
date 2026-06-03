import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import type { Address, AppConfig, Hex } from "../types/domain.js";
import type { LoopSimulationClient } from "../loop/simulator.js";
import { selectBestRpcEndpoint } from "./rpc.js";

export async function createViemLoopSimulationClient(config: AppConfig): Promise<LoopSimulationClient | null> {
  if (config.rpc.primaryUrl === null && config.rpc.fallbackUrls.length === 0) {
    return null;
  }
  const selection = await selectBestRpcEndpoint(config);
  const client = createPublicClient({
    chain: base,
    transport: http(selection.url, { timeout: config.rpc.timeoutMs }),
  });
  return {
    async getChainId(): Promise<number> {
      return client.getChainId();
    },
    async getCode(address: Address): Promise<Hex> {
      return (await client.getCode({ address })) ?? "0x";
    },
    async readContract(args): Promise<unknown> {
      return client.readContract(args as never);
    },
    async simulateContract(args): Promise<unknown> {
      return client.simulateContract(args as never);
    },
    async estimateContractGas(args): Promise<bigint> {
      return client.estimateContractGas(args as never);
    },
  };
}
