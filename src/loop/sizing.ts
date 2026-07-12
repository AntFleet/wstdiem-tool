import type { AppConfig } from "../types/domain.js";
import { WAD } from "../metrics/math.js";
import {
  adaptiveBorrowAprBps,
  MORPHO_INITIAL_RATE_AT_TARGET_APR_BPS,
  TARGET_UTILIZATION_WAD,
} from "./morphoRate.js";

const BPS_DENOMINATOR = 10_000;
const DAYS_PER_YEAR = 365;

export type LoopSizingStatus = "viable" | "marginal" | "blocked";

/**
 * How the simulator prices Morpho borrow cost.
 * - "flat": use `borrowApyBps` verbatim (legacy; treats borrow cost as constant).
 * - "adaptive-curve": derive borrow APR from the loop's POST-DRAW utilization via
 *   the AdaptiveCurveIrm curve and a `rateAtTargetApyBps` anchor. This is the
 *   default because a real loop's own borrow moves the rate — a shallow pool that
 *   reads ~1% idle can cost ~4x rateAtTarget once the loop consumes it.
 */
export type LoopBorrowRateModel = "flat" | "adaptive-curve";

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
  // The Curve pool as TWO legs in DIEM-equivalent (SPEC002 rev-2 R1). The exit draws the
  // DIEM leg, the entry draws the wstDIEM leg; the total (their sum) still feeds the
  // depth-sufficiency check. A single `--curve-depth-diem <total>` splits into balanced legs.
  curveDiemLegDiem: bigint;
  curveWstDiemLegDiem: bigint;
  morphoSupplyDiem: bigint;
  morphoExistingBorrowDiem: bigint;
  vaultApyBps: number;
  borrowApyBps: number;
  borrowRateModel: LoopBorrowRateModel;
  rateAtTargetApyBps: number;
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
  // One-time gas cost folded into `oneTimeCostDiem` (SPEC002 rev-2 R3). Defaults to 0
  // (unmodeled); the engine never auto-estimates gas, it warns when this is 0.
  gasCostDiem: bigint;
  // Optional live `get_dy` exit-slippage quote (SPEC002 rev-2 R2). When present it replaces
  // the leg-aware exit ESTIMATE at every consumption site. Injected by `--from-chain`
  // (SPEC003 Part B); the offline path leaves it undefined. Out of [0, 10000] -> invalid.
  externalExitSlippageBps?: number;
}

export interface LoopSizingAssumptions {
  curveDepthModel: "linear-per-leg-depth-share";
  morphoLiquidityModel: "supply-minus-existing-borrow";
  apyModel: "simple-annualized";
  borrowRateModel: "flat" | "adaptive-curve-instantaneous";
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
  // The exit-slippage bps ACTUALLY used by every gate/cost (SPEC002 rev-2 R1/R2). Holds the
  // leg-aware estimate, or a live `get_dy` quote when `externalExitSlippageBps` is injected.
  exitSlippageBps: number;
  // "get_dy" when a live exit quote was injected, else "estimate". Entry is always "estimate".
  exitSlippageSource: "get_dy" | "estimate";
  // Verdict-adjacent caveats that ride the status (SPEC002 rev-2 R3): "gas unmodeled" when
  // `gasCostDiem == 0`, and a leg-imbalance warning when the pool is materially lopsided.
  warnings: string[];
  flashFeeCostDiem: bigint;
  oneTimeCostDiem: bigint;
  annualizedOneTimeCostBps: number;
  grossVaultApyBps: number;
  borrowRateModel: LoopBorrowRateModel;
  postDrawUtilizationBps: number;
  effectiveBorrowApyBps: number;
  borrowAprAtTargetBps: number;
  borrowAprAtFullUtilizationBps: number;
  borrowCostApyBps: number;
  netApyBps: number;
  healthFactorBps: number | null;
  unwindDiemOut: bigint;
  unwindRepayRequiredDiem: bigint;
  // SPEC002 rev-3 E1 — shortfall (distance-to-clear) fields. Always populated, each ≥ 0 and exactly
  // `0` when its sub-condition passes, so a consumer reads "blocked by how much / what unblocks it"
  // uniformly. Pure derived arithmetic from values already computed above.
  //
  // `curveDiemLegSlippageShortfallDiem` is the DIEM leg depth that brings the EXIT-slippage
  // sub-condition (the PRIMARY curve gate) under the cap. Its type is `bigint | number`: normally a
  // bigint wei amount, but `Number.POSITIVE_INFINITY` when `maxSlippageBps ≤ curveFeeBps` (the exit
  // can never clear the cap by adding depth). The number-Infinity representation is chosen so the
  // EXISTING output.ts JSON replacer (non-finite number → `"Infinity"`) serializes it without any new
  // sentinel — a bigint has no Infinity value, so the unclearable case is carried as a number.
  curveDiemLegSlippageShortfallDiem: bigint | number;
  // Per-leg depth-SHARE gaps (E4 backstop's sub-condition; surfaced here in Wave 1, gate unchanged).
  curveDiemLegShortfallDiem: bigint;
  curveWstDiemLegShortfallDiem: bigint;
  // bps over the slippage cap. Mirrors `exitSlippageBps`'s finiteness: `+Infinity` on a zero drawn leg
  // (offline), which the replacer emits as `"Infinity"` — NOT clamped to 0 (a clamp would read as
  // "slippage is fine" on the most-drained pool).
  exitSlippageExcessBps: number;
  morphoSupplyShortfallDiem: bigint;
  netApyShortfallBps: number;
  // SPEC002 rev-3 E2 — entry-time STRUCTURAL liquidation-distance identity (the fractional decline in
  // collateral value, bps, absorbed before HF reaches 1.0). NOT a live margin: it inherits
  // `healthFactorBps`'s limits verbatim (assumes static NAV/oracle). `null` mirrors
  // `healthFactorBps === null` (debt-free; the engine yields null, never +Infinity); `0` when HF ≤ 10000.
  structuralMarginToLiquidationBps: number | null;
}

