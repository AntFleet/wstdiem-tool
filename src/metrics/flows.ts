/**
 * SPEC009 — attributable inference-demand flows (decision-support only).
 *
 * Tier 1 (chain-proven): DIEMCredited
 * Tier 2 (on-chain amount, path may be permissionless on X402): SettlementReceived
 * Tier 3 (unverifiable): whether USDC is third-party demand vs protocol self-seeding
 */
import { MIN_DEMAND_WINDOW_SAMPLES } from "./demand.js";
import { WAD } from "./math.js";
import type {
  Address,
  StoredInferenceCredit,
  StoredInferenceSettlement,
} from "../types/domain.js";

/** USDC is 6-dec on Base; DIEM/wstDIEM are 18-dec. Scale USDC → 18-dec by ×1e12. */
export const USDC_DECIMALS = 6;
export const DIEM_DECIMALS = 18;
export const USDC_TO_WAD_SCALE = 10n ** BigInt(DIEM_DECIMALS - USDC_DECIMALS); // 1e12

/** SPEC009 OQ-E default residual band half-width (±5% of realized yield). */
export const DEFAULT_INFERENCE_RECONCILE_TOLERANCE_BPS = 500;

export const FLOWS_DISCLAIMER =
  "Attributable inference flows are on-chain receipts (DIEMCredited / SettlementReceived / YieldRouted), " +
  "not a yield promise and not certification that demand is external vs protocol-seeded (Tier-3 limit). " +
  "Lead with Tier-1 DIEM credited; treat settled USDC as as-reported. Decision-support only.";

export type TrustTier = 1 | 2 | 3;

export interface FlowEventWindow {
  credits: StoredInferenceCredit[];
  settlements: StoredInferenceSettlement[];
  windowStart: number;
  windowEnd: number;
}

export interface AdapterLiveMeta {
  address: Address;
  name: string | null;
  isVenueAdapter: boolean | null;
  operatorFeeBps: number | null;
  /** Point-in-time USDC.balanceOf(adapter); null if unavailable. */
  unroutedUsdc: bigint | null;
}

export interface AdapterFlowSummary {
  address: string;
  name: string | null;
  isVenueAdapter: boolean | null;
  /** Tier 1 — Σ DIEMCredited.amount (18-dec string). */
  diemCredited: string;
  /** Tier 2 — Σ SettlementReceived.amount (6-dec string). NEVER under "inference volume"/"demand" keys. */
  usdcSettledAsReported: string;
  diemFromYieldRouted: string;
  operatorSharesFromYieldRouted: string;
  /** Realized DIEM-per-USDC from YieldRouted only (WAD string), or null. */
  realizedConversionDiemPerUsdcWad: string | null;
  unroutedUsdc: string | null;
  settlementReceivedCount: number;
  diemCreditedCount: number;
  yieldRoutedCount: number;
  trustLabels: string[];
}

export interface InferenceShareHeadline {
  status: "ok" | "n/a";
  reason: string | null;
  /** Mid-point share in bps of realized yield, clamped [0, 10000]. null when n/a. */
  inferenceShareBpsMid: number | null;
  /** Band low/high as percent strings with 2dp, e.g. "12.50". */
  inferenceSharePctLow: string | null;
  inferenceSharePctMid: string | null;
  inferenceSharePctHigh: string | null;
  totalRealizedYieldDiem: string | null;
  inferenceAttributableDiem: string | null;
  residualDiem: string | null;
  residualLabel: string;
  sStart: string | null;
  navStart: string | null;
  navEnd: string | null;
  yieldFeeBpsApplied: number | null;
  toleranceBps: number;
}

export interface FlowVelocity {
  status: "ok" | "n/a";
  reason: string | null;
  currentFlowEventCount: number;
  priorFlowEventCount: number;
  diemCreditedCurrent: string | null;
  diemCreditedPrior: string | null;
  usdcSettledAsReportedCurrent: string | null;
  usdcSettledAsReportedPrior: string | null;
}

