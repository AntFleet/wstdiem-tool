import { encodeFunctionData } from "viem";
import { morphoAbi } from "../abi/morpho.js";
import { missingDeploymentKeys } from "../config/load.js";
import {
  buildLoopExitParams,
  buildLoopOpenParams,
  buildLoopRebalanceParams,
  encodeLoopExecutorCall,
} from "../loop/params.js";
import { staticLoopPreflight } from "../loop/preflight.js";
import type { LoopExecutorParams, PreflightCheck } from "../loop/types.js";
import { parseDecimalToUnits, WAD } from "../metrics/math.js";
import type { Address, AppConfig, Hex } from "../types/domain.js";
import { CliError } from "./errors.js";

export interface LoopProjection {
  kind: "projection" | "live_passed" | "live_blocked" | "live_failed";
  action: "open" | "rebalance" | "exit";
  dryRun: boolean;
  simulation: {
    status: "not_run";
    reason: string;
  };
  executorParamsAvailable: boolean;
  executorCalldata?: Hex;
  preflightChecks: PreflightCheck[];
  targetLeverage?: number;
  initialDiem?: string;
  initialDiemWei?: string;
  projectedPositionNotionalDiemWei?: string;
  slippageBps: number;
  maxCurvePriceImpactBps: number;
  blocked: boolean;
  safeToProceed: boolean;
  blockers: string[];
  authorizationCalldata?: {
    to: Address;
    data: Hex;
    owner: Address;
    loopExecutor: Address;
  };
}

export interface LoopCommandOptions {
  action: "open" | "rebalance" | "exit";
  targetLeverage?: number;
  initialDiem?: string;
  slippageBps?: number;
  dryRun?: boolean;
  owner?: Address;
  from?: Address;
  force?: boolean;
  nowSeconds?: number;
}

export interface BuiltLoopExecutorParams {
  owner: Address | null;
  from: Address | null;
  params: LoopExecutorParams | null;
}

function validateLeverage(targetLeverage: number | undefined, required: boolean): void {
  if (targetLeverage === undefined) {
    if (required) {
      throw new CliError("INVALID_INPUT", "targetLeverage is required");
    }
    return;
  }
  if (!Number.isFinite(targetLeverage)) {
    throw new CliError("INVALID_INPUT", "targetLeverage must be finite");
  }
  if (targetLeverage < 1.5 || targetLeverage > 3.8) {
    throw new CliError("INVALID_INPUT", "targetLeverage must be between 1.5 and 3.8");
  }
}

function validateSlippage(config: AppConfig, slippageBps: number): void {
  if (!Number.isInteger(slippageBps) || slippageBps < 0) {
    throw new CliError("INVALID_INPUT", "slippageBps must be a non-negative integer");
  }
  if (slippageBps > config.execution.maxSlippageBps) {
    throw new CliError(
      "SLIPPAGE_TOO_HIGH",
      `slippageBps ${slippageBps} exceeds hard max ${config.execution.maxSlippageBps}`,
    );
  }
}

function buildAuthorizationCalldata(config: AppConfig, owner: Address | null): LoopProjection["authorizationCalldata"] {
  if (owner === null || config.contracts.loopExecutor === null) {
    return undefined;
  }
  return {
    to: config.contracts.morphoBlue,
    data: encodeFunctionData({
      abi: morphoAbi,
      functionName: "setAuthorization",
      args: [config.contracts.loopExecutor, true],
    }),
    owner,
    loopExecutor: config.contracts.loopExecutor,
  };
}

export function buildLoopExecutorParamsForCommand(
  config: AppConfig,
  options: LoopCommandOptions,
): BuiltLoopExecutorParams {
  const slippageBps = options.slippageBps ?? config.execution.defaultSlippageBps;
  const owner = options.owner ?? config.position.owner;
  const from = options.from ?? owner;
  if (owner === null) {
    return { owner, from: null, params: null };
  }
  if (options.action === "open" && options.targetLeverage !== undefined && options.initialDiem !== undefined) {
    return {
      owner,
      from,
      params: buildLoopOpenParams({
        config,
        owner,
        targetLeverage: options.targetLeverage,
        initialDiem: options.initialDiem,
        slippageBps,
        nowSeconds: options.nowSeconds,
      }),
    };
  }
  if (options.action === "rebalance" && options.targetLeverage !== undefined) {
    return {
      owner,
      from,
      params: buildLoopRebalanceParams({
        config,
        owner,
        targetLeverage: options.targetLeverage,
        slippageBps,
        nowSeconds: options.nowSeconds,
      }),
    };
  }
  if (options.action === "exit") {
    return {
      owner,
      from,
      params: buildLoopExitParams({
        config,
        owner,
        slippageBps,
        force: options.force,
        nowSeconds: options.nowSeconds,
      }),
    };
  }
  return { owner, from, params: null };
}

