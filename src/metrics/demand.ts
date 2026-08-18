import { YIELD_WINDOW_SECONDS } from "./collector.js";
import { ratio, SECONDS_PER_YEAR } from "./math.js";

/** Default headline window: 72 hours (SPEC008 OQ-A). */
export const DEFAULT_VELOCITY_WINDOW_HOURS = 72;
export const DEFAULT_VELOCITY_WINDOW_SECONDS = DEFAULT_VELOCITY_WINDOW_HOURS * 3600;
/** 1..this hours stay demand-proxy (SPEC008 v1). */
export const MAX_DEMAND_PROXY_WINDOW_HOURS = 168;
/** Absolute --window-hours cap (35d). 169..840 = realized. */
export const MAX_WINDOW_HOURS = 840;
/** Endpoint math minimum (not B-2's TWA floor of 4). */
export const MIN_DEMAND_WINDOW_SAMPLES = 2;
/** Realized density warning floor (non-demoting). */
export const MIN_REALIZED_DENSE_SAMPLES = 4;
/** Prevent dust-span annualization explosions. */
export const MIN_SPAN_SECONDS = 3600;
/** Windows at or below this force non-authoritative + short-window-noisy. */
export const SHORT_WINDOW_NOISY_SECONDS = 48 * 3600;

export type DemandWindowStatus =
  | "ok"
  | "insufficient-samples"
  | "no-anchor"
  | "zero-span"
  | "span-too-short"
  | "invalid-nav";

export interface NavSample {
  timestamp: number;
  nav: bigint;
  /** Present when loaded from metric_snapshots; used for invalid filter. */
  totalAssetsDiem?: bigint;
}

export interface DemandWindow {
  status: DemandWindowStatus;
  windowStart: number;
  windowEnd: number;
  spanSeconds: number | null;
  sampleCount: number;
  navStart: string | null;
  navEnd: string | null;
  windowGrowthBps: number | null;
  velocityBps: number | null;
  velocity: number | null;
}

export type DemandWindowKind = "demand-proxy" | "realized";

export interface LoopDemandResult {
  nowSeconds: number;
  windowSeconds: number;
  windowKind: DemandWindowKind;
  current: DemandWindow;
  prior: DemandWindow;
  reference7d: DemandWindow;
  accelerationBps: number | null;
  accelerationGloss: string | null;
  creditInflowDiemCurrent: string | null;
  sampleSource: "sqlite" | "sqlite+live-tip";
  headlineLabel:
    | "nav-ratchet-yield-velocity-bps-annualized-proxy"
    | "realized-nav-growth-bps-annualized-simple";
  pasteLine: string;
  decisionSupportOnly: true;
  notAYieldPromise: true;
  demandKind: "nav-ratchet-yield-velocity-proxy" | "realized-nav-growth";
  modelCaveats: string[];
  disclaimer: string;
  warnings: string[];
  authoritative: boolean;
}

export const DEMAND_DISCLAIMER =
  "NAV-ratchet yield velocity is an on-chain coincident proxy of inference demand (vault share-price growth), not AskSurplus demand itself and not a yield promise. Short windows are noisy; harvest cadence is irregular; flat NAV is not zero AskSurplus activity. Deposits do not move NAV — this series isolates yield from flows. Decision-support only; the operator must decide out-of-band.";

export const DEMAND_KIND = "nav-ratchet-yield-velocity-proxy" as const;
export const HEADLINE_LABEL = "nav-ratchet-yield-velocity-bps-annualized-proxy" as const;
export const REALIZED_DEMAND_KIND = "realized-nav-growth" as const;
export const REALIZED_HEADLINE_LABEL = "realized-nav-growth-bps-annualized-simple" as const;

export const REALIZED_DISCLAIMER =
  "REALIZED NAV growth is a holding-period share-price change annualized on the observed span, not a forward yield promise and not a demand signal. Harvest/keeper credits are lumpy; deposits do not move NAV. Decision-support only; the operator must decide out-of-band.";

export function windowKindForSeconds(windowSeconds: number): DemandWindowKind {
  return windowSeconds <= MAX_DEMAND_PROXY_WINDOW_HOURS * 3600 ? "demand-proxy" : "realized";
}