/**
 * How a chain-seeded input reached the sizing engine (SPEC003 §6). Present only on a
 * `loop sizing --from-chain` report; the offline path leaves it undefined so its output
 * stays byte-for-byte unchanged. Only the Part-A fields are populated — the Part-B curve
 * legs / vault-APY provenance are gated behind SPEC002 rev-2.
 *
 * `rateAtTargetSource` is only ever `"direct"` (a normal non-zero on-chain read) or
 * `"uninitialized-default"` (rateAtTarget read as 0; fail-closed to the genesis 400 bps
 * default). The `borrowRateView`-inversion fallback is deferred out of Part A (SPEC003
 * §3.1) — a direct-read revert fails closed instead, so no `"inverted"` /
 * `"inverted-ill-conditioned"` source is produced by this engine.
 */
export interface SeedProvenance {
  blockNumber: bigint;
  chainId: number;
  rateAtTargetSource: "direct" | "uninitialized-default";
  // Part B-1 curve provenance (SPEC003 §4.2/§6), populated only when the two Curve legs are
  // chain-seeded; Part A and the explicit-flag / liquidity-sweep paths leave them undefined.
  // Both legs are DIEM-denominated (`curveWstDiemLegDiem` is the wstDIEM leg valued at NAV).
  curveDiemLegDiem?: bigint;
  curveWstDiemLegDiem?: bigint;
  curveImbalanceRatio?: number;
  // Part B-2 vault-APY provenance (SPEC003 §4.3/§6). `"measured-7d"` when a 7-day DB window
  // produced a chain-measured vault APY; `"not-seeded"` when the operator supplied an explicit
  // `--vault-apy-bps` OR the window was too short / low-density (fell back to the default/grid).
  // Absent when no store is supplied (offline / Part-A/B-1 callers). Anything other than
  // `"measured-7d"` demotes the verdict (§6). vaultApy is block-pinning EXEMPT (§2).
  vaultApySource?: "measured-7d" | "not-seeded";
  seededFields: Record<string, "chain" | "flag" | "default">;
  authoritative: boolean;
  warnings: string[];
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
  // Additive, present ONLY under `--from-chain`. When `authoritative` is false the
  // rendered verdict token degrades (SPEC003 §6); the underlying gate status is untouched.
  seedProvenance?: SeedProvenance;
  authoritative?: boolean;
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

/**
 * The single source of truth for a scenario's levered position collateral (SPEC002 rev-2):
 * `ceil(initialCollateral × targetLeverage)`. Defined once here and reused by both
 * `sizeLoopScenario` and the `--from-chain` `get_dy` seam (SPEC003 §4.2), so the sizing
 * that drives the live exit quote is byte-identical to the sizing the gates evaluate.
 */
export function positionCollateralForScenario(scenario: LoopSizingScenario): bigint {
  return mulDivCeil(scenario.initialCollateralDiem, scenario.targetLeverageBps);
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
  drawnLegDiem: bigint,
  curveFeeBps: number,
): number {
  if (tradeDiem === 0n) {
    return curveFeeBps;
  }
  // A zero DRAWN leg cannot absorb the trade -> +Infinity (SPEC002 rev-2 R1).
  if (drawnLegDiem === 0n) {
    return Number.POSITIVE_INFINITY;
  }
  return curveFeeBps + numberRatioBps(tradeDiem, drawnLegDiem);
}

function capFiniteBps(value: number): number {
  if (!Number.isFinite(value)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.ceil(value);
}

function validateScenario(scenario: LoopSizingScenario): LoopSizingBlocker[] {
  const blockers: LoopSizingBlocker[] = [];
  const externalExitOutOfRange =
    scenario.externalExitSlippageBps !== undefined &&
    (scenario.externalExitSlippageBps < 0 ||
      scenario.externalExitSlippageBps > BPS_DENOMINATOR);
  if (
    scenario.initialCollateralDiem <= 0n ||
    scenario.targetLeverageBps <= BPS_DENOMINATOR ||
    scenario.curveDiemLegDiem < 0n ||
    scenario.curveWstDiemLegDiem < 0n ||
    scenario.morphoSupplyDiem < 0n ||
    scenario.morphoExistingBorrowDiem < 0n ||
    scenario.gasCostDiem < 0n ||
    externalExitOutOfRange ||
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
    Math.max(result.estimatedEntrySlippageBps, result.exitSlippageBps) >
    result.scenario.maxSlippageBps * 0.8;
  const healthNearFloor =
    result.healthFactorBps !== null &&
    result.healthFactorBps < Math.ceil(result.scenario.minHealthFactorBps * 1.1);
  const apyNearFloor = result.netApyBps < result.scenario.minNetApyBps + 200;
  return slippageNearCap || healthNearFloor || apyNearFloor;
}

export function sizeLoopScenario(scenario: LoopSizingScenario): LoopSizingResult {
  const blockers = validateScenario(scenario);
  const positionCollateralDiem = positionCollateralForScenario(scenario);
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
  // Total two-sided depth, RECONSTRUCTED from the legs (SPEC002 rev-2 R1). It feeds only the
  // depth-based parts of gate 1 (the sufficiency sub-condition and the `requiredCurve*`
  // outputs); slippage is per-leg below.
  const curveDepthDiem = scenario.curveDiemLegDiem + scenario.curveWstDiemLegDiem;
  // Leg-aware, direction-correct slippage (SPEC002 rev-2 R1): a Curve exchange(i,j) pays OUT
  // coin j, depleting the j leg. The EXIT sells wstDIEM (exchange(1,0)) -> draws the DIEM leg;
  // the ENTRY buys wstDIEM (exchange(0,1)) -> draws the wstDIEM leg. A zero DRAWN leg -> +Inf.
  const estimatedEntrySlippageBps = capFiniteBps(
    estimateSlippageBps(borrowAmountDiem, scenario.curveWstDiemLegDiem, scenario.curveFeeBps),
  );
  const estimatedExitSlippageBps = capFiniteBps(
    estimateSlippageBps(positionCollateralDiem, scenario.curveDiemLegDiem, scenario.curveFeeBps),
  );
  // A live get_dy quote (SPEC002 rev-2 R2), when injected, REPLACES the exit estimate at every
  // consumption site (gate 1, exit cost -> netApy, the unwind backstop, the marginal band) so
  // the verdict stays internally consistent. Entry is always an estimate.
  const exitSlippageSource: "get_dy" | "estimate" =
    scenario.externalExitSlippageBps === undefined ? "estimate" : "get_dy";
  const exitSlippageBps =
    scenario.externalExitSlippageBps === undefined
      ? estimatedExitSlippageBps
      : capFiniteBps(scenario.externalExitSlippageBps);
  const flashFeeCostDiem = mulDivCeil(borrowAmountDiem, scenario.flashFeeBps);
  const entrySlippageCostDiem = Number.isFinite(estimatedEntrySlippageBps)
    ? mulDivCeil(borrowAmountDiem, estimatedEntrySlippageBps)
    : positionCollateralDiem;
  const exitSlippageCostDiem = Number.isFinite(exitSlippageBps)
    ? mulDivCeil(positionCollateralDiem, exitSlippageBps)
    : positionCollateralDiem;
  // Gas is a first-class one-time cost (SPEC002 rev-2 R3); it defaults to 0 (unmodeled), and a
  // `gas unmodeled` warning then rides the verdict. MEV stays a caveat, not a number.
  const oneTimeCostDiem =
    entrySlippageCostDiem + exitSlippageCostDiem + flashFeeCostDiem + scenario.gasCostDiem;
  const annualizedOneTimeCostBps = Math.ceil(
    numberRatioBps(oneTimeCostDiem, scenario.initialCollateralDiem) *
      (DAYS_PER_YEAR / scenario.holdingPeriodDays),
  );
  const leverage = leverageMultiplier(scenario);
  const grossVaultApyBps = Math.round(leverage * scenario.vaultApyBps);
  // Post-draw utilization = (existing borrow + this loop's borrow) / supply. This
  // is what the loop's OWN draw pushes utilization to, and what the Adaptive Curve
  // IRM prices against — the whole reason a flat borrow-APY assumption understates cost.
  const postDrawBorrowDiem = scenario.morphoExistingBorrowDiem + borrowAmountDiem;
  const postDrawUtilizationWad =
    scenario.morphoSupplyDiem > 0n
      ? (postDrawBorrowDiem * WAD) / scenario.morphoSupplyDiem
      : postDrawBorrowDiem > 0n
        ? WAD
        : 0n;
  // Reported utilization is uncapped (can exceed 100% to signal an over-draw);
  // the rate curve itself clamps to 100%.
  const postDrawUtilizationBps = Number((postDrawUtilizationWad * BigInt(BPS_DENOMINATOR)) / WAD);
  const utilizationForRateWad = postDrawUtilizationWad > WAD ? WAD : postDrawUtilizationWad;
  const borrowAprAtTargetBps = adaptiveBorrowAprBps(
    TARGET_UTILIZATION_WAD,
    scenario.rateAtTargetApyBps,
  );
  const borrowAprAtFullUtilizationBps = adaptiveBorrowAprBps(WAD, scenario.rateAtTargetApyBps);
  const effectiveBorrowApyBps =
    scenario.borrowRateModel === "flat"
      ? scenario.borrowApyBps
      : adaptiveBorrowAprBps(utilizationForRateWad, scenario.rateAtTargetApyBps);
  const borrowCostApyBps = Math.round((leverage - 1) * effectiveBorrowApyBps);
  const netApyBps = grossVaultApyBps - borrowCostApyBps - annualizedOneTimeCostBps;
  const healthFactorBps =
    borrowAmountDiem === 0n
      ? null
      : Math.floor(
          (scenario.targetLeverageBps * scenario.lltvBps) /
            (scenario.targetLeverageBps - BPS_DENOMINATOR),
        );
  const unwindDiemOut =
    Number.isFinite(exitSlippageBps) && exitSlippageBps < BPS_DENOMINATOR
      ? mulDivFloor(positionCollateralDiem, BPS_DENOMINATOR - exitSlippageBps)
      : 0n;
  const unwindRepayRequiredDiem = mulDivCeil(
    borrowAmountDiem,
    BPS_DENOMINATOR + scenario.exitRepayBufferBps + scenario.flashFeeBps,
  );

  if (curveDepthDiem < requiredCurveDepthDiem || exitSlippageBps > scenario.maxSlippageBps) {
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

  // Verdict-adjacent caveats (SPEC002 rev-2 R3). Gas is unmodeled unless the operator supplies
  // a figure; a materially lopsided pool (|diemLeg - wstDiemLeg| / total > 20%) is where a
  // `viable` reading is most optimistic, so it rides the verdict too.
  const warnings: string[] = [];
  if (scenario.gasCostDiem === 0n) {
    warnings.push("gas unmodeled");
  }
  if (curveDepthDiem > 0n) {
    const legImbalance =
      scenario.curveDiemLegDiem > scenario.curveWstDiemLegDiem
        ? scenario.curveDiemLegDiem - scenario.curveWstDiemLegDiem
        : scenario.curveWstDiemLegDiem - scenario.curveDiemLegDiem;
    if (legImbalance * 5n > curveDepthDiem) {
      warnings.push("curve legs imbalanced");
    }
  }

  // SPEC002 rev-3 E1 — shortfall (distance-to-clear) fields. All ≥ 0 and exactly 0 when the
  // corresponding sub-condition passes; derived purely from values already computed above.
  // Depth that brings the linear EXIT slippage under the cap: fee + ratioBps(position, diemLeg) ≤
  // maxSlippageBps ⇔ diemLeg ≥ ceil(position·BPS/(maxSlippageBps − curveFeeBps)). When
  // maxSlippageBps ≤ curveFeeBps the cap is unreachable by depth → +Infinity (see interface note).
  const requiredDiemLegForSlippage =
    scenario.maxSlippageBps > scenario.curveFeeBps
      ? mulDivCeil(
          positionCollateralDiem,
          BPS_DENOMINATOR,
          scenario.maxSlippageBps - scenario.curveFeeBps,
        )
      : null;
  const curveDiemLegSlippageShortfallDiem: bigint | number =
    requiredDiemLegForSlippage === null
      ? Number.POSITIVE_INFINITY
      : requiredDiemLegForSlippage > scenario.curveDiemLegDiem
        ? requiredDiemLegForSlippage - scenario.curveDiemLegDiem
        : 0n;
  const curveDiemLegShortfallDiem =
    requiredCurveDiemDepth > scenario.curveDiemLegDiem
      ? requiredCurveDiemDepth - scenario.curveDiemLegDiem
      : 0n;
  const curveWstDiemLegShortfallDiem =
    requiredCurveWstDiemDepth > scenario.curveWstDiemLegDiem
      ? requiredCurveWstDiemDepth - scenario.curveWstDiemLegDiem
      : 0n;
  // +Infinity when exitSlippageBps is +Infinity (zero drawn leg, offline); never clamped to 0.
  const exitSlippageExcessBps =
    exitSlippageBps > scenario.maxSlippageBps ? exitSlippageBps - scenario.maxSlippageBps : 0;
  const morphoSupplyShortfallDiem =
    requiredMorphoSupplyDiem > scenario.morphoSupplyDiem
      ? requiredMorphoSupplyDiem - scenario.morphoSupplyDiem
      : 0n;
  const netApyShortfallBps = Math.max(0, scenario.minNetApyBps - netApyBps);
  // SPEC002 rev-3 E2 — entry-time structural liquidation-distance (see interface note).
  const structuralMarginToLiquidationBps =
    healthFactorBps === null
      ? null
      : Math.max(
          0,
          Math.round(
            (BPS_DENOMINATOR * (healthFactorBps - BPS_DENOMINATOR)) / healthFactorBps,
          ),
        );

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
    exitSlippageBps,
    exitSlippageSource,
    warnings,
    flashFeeCostDiem,
    oneTimeCostDiem,
    annualizedOneTimeCostBps,
    grossVaultApyBps,
    borrowRateModel: scenario.borrowRateModel,
    postDrawUtilizationBps,
    effectiveBorrowApyBps,
    borrowAprAtTargetBps,
    borrowAprAtFullUtilizationBps,
    borrowCostApyBps,
    netApyBps,
    healthFactorBps,
    unwindDiemOut,
    unwindRepayRequiredDiem,
    curveDiemLegSlippageShortfallDiem,
    curveDiemLegShortfallDiem,
    curveWstDiemLegShortfallDiem,
    exitSlippageExcessBps,
    morphoSupplyShortfallDiem,
    netApyShortfallBps,
    structuralMarginToLiquidationBps,
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
  const usesFlat = results.every((result) => result.borrowRateModel === "flat");
  return {
    assumptions: {
      curveDepthModel: "linear-per-leg-depth-share",
      morphoLiquidityModel: "supply-minus-existing-borrow",
      apyModel: "simple-annualized",
      borrowRateModel:
        results.length > 0 && usesFlat ? "flat" : "adaptive-curve-instantaneous",
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
  | "curveDiemLegDiem"
  | "curveWstDiemLegDiem"
  | "morphoSupplyDiem"
  | "vaultApyBps"
  | "borrowApyBps"
> {
  return {
    morphoExistingBorrowDiem: 0n,
    gasCostDiem: 0n,
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
    borrowRateModel: "adaptive-curve",
    rateAtTargetApyBps: MORPHO_INITIAL_RATE_AT_TARGET_APR_BPS,
  };
}
