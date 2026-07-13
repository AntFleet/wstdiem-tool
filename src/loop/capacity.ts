import {
  positionCollateralForScenario,
  sizeLoopScenario,
  type LoopSizingResult,
  type LoopSizingScenario,
  type SeedProvenance,
} from "./sizing.js";

/** Dust floor (0.001 DIEM). */
export const MIN_PROBE_EQUITY = 10n ** 15n;
/** Hard search window cap (1_000_000 DIEM). */
export const MAX_PROBE_EQUITY = 10n ** 24n;
/** Geometric ladder step. */
export const LADDER_GROWTH = 2n;
/** Binary-search stop (0.01 DIEM). */
export const SEARCH_RESOLUTION_DIEM = 10n ** 16n;
/** Memoized distinct position sizes per search. */
export const MAX_GET_DY_QUOTES = 64;

export type BindingConstraint =
  | "morpho-util-headroom"
  | "curve-exit-slippage"
  | "curve-depth"
  | "net-apy"
  | "health-factor"
  | "unwind"
  | "scenario-invalid"
  | "marginal-band"
  | "unbounded-in-search-window";

export type CapacityInputMode = "from-chain" | "explicit-flags" | "offline-defaults";

/**
 * Injectable exit-slippage quoter (chain-seeded curve path).
 * Hard-fail throws (or returns `{ hardFail }`); soft demote continues without injection.
 */
export type ExitSlippageQuote =
  | { bps: number }
  | { demote: string }
  | { hardFail: string };

export type ExitSlippageQuoter = (
  positionCollateralDiem: bigint,
  maxSlippageBps: number,
  blockNumber: bigint,
) => Promise<ExitSlippageQuote> | ExitSlippageQuote;

export interface LoopCapacityResult {
  targetLeverageBps: number;
  capacityEquityDiem: bigint;
  capacityNotionalDiem: bigint;
  headroomToBlockEquityDiem: bigint;
  headroomToBlockNotionalDiem: bigint;
  capacityStatus: "candidate" | "marginal" | "blocked";
  bindingConstraint: BindingConstraint;
  capacityEdge: LoopSizingResult | null;
  bindingEdge: LoopSizingResult | null;
  marginalReasons: string[];
  morphoRawAvailableDiem: bigint;
  availableMorphoBorrowDiem: bigint;
  search: {
    probes: number;
    getDyQuotes: number;
    resolutionDiem: bigint;
    truncated: boolean;
    minProbeEquityDiem: bigint;
    maxProbeEquityDiem: bigint;
  };
  inputMode: CapacityInputMode;
  seedProvenance?: SeedProvenance;
  authoritative: boolean;
  warnings: string[];
  decisionSupportOnly: true;
  notADeployRecommendation: true;
  capacityKind: "point-in-time-gate-bound-last-candidate";
  modelCaveats: string[];
  disclaimer: string;
}

export const CAPACITY_DISCLAIMER =
  "Point-in-time gate-bound absorption (last-candidate) under this tool's sizing gates — not a promise that capital can be deployed, not investment advice, and not a comfortable full-size operating point (the next increment is already marginal or blocked). Assumes no concurrent Morpho/Curve draw by other actors. Pool depth, borrow caps, and rates can move; the operator/keeper must decide and act out-of-band.";

export const CAPACITY_KIND = "point-in-time-gate-bound-last-candidate" as const;

export class CapacitySearchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CapacitySearchError";
  }
}

/** Internal: stop binary refine without updating bounds after get_dy budget exhausts. */
class SearchTruncatedSignal extends Error {
  constructor() {
    super("search truncated");
    this.name = "SearchTruncatedSignal";
  }
}