export interface InferenceFlowsResult {
  available: boolean;
  reason: string | null;
  windowStart: number;
  windowEnd: number;
  firstSeenBlock: string | null;
  adapters: AdapterFlowSummary[];
  aggregate: {
    diemCredited: string;
    usdcSettledAsReported: string;
    unroutedUsdcTotal: string | null;
    flowEventCount: number;
  };
  inferenceShare: InferenceShareHeadline;
  velocity: FlowVelocity;
  caveats: string[];
  disclaimer: string;
  decisionSupportOnly: true;
  notAYieldPromise: true;
}

function inWindow(ts: number, start: number, end: number): boolean {
  return ts > start && ts <= end;
}

/**
 * DIEM-per-USDC conversion in WAD terms.
 * usdc=1e6 (1 USDC) + diem=1e18 (1 DIEM) → 1e18 (1.0 DIEM/USDC), not 1e±12.
 */
export function realizedConversionDiemPerUsdcWad(usdc: bigint, diem: bigint): bigint | null {
  if (usdc <= 0n) {
    return null;
  }
  // diem * 1e18 / (usdc * 1e12) = diem * 1e6 / usdc
  return (diem * WAD) / (usdc * USDC_TO_WAD_SCALE);
}

/**
 * Holder DIEM from YieldRouted gross diem + operatorFeeBps.
 * holderDiem = diem * (1 - operatorFeeBps/1e4)
 */
export function holderDiemFromYieldRouted(diemOut: bigint, operatorFeeBps: number): bigint {
  if (operatorFeeBps < 0 || operatorFeeBps > 10_000) {
    throw new Error(`operatorFeeBps out of range: ${operatorFeeBps}`);
  }
  return (diemOut * BigInt(10_000 - operatorFeeBps)) / 10_000n;
}

/**
 * Dilute DIEMCredited by vault yieldFeeBps share-mint (first-order).
 * Factor 1.0 when treasury is zero / fee not applied.
 */
export function inferenceAttributableAfterYieldFee(
  diemCredited: bigint,
  yieldFeeBps: number,
  treasuryActive: boolean,
): bigint {
  if (!treasuryActive || yieldFeeBps <= 0) {
    return diemCredited;
  }
  if (yieldFeeBps > 10_000) {
    throw new Error(`yieldFeeBps out of range: ${yieldFeeBps}`);
  }
  return (diemCredited * BigInt(10_000 - yieldFeeBps)) / 10_000n;
}

/**
 * Total realized holder yield ≈ ΔNAV × S_start / WAD.
 * Uses start-of-window supply (NOT end supply — M1 trap).
 */
export function totalRealizedHolderYieldDiem(
  navStart: bigint,
  navEnd: bigint,
  sStart: bigint,
): bigint {
  if (sStart <= 0n) {
    return 0n;
  }
  if (navEnd >= navStart) {
    return ((navEnd - navStart) * sStart) / WAD;
  }
  // Negative NAV move → treat realized yield as 0 for share (headline residual absorbs).
  return 0n;
}

export function clampShareBps(bps: number): number {
  if (!Number.isFinite(bps)) {
    return 0;
  }
  return Math.min(10_000, Math.max(0, Math.round(bps)));
}

function bpsToPctString(bps: number): string {
  return (bps / 100).toFixed(2);
}

/**
 * inferenceSharePct band: mid ± toleranceBps (of realized-yield space), clamped [0,100]%.
 * identity: inference / total on no-rounding synthetic case.
 */