export function demandLookbackStart(nowSeconds: number, windowSeconds: number): number {
  return Math.min(nowSeconds - windowSeconds * 2, nowSeconds - 7 * 24 * 3600);
}

const DEMOTING_CODES = new Set([
  "short-window-noisy",
  "live-tip-nav-source-mismatch",
  "live-tip-nav-fallback-totals",
  "invalid-nav-sample-skipped",
  "nav-declined-in-window",
  "acceleration-cadence-artifact-possible",
]);

/** SPEC008 §2.1 — empty/failed watch ticks write nav=WAD and assets=0. */
export function isValidNavSample(sample: NavSample): boolean {
  if (sample.nav <= 0n) {
    return false;
  }
  if (sample.totalAssetsDiem !== undefined && sample.totalAssetsDiem <= 0n) {
    return false;
  }
  return true;
}

export function filterValidNavSamples(samples: NavSample[]): NavSample[] {
  return samples.filter(isValidNavSample);
}

/**
 * Density count (SPEC008 §3.3): in-window points + 1 if any valid sample at/before start.
 * Do NOT use unfiltered list.length (no upper bound).
 */
export function countDemandSamples(samples: NavSample[], start: number, end: number): number {
  const valid = filterValidNavSamples(samples);
  const inWindow = valid.filter((s) => s.timestamp > start && s.timestamp <= end).length;
  const hasAnchor = valid.some((s) => s.timestamp <= start);
  return inWindow + (hasAnchor ? 1 : 0);
}

function lastValidAtOrBefore(samples: NavSample[], ts: number): NavSample | null {
  let best: NavSample | null = null;
  for (const s of filterValidNavSamples(samples)) {
    if (s.timestamp <= ts && (best === null || s.timestamp >= best.timestamp)) {
      best = s;
    }
  }
  return best;
}

function lastValidAfterAndAtOrBefore(
  samples: NavSample[],
  after: number,
  end: number,
): NavSample | null {
  let best: NavSample | null = null;
  for (const s of filterValidNavSamples(samples)) {
    if (s.timestamp > after && s.timestamp <= end && (best === null || s.timestamp >= best.timestamp)) {
      best = s;
    }
  }
  return best;
}

/** Bigint delta then ratio — never float-divide absolute NAVs. */
export function navGrowthFraction(navStart: bigint, navEnd: bigint): number {
  if (navStart <= 0n) {
    return 0;
  }
  if (navEnd >= navStart) {
    return ratio(navEnd - navStart, navStart);
  }
  return -ratio(navStart - navEnd, navStart);
}

export function computeDemandWindow(
  samples: NavSample[],
  windowStart: number,
  windowEnd: number,
): DemandWindow {
  const sampleCount = countDemandSamples(samples, windowStart, windowEnd);
  const empty = (status: DemandWindowStatus): DemandWindow => ({
    status,
    windowStart,
    windowEnd,
    spanSeconds: null,
    sampleCount,
    navStart: null,
    navEnd: null,
    windowGrowthBps: null,
    velocityBps: null,
    velocity: null,
  });

  const navStartSample = lastValidAtOrBefore(samples, windowStart);
  if (navStartSample === null) {
    return empty("no-anchor");
  }
  if (navStartSample.nav <= 0n) {
    return empty("invalid-nav");
  }

  const navEndSample = lastValidAfterAndAtOrBefore(samples, navStartSample.timestamp, windowEnd);
  if (navEndSample === null) {
    return empty("insufficient-samples");
  }

  const spanSeconds = navEndSample.timestamp - navStartSample.timestamp;
  if (spanSeconds === 0) {
    return {
      ...empty("zero-span"),
      sampleCount,
      navStart: navStartSample.nav.toString(),
      navEnd: navEndSample.nav.toString(),
      spanSeconds: 0,
    };
  }
  if (spanSeconds < MIN_SPAN_SECONDS) {
    return {
      ...empty("span-too-short"),
      sampleCount,
      navStart: navStartSample.nav.toString(),
      navEnd: navEndSample.nav.toString(),
      spanSeconds,
    };
  }
  if (sampleCount < MIN_DEMAND_WINDOW_SAMPLES) {
    return {
      ...empty("insufficient-samples"),
      sampleCount,
      navStart: navStartSample.nav.toString(),
      navEnd: navEndSample.nav.toString(),
      spanSeconds,
    };
  }

  const growth = navGrowthFraction(navStartSample.nav, navEndSample.nav);
  const windowGrowthBps = Math.round(growth * 10_000);
  const velocity = growth * (SECONDS_PER_YEAR / spanSeconds);
  const velocityBps = Math.round(velocity * 10_000);

  return {
    status: "ok",
    windowStart,
    windowEnd,
    spanSeconds,
    sampleCount,
    navStart: navStartSample.nav.toString(),
    navEnd: navEndSample.nav.toString(),
    windowGrowthBps,
    velocityBps,
    velocity,
  };
}

