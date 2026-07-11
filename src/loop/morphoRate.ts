import { WAD } from "../metrics/math.js";

/**
 * Faithful, offline model of Morpho Blue's AdaptiveCurveIrm borrow rate curve.
 *
 * The on-chain IRM sets the instantaneous borrow rate as
 *   borrowRate = curve(utilization) * rateAtTarget
 * where `curve` is a piecewise-linear multiplier pinned at:
 *   - 0.25x  at 0%   utilization
 *   - 1.0x   at 90%  utilization (TARGET_UTILIZATION)
 *   - 4.0x   at 100% utilization (CURVE_STEEPNESS)
 * and `rateAtTarget` is a slow-moving anchor (the rate the market pays at 90%
 * utilization) that itself drifts up under sustained high utilization and down
 * when the market sits idle.
 *
 * This module models the INSTANTANEOUS rate at a supplied utilization for a
 * supplied `rateAtTarget`. It deliberately does not model the multi-day
 * `rateAtTarget` adaptation (that needs elapsed-time + wExp state the offline
 * sizing simulator does not have) — instead `rateAtTarget` is a parameter the
 * operator reads on-chain or defaults to the Morpho genesis value. The point is
 * to make borrow cost a FUNCTION of the loop's own post-draw utilization rather
 * than a flat constant.
 *
 * bigint math mirrors Solidity SignedWadMath (truncation toward zero), so the
 * numbers reproduce `AdaptiveCurveIrm.borrowRateView` at a given (util, rateAtTarget).
 */

const SECONDS_PER_YEAR = 31_536_000n; // 365 days, matching Morpho's `365 days`
const BPS = 10_000n;

/** Utilization (WAD) at which borrowRate == rateAtTarget. Morpho TARGET_UTILIZATION. */
export const TARGET_UTILIZATION_WAD = 900_000_000_000_000_000n; // 0.9e18
/** Steepness: rate multiplier at 100% utilization. Morpho CURVE_STEEPNESS. */
const CURVE_STEEPNESS_WAD = 4n * WAD; // 4e18

/** Morpho genesis rate-at-target = 4% APR. Conservative default when unobserved. */
export const MORPHO_INITIAL_RATE_AT_TARGET_APR_BPS = 400;
/** Morpho MIN_RATE_AT_TARGET = 0.1% APR. */
export const MORPHO_MIN_RATE_AT_TARGET_APR_BPS = 10;
/** Morpho MAX_RATE_AT_TARGET = 200% APR. */
export const MORPHO_MAX_RATE_AT_TARGET_APR_BPS = 20_000;

/** Solidity wMulToZero: (a * b) / WAD, truncated toward zero (BigInt division). */
function wMulToZero(a: bigint, b: bigint): bigint {
  return (a * b) / WAD;
}

/** Solidity wDivToZero: (a * WAD) / b, truncated toward zero. */
function wDivToZero(a: bigint, b: bigint): bigint {
  return (a * WAD) / b;
}

function clampUtilizationWad(utilizationWad: bigint): bigint {
  if (utilizationWad < 0n) {
    return 0n;
  }
  return utilizationWad > WAD ? WAD : utilizationWad;
}

/**
 * The AdaptiveCurveIrm curve multiplier (WAD) at a given utilization (WAD).
 * Returns a value in [0.25e18, 4e18]: 0.25x at 0% util, 1x at 90%, 4x at 100%.
 */
export function curveMultiplierWad(utilizationWad: bigint): bigint {
  const utilization = clampUtilizationWad(utilizationWad);
  const errNormFactor =
    utilization > TARGET_UTILIZATION_WAD ? WAD - TARGET_UTILIZATION_WAD : TARGET_UTILIZATION_WAD;
  // err in [-WAD, WAD]: negative below target, positive above.
  const err = wDivToZero(utilization - TARGET_UTILIZATION_WAD, errNormFactor);
  // Below target the slope is (1 - 1/steepness); above target it is (steepness - 1).
  const coeff = err < 0n ? WAD - wDivToZero(WAD, CURVE_STEEPNESS_WAD) : CURVE_STEEPNESS_WAD - WAD;
  return wMulToZero(coeff, err) + WAD;
}

/** Instantaneous per-second borrow rate (WAD) at a utilization for a rateAtTarget (per-second WAD). */
export function instantaneousBorrowRatePerSecWad(
  utilizationWad: bigint,
  rateAtTargetPerSecWad: bigint,
): bigint {
  return wMulToZero(curveMultiplierWad(utilizationWad), rateAtTargetPerSecWad);
}

/** Convert an APR in bps to a per-second rate in WAD (simple/linear annualization, matching Morpho). */
export function aprBpsToPerSecWad(aprBps: number): bigint {
  return (BigInt(Math.round(aprBps)) * WAD) / (BPS * SECONDS_PER_YEAR);
}

/** Convert a per-second rate in WAD to an APR in bps (simple/linear annualization, rounded). */
export function perSecWadToAprBps(perSecWad: bigint): number {
  return Number((perSecWad * SECONDS_PER_YEAR * BPS + WAD / 2n) / WAD);
}

/**
 * The instantaneous borrow APR (bps) at a given utilization (WAD) for a supplied
 * rate-at-target (APR bps). This is the value that replaces a flat borrow-APY
 * assumption in the loop sizing model.
 */
export function adaptiveBorrowAprBps(utilizationWad: bigint, rateAtTargetAprBps: number): number {
  const rateAtTargetPerSecWad = aprBpsToPerSecWad(rateAtTargetAprBps);
  const perSecWad = instantaneousBorrowRatePerSecWad(utilizationWad, rateAtTargetPerSecWad);
  return perSecWadToAprBps(perSecWad);
}