export function projectLoopCommand(config: AppConfig, options: LoopCommandOptions): LoopProjection {
  const slippageBps = options.slippageBps ?? config.execution.defaultSlippageBps;
  validateSlippage(config, slippageBps);
  validateLeverage(options.targetLeverage, options.action !== "exit");

  let initialDiemWei: bigint | undefined;
  if (options.action === "open") {
    if (options.initialDiem === undefined) {
      throw new CliError("INVALID_INPUT", "initialDiem is required for loop open");
    }
    initialDiemWei = parseDecimalToUnits(options.initialDiem);
    if (initialDiemWei <= 0n) {
      throw new CliError("INVALID_INPUT", "initialDIEM must be greater than zero");
    }
  }

  const blockers = missingDeploymentKeys(config).map((key) => `missing deployment config: ${key}`);
  blockers.push(
    "executor simulation unavailable: this command is projection-only and has not run simulateContract/eth_call or estimateGas",
  );
  const owner = options.owner ?? config.position.owner;
  const preflightChecks = staticLoopPreflight(config, owner);
  if (owner === null) {
    blockers.push("missing position.owner or --owner");
  }
  if (config.contracts.loopExecutor === null) {
    blockers.push("LoopExecutor is required; SPEC001 forbids multi-EOA loop construction");
  }
  if (options.action !== "open" && config.contracts.autoDeleverageExecutor === null) {
    blockers.push("autoDeleverageExecutor missing; automation monitoring is degraded");
  }

  if (options.action === "exit" && options.force === true) {
    blockers.push("FORCE EXIT CAN REALIZE UNBOUNDED CURVE SLIPPAGE; simulation remains mandatory");
  }

  const projectedPositionNotionalDiemWei =
    initialDiemWei !== undefined && options.targetLeverage !== undefined
      ? ((initialDiemWei * BigInt(Math.round(options.targetLeverage * 10_000))) / 10_000n).toString()
      : undefined;
  const { params: executorParams } = buildLoopExecutorParamsForCommand(config, options);
  if (executorParams === null) {
    blockers.push("unable to build exact LoopExecutor params from current config");
  }
  const executorCalldata =
    executorParams !== null && config.contracts.loopExecutor !== null
      ? encodeLoopExecutorCall(options.action, executorParams)
      : undefined;

  const blocked = blockers.length > 0;
  return {
    kind: "projection",
    action: options.action,
    dryRun: options.dryRun ?? true,
    simulation: {
      status: "not_run",
      reason: "SPEC001 executor simulation is not implemented in this product slice.",
    },
    executorParamsAvailable: executorParams !== null,
    executorCalldata,
    preflightChecks,
    targetLeverage: options.targetLeverage,
    initialDiem: options.initialDiem,
    initialDiemWei: initialDiemWei?.toString(),
    projectedPositionNotionalDiemWei,
    slippageBps,
    maxCurvePriceImpactBps: config.execution.maxCurvePriceImpactBps,
    blocked,
    safeToProceed: !blocked,
    blockers,
    authorizationCalldata: buildAuthorizationCalldata(config, owner),
  };
}

export function assertBroadcastNotAllowed(projection: LoopProjection): void {
  if (projection.blocked) {
    throw new CliError("LOOP_SAFETY_BLOCKED", projection.blockers.join("; "));
  }
  throw new CliError(
    "SIMULATION_REQUIRED",
    "Broadcast is not enabled in this product slice; run with --dry-run and verify executor simulation first",
  );
}

export function wadFromFloat(value: number): bigint {
  return BigInt(Math.round(value * 1_000_000)) * (WAD / 1_000_000n);
}