export interface FindLoopCapacityInput {
  template: LoopSizingScenario;
  inputMode: CapacityInputMode;
  /** Block pin for get_dy (required when quoter is provided). */
  blockNumber?: bigint;
  quoteExitSlippage?: ExitSlippageQuoter;
  seedProvenance?: SeedProvenance;
  authoritative?: boolean;
  warnings?: string[];
  minProbeEquity?: bigint;
  maxProbeEquity?: bigint;
  searchResolutionDiem?: bigint;
  maxGetDyQuotes?: number;
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function family(result: LoopSizingResult): string {
  return result.firstBlocker ?? (result.status === "marginal" ? "marginal-band" : "none");
}

export function taxonomyFromBindingEdge(
  bindingEdge: LoopSizingResult | null,
  options: { unbounded?: boolean; zeroMarginal?: boolean } = {},
): BindingConstraint {
  if (options.unbounded) {
    return "unbounded-in-search-window";
  }
  if (options.zeroMarginal) {
    return "marginal-band";
  }
  if (bindingEdge === null) {
    return "scenario-invalid";
  }
  switch (bindingEdge.firstBlocker) {
    case "morpho_supply_insufficient":
      return "morpho-util-headroom";
    case "curve_liquidity_insufficient":
      return bindingEdge.exitSlippageExcessBps > 0 ? "curve-exit-slippage" : "curve-depth";
    case "net_apy_below_threshold":
      return "net-apy";
    case "health_factor_below_threshold":
      return "health-factor";
    case "unwind_not_covered":
      return "unwind";
    case "scenario_invalid":
      return "scenario-invalid";
    case null:
      return bindingEdge.status === "marginal" ? "marginal-band" : "scenario-invalid";
    default:
      return "scenario-invalid";
  }
}

/** Best-effort marginal-band reasons from engine proximity signals (SPEC002 rev-3). */
export function collectMarginalReasons(result: LoopSizingResult | null): string[] {
  if (result === null) {
    return [];
  }
  const reasons: string[] = [];
  const maxSlip = Math.max(result.estimatedEntrySlippageBps, result.exitSlippageBps);
  if (maxSlip > result.scenario.maxSlippageBps * 0.8) {
    reasons.push("slip-near-cap");
  }
  if (
    result.healthFactorBps !== null &&
    result.healthFactorBps < Math.ceil(result.scenario.minHealthFactorBps * 1.1)
  ) {
    reasons.push("hf-near-floor");
  }
  if (result.netApyBps < result.scenario.minNetApyBps + 200) {
    reasons.push("apy-near-floor");
  }
  if (result.postDrawUtilizationBps > 7000 && result.netApyStressedBps < result.scenario.minNetApyBps) {
    reasons.push("stressed-net-apy");
  }
  return reasons;
}

export function morphoRawAvailableDiem(scenario: LoopSizingScenario): bigint {
  return maxBigInt(0n, scenario.morphoSupplyDiem - scenario.morphoExistingBorrowDiem);
}

export function notionalForEquity(template: LoopSizingScenario, equity: bigint): bigint {
  if (equity === 0n) {
    return 0n;
  }
  return positionCollateralForScenario({
    ...template,
    initialCollateralDiem: equity,
  });
}

function buildLadder(minProbe: bigint, maxProbe: bigint): bigint[] {
  const ladder: bigint[] = [];
  let e = minProbe;
  while (e < maxProbe) {
    ladder.push(e);
    const next = e * LADDER_GROWTH;
    if (next <= e) {
      break;
    }
    e = next;
  }
  ladder.push(maxProbe);
  return ladder;
}

function modelCaveatsFor(_input: FindLoopCapacityInput): string[] {
  return [
    "single-block-snapshot",
    "no-concurrent-flow",
    "last-candidate-no-operator-buffer",
    "gas-unmodeled-unless-flagged",
    "vault-apy-input",
    "linear-or-get_dy-slippage-model",
    "spec002-section-8",
  ];
}

/**
 * Pure capacity search over `sizeLoopScenario` (SPEC006 §2.3).
 * Mutates only equity on a frozen template; reuses engine gates — never re-implements them.
 */
/**
 * Structural HF is independent of equity. When it already sits in the marginal proximity band
 * (HF < 1.1×min) or below the hard floor, last-candidate capacity is zero for every market depth —
 * surface that so operators do not misread Morpho/curve abundance as capacity.
 */
export function structuralHfProximityWarning(template: LoopSizingScenario): string | null {
  if (template.targetLeverageBps <= 10_000) {
    return null;
  }
  const healthFactorBps = Math.floor(
    (template.targetLeverageBps * template.lltvBps) /
      (template.targetLeverageBps - 10_000),
  );
  if (healthFactorBps < template.minHealthFactorBps) {
    return (
      `structural HF ${(healthFactorBps / 10_000).toFixed(2)} at this leverage is below min ` +
      `${(template.minHealthFactorBps / 10_000).toFixed(2)} — capacity is 0 for all equities ` +
      `(binding health-factor); reduce leverage or --min-health-factor`
    );
  }
  const marginalFloor = Math.ceil(template.minHealthFactorBps * 1.1);
  if (healthFactorBps < marginalFloor) {
    return (
      `structural HF ${(healthFactorBps / 10_000).toFixed(2)} at this leverage sits in the ` +
      `engine proximity band (< ${(marginalFloor / 10_000).toFixed(2)}) — last-candidate capacity ` +
      `is 0 independent of Morpho/curve depth (binding marginal-band); try lower leverage ` +
      `(e.g. 1.5) or consciously lower --min-health-factor`
    );
  }
  return null;
}

export async function findLoopCapacity(input: FindLoopCapacityInput): Promise<LoopCapacityResult> {
  const minProbe = input.minProbeEquity ?? MIN_PROBE_EQUITY;
  const maxProbe = input.maxProbeEquity ?? MAX_PROBE_EQUITY;
  const resolution = input.searchResolutionDiem ?? SEARCH_RESOLUTION_DIEM;
  const maxQuotes = input.maxGetDyQuotes ?? MAX_GET_DY_QUOTES;
  const template = input.template;
  const warnings = [...(input.warnings ?? [])];
  const hfWarn = structuralHfProximityWarning(template);
  if (hfWarn !== null) {
    warnings.push(hfWarn);
  }
  let authoritative = input.authoritative ?? input.inputMode === "from-chain";
  if (input.inputMode === "offline-defaults") {
    authoritative = false;
  }

  let probes = 0;
  let getDyQuotes = 0;
  let truncated = false;
  let softDemoted = false;

  const resultCache = new Map<string, LoopSizingResult>();
  const quoteCache = new Map<string, { bps?: number; demote?: string }>();

  // Bound state for get_dy budget (set once a proven candidate/non-candidate bracket exists).
  let provenBound = false;

  async function injectAndSize(equity: bigint): Promise<LoopSizingResult> {
    const key = equity.toString();
    const cached = resultCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const scenario: LoopSizingScenario = {
      ...template,
      id: `capacity-${key}`,
      initialCollateralDiem: equity,
      targetLeverageBps: template.targetLeverageBps,
    };

    if (input.quoteExitSlippage !== undefined) {
      if (input.blockNumber === undefined) {
        throw new CapacitySearchError(
          "FROM_CHAIN_SEED_BLOCKED",
          "get_dy quoter requires a pinned blockNumber",
        );
      }
      const position = positionCollateralForScenario(scenario);
      const qKey = `${position.toString()}:${scenario.maxSlippageBps}`;
      let quoted = quoteCache.get(qKey);
      if (quoted === undefined) {
        if (getDyQuotes >= maxQuotes) {
          if (provenBound) {
            // SPEC006 §2.3: stop refining; do NOT size mid with leg-aware fallback
            // (that can inflate last-candidate capacity vs get_dy-backed bounds).
            truncated = true;
            throw new SearchTruncatedSignal();
          }
          throw new CapacitySearchError(
            "GET_DY_BUDGET_EXHAUSTED_BEFORE_BOUND",
            "get_dy quote budget exhausted before a capacity bound was established",
          );
        }
        getDyQuotes += 1;
        const raw = await input.quoteExitSlippage(
          position,
          scenario.maxSlippageBps,
          input.blockNumber,
        );
        if ("hardFail" in raw) {
          throw new CapacitySearchError("FROM_CHAIN_SEED_BLOCKED", raw.hardFail);
        }
        if ("demote" in raw) {
          quoted = { demote: raw.demote };
        } else {
          quoted = { bps: raw.bps };
        }
        quoteCache.set(qKey, quoted);
      }
      if (quoted.bps !== undefined) {
        scenario.externalExitSlippageBps = quoted.bps;
      } else if (quoted.demote !== undefined && !softDemoted) {
        authoritative = false;
        softDemoted = true;
        warnings.push(
          `get_dy exit quote unavailable (${quoted.demote}) — verdict is not authoritative`,
        );
      }
    }

    const result = sizeLoopScenario(scenario);
    resultCache.set(key, result);
    probes += 1;
    return result;
  }

  async function isCandidate(equity: bigint): Promise<boolean> {
    return (await injectAndSize(equity)).status === "candidate";
  }

  async function isNonBlocked(equity: bigint): Promise<boolean> {
    return (await injectAndSize(equity)).status !== "blocked";
  }

  // --- Step A: ladder scan (always include maxProbe) ---
  const ladder = buildLadder(minProbe, maxProbe);
  const ladderResults: Array<{ equity: bigint; result: LoopSizingResult }> = [];
  let sawCandidate = false;
  for (const equity of ladder) {
    try {
      const result = await injectAndSize(equity);
      ladderResults.push({ equity, result });
      if (result.status === "candidate") {
        sawCandidate = true;
      } else if (sawCandidate) {
        // Proven (low, high) bracket exists — further budget exhaust may truncate safely.
        provenBound = true;
      }
    } catch (error) {
      if (error instanceof SearchTruncatedSignal && provenBound && ladderResults.length > 0) {
        // Stop ladder; proceed with what we have.
        break;
      }
      throw error;
    }
  }

  let candidates = ladderResults.filter((entry) => entry.result.status === "candidate");

  // Island recovery when no ladder candidate: bisect pairs with differing blocker families.
  if (candidates.length === 0) {
    for (let i = 0; i < ladderResults.length - 1; i += 1) {
      const left = ladderResults[i];
      const right = ladderResults[i + 1];
      if (left.result.status === "candidate" || right.result.status === "candidate") {
        continue;
      }
      if (family(left.result) === family(right.result)) {
        continue;
      }
      const found = await islandBisect(
        left.equity,
        right.equity,
        left.result,
        right.result,
        injectAndSize,
        resolution,
      );
      if (found !== null) {
        candidates = [{ equity: found.equity, result: found.result }];
        // Continue gathering? Spec: "if a candidate is found in any bisect, treat as some candidate found"
        // Collect all islands for largest-candidate later.
        // Keep scanning remaining pairs for larger candidates.
      }
    }
    // Re-scan cache for any candidates found during island bisects.
    candidates = [];
    for (const [key, result] of resultCache) {
      if (result.status === "candidate") {
        candidates.push({ equity: BigInt(key), result });
      }
    }
    candidates.sort((a, b) => (a.equity < b.equity ? -1 : a.equity > b.equity ? 1 : 0));
  }

  // Zero path: never candidate.
  if (candidates.length === 0) {
    const minResult = await injectAndSize(minProbe);
    // SPEC006 §2.4: ≥1 probe marginal (anywhere) → status marginal + binding marginal-band,
    // even when minProbe itself is blocked (e.g. gas) while a mid probe is proximity-marginal.
    const anyMarginal = [...resultCache.values()].some((r) => r.status === "marginal");
    const capacityStatus: "marginal" | "blocked" = anyMarginal ? "marginal" : "blocked";
    const bindingConstraint: BindingConstraint = anyMarginal
      ? "marginal-band"
      : taxonomyFromBindingEdge(minResult);

    const headroom = await refineHeadroom({
      injectAndSize,
      isNonBlocked,
      ladderResults,
      minProbe,
      maxProbe,
      resolution,
      resultCache,
    });

    return finalize({
      template,
      input,
      capacityEquityDiem: 0n,
      capacityEdge: null,
      bindingEdge: minResult,
      capacityStatus,
      bindingConstraint,
      headroom,
      probes,
      getDyQuotes,
      truncated,
      resolution,
      minProbe,
      maxProbe,
      authoritative,
      warnings,
      resultCache,
    });
  }

  // Unbounded: still candidate at maxProbe (only if we could evaluate it).
  let maxResult = resultCache.get(maxProbe.toString()) ?? null;
  if (maxResult === null && !truncated) {
    try {
      maxResult = await injectAndSize(maxProbe);
    } catch (error) {
      if (!(error instanceof SearchTruncatedSignal)) {
        throw error;
      }
    }
  }
  if (maxResult !== null && maxResult.status === "candidate") {
    const headroom = {
      equity: maxProbe,
      edge: maxResult,
    };
    return finalize({
      template,
      input,
      capacityEquityDiem: maxProbe,
      capacityEdge: maxResult,
      bindingEdge: null,
      capacityStatus: "candidate",
      bindingConstraint: "unbounded-in-search-window",
      headroom,
      probes,
      getDyQuotes,
      truncated,
      resolution,
      minProbe,
      maxProbe,
      authoritative,
      warnings,
      resultCache,
    });
  }

  // Some candidate + first non-candidate above largest candidate → binary refine.
  let largestCandidate = candidates[candidates.length - 1]?.equity;
  // Ensure we have the true largest candidate from cache (island may have added more).
  for (const [key, result] of resultCache) {
    const e = BigInt(key);
    if (result.status === "candidate" && (largestCandidate === undefined || e > largestCandidate)) {
      largestCandidate = e;
    }
  }
  if (largestCandidate === undefined) {
    // Truncation mid-search without a candidate left in cache — fail closed.
    throw new CapacitySearchError(
      "GET_DY_BUDGET_EXHAUSTED_BEFORE_BOUND",
      "get_dy quote budget exhausted before a capacity bound was established",
    );
  }

  // First non-candidate above largest candidate (from ladder or cache).
  let firstNon: bigint | null = null;
  const orderedEquities = [...resultCache.keys()]
    .map((k) => BigInt(k))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const e of orderedEquities) {
    if (e > largestCandidate) {
      const r = resultCache.get(e.toString());
      if (r !== undefined && r.status !== "candidate") {
        firstNon = e;
        break;
      }
    }
  }
  if (firstNon === null) {
    if (maxResult !== null && maxResult.status !== "candidate") {
      firstNon = maxProbe;
    } else {
      // No non-candidate above in cache (truncated ladder) — use next ladder step if present,
      // else treat largest candidate as the bound (cannot refine further).
      const nextAbove = orderedEquities.find((e) => e > largestCandidate);
      firstNon = nextAbove ?? largestCandidate;
    }
  }

