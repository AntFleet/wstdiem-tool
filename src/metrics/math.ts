import type { MetricSnapshot, MorphoMarket, MorphoPosition } from "../types/domain.js";

export const WAD = 1_000_000_000_000_000_000n;
export const SECONDS_PER_YEAR = 31_536_000;

export function parseDecimalToUnits(value: string, decimals = 18): bigint {
  if (!/^[0-9]+(\.[0-9]+)?$/.test(value)) {
    throw new Error(`Invalid decimal token amount: ${value}`);
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Token amount has more than ${decimals} decimal places: ${value}`);
  }
  const padded = fraction.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

export function formatWad(value: bigint, precision = 6): string {
  const whole = value / WAD;
  const fraction = (value % WAD).toString().padStart(18, "0").slice(0, precision);
  return precision === 0 ? whole.toString() : `${whole}.${fraction}`;
}

export function ratio(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) {
    return 0;
  }
  return Number(numerator) / Number(denominator);
}

export function computeNav(totalAssets: bigint, totalShares: bigint): {
  nav: bigint;
  source: "empty" | "onchain";
} {
  if (totalShares === 0n) {
    return { nav: WAD, source: "empty" };
  }
  return { nav: (totalAssets * WAD) / totalShares, source: "onchain" };
}

export function computeBaseApy(rollingCreditDiem7d: bigint, averageVaultAssets7d: bigint): number {
  if (averageVaultAssets7d === 0n) {
    return 0;
  }
  return ratio(rollingCreditDiem7d, averageVaultAssets7d) * (365 / 7);
}

export function computeUtilization(market: Pick<MorphoMarket, "totalBorrowAssets" | "totalSupplyAssets">): number {
  if (market.totalSupplyAssets === 0n) {
    return 0;
  }
  return ratio(market.totalBorrowAssets, market.totalSupplyAssets);
}

export function computeBorrowRate(borrowRatePerSecondWad: bigint): number {
  return Math.exp((Number(borrowRatePerSecondWad) / Number(WAD)) * SECONDS_PER_YEAR) - 1;
}

export function computeBorrowedDiem(
  market: Pick<MorphoMarket, "totalBorrowAssets" | "totalBorrowShares">,
  position: Pick<MorphoPosition, "borrowShares">,
): bigint {
  if (market.totalBorrowShares === 0n) {
    return 0n;
  }
  return (position.borrowShares * market.totalBorrowAssets) / market.totalBorrowShares;
}

export function computeHealthFactor(
  collateralValueDiem: bigint,
  borrowedDiem: bigint,
  liquidationLtvWad: bigint,
): number {
  if (borrowedDiem === 0n) {
    return Number.POSITIVE_INFINITY;
  }
  return ratio(collateralValueDiem * liquidationLtvWad, borrowedDiem * WAD);
}

export function computeLeverage(collateralValueDiem: bigint, borrowedDiem: bigint): number {
  if (collateralValueDiem === 0n) {
    return 1;
  }
  const equity = collateralValueDiem > borrowedDiem ? collateralValueDiem - borrowedDiem : 0n;
  if (equity === 0n) {
    return Number.POSITIVE_INFINITY;
  }
  return ratio(collateralValueDiem, equity);
}

export function computeNetApy(leverage: number, baseApy: number, borrowRate: number): number {
  return leverage * baseApy - (leverage - 1) * borrowRate;
}

export function computeSpreadScore(netApy: number, riskFreeRate: number): number {
  return netApy - 1.5 * riskFreeRate;
}

export function computeCurvePoolTvlDiem(diemBalance: bigint, wstDiemBalance: bigint, wstDiemNav: bigint): bigint {
  return diemBalance + (wstDiemBalance * wstDiemNav) / WAD;
}

export function computeOracleDeviation(onchainOraclePrice: bigint, convertToAssetsOneWstDiem: bigint): number {
  const computedOraclePrice = convertToAssetsOneWstDiem * WAD;
  if (computedOraclePrice === 0n) {
    return 0;
  }
  const diff =
    onchainOraclePrice > computedOraclePrice
      ? onchainOraclePrice - computedOraclePrice
      : computedOraclePrice - onchainOraclePrice;
  return ratio(diff, computedOraclePrice);
}

export function computePositionSizeVsCurveDepth(positionNotionalDiem: bigint, curveTvlDiem: bigint): number {
  if (curveTvlDiem === 0n) {
    return Number.POSITIVE_INFINITY;
  }
  return ratio(positionNotionalDiem, curveTvlDiem);
}

export function makeEmptySnapshot(timestamp = Math.floor(Date.now() / 1000)): MetricSnapshot {
  const nav = computeNav(0n, 0n);
  const baseApy = 0;
  const borrowRate = 0;
  const netApy35 = computeNetApy(3.5, baseApy, borrowRate);
  return {
    timestamp,
    blockNumber: 0n,
    validity: {
      vault: false,
      yieldWindow: false,
      morphoMarket: false,
      position: false,
      curve: false,
      oracle: false,
      harvestHistory: false,
      rpcFreshness: false,
    },
    nav: nav.nav,
    navDisplay: formatWad(nav.nav),
    navSource: nav.source,
    baseApy,
    borrowRate,
    utilization: 0,
    netApy35,
    spreadScore: computeSpreadScore(netApy35, 0.05),
    healthFactor: Number.POSITIVE_INFINITY,
    leverage: 1,
    curveTvlDiem: 0n,
    oracleDeviation: 0,
    positionSizeVsCurveDepth: 0,
    lastHarvestAt: null,
    latestBlockAgeSeconds: 0,
  };
}
