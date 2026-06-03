import { erc20BalanceOfAbi } from "../abi/erc20.js";
import { morphoAbi } from "../abi/morpho.js";
import { deriveConfiguredExitFlashFee } from "./flashFeeProof.js";
import { buildConfiguredMarketParams } from "./params.js";
import { computeBorrowedDiem } from "../metrics/math.js";
import type { Address, AppConfig } from "../types/domain.js";
import type { FlashLoanLiquidityEvidence, LoopExitParams, RouteSlippageEvidence } from "./types.js";
import { parseMorphoMarket, parseMorphoPosition, type LoopPreflightClient } from "./preflight.js";
import { quoteCurveExitRoute, type CurveExitRouteQuote, type RouteQuoteClient } from "./routeQuote.js";

function addExitRepayAccrualBuffer(repayAmountDiem: bigint, bufferBps: number): bigint {
  const buffer = repayAmountDiem === 0n ? 0n : (repayAmountDiem * BigInt(bufferBps) + 9_999n) / 10_000n;
  return repayAmountDiem + buffer;
}

export interface LiveExitPlanResult {
  params: LoopExitParams | null;
  routeQuote?: CurveExitRouteQuote;
  routeSlippage?: RouteSlippageEvidence;
  flashLoanLiquidity?: FlashLoanLiquidityEvidence;
  morphoDebtBlockNumber?: bigint;
  readiness: string[];
}

