import { YIELD_WINDOW_SECONDS } from "./collector.js";
import { ratio, SECONDS_PER_YEAR } from "./math.js";

/** Default headline window: 72 hours (SPEC008 OQ-A). */
export const DEFAULT_VELOCITY_WINDOW_HOURS = 72;
export const DEFAULT_VELOCITY_WINDOW_SECONDS = DEFAULT_VELOCITY_WINDOW_HOURS * 3600;
/** Endpoint math minimum (not B-2's TWA floor of 4). */
export const MIN_DEMAND_WINDOW_SAMPLES = 2;
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

export interface LoopDemandResult {
  nowSeconds: number;
  windowSeconds: number;
  current: DemandWindow;
  prior: DemandWindow;
  reference7d: DemandWindow;
  accelerationBps: number | null;
  accelerationGloss: string | null;
  creditInflowDiemCurrent: string | null;
  sampleSource: "sqlite" | "sqlite+live-tip";
  headlineLabel: "nav-ratchet-yield-velocity-bps-annualized-proxy";
  pasteLine: string;
  decisionSupportOnly: true;
  notAYieldPromise: true;
  demandKind: "nav-ratchet-yield-velocity-proxy";
  modelCaveats: string[];
  disclaimer: string;
  warnings: string[];
  authoritative: boolean;
}

export const DEMAND_DISCLAIMER =
  "NAV-ratchet yield velocity is an on-chain coincident proxy of inference demand (vault share-price growth), not AskSurplus demand itself and not a yield promise. Short windows are noisy; harvest cadence is irregular; flat NAV is not zero AskSurplus activity. Deposits do not move NAV — this series isolates yield from flows. Decision-support only; the operator must decide out-of-band.";

export const DEMAND_KIND = "nav-ratchet-yield-velocity-proxy" as const;
export const HEADLINE_LABEL = "nav-ratchet-yield-velocity-bps-annualized-proxy" as const;

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
): string {
  const configuredHours = windowSeconds / 3600;
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
    current.status === "ok" &&
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
    current,
    prior,
    reference7d,
    accelerationBps,
    accelerationGloss,
    creditInflowDiemCurrent,
    sampleSource,
    headlineLabel: HEADLINE_LABEL,
    pasteLine: buildPasteLine(current, windowSeconds),
    decisionSupportOnly: true,
    notAYieldPromise: true,
    demandKind: DEMAND_KIND,
    modelCaveats: [...modelCaveats],
    disclaimer: DEMAND_DISCLAIMER,
    warnings,
    authoritative,
  };
}
