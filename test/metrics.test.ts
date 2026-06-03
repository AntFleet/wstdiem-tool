import { describe, expect, it } from "vitest";
import {
  WAD,
  computeBaseApy,
  computeBorrowRate,
  computeBorrowedDiem,
  computeCurvePoolTvlDiem,
  computeHealthFactor,
  computeNav,
  computeNetApy,
  computeOracleDeviation,
  computePositionSizeVsCurveDepth,
  computeSpreadScore,
  computeUtilization,
  parseDecimalToUnits,
} from "../src/metrics/math.js";

describe("SPEC001 metric math", () => {
  it("uses 1.0 NAV and empty source when total shares are zero", () => {
    expect(computeNav(0n, 0n)).toEqual({ nav: WAD, source: "empty" });
  });

  it("computes NAV from totalAssets over totalSupply shares", () => {
    expect(computeNav(200n * WAD, 100n * WAD)).toEqual({ nav: 2n * WAD, source: "onchain" });
  });

  it("returns zero APY for missing average asset denominator", () => {
    expect(computeBaseApy(10n * WAD, 0n)).toBe(0);
  });

  it("computes SPEC001 APY, utilization, net APY, and spread score", () => {
    const baseApy = computeBaseApy(7n * WAD, 100n * WAD);
    expect(baseApy).toBeCloseTo(3.65);
    expect(computeUtilization({ totalBorrowAssets: 25n, totalSupplyAssets: 100n })).toBe(0.25);
    expect(computeNetApy(3.5, 0.2, 0.08)).toBeCloseTo(0.5);
    expect(computeSpreadScore(0.5, 0.05)).toBeCloseTo(0.425);
  });

  it("computes borrow debt from Morpho shares", () => {
    expect(
      computeBorrowedDiem(
        { totalBorrowAssets: 1_000n * WAD, totalBorrowShares: 100n * WAD },
        { borrowShares: 10n * WAD },
      ),
    ).toBe(100n * WAD);
  });

  it("computes infinite health factor when there is no debt", () => {
    expect(computeHealthFactor(100n * WAD, 0n, 770_000_000_000_000_000n)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("computes Curve TVL, oracle deviation, and blocked zero depth", () => {
    expect(computeCurvePoolTvlDiem(100n * WAD, 100n * WAD, 2n * WAD)).toBe(300n * WAD);
    expect(computeOracleDeviation(101n * WAD * WAD, 100n * WAD)).toBeCloseTo(0.01);
    expect(computePositionSizeVsCurveDepth(1n, 0n)).toBe(Number.POSITIVE_INFINITY);
  });

  it("parses decimal token amounts into wei units", () => {
    expect(parseDecimalToUnits("1.25")).toBe(1_250_000_000_000_000_000n);
  });

  it("rejects token amounts with more precision than token decimals", () => {
    expect(() => parseDecimalToUnits("1.0000000000000000009")).toThrow(/more than 18/);
  });

  it("compounds a wad-denominated per-second borrow rate", () => {
    expect(computeBorrowRate(0n)).toBe(0);
  });
});
