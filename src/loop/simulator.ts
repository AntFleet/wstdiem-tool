import { decodeEventLog } from "viem";
import { loopExecutorAbi } from "../abi/loopExecutor.js";
import type { Address, AppConfig, Hex } from "../types/domain.js";
import { buildExitFlashFeeProof } from "./flashFeeProof.js";
import { encodeLoopExecutorCall, unsupportedExecutorAction } from "./params.js";
import { hasPreflightFailures, runLoopPreflight, type LoopPreflightClient } from "./preflight.js";
import type {
  ExitExecutionEvidence,
  ExitFlashFeeProof,
  LoopAction,
  LoopExecutorParams,
  LoopExitParams,
  LoopSafetyEvidence,
  LoopSimulationResult,
} from "./types.js";

interface SimulatedLog {
  data: Hex;
  topics: readonly Hex[];
}

export interface LoopSimulationClient extends LoopPreflightClient {
  getBlockNumber(): Promise<bigint>;
  simulateContract(args: {
    address: Address;
    abi: unknown;
    functionName: string;
    args?: readonly unknown[];
    account: Address;
    blockNumber?: bigint;
  }): Promise<unknown>;
  estimateContractGas(args: {
    address: Address;
    abi: unknown;
    functionName: string;
    args?: readonly unknown[];
    account: Address;
    blockNumber?: bigint;
  }): Promise<bigint>;
}

function extractLogs(simulationResult: unknown): SimulatedLog[] {
  if (simulationResult === null || typeof simulationResult !== "object") {
    return [];
  }
  const logs = (simulationResult as { logs?: unknown }).logs;
  if (!Array.isArray(logs)) {
    return [];
  }
  return logs.flatMap((entry): SimulatedLog[] => {
    if (entry === null || typeof entry !== "object") {
      return [];
    }
    const data = (entry as { data?: unknown }).data;
    const topics = (entry as { topics?: unknown }).topics;
    if (typeof data !== "string" || !data.startsWith("0x") || !Array.isArray(topics)) {
      return [];
    }
    if (!topics.every((topic) => typeof topic === "string" && topic.startsWith("0x"))) {
      return [];
    }
    return [{ data: data as Hex, topics: topics as Hex[] }];
  });
}