export function computeInferenceShareHeadline(input: {
  navStart: bigint | null;
  navEnd: bigint | null;
  sStart: bigint | null;
  diemCreditedSum: bigint;
  yieldFeeBps: number | null;
  treasuryActive: boolean;
  toleranceBps: number;
}): InferenceShareHeadline {
  const residualLabel =
    "base DIEM-staking accrual + deposit-fee revenue + noise (NAV-side residual; not the asset-side residual)";
  const base: InferenceShareHeadline = {
    status: "n/a",
    reason: null,
    inferenceShareBpsMid: null,
    inferenceSharePctLow: null,
    inferenceSharePctMid: null,
    inferenceSharePctHigh: null,
    totalRealizedYieldDiem: null,
    inferenceAttributableDiem: null,
    residualDiem: null,
    residualLabel,
    sStart: input.sStart?.toString() ?? null,
    navStart: input.navStart?.toString() ?? null,
    navEnd: input.navEnd?.toString() ?? null,
    yieldFeeBpsApplied: null,
    toleranceBps: input.toleranceBps,
  };

  if (input.navStart === null || input.navEnd === null || input.sStart === null) {
    return { ...base, reason: "missing-nav-or-s-start" };
  }
  if (input.sStart <= 0n) {
    return { ...base, reason: "s-start-zero" };
  }
  if (input.navStart <= 0n) {
    return { ...base, reason: "invalid-nav-start" };
  }
  // Fail closed: treasury is active (the yieldFeeBps share-mint dilutes the holder yield) but the
  // live yieldFeeBps read failed. Applying factor 1.0 here would silently OVER-report the inference
  // share by up to yieldFeeBps — exactly the headline number this feature exists to keep credible
  // (§5 honesty). Report n/a rather than an inflated share. When treasury is inactive no fee applies,
  // so a null read is harmless there.
  if (input.treasuryActive && input.yieldFeeBps === null) {
    return { ...base, reason: "yield-fee-unavailable" };
  }

  const feeBps = input.yieldFeeBps ?? 0;
  const attributable = inferenceAttributableAfterYieldFee(
    input.diemCreditedSum,
    feeBps,
    input.treasuryActive,
  );
  const total = totalRealizedHolderYieldDiem(input.navStart, input.navEnd, input.sStart);

  if (total <= 0n) {
    // No positive realized yield — cannot form a meaningful share; still surface raw sides.
    return {
      ...base,
      reason: "zero-or-negative-realized-yield",
      totalRealizedYieldDiem: total.toString(),
      inferenceAttributableDiem: attributable.toString(),
      residualDiem: null,
      yieldFeeBpsApplied: input.treasuryActive ? feeBps : 0,
    };
  }

  // mid bps = attributable / total * 10000 (bigint path then clamp)
  const midBps = clampShareBps(Number((attributable * 10_000n) / total));
  const lowBps = clampShareBps(midBps - input.toleranceBps);
  const highBps = clampShareBps(midBps + input.toleranceBps);
  const residual = total >= attributable ? total - attributable : 0n;

  return {
    status: "ok",
    reason: null,
    inferenceShareBpsMid: midBps,
    inferenceSharePctLow: bpsToPctString(lowBps),
    inferenceSharePctMid: bpsToPctString(midBps),
    inferenceSharePctHigh: bpsToPctString(highBps),
    totalRealizedYieldDiem: total.toString(),
    inferenceAttributableDiem: attributable.toString(),
    residualDiem: residual.toString(),
    residualLabel,
    sStart: input.sStart.toString(),
    navStart: input.navStart.toString(),
    navEnd: input.navEnd.toString(),
    yieldFeeBpsApplied: input.treasuryActive ? feeBps : 0,
    toleranceBps: input.toleranceBps,
  };
}

function isX402Name(name: string | null | undefined): boolean {
  if (name === null || name === undefined) {
    return false;
  }
  return name.toLowerCase().includes("x402");
}

function adapterTrustLabels(input: {
  name: string | null;
  isVenueAdapter: boolean | null;
  hasSettlement: boolean;
}): string[] {
  const labels: string[] = [
    "tier1-diem-credited-chain-proven",
    "tier2-usdc-settled-as-reported",
    "tier3-external-vs-seeded-unverifiable",
  ];
  if (input.hasSettlement) {
    labels.push("usdc-settled-not-inference-volume");
    labels.push("caller-path-unidentifiable-from-event");
  }
  if (isX402Name(input.name)) {
    labels.push("x402-permissionless-settlement-path");
    labels.push("unrestricted-path");
  }
  if (input.isVenueAdapter === false) {
    labels.push("not-registered-venue-adapter");
  }
  return labels;
}

export function sumInWindowCredits(
  credits: StoredInferenceCredit[],
  start: number,
  end: number,
  kind: "DIEMCredited" | "WstDIEMCredited" = "DIEMCredited",
): bigint {
  return credits.reduce((sum, c) => {
    if (c.kind === kind && inWindow(c.timestamp, start, end)) {
      return sum + c.amountDiem;
    }
    return sum;
  }, 0n);
}