  let low = largestCandidate;
  let high = firstNon;
  provenBound = true;

  while (high - low > resolution) {
    if (truncated) {
      break;
    }
    const mid = (low + high) / 2n;
    if (mid <= low || mid >= high) {
      break;
    }
    try {
      if (await isCandidate(mid)) {
        low = mid;
      } else {
        high = mid;
      }
    } catch (error) {
      if (error instanceof SearchTruncatedSignal) {
        // Keep last proven low/high; do not reclassify mid with leg-aware.
        break;
      }
      throw error;
    }
  }

  // low/high must already be in cache from ladder/binary (get_dy-backed). Do not probe new sizes.
  const capacityEdge = resultCache.get(low.toString()) ?? (await injectAndSize(low));
  const bindingEdge = resultCache.get(high.toString()) ?? (await injectAndSize(high));

  let headroom: { equity: bigint; edge: LoopSizingResult | null };
  try {
    headroom = await refineHeadroom({
      injectAndSize,
      isNonBlocked,
      ladderResults,
      minProbe,
      maxProbe,
      resolution,
      resultCache,
    });
  } catch (error) {
    if (error instanceof SearchTruncatedSignal) {
      // Secondary metric only — freeze at largest non-blocked already probed.
      let best = 0n;
      let bestEdge: LoopSizingResult | null = null;
      for (const [key, result] of resultCache) {
        if (result.status !== "blocked") {
          const e = BigInt(key);
          if (e >= best) {
            best = e;
            bestEdge = result;
          }
        }
      }
      headroom = { equity: best, edge: bestEdge };
    } else {
      throw error;
    }
  }