export function accelerationGlossFor(
  current: DemandWindow,
  prior: DemandWindow,
  accelerationBps: number | null,
): string | null {
  if (accelerationBps === null || current.status !== "ok" || prior.status !== "ok") {
    return null;
  }
  if (current.velocityBps !== null && current.velocityBps < 0) {
    return "negative-nav-move-investigate-not-demand-collapse";
  }
  if (
    current.velocityBps !== null &&
    prior.velocityBps !== null &&
    current.velocityBps > 0 &&
    prior.velocityBps > 0 &&
    accelerationBps < 0
  ) {
    return "decelerating-but-still-positive-proxy";
  }
  if (accelerationBps > 0) {
    return "accelerating-proxy";
  }
  if (accelerationBps < 0) {
    return "decelerating-proxy";
  }
  return "flat-proxy";
}

function buildPasteLine(
  current: DemandWindow,
  windowSeconds: number,
  windowKind: DemandWindowKind,
): string {
  const configuredHours = windowSeconds / 3600;
  if (windowKind === "realized") {
    if (current.status !== "ok" || current.velocityBps === null || current.spanSeconds === null) {
      return (
        `REALIZED NAV growth (annualized simple, not a forward yield): n/a bps over observed n/a ` +
        `(configured ${configuredHours}h; window growth n/a; samples ${current.sampleCount}) — not AskSurplus demand; not a yield promise; decision-support only`
      );
    }
    const observedHours = Math.round(current.spanSeconds / 3600);
    const pct = (current.velocityBps / 100).toFixed(2);
    return (
      `REALIZED NAV growth (annualized simple, not a forward yield): ${current.velocityBps} bps (${pct}%) over observed ${observedHours}h ` +
      `(configured ${configuredHours}h; window growth ${current.windowGrowthBps} bps; samples ${current.sampleCount}) — not AskSurplus demand; not a yield promise; decision-support only`
    );
  }
  if (current.status !== "ok" || current.velocityBps === null || current.spanSeconds === null) {
    return (
      `NAV-ratchet yield velocity (demand proxy): n/a bps annualized simple over observed n/a span ` +
      `(configured window ${configuredHours}h; window growth n/a) — not AskSurplus demand; not a yield promise; decision-support only`
    );
  }
  const observedHours = Math.round(current.spanSeconds / 3600);
  return (
    `NAV-ratchet yield velocity (demand proxy): ${current.velocityBps} bps annualized simple over observed ${observedHours}h span ` +
    `(configured window ${configuredHours}h; window growth ${current.windowGrowthBps} bps) — not AskSurplus demand; not a yield promise; decision-support only`
  );
}

export function sumCreditInflowDiem(
  credits: Array<{ timestamp: number; amountDiem: bigint }>,
  currentStart: number,
  currentEnd: number,
): bigint {
  return credits.reduce((total, c) => {
    if (c.timestamp > currentStart && c.timestamp <= currentEnd) {
      return total + c.amountDiem;
    }
    return total;
  }, 0n);
}

export interface BuildLoopDemandInput {
  samples: NavSample[];
  nowSeconds: number;
  windowSeconds: number;
  /** When store credit path is available; omit → creditInflow null. */
  creditSamples?: Array<{ timestamp: number; amountDiem: bigint }>;
  sampleSource?: "sqlite" | "sqlite+live-tip";
  extraWarnings?: string[];
}