export function sumInWindowUsdcSettled(
  settlements: StoredInferenceSettlement[],
  start: number,
  end: number,
): bigint {
  return settlements.reduce((sum, s) => {
    if (s.kind === "SettlementReceived" && inWindow(s.timestamp, start, end) && s.usdcAmount !== undefined) {
      return sum + s.usdcAmount;
    }
    return sum;
  }, 0n);
}

function countFlowEvents(
  credits: StoredInferenceCredit[],
  settlements: StoredInferenceSettlement[],
  start: number,
  end: number,
): number {
  const c = credits.filter((e) => e.kind === "DIEMCredited" && inWindow(e.timestamp, start, end)).length;
  const s = settlements.filter(
    (e) => e.kind === "SettlementReceived" && inWindow(e.timestamp, start, end),
  ).length;
  return c + s;
}

export function buildAdapterSummaries(input: {
  credits: StoredInferenceCredit[];
  settlements: StoredInferenceSettlement[];
  windowStart: number;
  windowEnd: number;
  configAdapters: Array<{ address: Address; name?: string }>;
  liveMeta?: AdapterLiveMeta[];
}): AdapterFlowSummary[] {
  const addresses = new Set<string>();
  for (const a of input.configAdapters) {
    addresses.add(a.address.toLowerCase());
  }
  for (const c of input.credits) {
    if (inWindow(c.timestamp, input.windowStart, input.windowEnd)) {
      addresses.add(c.adapter.toLowerCase());
    }
  }
  for (const s of input.settlements) {
    if (inWindow(s.timestamp, input.windowStart, input.windowEnd)) {
      addresses.add(s.adapter.toLowerCase());
    }
  }

  const liveByAddr = new Map(
    (input.liveMeta ?? []).map((m) => [m.address.toLowerCase(), m] as const),
  );
  const configByAddr = new Map(
    input.configAdapters.map((a) => [a.address.toLowerCase(), a] as const),
  );

  const sorted = [...addresses].sort();
  return sorted.map((addrLower) => {
    const live = liveByAddr.get(addrLower);
    const cfg = configByAddr.get(addrLower);
    const name = live?.name ?? cfg?.name ?? null;
    const displayAddress = cfg?.address ?? live?.address ?? (`0x${addrLower.slice(2)}` as Address);

    const diemCredits = input.credits.filter(
      (c) =>
        c.kind === "DIEMCredited" &&
        c.adapter.toLowerCase() === addrLower &&
        inWindow(c.timestamp, input.windowStart, input.windowEnd),
    );
    const settlementsRecv = input.settlements.filter(
      (s) =>
        s.kind === "SettlementReceived" &&
        s.adapter.toLowerCase() === addrLower &&
        inWindow(s.timestamp, input.windowStart, input.windowEnd),
    );
    const yields = input.settlements.filter(
      (s) =>
        s.kind === "YieldRouted" &&
        s.adapter.toLowerCase() === addrLower &&
        inWindow(s.timestamp, input.windowStart, input.windowEnd),
    );

    const diemCredited = diemCredits.reduce((sum, c) => sum + c.amountDiem, 0n);
    const usdcSettled = settlementsRecv.reduce((sum, s) => sum + (s.usdcAmount ?? 0n), 0n);
    const diemRouted = yields.reduce((sum, s) => sum + (s.diemOut ?? 0n), 0n);
    const opShares = yields.reduce((sum, s) => sum + (s.operatorShares ?? 0n), 0n);
    const usdcRouted = yields.reduce((sum, s) => sum + (s.usdcAmount ?? 0n), 0n);
    const conversion =
      usdcRouted > 0n ? realizedConversionDiemPerUsdcWad(usdcRouted, diemRouted) : null;

    return {
      address: displayAddress,
      name,
      isVenueAdapter: live?.isVenueAdapter ?? null,
      diemCredited: diemCredited.toString(),
      usdcSettledAsReported: usdcSettled.toString(),
      diemFromYieldRouted: diemRouted.toString(),
      operatorSharesFromYieldRouted: opShares.toString(),
      realizedConversionDiemPerUsdcWad: conversion?.toString() ?? null,
      unroutedUsdc: live?.unroutedUsdc?.toString() ?? null,
      settlementReceivedCount: settlementsRecv.length,
      diemCreditedCount: diemCredits.length,
      yieldRoutedCount: yields.length,
      trustLabels: adapterTrustLabels({
        name,
        isVenueAdapter: live?.isVenueAdapter ?? null,
        hasSettlement: settlementsRecv.length > 0,
      }),
    };
  });
}

