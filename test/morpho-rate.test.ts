import { describe, expect, it } from "vitest";
import { WAD } from "../src/metrics/math.js";
import {
  adaptiveBorrowAprBps,
  aprBpsToPerSecWad,
  curveMultiplierWad,
  perSecWadToAprBps,
  TARGET_UTILIZATION_WAD,
} from "../src/loop/morphoRate.js";

/** Express a percentage as a WAD-scaled utilization (e.g. 41.7 -> 0.417e18). */
function utilWad(pct: number): bigint {
  return (BigInt(Math.round(pct * 100)) * WAD) / 10_000n;
}

describe("AdaptiveCurveIrm borrow-rate model", () => {
  it("pins the curve multiplier at 0.25x (0%), 1x (target), 4x (100%)", () => {
    expect(curveMultiplierWad(0n)).toBe(WAD / 4n);
    expect(curveMultiplierWad(TARGET_UTILIZATION_WAD)).toBe(WAD);
    expect(curveMultiplierWad(WAD)).toBe(4n * WAD);
  });

  it("clamps utilization above 100% to the 4x ceiling", () => {
    expect(curveMultiplierWad(2n * WAD)).toBe(4n * WAD);
  });

  it("round-trips APR <-> per-second rate", () => {
    expect(perSecWadToAprBps(aprBpsToPerSecWad(400))).toBe(400);
    expect(perSecWadToAprBps(aprBpsToPerSecWad(217))).toBe(217);
  });

  it("reproduces the 2026-07-11 on-chain reading (rateAtTarget ~= 217 bps)", () => {
    // At 90% utilization the borrow rate equals rateAtTarget.
    expect(adaptiveBorrowAprBps(TARGET_UTILIZATION_WAD, 217)).toBe(217);
    // At 100% utilization it is 4x rateAtTarget (~866 bps read on-chain).
    expect(adaptiveBorrowAprBps(WAD, 217)).toBeGreaterThanOrEqual(864);
    expect(adaptiveBorrowAprBps(WAD, 217)).toBeLessThanOrEqual(870);
    // At the live 41.7% utilization the instantaneous rate is ~1.3% (~129 bps).
    expect(adaptiveBorrowAprBps(utilWad(41.7), 217)).toBeGreaterThanOrEqual(125);
    expect(adaptiveBorrowAprBps(utilWad(41.7), 217)).toBeLessThanOrEqual(133);
  });

  it("borrow APR rises monotonically with utilization", () => {
    const r = (pct: number) => adaptiveBorrowAprBps(utilWad(pct), 400);
    expect(r(10)).toBeLessThan(r(50));
    expect(r(50)).toBeLessThan(r(80));
    expect(r(80)).toBeLessThan(r(90));
    expect(r(90)).toBeLessThan(r(100));
  });

  it("a near-idle read understates the cost of a loop that fills the pool", () => {
    // The founder's-post trap: ~1% idle vs ~4x rateAtTarget once utilization is high.
    const idle = adaptiveBorrowAprBps(utilWad(5), 217);
    const full = adaptiveBorrowAprBps(WAD, 217);
    expect(full).toBeGreaterThan(idle * 8);
  });
});
