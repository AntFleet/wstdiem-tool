import type { AlertEvaluation, ThresholdConfig } from "../types/domain.js";
import { computeNav, formatWad, ratio } from "./math.js";

export type MarketPriceSourceKind = "cli-flag" | "config" | "unavailable";

export type BasisNavSource = "convertToAssets" | "totalAssets/totalSupply" | "unavailable";

export type BasisGloss =
  | "discount-stress-and-edge-proxy"
  | "premium-secondary-above-nav"
  | "flat-at-nav"
  | null;

export interface ResolveNavInput {
  totalAssets: bigint;
  totalSupply: bigint;
  /** convertToAssets(1e18) if read succeeded; null on failure */
  navConvert: bigint | null;
}

export interface ResolveNavResult {
  nav: bigint | null;
  navSource: BasisNavSource;
  navTotals: bigint | null;
  warnings: string[];
}

export interface ComputeBasisResult {
  basisBps: number | null;
  basis: number | null;
  basisGloss: BasisGloss;
}

export interface LoopBasisResult {
  nav: string | null;
  navSource: BasisNavSource;
  navTotals: string | null;
  marketPriceDiemPerWstDiem: string | null;
  marketPriceSource: MarketPriceSourceKind;
  basisBps: number | null;
  basis: number | null;
  basisGloss: BasisGloss;
  alerts: AlertEvaluation[];
  blockNumber: string | null;
  arithmeticComplete: boolean;
  authoritative: false;
  decisionSupportOnly: true;
  notATradeRecommendation: true;
  basisKind: "secondary-market-vs-nav";
  modelCaveats: string[];
  disclaimer: string;
  pasteLine: string;
  warnings: string[];
}

export const BASIS_DISCLAIMER =
  "Secondary-market basis (market price vs vault NAV) is decision-support only — not investment advice and not a trade recommendation. A discount can reflect stress/illiquidity or a genuine edge; the tool cannot tell which. Morpho oracle tracks NAV and is not used as market price. v1 market input is operator-supplied and may be stale. The operator must decide and act out-of-band.";

export const BASIS_KIND = "secondary-market-vs-nav" as const;

const ALWAYS_CAVEATS = [
  "operator-supplied-market-price",
  "secondary-not-morpho-oracle",
  "discount-dual-signal-stress-and-edge",
  "nav-point-in-time",
  "basis-not-trade-recommendation",
  "thresholds-unvalidated-secondary-spreads",
  "no-market-price-timestamp",
  "v1-not-authoritative-market",
] as const;

/**
 * SPEC007 §2.1 — never use empty/WAD placeholder as basis denominator.
 */
export function resolveNavForBasis(input: ResolveNavInput): ResolveNavResult {
  const warnings: string[] = [];
  const totals = computeNav(input.totalAssets, input.totalSupply);
  const navTotals =
    totals.source === "onchain" && totals.nav > 0n ? totals.nav : null;

  const supplyOk = input.totalSupply > 0n && input.totalAssets > 0n;

  if (input.navConvert !== null && input.navConvert > 0n && supplyOk) {
    if (navTotals !== null && navTotals !== input.navConvert) {
      warnings.push("nav-source-mismatch");
    }
    return {
      nav: input.navConvert,
      navSource: "convertToAssets",
      navTotals,
      warnings,
    };
  }

  if (totals.source === "onchain" && totals.nav > 0n && supplyOk) {
    return {
      nav: totals.nav,
      navSource: "totalAssets/totalSupply",
      navTotals: totals.nav,
      warnings,
    };
  }

  return {
    nav: null,
    navSource: "unavailable",
    navTotals,
    warnings,
  };
}

/** Pure basis math — never fabricates 0 for missing inputs. */
export function computeBasis(nav: bigint | null, marketPrice: bigint | null): ComputeBasisResult {
  if (nav === null || nav <= 0n || marketPrice === null || marketPrice <= 0n) {
    return { basisBps: null, basis: null, basisGloss: null };
  }
  const delta = marketPrice - nav;
  const basis =
    delta >= 0n ? ratio(delta, nav) : -ratio(nav - marketPrice, nav);
  const basisBps = Math.round(basis * 10_000);
  let basisGloss: BasisGloss;
  if (basisBps < 0) {
    basisGloss = "discount-stress-and-edge-proxy";
  } else if (basisBps > 0) {
    basisGloss = "premium-secondary-above-nav";
  } else {
    basisGloss = "flat-at-nav";
  }
  return { basisBps, basis, basisGloss };
}

