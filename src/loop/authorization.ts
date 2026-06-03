import { encodeFunctionData } from "viem";
import { morphoAbi } from "../abi/morpho.js";
import type { Address, AppConfig, Hex } from "../types/domain.js";
import type { LoopSimulationClient } from "./simulator.js";

export interface AuthorizationSimulationResult {
  status: "passed" | "failed" | "blocked";
  owner: Address | null;
  loopExecutor: Address | null;
  alreadyAuthorized: boolean | null;
  authorizationCalldata?: {
    to: Address;
    data: Hex;
    owner: Address;
    loopExecutor: Address;
  };
  gasEstimate?: string;
  error?: {
    code: string;
    message: string;
  };
}

export async function simulateMorphoAuthorization(input: {
  config: AppConfig;
  owner: Address | null;
  client?: LoopSimulationClient;
}): Promise<AuthorizationSimulationResult> {
  const loopExecutor = input.config.contracts.loopExecutor;
  if (input.owner === null || loopExecutor === null) {
    return {
      status: "blocked",
      owner: input.owner,
      loopExecutor,
      alreadyAuthorized: null,
      error: {
        code: "AUTHORIZATION_INPUT_MISSING",
        message: "owner and loopExecutor are required for live authorization simulation",
      },
    };
  }

  const authorizationCalldata = {
    to: input.config.contracts.morphoBlue,
    data: encodeFunctionData({
      abi: morphoAbi,
      functionName: "setAuthorization",
      args: [loopExecutor, true],
    }) as Hex,
    owner: input.owner,
    loopExecutor,
  };

  if (input.client === undefined) {
    return {
      status: "blocked",
      owner: input.owner,
      loopExecutor,
      alreadyAuthorized: null,
      authorizationCalldata,
      error: {
        code: "SIMULATION_CLIENT_MISSING",
        message: "No simulation client provided; authorization read and gas simulation were not run.",
      },
    };
  }

  try {
    const chainId = await input.client.getChainId();
    if (chainId !== input.config.chainId) {
      return {
        status: "blocked",
        owner: input.owner,
        loopExecutor,
        alreadyAuthorized: null,
        authorizationCalldata,
        error: {
          code: "CHAIN_ID_MISMATCH",
          message: `unexpected chainId ${chainId}; expected ${input.config.chainId}`,
        },
      };
    }

    const alreadyAuthorized = (await input.client.readContract({
      address: input.config.contracts.morphoBlue,
      abi: morphoAbi,
      functionName: "isAuthorized",
      args: [input.owner, loopExecutor],
    })) as boolean;
    if (alreadyAuthorized) {
      return {
        status: "passed",
        owner: input.owner,
        loopExecutor,
        alreadyAuthorized,
        authorizationCalldata,
      };
    }

    await input.client.simulateContract({
      address: input.config.contracts.morphoBlue,
      abi: morphoAbi,
      functionName: "setAuthorization",
      args: [loopExecutor, true],
      account: input.owner,
    });
    const gas = await input.client.estimateContractGas({
      address: input.config.contracts.morphoBlue,
      abi: morphoAbi,
      functionName: "setAuthorization",
      args: [loopExecutor, true],
      account: input.owner,
    });

    return {
      status: "passed",
      owner: input.owner,
      loopExecutor,
      alreadyAuthorized,
      authorizationCalldata,
      gasEstimate: gas.toString(),
    };
  } catch (error) {
    return {
      status: "failed",
      owner: input.owner,
      loopExecutor,
      alreadyAuthorized: null,
      authorizationCalldata,
      error: {
        code: "AUTHORIZATION_SIMULATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
