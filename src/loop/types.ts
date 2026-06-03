import type { Address } from "../types/domain.js";

export type LoopAction = "open" | "rebalance" | "exit";

export interface MorphoMarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

export interface LoopOpenParams {
  owner: Address;
  marketParams: MorphoMarketParams;
  initialDiem: bigint;
  flashDiem: bigint;
  minWstDiemReceived: bigint;
  minBorrowedDiem: bigint;
  maxCurvePriceImpactBps: bigint;
  deadline: bigint;
}

export interface LoopRebalanceParams {
  owner: Address;
  marketParams: MorphoMarketParams;
  targetLeverageWad: bigint;
  maxSlippageBps: bigint;
  deadline: bigint;
}

export interface LoopExitParams {
  owner: Address;
  marketParams: MorphoMarketParams;
  repayAmountDiem: bigint;
  maxWstDiemToSell: bigint;
  minDiemOut: bigint;
  force: boolean;
  deadline: bigint;
}

export type LoopExecutorParams = LoopOpenParams | LoopRebalanceParams | LoopExitParams;

export interface PreflightCheck {
  key: string;
  status: "pass" | "fail" | "skip";
  message: string;
}

export interface BaseApyEvidence {
  source: "metrics-snapshot" | "test";
  chainId: number;
  blockNumber: bigint;
  windowSeconds: number;
  baseApy: number;
  valid: boolean;
}

export interface SignerEvidence {
  source: "configured-wallet" | "hardware-wallet" | "test";
  address: Address;
  verified: boolean;
}

export interface RouteSlippageEvidence {
  source: "route-quote" | "test";
  action: LoopAction;
  chainId: number;
  blockNumber: bigint;
  maxSlippageBps: number;
  priceImpactBps: number;
  amountIn?: bigint;
  expectedOut?: bigint;
  quotedOut?: bigint;
  protectedMinOut?: bigint;
  valid: boolean;
}

export interface LoopSafetyEvidence {
  baseApy?: BaseApyEvidence;
  routeSlippage?: RouteSlippageEvidence;
  signer?: SignerEvidence;
}

export interface LoopSimulationRequest {
  action: LoopAction;
  owner: Address;
  params: LoopExecutorParams;
}

export interface LoopSimulationResult {
  status: "passed" | "failed" | "blocked";
  action: LoopAction;
  preflightChecks: PreflightCheck[];
  calldata?: `0x${string}`;
  gasEstimate?: string;
  error?: {
    code: string;
    message: string;
  };
}
