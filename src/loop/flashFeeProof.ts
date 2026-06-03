import type {
  ExitFlashFeeProof,
  FlashLoanLiquidityEvidence,
  LoopAction,
  LoopExecutorParams,
  LoopExitParams,
  RouteSlippageEvidence,
} from "./types.js";
import type { AppConfig } from "../types/domain.js";
import { ALLOWED_UNISWAP_V3_FEE_TIERS, expectedUniswapV3FlashFee } from "./uniswapV3FlashFee.js";

const unresolvedReason =
  "fee-inclusive proof is blocked until Uniswap V3 flash-loan provider config and executor callback behavior are available";

export function deriveConfiguredExitFlashFee(
  config: AppConfig,
  repayAmountDiem: bigint,
):
  | {
      flashFee: bigint;
      totalFlashRepaymentDiem: bigint;
      provider: "uniswap-v3";
      pool: NonNullable<AppConfig["flashLoan"]["pool"]>;
      factory: NonNullable<AppConfig["flashLoan"]["factory"]>;
      feeTier: number;
    }
  | null {
  const flashLoan = config.flashLoan;
  if (
    flashLoan.provider !== "uniswap-v3" ||
    flashLoan.factory === null ||
    flashLoan.pool === null ||
    flashLoan.loanToken === null ||
    flashLoan.pairToken === null ||
    flashLoan.feeTier === null ||
    flashLoan.loanToken.toLowerCase() !== config.contracts.diem.toLowerCase() ||
    flashLoan.pairToken.toLowerCase() === flashLoan.loanToken.toLowerCase() ||
    !ALLOWED_UNISWAP_V3_FEE_TIERS.has(flashLoan.feeTier)
  ) {
    return null;
  }

  const flashFee = expectedUniswapV3FlashFee(repayAmountDiem, flashLoan.feeTier);
  if (flashFee === null) {
    return null;
  }
  return {
    flashFee,
    totalFlashRepaymentDiem: repayAmountDiem + flashFee,
    provider: "uniswap-v3",
    pool: flashLoan.pool,
    factory: flashLoan.factory,
    feeTier: flashLoan.feeTier,
  };
}

function buildUnresolvedProof(repayAmountDiem?: bigint, minDiemOut?: bigint, morphoRepayCovered?: boolean): ExitFlashFeeProof {
  return {
    repayAmountDiem: repayAmountDiem?.toString(),
    flashFee: "unresolved",
    flashFeeSource: "unresolved",
    flashLoanProvider: "unconfigured",
    totalFlashRepaymentDiem: "unresolved",
    minDiemOut: minDiemOut?.toString(),
    morphoRepayCovered,
    feeInclusiveRepayCovered: "blocked",
    reason: unresolvedReason,
  };
}

export function buildExitFlashFeeProof(
  config: AppConfig,
  action: LoopAction,
  params: LoopExecutorParams | null,
  flashLoanLiquidity?: FlashLoanLiquidityEvidence,
  routeSlippage?: RouteSlippageEvidence,
): ExitFlashFeeProof | undefined {
  if (action !== "exit") {
    return undefined;
  }
  if (params === null) {
    return buildUnresolvedProof();
  }

  const exitParams = params as LoopExitParams;
  const morphoRepayCovered = exitParams.minDiemOut >= exitParams.repayAmountDiem;
  const configuredFlashFee = deriveConfiguredExitFlashFee(config, exitParams.repayAmountDiem);
  if (configuredFlashFee === null) {
    return buildUnresolvedProof(exitParams.repayAmountDiem, exitParams.minDiemOut, morphoRepayCovered);
  }
  const matchingLiquidity =
    flashLoanLiquidity?.provider === "uniswap-v3" &&
    flashLoanLiquidity.factory.toLowerCase() === configuredFlashFee.factory.toLowerCase() &&
    flashLoanLiquidity.pool.toLowerCase() === configuredFlashFee.pool.toLowerCase() &&
    flashLoanLiquidity.loanToken.toLowerCase() === config.contracts.diem.toLowerCase() &&
    flashLoanLiquidity.requestedLoan === exitParams.repayAmountDiem &&
    flashLoanLiquidity.valid === true &&
    flashLoanLiquidity.availableLoan >= flashLoanLiquidity.requestedLoan &&
    routeSlippage !== undefined &&
    flashLoanLiquidity.blockNumber === routeSlippage.blockNumber
      ? flashLoanLiquidity
      : undefined;
  const hasLiquidityEvidence = matchingLiquidity !== undefined;

  return {
    repayAmountDiem: exitParams.repayAmountDiem.toString(),
    flashFee: configuredFlashFee.flashFee.toString(),
    flashFeeSource: "uniswap-v3-fee-tier",
    flashLoanProvider: "uniswap-v3",
    flashLoanPool: configuredFlashFee.pool,
    flashLoanFactory: configuredFlashFee.factory,
    flashLoanFeeTier: configuredFlashFee.feeTier,
    flashLoanLiquidityBlockNumber: matchingLiquidity?.blockNumber.toString(),
    flashLoanAvailableDiem: matchingLiquidity?.availableLoan.toString(),
    flashLoanRequestedDiem: matchingLiquidity?.requestedLoan.toString(),
    flashLoanLiquidityCovered: matchingLiquidity?.valid,
    totalFlashRepaymentDiem: configuredFlashFee.totalFlashRepaymentDiem.toString(),
    minDiemOut: exitParams.minDiemOut.toString(),
    morphoRepayCovered,
    feeInclusiveRepayCovered: hasLiquidityEvidence
      ? exitParams.minDiemOut >= configuredFlashFee.totalFlashRepaymentDiem
      : "blocked",
    reason: hasLiquidityEvidence
      ? "fee-inclusive proof computed from configured Uniswap V3 fee tier with matching live liquidity evidence; callback fee remains canonical in executor fork tests"
      : "fee-inclusive proof requires matching same-block route and live Uniswap V3 liquidity evidence before simulation can pass",
  };
}