export async function buildLiveLoopExitPlan(input: {
  config: AppConfig;
  owner: Address | null;
  preflightClient: LoopPreflightClient;
  routeQuoteClient: RouteQuoteClient;
  slippageBps: number;
  force?: boolean;
  nowSeconds?: number;
}): Promise<LiveExitPlanResult> {
  const readiness: string[] = [];
  const marketParams = buildConfiguredMarketParams(input.config);
  if (input.owner === null) {
    return { params: null, readiness: ["owner is required to build live exit params"] };
  }
  if (input.config.morpho.marketId === null || marketParams === null) {
    return {
      params: null,
      readiness: ["marketId, inferenceVault, and morphoOracle are required to build live exit params"],
    };
  }

  const planningBlock = await input.routeQuoteClient.getBlockNumber();
  let market;
  let position;
  try {
    market = parseMorphoMarket(
      await input.preflightClient.readContract({
        address: input.config.contracts.morphoBlue,
        abi: morphoAbi,
        functionName: "market",
        args: [input.config.morpho.marketId],
        blockNumber: planningBlock,
      }),
    );
    position = parseMorphoPosition(
      await input.preflightClient.readContract({
        address: input.config.contracts.morphoBlue,
        abi: morphoAbi,
        functionName: "position",
        args: [input.config.morpho.marketId, input.owner],
        blockNumber: planningBlock,
      }),
    );
  } catch (error) {
    return {
      params: null,
      morphoDebtBlockNumber: planningBlock,
      readiness: [
        `failed to parse Morpho exit position at planning block: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  if (market === null) {
    return { params: null, readiness: ["Morpho market returned an unsupported shape for live exit params"] };
  }
  if (position === null) {
    return { params: null, readiness: ["Morpho position returned an unsupported shape for live exit params"] };
  }
  if (position.collateral <= 0n) {
    return { params: null, readiness: ["position collateral is zero; live exit params are unavailable"] };
  }

  const currentBorrowedDiem = computeBorrowedDiem(market, { borrowShares: position.borrowShares });
  if (currentBorrowedDiem <= 0n) {
    return { params: null, readiness: ["position borrowed DIEM is zero; live exit params are unavailable"] };
  }
  const repayAmountDiem = addExitRepayAccrualBuffer(currentBorrowedDiem, input.config.execution.exitRepayBufferBps);

  const quoteResult = await quoteCurveExitRoute({
    config: input.config,
    client: input.routeQuoteClient,
    wstDiemIn: position.collateral,
    slippageBps: input.slippageBps,
    blockNumber: planningBlock,
  });
  readiness.push(...quoteResult.readiness);
  if (quoteResult.quote === undefined || quoteResult.evidence === undefined) {
    return { params: null, readiness };
  }
  if (quoteResult.quote.minDiemOut < repayAmountDiem) {
    readiness.push("Curve exit route minDiemOut does not cover Morpho repay amount");
    return {
      params: null,
      routeQuote: quoteResult.quote,
      routeSlippage: quoteResult.evidence,
      morphoDebtBlockNumber: planningBlock,
      readiness,
    };
  }
  const configuredFlashFee = deriveConfiguredExitFlashFee(input.config, repayAmountDiem);
  if (configuredFlashFee === null) {
    readiness.push("flash-loan provider config is required for fee-inclusive exit proof");
    return {
      params: null,
      routeQuote: quoteResult.quote,
      routeSlippage: quoteResult.evidence,
      morphoDebtBlockNumber: planningBlock,
      readiness,
    };
  }
  const flashPoolDiemBalance = await input.preflightClient.readContract({
    address: input.config.contracts.diem,
    abi: [erc20BalanceOfAbi],
    functionName: "balanceOf",
    args: [configuredFlashFee.pool],
    blockNumber: quoteResult.evidence.blockNumber,
  });
  if (typeof flashPoolDiemBalance !== "bigint") {
    readiness.push("DIEM balanceOf returned an unsupported shape for configured flash-loan pool");
    return {
      params: null,
      routeQuote: quoteResult.quote,
      routeSlippage: quoteResult.evidence,
      morphoDebtBlockNumber: planningBlock,
      readiness,
    };
  }
  const flashLoanLiquidity: FlashLoanLiquidityEvidence = {
    source: "uniswap-v3-pool-balance",
    provider: "uniswap-v3",
    chainId: quoteResult.evidence.chainId,
    blockNumber: planningBlock,
    factory: configuredFlashFee.factory,
    pool: configuredFlashFee.pool,
    loanToken: input.config.contracts.diem,
    requestedLoan: repayAmountDiem,
    availableLoan: flashPoolDiemBalance,
    valid: flashPoolDiemBalance >= repayAmountDiem,
  };
  if (flashPoolDiemBalance < repayAmountDiem) {
    readiness.push("configured Uniswap V3 DIEM pool balance does not cover requested flash loan amount");
    return {
      params: null,
      routeQuote: quoteResult.quote,
      routeSlippage: quoteResult.evidence,
      flashLoanLiquidity,
      morphoDebtBlockNumber: planningBlock,
      readiness,
    };
  }
  if (quoteResult.quote.minDiemOut < configuredFlashFee.totalFlashRepaymentDiem) {
    readiness.push("Curve exit route minDiemOut does not cover Morpho repay amount plus Uniswap V3 flash fee");
    return {
      params: null,
      routeQuote: quoteResult.quote,
      routeSlippage: quoteResult.evidence,
      flashLoanLiquidity,
      morphoDebtBlockNumber: planningBlock,
      readiness,
    };
  }
  if (!input.force && !quoteResult.evidence.valid) {
    readiness.push("Curve exit route price impact exceeds configured cap; use force only after external review");
    return {
      params: null,
      routeQuote: quoteResult.quote,
      routeSlippage: quoteResult.evidence,
      flashLoanLiquidity,
      morphoDebtBlockNumber: planningBlock,
      readiness,
    };
  }

  const deadline =
    BigInt(input.nowSeconds ?? Math.floor(Date.now() / 1000)) +
    BigInt(input.config.execution.transactionDeadlineSeconds);
  return {
    params: {
      owner: input.owner,
      marketParams,
      repayAmountDiem,
      maxWstDiemToSell: position.collateral,
      minDiemOut: quoteResult.quote.minDiemOut,
      force: input.force ?? false,
      deadline,
    },
    routeQuote: quoteResult.quote,
    routeSlippage: quoteResult.evidence,
    flashLoanLiquidity,
    morphoDebtBlockNumber: planningBlock,
    readiness,
  };
}