export function buildFlowVelocity(input: {
  credits: StoredInferenceCredit[];
  settlements: StoredInferenceSettlement[];
  nowSeconds: number;
  windowSeconds: number;
  minEvents?: number;
}): FlowVelocity {
  const minEvents = input.minEvents ?? MIN_DEMAND_WINDOW_SAMPLES;
  const currentStart = input.nowSeconds - input.windowSeconds;
  const priorStart = currentStart - input.windowSeconds;
  const currentCount = countFlowEvents(
    input.credits,
    input.settlements,
    currentStart,
    input.nowSeconds,
  );
  const priorCount = countFlowEvents(input.credits, input.settlements, priorStart, currentStart);

  const diemCurr = sumInWindowCredits(input.credits, currentStart, input.nowSeconds);
  const diemPrior = sumInWindowCredits(input.credits, priorStart, currentStart);
  const usdcCurr = sumInWindowUsdcSettled(input.settlements, currentStart, input.nowSeconds);
  const usdcPrior = sumInWindowUsdcSettled(input.settlements, priorStart, currentStart);

  if (currentCount < minEvents) {
    return {
      status: "n/a",
      reason: `below-min-flow-events (${currentCount}<${minEvents}); raw settlements shown; trend not computed`,
      currentFlowEventCount: currentCount,
      priorFlowEventCount: priorCount,
      diemCreditedCurrent: diemCurr.toString(),
      diemCreditedPrior: diemPrior.toString(),
      usdcSettledAsReportedCurrent: usdcCurr.toString(),
      usdcSettledAsReportedPrior: usdcPrior.toString(),
    };
  }

  return {
    status: "ok",
    reason: null,
    currentFlowEventCount: currentCount,
    priorFlowEventCount: priorCount,
    diemCreditedCurrent: diemCurr.toString(),
    diemCreditedPrior: diemPrior.toString(),
    usdcSettledAsReportedCurrent: usdcCurr.toString(),
    usdcSettledAsReportedPrior: usdcPrior.toString(),
  };
}

export interface BuildInferenceFlowsInput {
  credits: StoredInferenceCredit[];
  settlements: StoredInferenceSettlement[];
  nowSeconds: number;
  windowSeconds: number;
  configAdapters: Array<{ address: Address; name?: string }>;
  liveMeta?: AdapterLiveMeta[];
  /** Start-of-window NAV (convertToAssets(1e18)). */
  navStart: bigint | null;
  navEnd: bigint | null;
  /** Start-of-window totalSupply — must be persisted, not reconstructed. */
  sStart: bigint | null;
  yieldFeeBps: number | null;
  treasuryActive: boolean;
  toleranceBps?: number;
  firstSeenBlock: bigint | null;
}

