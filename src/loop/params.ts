import { encodeFunctionData } from "viem";
import { loopExecutorAbi } from "../abi/loopExecutor.js";
import type { AppConfig, Address, Hex } from "../types/domain.js";
import { WAD } from "../metrics/math.js";
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
  slippageBps: number;
  nowSeconds?: number;
}): LoopOpenParams | null {
  const marketParams = buildConfiguredMarketParams(input.config);
  if (marketParams === null) {
    return null;
  }
  // SPEC001 requires protected min-out/min-borrow bounds derived from live route quotes.
  // Until those quote inputs exist, do not emit open calldata with zero protection.
  void input.slippageBps;
  return null;
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
  // SPEC001 requires repay/sell/min-out bounds from live position and Curve quote state.
  // Until those inputs exist, do not emit no-op or unprotected exit calldata.
  void input.owner;
  void input.slippageBps;
  void input.force;
  void input.nowSeconds;
  return null;
}

export function encodeLoopExecutorCall(action: LoopAction, params: LoopExecutorParams): Hex {
  const unsupported = unsupportedExecutorAction(action);
  if (unsupported !== null) {
    throw new Error(unsupported);
  }
  return encodeFunctionData({ abi: loopExecutorAbi, functionName: "exit", args: [params as LoopExitParams] });
}

export function unsupportedExecutorAction(action: LoopAction): string | null {
  return action === "exit" ? null : `LoopExecutor action ${action} is unsupported by the deployed exit-only executor`;
}
