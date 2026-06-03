import { encodeFunctionData } from "viem";
import { loopExecutorAbi } from "../abi/loopExecutor.js";
import type { AppConfig, Address, Hex } from "../types/domain.js";
import { parseDecimalToUnits, WAD } from "../metrics/math.js";
import type {
  LoopAction,
  LoopExecutorParams,
  LoopExitParams,
  LoopOpenParams,
  LoopRebalanceParams,
  MorphoMarketParams,
} from "./types.js";

export function buildConfiguredMarketParams(config: AppConfig): MorphoMarketParams | null {
  if (config.contracts.inferenceVault === null || config.contracts.morphoOracle === null) {
    return null;
  }
  return {
    loanToken: config.contracts.diem,
    collateralToken: config.contracts.inferenceVault,
    oracle: config.contracts.morphoOracle,
    irm: config.contracts.adaptiveCurveIrm,
    lltv: BigInt(config.morpho.lltvWad),
  };
}

export function leverageToWad(leverage: number): bigint {
  return BigInt(Math.round(leverage * 1_000_000)) * (WAD / 1_000_000n);
}

export function buildLoopOpenParams(input: {
  config: AppConfig;
  owner: Address;
  targetLeverage: number;
  initialDiem: string;
  nowSeconds?: number;
}): LoopOpenParams | null {
  const marketParams = buildConfiguredMarketParams(input.config);
  if (marketParams === null) {
    return null;
  }
  const initialDiem = parseDecimalToUnits(input.initialDiem);
  const leverageUnits = BigInt(Math.round(input.targetLeverage * 10_000));
  const flashDiem = (initialDiem * (leverageUnits - 10_000n)) / 10_000n;
  const deadline =
    BigInt(input.nowSeconds ?? Math.floor(Date.now() / 1000)) +
    BigInt(input.config.execution.transactionDeadlineSeconds);
  return {
    owner: input.owner,
    marketParams,
    initialDiem,
    flashDiem,
    minWstDiemReceived: 0n,
    minBorrowedDiem: flashDiem,
    maxCurvePriceImpactBps: BigInt(input.config.execution.maxCurvePriceImpactBps),
    deadline,
  };
}

export function buildLoopRebalanceParams(input: {
  config: AppConfig;
  owner: Address;
  targetLeverage: number;
  slippageBps: number;
  nowSeconds?: number;
}): LoopRebalanceParams | null {
  const marketParams = buildConfiguredMarketParams(input.config);
  if (marketParams === null) {
    return null;
  }
  const deadline =
    BigInt(input.nowSeconds ?? Math.floor(Date.now() / 1000)) +
    BigInt(input.config.execution.transactionDeadlineSeconds);
  return {
    owner: input.owner,
    marketParams,
    targetLeverageWad: leverageToWad(input.targetLeverage),
    maxSlippageBps: BigInt(input.slippageBps),
    deadline,
  };
}

export function buildLoopExitParams(input: {
  config: AppConfig;
  owner: Address;
  slippageBps: number;
  force?: boolean;
  nowSeconds?: number;
}): LoopExitParams | null {
  const marketParams = buildConfiguredMarketParams(input.config);
  if (marketParams === null) {
    return null;
  }
  const deadline =
    BigInt(input.nowSeconds ?? Math.floor(Date.now() / 1000)) +
    BigInt(input.config.execution.transactionDeadlineSeconds);
  return {
    owner: input.owner,
    marketParams,
    repayAmountDiem: 0n,
    maxWstDiemToSell: 0n,
    minDiemOut: 0n,
    force: input.force ?? false,
    deadline,
  };
}

export function encodeLoopExecutorCall(action: LoopAction, params: LoopExecutorParams): Hex {
  if (action === "open") {
    return encodeFunctionData({ abi: loopExecutorAbi, functionName: "open", args: [params as LoopOpenParams] });
  }
  if (action === "rebalance") {
    return encodeFunctionData({
      abi: loopExecutorAbi,
      functionName: "rebalance",
      args: [params as LoopRebalanceParams],
    });
  }
  return encodeFunctionData({ abi: loopExecutorAbi, functionName: "exit", args: [params as LoopExitParams] });
}
