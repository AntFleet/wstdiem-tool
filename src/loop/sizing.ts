import type { AppConfig } from "../types/domain.js";
import { WAD } from "../metrics/math.js";

const BPS_DENOMINATOR = 10_000;
const DAYS_PER_YEAR = 365;

export type LoopSizingStatus = "viable" | "marginal" | "blocked";

export type LoopSizingBlocker =
  | "scenario_invalid"
  | "curve_liquidity_insufficient"
  | "morpho_supply_insufficient"
  | "net_apy_below_threshold"
  | "health_factor_below_threshold"
  | "unwind_not_covered";

export interface LoopSizingScenario {
  id: string;
  initialCollateralDiem: bigint;
  targetLeverageBps: number;
  curveDepthDiem: bigint;
  morphoSupplyDiem: bigint;
  morphoExistingBorrowDiem: bigint;
  vaultApyBps: number;
  borrowApyBps: number;
  curveFeeBps: number;
  maxSlippageBps: number;
  flashFeeBps: number;
  maxCurvePositionShareBps: number;
  maxMorphoUtilizationBps: number;
  lltvBps: number;
  minHealthFactorBps: number;
  minNetApyBps: number;
  exitRepayBufferBps: number;
  holdingPeriodDays: number;
}

export interface LoopSizingAssumptions {
  curveDepthModel: "linear-depth-share";
  morphoLiquidityModel: "supply-minus-existing-borrow";
  apyModel: "simple-annualized";
  readOnly: true;
  broadcastAvailable: false;
  auditRequired: true;
}

export interface LoopSizingResult {
  scenario: LoopSizingScenario;
  status: LoopSizingStatus;
  blockers: LoopSizingBlocker[];
  firstBlocker: LoopSizingBlocker | null;
  positionCollateralDiem: bigint;
  borrowAmountDiem: bigint;
  equityDiem: bigint;
  requiredCurveDepthDiem: bigint;
  requiredCurveDiemDepth: bigint;
  requiredCurveWstDiemDepth: bigint;
  requiredMorphoSupplyDiem: bigint;
  availableMorphoBorrowDiem: bigint;
  estimatedEntrySlippageBps: number;
  estimatedExitSlippageBps: number;
  flashFeeCostDiem: bigint;
  oneTimeCostDiem: bigint;
  annualizedOneTimeCostBps: number;
  grossVaultApyBps: number;
  borrowCostApyBps: number;
  netApyBps: number;
  healthFactorBps: number | null;
  unwindDiemOut: bigint;
  unwindRepayRequiredDiem: bigint;
}

export interface LoopSizingReport {
  assumptions: LoopSizingAssumptions;
  results: LoopSizingResult[];
  summary: {
    total: number;
    viable: number;
    marginal: number;
    blocked: number;
    firstViableByLeverage: Array<{
      targetLeverageBps: number;
      requiredCurveDepthDiem: bigint;
      requiredMorphoSupplyDiem: bigint;
      status: Exclude<LoopSizingStatus, "blocked">;
      scenarioId: string;
    }>;
  };
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("denominator must be positive");
  }
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function mulDivCeil(value: bigint, multiplier: number, denominator = BPS_DENOMINATOR): bigint {
  return ceilDiv(value * BigInt(multiplier), BigInt(denominator));
}

function mulDivFloor(value: bigint, multiplier: number, denominator = BPS_DENOMINATOR): bigint {
  return (value * BigInt(multiplier)) / BigInt(denominator);
}

function leverageMultiplier(scenario: LoopSizingScenario): number {
  return scenario.targetLeverageBps / BPS_DENOMINATOR;
}

function numberRatioBps(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) {
    return Number.POSITIVE_INFINITY;
  }
  const scaled = (numerator * 1_000_000n) / denominator;
  return Number(scaled) / 100;
}

function estimateSlippageBps(
  tradeDiem: bigint,
  curveDepthDiem: bigint,
  curveFeeBps: number,
): number {
  if (tradeDiem === 0n) {
    return curveFeeBps;
  }
  if (curveDepthDiem === 0n) {
    return Number.POSITIVE_INFINITY;
  }
  return curveFeeBps + numberRatioBps(tradeDiem, curveDepthDiem);
}