export function buildLoopDemand(input: BuildLoopDemandInput): LoopDemandResult {
  const {
    samples,
    nowSeconds,
    windowSeconds,
    creditSamples,
    sampleSource = "sqlite",
    extraWarnings = [],
  } = input;

  const windowKind = windowKindForSeconds(windowSeconds);
  const currentStart = nowSeconds - windowSeconds;
  const priorStart = currentStart - windowSeconds;

  const current = computeDemandWindow(samples, currentStart, nowSeconds);
  const prior = computeDemandWindow(samples, priorStart, currentStart);
  const reference7d = computeDemandWindow(
    samples,
    nowSeconds - YIELD_WINDOW_SECONDS,
    nowSeconds,
  );

  const warnings: string[] = [...extraWarnings];
  const modelCaveats = new Set<string>([
    "nav-not-total-assets",
    "irregular-harvest-cadence",
    "proxy-not-asksurplus",
    "simple-annualization-observed-span",
    "requires-sqlite-history",
    "spec008-v1-no-harvest-reconcile",
  ]);
  if (windowKind === "realized") {
    modelCaveats.add("realized-holding-period-not-demand-proxy");
    if (current.status === "ok" && current.sampleCount < MIN_REALIZED_DENSE_SAMPLES) {
      warnings.push("sparse-realized-window");
    }
  }

  if (windowSeconds <= SHORT_WINDOW_NOISY_SECONDS) {
    warnings.push("short-window-noisy");
    modelCaveats.add("short-window-noisy");
  }

  if (
    current.status === "ok" &&
    current.velocityBps !== null &&
    current.velocityBps < 0
  ) {
    warnings.push("nav-declined-in-window");
  }

  let creditInflowDiemCurrent: string | null = null;
  if (creditSamples !== undefined) {
    creditInflowDiemCurrent = sumCreditInflowDiem(
      creditSamples,
      currentStart,
      nowSeconds,
    ).toString();
  }

  if (
    current.status === "ok" &&
    (current.velocityBps === 0 || current.windowGrowthBps === 0)
  ) {
    let msg =
      "flat-nav-not-zero-demand: NAV flat in window (proxy); not a measure of AskSurplus activity";
    if (creditInflowDiemCurrent === "0") {
      msg += " — no credit inflow observed; harvest lag possible";
    }
    warnings.push(msg);
    modelCaveats.add("flat-nav-not-zero-demand");
  }

  let accelerationBps: number | null = null;
  if (
    current.status === "ok" &&
    prior.status === "ok" &&
    current.velocityBps !== null &&
    prior.velocityBps !== null
  ) {
    accelerationBps = current.velocityBps - prior.velocityBps;
    if (
      prior.velocityBps !== 0 &&
      Math.abs(accelerationBps) > Math.max(Math.abs(prior.velocityBps), 500)
    ) {
      warnings.push("acceleration-cadence-artifact-possible");
    }
  }

  const accelerationGloss = accelerationGlossFor(current, prior, accelerationBps);

  const minAuthoritativeSpan = Math.min(windowSeconds, 24 * 3600);
  const demotingHit = warnings.some((w) =>
    [...DEMOTING_CODES].some((code) => w === code || w.startsWith(`${code}:`) || w.startsWith(`${code} `)),
  );

  const authoritative =
    windowKind === "realized"
      ? false
      : current.status === "ok" &&
        prior.status === "ok" &&
        windowSeconds > SHORT_WINDOW_NOISY_SECONDS &&
        current.spanSeconds !== null &&
        prior.spanSeconds !== null &&
        current.spanSeconds >= minAuthoritativeSpan &&
        prior.spanSeconds >= minAuthoritativeSpan &&
        !demotingHit;

  return {
    nowSeconds,
    windowSeconds,
    windowKind,
    current,
    prior,
    reference7d,
    accelerationBps,
    accelerationGloss,
    creditInflowDiemCurrent,
    sampleSource,
    headlineLabel: windowKind === "realized" ? REALIZED_HEADLINE_LABEL : HEADLINE_LABEL,
    pasteLine: buildPasteLine(current, windowSeconds, windowKind),
    decisionSupportOnly: true,
    notAYieldPromise: true,
    demandKind: windowKind === "realized" ? REALIZED_DEMAND_KIND : DEMAND_KIND,
    modelCaveats: [...modelCaveats],
    disclaimer: windowKind === "realized" ? REALIZED_DISCLAIMER : DEMAND_DISCLAIMER,
    warnings,
    authoritative,
  };
}