export function buildInferenceFlows(input: BuildInferenceFlowsInput): InferenceFlowsResult {
  const toleranceBps = input.toleranceBps ?? DEFAULT_INFERENCE_RECONCILE_TOLERANCE_BPS;
  const windowStart = input.nowSeconds - input.windowSeconds;
  const windowEnd = input.nowSeconds;

  const caveats = [
    "tier1-lead-diem-credited",
    "tier2-settlement-as-reported-not-demand",
    "tier3-external-vs-seeded-unverifiable",
    "unrouted-usdc-is-state-fact-not-forward-signal",
    "velocity-gated-on-min-flow-events",
    "forward-only-from-shared-cursor",
    "decision-support-only",
    "not-a-yield-promise",
  ];

  const adapters = buildAdapterSummaries({
    credits: input.credits,
    settlements: input.settlements,
    windowStart,
    windowEnd,
    configAdapters: input.configAdapters,
    liveMeta: input.liveMeta,
  });

  const diemCredited = sumInWindowCredits(input.credits, windowStart, windowEnd);
  const usdcSettled = sumInWindowUsdcSettled(input.settlements, windowStart, windowEnd);
  const flowEventCount = countFlowEvents(input.credits, input.settlements, windowStart, windowEnd);

  let unroutedTotal: bigint | null = null;
  for (const a of adapters) {
    if (a.unroutedUsdc !== null) {
      unroutedTotal = (unroutedTotal ?? 0n) + BigInt(a.unroutedUsdc);
    }
  }

  const hasAnyData =
    flowEventCount > 0 ||
    (unroutedTotal !== null && unroutedTotal > 0n) ||
    adapters.some((a) => a.unroutedUsdc !== null && BigInt(a.unroutedUsdc) > 0n);

  const inferenceShare = computeInferenceShareHeadline({
    navStart: input.navStart,
    navEnd: input.navEnd,
    sStart: input.sStart,
    diemCreditedSum: diemCredited,
    yieldFeeBps: input.yieldFeeBps,
    treasuryActive: input.treasuryActive,
    toleranceBps,
  });

  const velocity = buildFlowVelocity({
    credits: input.credits,
    settlements: input.settlements,
    nowSeconds: input.nowSeconds,
    windowSeconds: input.windowSeconds,
  });

  if (!hasAnyData && inferenceShare.status === "n/a") {
    return {
      available: false,
      reason: "no-events-no-unrouted-usdc",
      windowStart,
      windowEnd,
      firstSeenBlock: input.firstSeenBlock?.toString() ?? null,
      adapters,
      aggregate: {
        diemCredited: "0",
        usdcSettledAsReported: "0",
        unroutedUsdcTotal: unroutedTotal?.toString() ?? null,
        flowEventCount: 0,
      },
      inferenceShare,
      velocity,
      caveats,
      disclaimer: FLOWS_DISCLAIMER,
      decisionSupportOnly: true,
      notAYieldPromise: true,
    };
  }

  // Honesty: zero DIEMCredited with unrouted USDC is NOT zero demand.
  if (diemCredited === 0n && unroutedTotal !== null && unroutedTotal > 0n) {
    caveats.push(
      "zero-diem-credited-with-unrouted-usdc: routing lull possible; not zero demand",
    );
  }

  return {
    available: true,
    reason: null,
    windowStart,
    windowEnd,
    firstSeenBlock: input.firstSeenBlock?.toString() ?? null,
    adapters,
    aggregate: {
      diemCredited: diemCredited.toString(),
      usdcSettledAsReported: usdcSettled.toString(),
      unroutedUsdcTotal: unroutedTotal?.toString() ?? null,
      flowEventCount,
    },
    inferenceShare,
    velocity,
    caveats,
    disclaimer: FLOWS_DISCLAIMER,
    decisionSupportOnly: true,
    notAYieldPromise: true,
  };
}

/**
 * Guard: JSON must never put SettlementReceived under "inference volume" / bare "demand" keys.
 * Used by tests and renderers.
 */
export const FORBIDDEN_SETTLEMENT_JSON_KEYS = [
  "inferenceVolume",
  "inference_volume",
  "demand",
  "inferenceDemand",
  "inference_demand",
] as const;

export function assertNoForbiddenSettlementKeys(obj: unknown, path = ""): void {
  if (obj === null || typeof obj !== "object") {
    return;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      assertNoForbiddenSettlementKeys(obj[i], `${path}[${i}]`);
    }
    return;
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (
      FORBIDDEN_SETTLEMENT_JSON_KEYS.some((f) => f.toLowerCase() === lower) &&
      // Allow demandKind / decisionSupportOnly style metadata that does not hold settled USDC.
      key !== "demandKind" &&
      !key.startsWith("decision")
    ) {
      // Only flag if the value looks like a settlement quantity (string digits / number).
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "bigint"
      ) {
        throw new Error(`forbidden settlement key at ${path}.${key}`);
      }
    }
    assertNoForbiddenSettlementKeys(value, path ? `${path}.${key}` : key);
  }
}