  return finalize({
    template,
    input,
    capacityEquityDiem: low,
    capacityEdge,
    bindingEdge,
    capacityStatus: "candidate",
    bindingConstraint: taxonomyFromBindingEdge(bindingEdge),
    headroom,
    probes,
    getDyQuotes,
    truncated,
    resolution,
    minProbe,
    maxProbe,
    authoritative,
    warnings,
  });
}

async function islandBisect(
  low: bigint,
  high: bigint,
  lowResult: LoopSizingResult,
  highResult: LoopSizingResult,
  injectAndSize: (e: bigint) => Promise<LoopSizingResult>,
  resolution: bigint,
): Promise<{ equity: bigint; result: LoopSizingResult } | null> {
  if (high - low <= resolution) {
    return null;
  }
  const mid = (low + high) / 2n;
  if (mid <= low || mid >= high) {
    return null;
  }
  const midResult = await injectAndSize(mid);
  if (midResult.status === "candidate") {
    return { equity: mid, result: midResult };
  }

  // Recurse only into subintervals where adjacent families differ (gas floor + curve ceiling).
  // Do NOT always explore both halves when the original endpoints differ — that exhausts
  // get_dy budget by scanning the full binary tree down to resolution.
  if (family(lowResult) !== family(midResult)) {
    const left = await islandBisect(low, mid, lowResult, midResult, injectAndSize, resolution);
    if (left !== null) {
      return left;
    }
  }
  if (family(midResult) !== family(highResult)) {
    const right = await islandBisect(mid, high, midResult, highResult, injectAndSize, resolution);
    if (right !== null) {
      return right;
    }
  }
  return null;
}

