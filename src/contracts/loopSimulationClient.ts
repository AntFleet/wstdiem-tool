import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import type { Address, AppConfig, Hex } from "../types/domain.js";
import type { LoopSimulationClient } from "../loop/simulator.js";

function firstRpcUrl(config: AppConfig): string | null {
  return config.rpc.primaryUrl ?? config.rpc.fallbackUrls[0] ?? null;
}

export function createViemLoopSimulationClient(config: AppConfig): LoopSimulationClient | null {
  const url = firstRpcUrl(config);
  if (url === null) {
    return null;
  }
  const client = createPublicClient({
    chain: base,
    transport: http(url, { timeout: config.rpc.timeoutMs }),
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