function capFiniteBps(value: number): number {
  if (!Number.isFinite(value)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.ceil(value);
}

function validateScenario(scenario: LoopSizingScenario): LoopSizingBlocker[] {
  const blockers: LoopSizingBlocker[] = [];
  if (
    scenario.initialCollateralDiem <= 0n ||
    scenario.targetLeverageBps <= BPS_DENOMINATOR ||
    scenario.curveDepthDiem < 0n ||
    scenario.morphoSupplyDiem < 0n ||
    scenario.morphoExistingBorrowDiem < 0n ||
    scenario.maxCurvePositionShareBps <= 0 ||
    scenario.maxMorphoUtilizationBps <= 0 ||
    scenario.maxMorphoUtilizationBps > BPS_DENOMINATOR ||
    scenario.lltvBps <= 0 ||
    scenario.minHealthFactorBps <= 0 ||
    scenario.holdingPeriodDays <= 0
  ) {
    blockers.push("scenario_invalid");
  }
  return blockers;
}

function isMarginal(result: Omit<LoopSizingResult, "status">): boolean {
  const slippageNearCap =
    Math.max(result.estimatedEntrySlippageBps, result.estimatedExitSlippageBps) >
    result.scenario.maxSlippageBps * 0.8;
  const healthNearFloor =
    result.healthFactorBps !== null &&
    result.healthFactorBps < Math.ceil(result.scenario.minHealthFactorBps * 1.1);
  const apyNearFloor = result.netApyBps < result.scenario.minNetApyBps + 200;
  return slippageNearCap || healthNearFloor || apyNearFloor;
}

export function sizeLoopScenario(scenario: LoopSizingScenario): LoopSizingResult {
  const blockers = validateScenario(scenario);
  const positionCollateralDiem = mulDivCeil(
    scenario.initialCollateralDiem,
    scenario.targetLeverageBps,
  );
  const borrowAmountDiem =
    positionCollateralDiem > scenario.initialCollateralDiem
      ? positionCollateralDiem - scenario.initialCollateralDiem
      : 0n;
  const requiredCurveDepthDiem = mulDivCeil(
    positionCollateralDiem,
    BPS_DENOMINATOR,
    scenario.maxCurvePositionShareBps,
  );
  const requiredCurveDiemDepth = requiredCurveDepthDiem / 2n;
  const requiredCurveWstDiemDepth = requiredCurveDepthDiem - requiredCurveDiemDepth;
  const requiredMorphoSupplyDiem = mulDivCeil(
    borrowAmountDiem,
    BPS_DENOMINATOR,
    scenario.maxMorphoUtilizationBps,
  );
  const utilizationBorrowLimit = mulDivFloor(
    scenario.morphoSupplyDiem,
    scenario.maxMorphoUtilizationBps,
  );
  const availableMorphoBorrowDiem =
    utilizationBorrowLimit > scenario.morphoExistingBorrowDiem
      ? utilizationBorrowLimit - scenario.morphoExistingBorrowDiem
      : 0n;
  const estimatedEntrySlippageBps = capFiniteBps(
    estimateSlippageBps(borrowAmountDiem, scenario.curveDepthDiem, scenario.curveFeeBps),
  );
  const estimatedExitSlippageBps = capFiniteBps(
    estimateSlippageBps(positionCollateralDiem, scenario.curveDepthDiem, scenario.curveFeeBps),
  );
  const flashFeeCostDiem = mulDivCeil(borrowAmountDiem, scenario.flashFeeBps);
  const entrySlippageCostDiem = Number.isFinite(estimatedEntrySlippageBps)
    ? mulDivCeil(borrowAmountDiem, estimatedEntrySlippageBps)
    : positionCollateralDiem;
  const exitSlippageCostDiem = Number.isFinite(estimatedExitSlippageBps)
    ? mulDivCeil(positionCollateralDiem, estimatedExitSlippageBps)
    : positionCollateralDiem;
  const oneTimeCostDiem = entrySlippageCostDiem + exitSlippageCostDiem + flashFeeCostDiem;
  const annualizedOneTimeCostBps = Math.ceil(
    numberRatioBps(oneTimeCostDiem, scenario.initialCollateralDiem) *
      (DAYS_PER_YEAR / scenario.holdingPeriodDays),
  );
  const leverage = leverageMultiplier(scenario);
  const grossVaultApyBps = Math.round(leverage * scenario.vaultApyBps);
  const borrowCostApyBps = Math.round((leverage - 1) * scenario.borrowApyBps);
  const netApyBps = grossVaultApyBps - borrowCostApyBps - annualizedOneTimeCostBps;
  const healthFactorBps =
    borrowAmountDiem === 0n
      ? null
      : Math.floor(
          (scenario.targetLeverageBps * scenario.lltvBps) /
            (scenario.targetLeverageBps - BPS_DENOMINATOR),
        );
  const unwindDiemOut =
    Number.isFinite(estimatedExitSlippageBps) && estimatedExitSlippageBps < BPS_DENOMINATOR
      ? mulDivFloor(positionCollateralDiem, BPS_DENOMINATOR - estimatedExitSlippageBps)
      : 0n;
  const unwindRepayRequiredDiem = mulDivCeil(
    borrowAmountDiem,
    BPS_DENOMINATOR + scenario.exitRepayBufferBps + scenario.flashFeeBps,
  );

  if (
    scenario.curveDepthDiem < requiredCurveDepthDiem ||
    estimatedExitSlippageBps > scenario.maxSlippageBps
  ) {
    blockers.push("curve_liquidity_insufficient");
  }
  if (
    scenario.morphoSupplyDiem < requiredMorphoSupplyDiem ||
    availableMorphoBorrowDiem < borrowAmountDiem
  ) {
    blockers.push("morpho_supply_insufficient");
  }
  if (netApyBps < scenario.minNetApyBps) {
    blockers.push("net_apy_below_threshold");
  }
  if (healthFactorBps !== null && healthFactorBps < scenario.minHealthFactorBps) {
    blockers.push("health_factor_below_threshold");
  }
  if (unwindDiemOut < unwindRepayRequiredDiem) {
    blockers.push("unwind_not_covered");
  }

  const baseResult = {
    scenario,
    blockers,
    firstBlocker: blockers[0] ?? null,
    positionCollateralDiem,
    borrowAmountDiem,
    equityDiem: scenario.initialCollateralDiem,
    requiredCurveDepthDiem,
    requiredCurveDiemDepth,
    requiredCurveWstDiemDepth,
    requiredMorphoSupplyDiem,
    availableMorphoBorrowDiem,
    estimatedEntrySlippageBps,
    estimatedExitSlippageBps,
    flashFeeCostDiem,
    oneTimeCostDiem,
    annualizedOneTimeCostBps,
    grossVaultApyBps,
    borrowCostApyBps,
    netApyBps,
    healthFactorBps,
    unwindDiemOut,
    unwindRepayRequiredDiem,
  };
  return {
    ...baseResult,
    status: blockers.length > 0 ? "blocked" : isMarginal(baseResult) ? "marginal" : "viable",
  };
}

function firstViableByLeverage(
  results: LoopSizingResult[],
): LoopSizingReport["summary"]["firstViableByLeverage"] {
  const selected = new Map<number, LoopSizingResult>();
  for (const result of results) {
    if (result.status === "blocked") {
      continue;
    }
    const existing = selected.get(result.scenario.targetLeverageBps);
    if (
      existing === undefined ||
      result.requiredCurveDepthDiem < existing.requiredCurveDepthDiem ||
      (result.requiredCurveDepthDiem === existing.requiredCurveDepthDiem &&
        result.requiredMorphoSupplyDiem < existing.requiredMorphoSupplyDiem)
    ) {
      selected.set(result.scenario.targetLeverageBps, result);
    }
  }
  return [...selected.values()]
    .sort((left, right) => left.scenario.targetLeverageBps - right.scenario.targetLeverageBps)
    .map((result) => ({
      targetLeverageBps: result.scenario.targetLeverageBps,
      requiredCurveDepthDiem: result.requiredCurveDepthDiem,
      requiredMorphoSupplyDiem: result.requiredMorphoSupplyDiem,
      status: result.status as Exclude<LoopSizingStatus, "blocked">,
      scenarioId: result.scenario.id,
    }));
}

export function buildLoopSizingReport(scenarios: LoopSizingScenario[]): LoopSizingReport {
  const results = scenarios.map(sizeLoopScenario);
  return {
    assumptions: {
      curveDepthModel: "linear-depth-share",
      morphoLiquidityModel: "supply-minus-existing-borrow",
      apyModel: "simple-annualized",
      readOnly: true,
      broadcastAvailable: false,
      auditRequired: true,
    },
    results,
    summary: {
      total: results.length,
      viable: results.filter((result) => result.status === "viable").length,
      marginal: results.filter((result) => result.status === "marginal").length,
      blocked: results.filter((result) => result.status === "blocked").length,
      firstViableByLeverage: firstViableByLeverage(results),
    },
  };
}

export function defaultSizingValues(
  config: AppConfig,
): Omit<
  LoopSizingScenario,
  | "id"
  | "initialCollateralDiem"
  | "targetLeverageBps"
  | "curveDepthDiem"
  | "morphoSupplyDiem"
  | "vaultApyBps"
  | "borrowApyBps"
> {
  return {
    morphoExistingBorrowDiem: 0n,
    curveFeeBps: 4,
    maxSlippageBps: config.execution.maxSlippageBps,
    flashFeeBps: Math.ceil((config.flashLoan.feeTier ?? 0) / 100),
    maxCurvePositionShareBps: Math.max(
      1,
      Math.floor(config.thresholds.curveDepthWarn * BPS_DENOMINATOR),
    ),
    maxMorphoUtilizationBps: 8000,
    lltvBps: Number((BigInt(config.morpho.lltvWad) * BigInt(BPS_DENOMINATOR)) / WAD),
    minHealthFactorBps: Math.ceil(config.thresholds.minPostLoopHealthFactor * BPS_DENOMINATOR),
    minNetApyBps: 0,
    exitRepayBufferBps: config.execution.exitRepayBufferBps,
    holdingPeriodDays: DAYS_PER_YEAR,
  };
}