export function evaluateBasisAlerts(input: {
  basisBps: number | null;
  nav: bigint | null;
  marketPrice: bigint | null;
  marketPriceSource: MarketPriceSourceKind;
  thresholds: Pick<ThresholdConfig, "basisDiscountWarnBps" | "basisDiscountCriticalBps">;
}): AlertEvaluation[] {
  const { basisBps, nav, marketPrice, marketPriceSource, thresholds } = input;
  if (
    basisBps === null ||
    basisBps >= 0 ||
    nav === null ||
    marketPrice === null ||
    marketPriceSource === "unavailable"
  ) {
    return [];
  }
  const absBps = Math.abs(basisBps);
  const m = formatWad(marketPrice);
  const n = formatWad(nav);
  const baseMetrics = {
    basisBps,
    marketPriceDiemPerWstDiem: marketPrice.toString(),
    nav: nav.toString(),
    marketPriceSource,
  };
  if (basisBps <= -thresholds.basisDiscountCriticalBps) {
    return [
      {
        alertKey: "basis_discount",
        level: "CRITICAL",
        message:
          `ADVISORY: secondary-market discount ${absBps} bps (stress/illiquidity and possible edge; tool cannot tell which). ` +
          `market ${m} / NAV ${n} DIEM per wstDIEM. Source: operator-supplied (${marketPriceSource}) — not a verified live market print. ` +
          `Act out-of-band if desired; tool does not trade.`,
        suggestedAction: "Act out-of-band if desired; tool does not trade or expand.",
        cooldownSeconds: 3600,
        metrics: baseMetrics,
      },
    ];
  }
  if (basisBps <= -thresholds.basisDiscountWarnBps) {
    return [
      {
        alertKey: "basis_discount",
        level: "WARN",
        message:
          `ADVISORY: secondary-market discount ${absBps} bps (stress/illiquidity and possible edge; tool cannot tell which). ` +
          `market ${m} / NAV ${n} DIEM per wstDIEM. Source: operator-supplied (${marketPriceSource}) — not a verified live market print. ` +
          `Act out-of-band if desired; tool does not trade.`,
        suggestedAction: "Act out-of-band if desired; tool does not trade or expand.",
        cooldownSeconds: 3600,
        metrics: baseMetrics,
      },
    ];
  }
  return [];
}

function buildPasteLine(input: {
  basisBps: number | null;
  basisGloss: BasisGloss;
  nav: bigint | null;
  marketPrice: bigint | null;
  marketPriceSource: MarketPriceSourceKind;
}): string {
  if (
    input.basisBps === null ||
    input.nav === null ||
    input.marketPrice === null ||
    input.marketPriceSource === "unavailable"
  ) {
    return "Secondary-market basis: n/a · market and/or NAV unavailable — decision-support only; not a trade recommendation";
  }
  const m = formatWad(input.marketPrice);
  const n = formatWad(input.nav);
  const absBps = Math.abs(input.basisBps);
  if (input.basisBps < 0) {
    return (
      `Secondary-market basis: ${absBps} bps discount (stress/illiquidity and possible edge; tool cannot tell which) · ` +
      `market ${m} / NAV ${n} DIEM per wstDIEM · source operator-supplied — decision-support only; not a trade recommendation`
    );
  }
  if (input.basisBps > 0) {
    return (
      `Secondary-market basis: ${absBps} bps premium (secondary prints above NAV; not cheap intrinsic) · ` +
      `market ${m} / NAV ${n} DIEM per wstDIEM · source operator-supplied — decision-support only; not a trade recommendation`
    );
  }
  return (
    `Secondary-market basis: 0 bps flat at NAV · market ${m} / NAV ${n} · source operator-supplied — decision-support only; not a trade recommendation`
  );
}

export interface BuildLoopBasisInput {
  totalAssets: bigint | null;
  totalSupply: bigint | null;
  navConvert: bigint | null;
  marketPrice: bigint | null;
  marketPriceSource: MarketPriceSourceKind;
  thresholds: Pick<ThresholdConfig, "basisDiscountWarnBps" | "basisDiscountCriticalBps">;
  blockNumber?: bigint | null;
  extraWarnings?: string[];
}

export function buildLoopBasis(input: BuildLoopBasisInput): LoopBasisResult {
  const warnings = [...(input.extraWarnings ?? [])];
  let nav: bigint | null = null;
  let navSource: BasisNavSource = "unavailable";
  let navTotals: bigint | null = null;

  if (input.totalAssets !== null && input.totalSupply !== null) {
    const resolved = resolveNavForBasis({
      totalAssets: input.totalAssets,
      totalSupply: input.totalSupply,
      navConvert: input.navConvert,
    });
    nav = resolved.nav;
    navSource = resolved.navSource;
    navTotals = resolved.navTotals;
    warnings.push(...resolved.warnings);
  }

  const marketPrice =
    input.marketPriceSource === "unavailable" ? null : input.marketPrice;
  const computed = computeBasis(nav, marketPrice ?? null);
  const alerts = evaluateBasisAlerts({
    basisBps: computed.basisBps,
    nav,
    marketPrice: marketPrice ?? null,
    marketPriceSource: input.marketPriceSource,
    thresholds: input.thresholds,
  });

  const arithmeticComplete =
    computed.basisBps !== null &&
    nav !== null &&
    marketPrice !== null &&
    input.marketPriceSource !== "unavailable" &&
    (navSource === "convertToAssets" || navSource === "totalAssets/totalSupply");

  return {
    nav: nav === null ? null : nav.toString(),
    navSource,
    navTotals: navTotals === null ? null : navTotals.toString(),
    marketPriceDiemPerWstDiem:
      marketPrice === null || input.marketPriceSource === "unavailable"
        ? null
        : marketPrice.toString(),
    marketPriceSource: input.marketPriceSource,
    basisBps: computed.basisBps,
    basis: computed.basis,
    basisGloss: computed.basisGloss,
    alerts,
    blockNumber:
      input.blockNumber === undefined || input.blockNumber === null
        ? null
        : input.blockNumber.toString(),
    arithmeticComplete,
    authoritative: false,
    decisionSupportOnly: true,
    notATradeRecommendation: true,
    basisKind: BASIS_KIND,
    modelCaveats: [...ALWAYS_CAVEATS],
    disclaimer: BASIS_DISCLAIMER,
    pasteLine: buildPasteLine({
      basisBps: computed.basisBps,
      basisGloss: computed.basisGloss,
      nav,
      marketPrice: marketPrice ?? null,
      marketPriceSource: input.marketPriceSource,
    }),
    warnings,
  };
}