export function extractExitExecutionEvidence(simulationResult: unknown): ExitExecutionEvidence | undefined {
  for (const log of extractLogs(simulationResult)) {
    try {
      const decoded = decodeEventLog({
        abi: loopExecutorAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== "LoopExitExecuted") {
        continue;
      }
      const args = decoded.args as {
        owner: Address;
        repayAmountDiem: bigint;
        flashFee: bigint;
        totalFlashRepaymentDiem: bigint;
        wstDiemSold: bigint;
        diemReceived: bigint;
        diemDustRefunded: bigint;
        wstDiemDustRefunded: bigint;
      };
      return {
        source: "executor-event-log",
        owner: args.owner,
        repayAmountDiem: args.repayAmountDiem,
        flashFee: args.flashFee,
        totalFlashRepaymentDiem: args.totalFlashRepaymentDiem,
        wstDiemSold: args.wstDiemSold,
        diemReceived: args.diemReceived,
        diemDustRefunded: args.diemDustRefunded,
        wstDiemDustRefunded: args.wstDiemDustRefunded,
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

function exitProofBlocker(proof: ExitFlashFeeProof | undefined): string | null {
  if (proof === undefined) {
    return "exit flash-fee proof is required";
  }
  if (
    proof.flashFeeSource === "unresolved" ||
    proof.flashFee === "unresolved" ||
    proof.totalFlashRepaymentDiem === "unresolved"
  ) {
    return "exit flash-fee proof is unresolved";
  }
  if (
    proof.feeInclusiveRepayCovered !== true ||
    proof.morphoRepayCovered !== true ||
    proof.flashLoanLiquidityCovered !== true
  ) {
    return "exit flash-fee proof does not prove fee-inclusive repayment and flash-loan liquidity coverage";
  }
  return null;
}

function exitEvidenceMismatch(
  params: LoopExitParams,
  proof: ExitFlashFeeProof | undefined,
  evidence: ExitExecutionEvidence | undefined,
): string | null {
  if (proof === undefined || evidence === undefined) {
    return null;
  }
  if (evidence.owner.toLowerCase() !== params.owner.toLowerCase()) {
    return "executor LoopExitExecuted owner does not match exit params";
  }
  if (proof.flashFee !== evidence.flashFee.toString()) {
    return "executor LoopExitExecuted flashFee does not match off-chain flash-fee proof";
  }
  if (proof.totalFlashRepaymentDiem !== evidence.totalFlashRepaymentDiem.toString()) {
    return "executor LoopExitExecuted totalFlashRepaymentDiem does not match off-chain flash-fee proof";
  }
  if (proof.repayAmountDiem !== undefined && evidence.repayAmountDiem > BigInt(proof.repayAmountDiem)) {
    return "executor LoopExitExecuted repayAmountDiem exceeds off-chain exit plan flash principal";
  }
  if (evidence.diemReceived < params.minDiemOut) {
    return "executor LoopExitExecuted diemReceived is below exit params minDiemOut";
  }
  if (evidence.wstDiemSold > params.maxWstDiemToSell) {
    return "executor LoopExitExecuted wstDiemSold exceeds exit params maxWstDiemToSell";
  }
  if (proof.totalFlashRepaymentDiem !== "unresolved") {
    const unusedFlashPrincipal = params.repayAmountDiem - evidence.repayAmountDiem;
    if (BigInt(proof.totalFlashRepaymentDiem) > params.minDiemOut + unusedFlashPrincipal) {
      return "executor LoopExitExecuted totalFlashRepaymentDiem is not covered by minDiemOut plus unused flash principal";
    }
  }
  return null;
}

export async function simulateLoopExecutorCall(input: {
  config: AppConfig;
  action: LoopAction;
  owner: Address | null;
  from: Address | null;
  params: LoopExecutorParams | null;
  safetyEvidence?: LoopSafetyEvidence;
  client?: LoopSimulationClient;
}): Promise<LoopSimulationResult> {
  let preflightChecks: Awaited<ReturnType<typeof runLoopPreflight>>;
  try {
    const planningBlock =
      input.safetyEvidence?.routeSlippage?.blockNumber ??
      (input.client === undefined ? undefined : await input.client.getBlockNumber());
    preflightChecks = await runLoopPreflight(input.config, input.owner, input.client, {
      action: input.action,
      params: input.params,
      safetyEvidence: input.safetyEvidence,
      planningBlock,
    });
  } catch (error) {
    return {
      status: "failed",
      action: input.action,
      preflightChecks: [],
      error: {
        code: "PREFLIGHT_READ_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
      exitFlashFeeProof: buildExitFlashFeeProof(
        input.config,
        input.action,
        input.params,
        input.safetyEvidence?.flashLoanLiquidity,
        input.safetyEvidence?.routeSlippage,
      ),
    };
  }
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
  if (input.from === null) {
    preflightChecks.push({
      key: "tx-sender",
      status: "fail",
      message: "transaction sender --from is required for live simulation",
    });
  } else {
    const signer = input.safetyEvidence?.signer;
    const signerMatches = signer?.address.toLowerCase() === input.from.toLowerCase();
    preflightChecks.push({
      key: "tx-signer",
      status: signer?.verified === true && signerMatches ? "pass" : "fail",
      message:
        signer?.verified === true && signerMatches
          ? "verified signer evidence matches transaction sender"
          : "verified signer evidence matching --from is required for live simulation",
    });
  }
  if (input.client === undefined) {
    return {
      status: "blocked",
      action: input.action,
      preflightChecks,
      exitFlashFeeProof: buildExitFlashFeeProof(
        input.config,
        input.action,
        input.params,
        input.safetyEvidence?.flashLoanLiquidity,
        input.safetyEvidence?.routeSlippage,
      ),
      error: {
        code: "SIMULATION_CLIENT_MISSING",
        message: "No simulation client provided; simulateContract and estimateGas were not run.",
      },
    };
  }
  const unsupported = unsupportedExecutorAction(input.action);
  if (unsupported !== null) {
    return {
      status: "blocked",
      action: input.action,
      preflightChecks,
      exitFlashFeeProof: buildExitFlashFeeProof(
        input.config,
        input.action,
        input.params,
        input.safetyEvidence?.flashLoanLiquidity,
        input.safetyEvidence?.routeSlippage,
      ),
      error: {
        code: "UNSUPPORTED_EXECUTOR_ACTION",
        message: unsupported,
      },
    };
  }
  if (
    input.owner === null ||
    input.from === null ||
    input.params === null ||
    input.config.contracts.loopExecutor === null ||
    hasPreflightFailures(preflightChecks)
  ) {
    return {
      status: "blocked",
      action: input.action,
      preflightChecks,
      exitFlashFeeProof: buildExitFlashFeeProof(
        input.config,
        input.action,
        input.params,
        input.safetyEvidence?.flashLoanLiquidity,
        input.safetyEvidence?.routeSlippage,
      ),
      error: {
        code: "PREFLIGHT_FAILED",
        message: "LoopExecutor simulation blocked by failed preflight checks.",
      },
    };
  }

  const calldata = encodeLoopExecutorCall(input.action, input.params);
  const simulationBlockNumber = input.action === "exit" ? input.safetyEvidence?.routeSlippage?.blockNumber : undefined;
  try {
    const simulation = await input.client.simulateContract({
      address: input.config.contracts.loopExecutor,
      abi: loopExecutorAbi,
      functionName: input.action,
      args: [input.params],
      account: input.from,
      blockNumber: simulationBlockNumber,
    });
    const exitFlashFeeProof = buildExitFlashFeeProof(
      input.config,
      input.action,
      input.params,
      input.safetyEvidence?.flashLoanLiquidity,
      input.safetyEvidence?.routeSlippage,
    );
    const proofBlocker = input.action === "exit" ? exitProofBlocker(exitFlashFeeProof) : null;
    if (proofBlocker !== null) {
      return {
        status: "blocked",
        action: input.action,
        preflightChecks,
        exitFlashFeeProof,
        calldata: calldata as Hex,
        error: {
          code: "EXIT_FLASH_FEE_PROOF_INCOMPLETE",
          message: proofBlocker,
        },
      };
    }
    const exitExecutionEvidence = extractExitExecutionEvidence(simulation);
    const mismatch =
      input.action === "exit"
        ? exitEvidenceMismatch(input.params as LoopExitParams, exitFlashFeeProof, exitExecutionEvidence)
        : null;
    if (mismatch !== null) {
      return {
        status: "failed",
        action: input.action,
        preflightChecks,
        exitFlashFeeProof,
        exitExecutionEvidence,
        calldata: calldata as Hex,
        error: {
          code: "EXIT_EXECUTION_EVIDENCE_MISMATCH",
          message: mismatch,
        },
      };
    }
    const gas = await input.client.estimateContractGas({
      address: input.config.contracts.loopExecutor,
      abi: loopExecutorAbi,
      functionName: input.action,
      args: [input.params],
      account: input.from,
      blockNumber: simulationBlockNumber,
    });
    return {
      status: "passed",
      action: input.action,
      preflightChecks,
      exitFlashFeeProof,
      exitExecutionEvidence,
      calldata: calldata as Hex,
      gasEstimate: gas.toString(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      action: input.action,
      preflightChecks,
      exitFlashFeeProof: buildExitFlashFeeProof(
        input.config,
        input.action,
        input.params,
        input.safetyEvidence?.flashLoanLiquidity,
        input.safetyEvidence?.routeSlippage,
      ),
      calldata: calldata as Hex,
      error: {
        code: "SIMULATION_FAILED",
        message,
      },
    };
  }
}