async function refineHeadroom(args: {
  injectAndSize: (e: bigint) => Promise<LoopSizingResult>;
  isNonBlocked: (e: bigint) => Promise<boolean>;
  ladderResults: Array<{ equity: bigint; result: LoopSizingResult }>;
  minProbe: bigint;
  maxProbe: bigint;
  resolution: bigint;
  resultCache: Map<string, LoopSizingResult>;
}): Promise<{ equity: bigint; edge: LoopSizingResult | null }> {
  const { injectAndSize, isNonBlocked, minProbe, maxProbe, resolution, resultCache } = args;

  // Collect non-blocked equities from cache.
  let largestNonBlocked: bigint | null = null;
  let firstBlockedAbove: bigint | null = null;
  const ordered = [...resultCache.keys()]
    .map((k) => BigInt(k))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const e of ordered) {
    const r = resultCache.get(e.toString());
    if (r === undefined) {
      continue;
    }
    if (r.status !== "blocked") {
      if (largestNonBlocked === null || e > largestNonBlocked) {
        largestNonBlocked = e;
      }
    }
  }

  if (largestNonBlocked === null) {
    // All known probes blocked — confirm minProbe.
    const minR = await injectAndSize(minProbe);
    if (minR.status === "blocked") {
      return { equity: 0n, edge: null };
    }
    largestNonBlocked = minProbe;
  }

  const maxR = await injectAndSize(maxProbe);
  if (maxR.status !== "blocked") {
    return { equity: maxProbe, edge: maxR };
  }

  // Find first blocked above largest non-blocked.
  for (const e of ordered) {
    if (e > largestNonBlocked) {
      const r = resultCache.get(e.toString());
      if (r !== undefined && r.status === "blocked") {
        firstBlockedAbove = e;
        break;
      }
    }
  }
  if (firstBlockedAbove === null) {
    firstBlockedAbove = maxProbe;
  }

  let low = largestNonBlocked;
  let high = firstBlockedAbove;
  while (high - low > resolution) {
    const mid = (low + high) / 2n;
    if (mid <= low || mid >= high) {
      break;
    }
    if (await isNonBlocked(mid)) {
      low = mid;
    } else {
      high = mid;
    }
  }
  const edge = await injectAndSize(low);
  return { equity: low, edge };
}

