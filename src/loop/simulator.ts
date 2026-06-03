import { loopExecutorAbi } from "../abi/loopExecutor.js";
import type { Address, AppConfig, Hex } from "../types/domain.js";
import { encodeLoopExecutorCall } from "./params.js";
import { hasPreflightFailures, runLoopPreflight, type LoopPreflightClient } from "./preflight.js";
import type { LoopAction, LoopExecutorParams, LoopSimulationResult } from "./types.js";

export interface LoopSimulationClient extends LoopPreflightClient {
  simulateContract(args: {
    address: Address;
    abi: unknown;
    functionName: LoopAction;
    args: readonly [LoopExecutorParams];
    account: Address;
  }): Promise<unknown>;
  estimateContractGas(args: {
    address: Address;
    abi: unknown;
    functionName: LoopAction;
    args: readonly [LoopExecutorParams];
    account: Address;
  }): Promise<bigint>;
}

export async function simulateLoopExecutorCall(input: {
  config: AppConfig;
  action: LoopAction;
  owner: Address | null;
  params: LoopExecutorParams | null;
  client?: LoopSimulationClient;
}): Promise<LoopSimulationResult> {
  const preflightChecks = await runLoopPreflight(input.config, input.owner, input.client);
  if (input.params === null) {
    preflightChecks.push({
      key: "executor-params",
      status: "fail",
      message: "unable to build exact LoopExecutor params from current config",
    });
  }
  if (input.config.contracts.loopExecutor === null) {
    preflightChecks.push({
      key: "loop-executor",
      status: "fail",
      message: "loopExecutor address is required",
    });
  }
  if (input.client === undefined) {
    return {
      status: "blocked",
      action: input.action,
      preflightChecks,
      error: {
        code: "SIMULATION_CLIENT_MISSING",
        message: "No simulation client provided; simulateContract and estimateGas were not run.",
      },
    };
  }
  if (
    input.owner === null ||
    input.params === null ||
    input.config.contracts.loopExecutor === null ||
    hasPreflightFailures(preflightChecks)
  ) {
    return {
      status: "blocked",
      action: input.action,
      preflightChecks,
      error: {
        code: "PREFLIGHT_FAILED",
        message: "LoopExecutor simulation blocked by failed preflight checks.",
      },
    };
  }

  const calldata = encodeLoopExecutorCall(input.action, input.params);
  try {
    await input.client.simulateContract({
      address: input.config.contracts.loopExecutor,
      abi: loopExecutorAbi,
      functionName: input.action,
      args: [input.params],
      account: input.owner,
    });
    const gas = await input.client.estimateContractGas({
      address: input.config.contracts.loopExecutor,
      abi: loopExecutorAbi,
      functionName: input.action,
      args: [input.params],
      account: input.owner,
    });
    return {
      status: "passed",
      action: input.action,
      preflightChecks,
      calldata: calldata as Hex,
      gasEstimate: gas.toString(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      action: input.action,
      preflightChecks,
      calldata: calldata as Hex,
      error: {
        code: "SIMULATION_FAILED",
        message,
      },
    };
  }
}
