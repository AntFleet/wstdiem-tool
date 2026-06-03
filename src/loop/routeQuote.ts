import type { Abi } from "viem";
import { curvePoolAbi } from "../abi/curvePool.js";
import { inferenceVaultAbi } from "../abi/inferenceVault.js";
import type { AppConfig } from "../types/domain.js";
import type { RouteSlippageEvidence } from "./types.js";

const BPS_DENOMINATOR = 10_000n;
const WSTDIEM_INDEX = 1n;
const DIEM_INDEX = 0n;

export interface RouteQuoteClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  readContract(args: {
    address: `0x${string}`;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }): Promise<unknown>;
}

export interface CurveExitRouteQuote {
  action: "exit";
  wstDiemIn: bigint;
  expectedDiemOutAtNav: bigint;
  quotedDiemOut: bigint;
  minDiemOut: bigint;
  maxSlippageBps: number;
  priceImpactBps: number;
  blockNumber: bigint;
}

export interface RouteQuoteResult {
  quote?: CurveExitRouteQuote;
  evidence?: RouteSlippageEvidence;
  readiness: string[];
}

function applySlippageFloor(amount: bigint, slippageBps: number): bigint {
  return (amount * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR;
}

function priceImpactBps(expectedOut: bigint, quotedOut: bigint): number {
  if (expectedOut === 0n || quotedOut >= expectedOut) {
    return 0;
  }
  const diff = expectedOut - quotedOut;
  return Number((diff * 1_000_000n) / expectedOut) / 100;
}

export async function quoteCurveExitRoute(input: {
  config: AppConfig;
  client: RouteQuoteClient;
  wstDiemIn: bigint;
  slippageBps: number;
  blockNumber?: bigint;
}): Promise<RouteQuoteResult> {
  const readiness: string[] = [];
  if (input.config.contracts.curvePool === null || input.config.contracts.inferenceVault === null) {
    return {
      readiness: ["curvePool and inferenceVault are required for Curve exit route quotes"],
    };
  }
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0) {
    return { readiness: ["slippageBps must be a non-negative integer for Curve exit route quotes"] };
  }
  if (input.slippageBps > input.config.execution.maxSlippageBps) {
    return {
      readiness: [
        `slippageBps ${input.slippageBps} exceeds hard max ${input.config.execution.maxSlippageBps} for Curve exit route quotes`,
      ],
    };
  }
  if (input.wstDiemIn <= 0n) {
    return { readiness: ["wstDiemIn must be greater than zero for Curve exit route quotes"] };
  }

  const chainId = await input.client.getChainId();
  if (chainId !== input.config.chainId) {
    return { readiness: [`unexpected route quote chainId ${chainId}; expected ${input.config.chainId}`] };
  }
  const blockNumber = input.blockNumber ?? (await input.client.getBlockNumber());
  const [expectedDiemOutAtNav, quotedDiemOut] = await Promise.all([
    input.client.readContract({
      address: input.config.contracts.inferenceVault,
      abi: inferenceVaultAbi,
      functionName: "convertToAssets",
      args: [input.wstDiemIn],
      blockNumber,
    }) as Promise<bigint>,
    input.client.readContract({
      address: input.config.contracts.curvePool,
      abi: curvePoolAbi,
      functionName: "get_dy",
      args: [WSTDIEM_INDEX, DIEM_INDEX, input.wstDiemIn],
      blockNumber,
    }) as Promise<bigint>,
  ]);
  if (expectedDiemOutAtNav <= 0n) {
    return { readiness: ["InferenceVault.convertToAssets returned zero for Curve exit route quote"] };
  }
  if (quotedDiemOut <= 0n) {
    return { readiness: ["Curve get_dy returned zero for Curve exit route quote"] };
  }

  const minDiemOut = applySlippageFloor(quotedDiemOut, input.slippageBps);
  const impact = priceImpactBps(expectedDiemOutAtNav, quotedDiemOut);
  const quote: CurveExitRouteQuote = {
    action: "exit",
    wstDiemIn: input.wstDiemIn,
    expectedDiemOutAtNav,
    quotedDiemOut,
    minDiemOut,
    maxSlippageBps: input.slippageBps,
    priceImpactBps: impact,
    blockNumber,
  };
  return {
    quote,
    evidence: {
      source: "route-quote",
      action: "exit",
      chainId,
      blockNumber,
      maxSlippageBps: input.slippageBps,
      priceImpactBps: impact,
      amountIn: input.wstDiemIn,
      expectedOut: expectedDiemOutAtNav,
      quotedOut: quotedDiemOut,
      protectedMinOut: minDiemOut,
      valid: impact <= input.config.execution.maxCurvePriceImpactBps,
    },
    readiness,
  };
}