function finalize(args: {
  template: LoopSizingScenario;
  input: FindLoopCapacityInput;
  capacityEquityDiem: bigint;
  capacityEdge: LoopSizingResult | null;
  bindingEdge: LoopSizingResult | null;
  capacityStatus: "candidate" | "marginal" | "blocked";
  bindingConstraint: BindingConstraint;
  headroom: { equity: bigint; edge: LoopSizingResult | null };
  probes: number;
  getDyQuotes: number;
  truncated: boolean;
  resolution: bigint;
  minProbe: bigint;
  maxProbe: bigint;
  authoritative: boolean;
  warnings: string[];
  resultCache?: Map<string, LoopSizingResult>;
}): LoopCapacityResult {
  const {
    template,
    input,
    capacityEquityDiem,
    capacityEdge,
    bindingEdge,
    capacityStatus,
    bindingConstraint,
    headroom,
    probes,
    getDyQuotes,
    truncated,
    resolution,
    minProbe,
    maxProbe,
    authoritative,
    warnings,
    resultCache,
  } = args;

  const capacityNotionalDiem =
    capacityEquityDiem === 0n
      ? 0n
      : capacityEdge !== null
        ? capacityEdge.positionCollateralDiem
        : notionalForEquity(template, capacityEquityDiem);

  const headroomToBlockNotionalDiem =
    headroom.equity === 0n
      ? 0n
      : headroom.edge !== null
        ? headroom.edge.positionCollateralDiem
        : notionalForEquity(template, headroom.equity);

  const availableMorphoBorrowDiem =
    bindingEdge?.availableMorphoBorrowDiem ??
    capacityEdge?.availableMorphoBorrowDiem ??
    0n;

  // Prefer a true marginal probe for reasons (zero-path may pin bindingEdge to blocked minProbe).
  let firstCachedMarginal: LoopSizingResult | null = null;
  if (resultCache !== undefined) {
    for (const result of resultCache.values()) {
      if (result.status === "marginal") {
        firstCachedMarginal = result;
        break;
      }
    }
  }
  const marginalSource =
    firstCachedMarginal ??
    (bindingEdge?.status === "marginal"
      ? bindingEdge
      : capacityEdge?.status === "marginal"
        ? capacityEdge
        : bindingEdge);

  return {
    targetLeverageBps: template.targetLeverageBps,
    capacityEquityDiem,
    capacityNotionalDiem,
    headroomToBlockEquityDiem: headroom.equity,
    headroomToBlockNotionalDiem,
    capacityStatus,
    bindingConstraint,
    capacityEdge,
    bindingEdge,
    marginalReasons: collectMarginalReasons(marginalSource),
    morphoRawAvailableDiem: morphoRawAvailableDiem(template),
    availableMorphoBorrowDiem,
    search: {
      probes,
      getDyQuotes,
      resolutionDiem: resolution,
      truncated,
      minProbeEquityDiem: minProbe,
      maxProbeEquityDiem: maxProbe,
    },
    inputMode: input.inputMode,
    seedProvenance: input.seedProvenance,
    authoritative,
    warnings,
    decisionSupportOnly: true,
    notADeployRecommendation: true,
    capacityKind: CAPACITY_KIND,
    modelCaveats: modelCaveatsFor(input),
    disclaimer: CAPACITY_DISCLAIMER,
  };
}
