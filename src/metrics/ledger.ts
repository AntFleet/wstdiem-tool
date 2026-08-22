/**
 * DIEM resource ledger: capacity utilization, location buckets, and liveness.
 *
 * Decision-support only. Venice credit is economically useful only if spent.
 * DIEMCredited is Tier 1; SettlementReceived / YieldRouted are lower-trust context.
 * Keeper / routeYield cadence is lumpy — a flat window is not proof of no demand.
 */
import { curvePoolAbi } from "../abi/curvePool.js";
import { erc20BalanceOfAbi } from "../abi/erc20.js";
import { inferenceAdapterReadAbis } from "../abi/inferenceAdapter.js";
import { inferenceVaultAbi } from "../abi/inferenceVault.js";
import { morphoAbi } from "../abi/morpho.js";
import type { Address, AppConfig, StoredInferenceCredit, StoredInferenceSettlement } from "../types/domain.js";
import { parseMorphoMarket, parseMorphoPosition, type LoopPreflightClient } from "../loop/preflight.js";
import { computeBorrowedDiem, formatWad, WAD } from "./math.js";
import { VENICE_CREDIT_PRIMARY } from "./diemYield.js";
import {
  type AdapterLiveMeta,
  buildInferenceFlows,
  sumInWindowCredits,
} from "./flows.js";

export const DEFAULT_LEDGER_WINDOW_HOURS = 72;

export const LEDGER_BANNER =
  "DIEM resource ledger. Decision-support only; not advice; not a yield promise. " +
  "Capacity is Venice API credit if spent ($0 token yield if unused).";

export const LEDGER_DISCLAIMER =
  "Decision-support only; not investment advice; not a yield promise. " +
  "Venice is $1/day per DIEM (API credit if spent; $0 token yield if unused). " +
  "DIEMCredited is Tier 1 chain-proven; SettlementReceived / YieldRouted / unrouted USDC are lower-trust context (SPEC009). " +
  "Keeper and routeYield are lumpy and operator-triggered — a flat window is not proof of no demand.";

export const REQUIRED_BUCKET_IDS = [
  "vault-total-diem-assets",
  "vault-total-wstdiem-supply",
  "vault-nav",
  "diem-credited-window",
  "wstdiem-credited-window",
  "unrouted-usdc-adapters",
  "morpho-supply",
  "morpho-debt",
  "morpho-available-borrow",
  "curve-diem-leg",
  "curve-wstdiem-leg",
  "owner-position",
] as const;

export type LedgerBucketId = (typeof REQUIRED_BUCKET_IDS)[number];

export type LivenessStatus =
  | "fresh"
  | "stale"
  | "lagging"
  | "unavailable"
  | "unknown"
  | "not_configured";

export interface LivenessState {
  status: LivenessStatus;
  ageSeconds: number | null;
  reason: string;
}

export const LIVENESS_THRESHOLDS = {
  /** Live chain/vault read: 2 minutes. */
  chainFreshSeconds: 120,
  /** Live chain/vault read: 15 minutes. */
  chainStaleSeconds: 900,
  /** Sampling cron is 6h; allow one missed tick. */
  samplingFreshSeconds: 8 * 3600,
  /** Sampling: a day without ticks. */
  samplingStaleSeconds: 24 * 3600,
  /** Harvest silence warn (config default 7d). */
  keeperFreshSeconds: 7 * 24 * 3600,
  /** Harvest silence critical (config default 14d). */
  keeperStaleSeconds: 14 * 24 * 3600,
} as const;

export type UtilizationStatus = "ok" | "n/a" | "ambiguous";

export interface DiemCapacityUtilization {
  status: UtilizationStatus;
  reason: string | null;
  windowHours: number;
  windowSeconds: number;
  numeratorDailyDiem: string | null;
  numeratorSource: "DIEMCredited";
  numeratorTrustTier: 1;
  numeratorTrustLabel: "tier1-diem-credited-chain-proven";
  windowDiemCredited: string;
  denominatorDailyDiem: string | null;
  denominatorSource: "vault-staked-diem" | null;
  denominatorOrigin: "live" | "sqlite" | null;
  estimatedVeniceUsdPerDay: string | null;
  ratioBps: number | null;
  veniceCreditSemantics: string;
  tier2Context: {
    trustTier: 2;
    trustLabel: "tier2-usdc-settled-as-reported";
    windowUsdcSettledAsReported: string;
    windowDiemFromYieldRouted: string;
    unroutedUsdc: string | null;
    unroutedIncomplete: boolean;
  };
  caveats: string[];
  decisionSupportOnly: true;
  notAdvice: true;
  notAYieldPromise: true;
}

export type BucketStatus = "ok" | "unavailable" | "not_configured" | "unknown";
export type BucketPurpose =
  | "productive-staked"
  | "claim-on-staked"
  | "credited-window"
  | "idle-unrouted"
  | "debt"
  | "collateral"
  | "available-borrow"
  | "amm-leg"
  | "owner-position";

export interface LedgerBucket {
  id: LedgerBucketId;
  label: string;
  status: BucketStatus;
  amount: string | null;
  unit: "DIEM" | "wstDIEM" | "USDC" | "DIEM-per-wstDIEM" | "mixed";
  purpose: BucketPurpose;
  trustTier: 1 | 2 | 3 | null;
  trustLabel: string | null;
  reason: string | null;
  extras: Record<string, string | null>;
}

export interface LedgerLiveness {
  vaultSample: LivenessState;
  lastDiemCredited: LivenessState;
  lastYieldRouted: LivenessState;
  lastSettlementReceived: LivenessState;
  sqliteSampling: LivenessState;
  rpcBlock: LivenessState;
  getDyQuote: LivenessState;
  keeperHarvestCadence: LivenessState;
  creditCadence: LivenessState;
}

export interface DiemLedgerResult {
  banner: string;
  disclaimer: string;
  windowHours: number;
  windowStart: number;
  windowEnd: number;
  utilization: DiemCapacityUtilization;
  buckets: LedgerBucket[];
  liveness: LedgerLiveness;
  caveats: string[];
  decisionSupportOnly: true;
  notAdvice: true;
  notAYieldPromise: true;
}

export interface LedgerLiveState {
  vaultTotalAssets: bigint | null;
  vaultTotalSupply: bigint | null;
  vaultNav: bigint | null;
  vaultReason: string | null;
  morphoSupply: bigint | null;
  morphoBorrow: bigint | null;
  morphoBorrowShares: bigint | null;
  morphoReason: string | null;
  curveDiemLeg: bigint | null;
  curveWstDiemLeg: bigint | null;
  curveWstDiemLegInDiem: bigint | null;
  curveReason: string | null;
  owner: {
    configured: boolean;
    morphoExpected: boolean;
    address: Address | null;
    walletWstDiem: bigint | null;
    walletValueDiem: bigint | null;
    collateralWstDiem: bigint | null;
    borrowedDiem: bigint | null;
    reason: string | null;
  };
  adapters: AdapterLiveMeta[];
  blockNumber: bigint | null;
  blockTimestamp: number | null;
  getDyQuotedAt: number | null;
}

export interface LedgerObservations {
  nowSeconds: number;
  windowHours: number;
  credits: StoredInferenceCredit[];
  settlements: StoredInferenceSettlement[];
  latestSnapshot: {
    timestamp: number;
    nav: bigint;
    totalAssetsDiem: bigint;
    totalSupply: bigint;
    blockNumber: bigint;
  } | null;
  lastHarvestAt: number | null;
  lastCreditEventAt: number | null;
  lastDiemCreditedAt: number | null;
  lastYieldRoutedAt: number | null;
  lastSettlementReceivedAt: number | null;
  firstSeenBlock: bigint | null;
  creditUsdPerDiemPerDay: number;
  configAdapters: Array<{ address: Address; name?: string }>;
  live: LedgerLiveState | null;
  rpcConfigured: boolean;
  rpcHeaderTimestamp?: number | null;
  keeperFreshSeconds?: number;
  keeperStaleSeconds?: number;
}

export function classifyLiveness(input: {
  nowSeconds: number;
  observedAt: number | null;
  freshSeconds: number;
  staleSeconds: number;
  configured?: boolean;
  unavailableReason?: string;
  notConfiguredReason?: string;
  extraReason?: string;
}): LivenessState {
  if (input.configured === false) {
    return {
      status: "not_configured",
      ageSeconds: null,
      reason: input.notConfiguredReason ?? "not configured",
    };
  }
  if (input.observedAt === null) {
    return {
      status: "unavailable",
      ageSeconds: null,
      reason: input.unavailableReason ?? "no observation",
    };
  }
  if (!Number.isFinite(input.observedAt) || input.observedAt <= 0) {
    return {
      status: "unknown",
      ageSeconds: null,
      reason: "observation timestamp is not a finite unix time",
    };
  }
  const ageSeconds = Math.max(0, input.nowSeconds - input.observedAt);
  let status: LivenessStatus;
  if (ageSeconds <= input.freshSeconds) {
    status = "fresh";
  } else if (ageSeconds <= input.staleSeconds) {
    status = "stale";
  } else {
    status = "lagging";
  }
  const extra = input.extraReason !== undefined ? ` ${input.extraReason}` : "";
  return {
    status,
    ageSeconds,
    reason: `${status}: age ${ageSeconds}s (fresh<=${input.freshSeconds}s, stale<=${input.staleSeconds}s).${extra}`,
  };
}

const SECONDS_PER_DAY = 86_400n;

/** Convert a window sum into a daily rate. Same 18-dec unit in and out. */
export function dailyFromWindow(amount: bigint, windowSeconds: number): bigint | null {
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    return null;
  }
  return (amount * SECONDS_PER_DAY) / BigInt(windowSeconds);
}

function wadUsdPerDay(stakedDiem: bigint, creditUsdPerDiemPerDay: number): string {
  if (!Number.isFinite(creditUsdPerDiemPerDay) || creditUsdPerDiemPerDay <= 0) {
    return formatWad(stakedDiem, 6);
  }
  // Scale by 1e6 so non-integer USD/DIEM/day stays exact enough for display.
  const scaled = BigInt(Math.round(creditUsdPerDiemPerDay * 1_000_000));
  return formatWad((stakedDiem * scaled) / 1_000_000n, 6);
}

function bucket(input: Omit<LedgerBucket, "extras"> & { extras?: Record<string, string | null> }): LedgerBucket {
  return { extras: {}, ...input };
}

/**
 * Do not let a 0n in-wallet balance headline a levered Morpho position.
 * When collateral or debt is non-zero, amount is null and extras carry the split.
 */
export function ownerHeadlineAmount(owner: LedgerLiveState["owner"] | undefined): string | null {
  if (owner === undefined) {
    return null;
  }
  const morphoUnread =
    owner.morphoExpected && (owner.collateralWstDiem === null || owner.borrowedDiem === null);
  const pledged =
    (owner.collateralWstDiem !== null && owner.collateralWstDiem > 0n) ||
    (owner.borrowedDiem !== null && owner.borrowedDiem > 0n);
  if (pledged || morphoUnread) {
    return null;
  }
  if (owner.walletValueDiem !== null) {
    return owner.walletValueDiem.toString();
  }
  if (owner.walletWstDiem !== null) {
    return owner.walletWstDiem.toString();
  }
  if (owner.collateralWstDiem !== null) {
    return owner.collateralWstDiem.toString();
  }
  if (owner.borrowedDiem !== null) {
    return owner.borrowedDiem.toString();
  }
  return null;
}

/**
 * Utilization = daily Tier-1 DIEMCredited / vault-staked DIEM daily Venice capacity.
 * Units must both be 18-dec DIEM. Settled USDC is never the numerator.
 */
export function computeCapacityUtilization(input: {
  windowHours: number;
  windowDiemCredited: bigint;
  vaultStakedDiem: bigint | null;
  unroutedUsdc: bigint | null;
  /** True when at least one configured adapter's USDC.balanceOf was unread. */
  unroutedIncomplete?: boolean;
  hasKeeperCadenceEvidence: boolean;
  creditUsdPerDiemPerDay: number;
  windowUsdcSettledAsReported: bigint;
  windowDiemFromYieldRouted: bigint;
  denominatorOrigin?: "live" | "sqlite" | null;
}): DiemCapacityUtilization {
  const windowSeconds = input.windowHours * 3600;
  const caveats = [
    "venice-credit-only-if-spent",
    "not-a-yield-promise",
    "decision-support-only",
    "tier1-numerator-diem-credited",
    "tier2-settlement-context-only",
    "lumpy-keeper-cadence",
  ];
  const base: DiemCapacityUtilization = {
    status: "n/a",
    reason: null,
    windowHours: input.windowHours,
    windowSeconds,
    numeratorDailyDiem: null,
    numeratorSource: "DIEMCredited",
    numeratorTrustTier: 1,
    numeratorTrustLabel: "tier1-diem-credited-chain-proven",
    windowDiemCredited: input.windowDiemCredited.toString(),
    denominatorDailyDiem: null,
    denominatorSource: null,
    denominatorOrigin: input.denominatorOrigin ?? null,
    estimatedVeniceUsdPerDay: null,
    ratioBps: null,
    veniceCreditSemantics: VENICE_CREDIT_PRIMARY,
    tier2Context: {
      trustTier: 2,
      trustLabel: "tier2-usdc-settled-as-reported",
      windowUsdcSettledAsReported: input.windowUsdcSettledAsReported.toString(),
      windowDiemFromYieldRouted: input.windowDiemFromYieldRouted.toString(),
      unroutedUsdc: input.unroutedUsdc?.toString() ?? null,
      unroutedIncomplete: input.unroutedIncomplete === true,
    },
    caveats,
    decisionSupportOnly: true,
    notAdvice: true,
    notAYieldPromise: true,
  };

  if (windowSeconds <= 0) {
    return { ...base, reason: "invalid-window" };
  }

  const dailyCredited = dailyFromWindow(input.windowDiemCredited, windowSeconds);
  if (dailyCredited === null) {
    return { ...base, reason: "invalid-window" };
  }
  base.numeratorDailyDiem = dailyCredited.toString();

  if (input.vaultStakedDiem === null) {
    return {
      ...base,
      status: "n/a",
      reason: "denominator-unavailable: vault-staked DIEM not readable",
    };
  }
  if (input.vaultStakedDiem <= 0n) {
    return {
      ...base,
      status: "n/a",
      reason: "denominator-unavailable: vault-staked DIEM is zero",
      denominatorDailyDiem: "0",
      denominatorSource: "vault-staked-diem",
      estimatedVeniceUsdPerDay: "0",
    };
  }

  base.denominatorDailyDiem = input.vaultStakedDiem.toString();
  base.denominatorSource = "vault-staked-diem";
  base.estimatedVeniceUsdPerDay = wadUsdPerDay(input.vaultStakedDiem, input.creditUsdPerDiemPerDay);

  const idleUnknown = input.unroutedUsdc === null || input.unroutedIncomplete === true;
  const idlePositive = input.unroutedIncomplete !== true && input.unroutedUsdc !== null && input.unroutedUsdc > 0n;
  if (input.windowDiemCredited === 0n && (idlePositive || idleUnknown || !input.hasKeeperCadenceEvidence)) {
    const why: string[] = [];
    if (idlePositive) {
      why.push("unrouted USDC is non-zero (routing lull possible)");
    }
    if (idleUnknown) {
      why.push(
        input.unroutedIncomplete === true
          ? "unrouted USDC incomplete (some adapters unread)"
          : "unrouted USDC unavailable",
      );
    }
    if (!input.hasKeeperCadenceEvidence) {
      why.push("keeper/routeYield cadence not observed in the freshness window");
    }
    caveats.push("zero-diem-credited-is-not-zero-demand");
    return {
      ...base,
      status: "ambiguous",
      reason: `zero recent DIEMCredited is not proof of no demand: ${why.join("; ")}`,
      caveats,
    };
  }

  const ratioBps = Number((dailyCredited * 10_000n) / input.vaultStakedDiem);
  if (ratioBps > 10_000) {
    caveats.push("ratio-above-100pct-lumpy-catch-up-not-sustainable-utilization");
  }
  if (input.windowDiemCredited === 0n) {
    caveats.push("zero-diem-credited-is-not-proof-of-no-demand");
  }

  return {
    ...base,
    status: "ok",
    reason: null,
    ratioBps,
    caveats,
  };
}

export function buildLedgerBuckets(input: {
  windowHours: number;
  windowDiemCredited: bigint;
  windowWstDiemCredited: bigint;
  unroutedUsdc: bigint | null;
  unroutedReason: string | null;
  unroutedIncomplete?: boolean;
  latestSnapshot: LedgerObservations["latestSnapshot"];
  live: LedgerLiveState | null;
}): LedgerBucket[] {
  const live = input.live;
  const snap = input.latestSnapshot;

  const vaultAssets = live?.vaultTotalAssets ?? snap?.totalAssetsDiem ?? null;
  const vaultAssetsStatus: BucketStatus =
    live?.vaultTotalAssets !== null && live?.vaultTotalAssets !== undefined
      ? "ok"
      : snap !== null
        ? "ok"
        : "unavailable";
  const vaultAssetsReason =
    live?.vaultTotalAssets !== null && live?.vaultTotalAssets !== undefined
      ? "live vault.totalAssets"
      : snap !== null
        ? "sqlite sample (live vault unread)"
        : (live?.vaultReason ?? "vault totalAssets unavailable");

  const vaultSupply = live?.vaultTotalSupply ?? snap?.totalSupply ?? null;
  const vaultSupplyStatus: BucketStatus =
    live?.vaultTotalSupply !== null && live?.vaultTotalSupply !== undefined
      ? "ok"
      : snap !== null
        ? "ok"
        : "unavailable";
  const vaultNav = live?.vaultNav ?? snap?.nav ?? null;
  const vaultNavStatus: BucketStatus =
    live?.vaultNav !== null && live?.vaultNav !== undefined
      ? "ok"
      : snap !== null
        ? "ok"
        : "unavailable";

  const morphoSupply = live?.morphoSupply ?? null;
  const morphoBorrow = live?.morphoBorrow ?? null;
  const morphoAvailable =
    morphoSupply !== null && morphoBorrow !== null
      ? morphoSupply > morphoBorrow
        ? morphoSupply - morphoBorrow
        : 0n
      : null;
  const morphoConfigured = live === null ? "unknown" : live.morphoReason === "marketId not configured" ? "not_configured" : null;

  const owner = live?.owner;
  const morphoUnread =
    owner !== undefined &&
    owner.morphoExpected &&
    (owner.collateralWstDiem === null || owner.borrowedDiem === null);
  const ownerStatus: BucketStatus =
    owner === undefined || owner === null
      ? "unavailable"
      : !owner.configured
        ? "not_configured"
        : morphoUnread
          ? "unavailable"
          : owner.walletWstDiem === null &&
              owner.collateralWstDiem === null &&
              owner.borrowedDiem === null
            ? "unavailable"
            : "ok";

  const unroutedStatus: BucketStatus =
    input.unroutedIncomplete === true
      ? "unavailable"
      : input.unroutedUsdc !== null
        ? "ok"
        : input.unroutedReason === "not_configured"
          ? "not_configured"
          : "unavailable";

  const curveDiem = live?.curveDiemLeg ?? null;
  const curveWst = live?.curveWstDiemLegInDiem ?? live?.curveWstDiemLeg ?? null;
  const curveDiemStatus: BucketStatus =
    curveDiem !== null ? "ok" : live?.curveReason === "curvePool not configured" ? "not_configured" : "unavailable";
  const curveWstStatus: BucketStatus =
    curveWst !== null ? "ok" : live?.curveReason === "curvePool not configured" ? "not_configured" : "unavailable";

  return [
    bucket({
      id: "vault-total-diem-assets",
      label: "Vault total DIEM assets (staked)",
      status: vaultAssetsStatus,
      amount: vaultAssets?.toString() ?? null,
      unit: "DIEM",
      purpose: "productive-staked",
      trustTier: 1,
      trustLabel: "chain-or-sqlite-vault-assets",
      reason: vaultAssetsReason,
      extras: {
        source:
          live?.vaultTotalAssets !== null && live?.vaultTotalAssets !== undefined ? "live" : snap !== null ? "sqlite" : null,
      },
    }),
    bucket({
      id: "vault-total-wstdiem-supply",
      label: "Vault total wstDIEM supply",
      status: vaultSupplyStatus,
      amount: vaultSupply?.toString() ?? null,
      unit: "wstDIEM",
      purpose: "claim-on-staked",
      trustTier: 1,
      trustLabel: "chain-or-sqlite-total-supply",
      reason:
        vaultSupplyStatus === "ok"
          ? "wstDIEM is a claim on vault-staked DIEM, not a second stock of DIEM"
          : (live?.vaultReason ?? "vault totalSupply unavailable"),
    }),
    bucket({
      id: "vault-nav",
      label: "Vault NAV (DIEM per wstDIEM)",
      status: vaultNavStatus,
      amount: vaultNav?.toString() ?? null,
      unit: "DIEM-per-wstDIEM",
      purpose: "claim-on-staked",
      trustTier: 1,
      trustLabel: "convertToAssets-or-totals",
      reason: vaultNavStatus === "ok" ? "accounting NAV; not a market/exit quote" : "NAV unavailable",
    }),
    bucket({
      id: "diem-credited-window",
      label: `DIEM credited (Tier 1) in ${input.windowHours}h`,
      status: "ok",
      amount: input.windowDiemCredited.toString(),
      unit: "DIEM",
      purpose: "credited-window",
      trustTier: 1,
      trustLabel: "tier1-diem-credited-chain-proven",
      reason: "Σ DIEMCredited.amount in window (0 is a count, not proof of no demand)",
    }),
    bucket({
      id: "wstdiem-credited-window",
      label: `wstDIEM credited / operator-compounded in ${input.windowHours}h`,
      status: "ok",
      amount: input.windowWstDiemCredited.toString(),
      unit: "DIEM",
      purpose: "credited-window",
      trustTier: 1,
      trustLabel: "wstdiem-credited-operator-take",
      reason: "Σ WstDIEMCredited.diem (operator compounding; NAV-neutral share mint)",
    }),
    bucket({
      id: "unrouted-usdc-adapters",
      label: "Unrouted USDC at adapters (operator has not called routeYield)",
      status: unroutedStatus,
      amount: input.unroutedUsdc?.toString() ?? null,
      unit: "USDC",
      purpose: "idle-unrouted",
      trustTier: 2,
      trustLabel: "tier2-state-fact-not-demand",
      reason:
        input.unroutedIncomplete === true
          ? (input.unroutedReason ?? "partial-sum; some adapters unread")
          : unroutedStatus === "ok"
            ? "point-in-time USDC.balanceOf(adapter); state fact, not a forward demand signal"
            : (input.unroutedReason ?? "unrouted USDC unavailable"),
    }),
    bucket({
      id: "morpho-supply",
      label: "Morpho market supply (DIEM lent)",
      status:
        morphoSupply !== null ? "ok" : morphoConfigured === "not_configured" ? "not_configured" : live === null ? "unavailable" : "unavailable",
      amount: morphoSupply?.toString() ?? null,
      unit: "DIEM",
      purpose: "available-borrow",
      trustTier: 1,
      trustLabel: "morpho-market-supply",
      reason:
        morphoSupply !== null
          ? "Morpho totalSupplyAssets (loan-token DIEM supplied to the market; not borrower collateral)"
          : (live?.morphoReason ?? "Morpho market unread"),
    }),
    bucket({
      id: "morpho-debt",
      label: "Morpho market debt (DIEM borrowed)",
      status:
        morphoBorrow !== null ? "ok" : morphoConfigured === "not_configured" ? "not_configured" : live === null ? "unavailable" : "unavailable",
      amount: morphoBorrow?.toString() ?? null,
      unit: "DIEM",
      purpose: "debt",
      trustTier: 1,
      trustLabel: "morpho-market-borrow",
      reason:
        morphoBorrow !== null
          ? "Morpho totalBorrowAssets"
          : (live?.morphoReason ?? "Morpho market unread"),
    }),
    bucket({
      id: "morpho-available-borrow",
      label: "Morpho available borrow (supply − debt)",
      status:
        morphoAvailable !== null
          ? "ok"
          : morphoConfigured === "not_configured"
            ? "not_configured"
            : live === null
              ? "unavailable"
              : "unavailable",
      amount: morphoAvailable?.toString() ?? null,
      unit: "DIEM",
      purpose: "available-borrow",
      trustTier: 1,
      trustLabel: "morpho-headroom",
      reason:
        morphoAvailable !== null
          ? "max(0, totalSupplyAssets − totalBorrowAssets); not a deploy recommendation"
          : (live?.morphoReason ?? "Morpho market unread"),
    }),
    bucket({
      id: "curve-diem-leg",
      label: "Curve DIEM leg",
      status: curveDiemStatus,
      amount: curveDiem?.toString() ?? null,
      unit: "DIEM",
      purpose: "amm-leg",
      trustTier: 1,
      trustLabel: "curve-balances-0",
      reason:
        curveDiem !== null ? "Curve balances(0); 0 is a drained pool, not omitted" : (live?.curveReason ?? "Curve unread"),
    }),
    bucket({
      id: "curve-wstdiem-leg",
      label: "Curve wstDIEM leg (DIEM-equivalent)",
      status: curveWstStatus,
      amount: curveWst?.toString() ?? null,
      unit: live?.curveWstDiemLegInDiem !== null && live?.curveWstDiemLegInDiem !== undefined ? "DIEM" : "wstDIEM",
      purpose: "amm-leg",
      trustTier: 1,
      trustLabel: "curve-balances-1",
      reason:
        curveWst !== null
          ? "Curve balances(1) valued at vault NAV when convertToAssets succeeds"
          : (live?.curveReason ?? "Curve unread"),
      extras: {
        rawWstDiem: live?.curveWstDiemLeg?.toString() ?? null,
        diemEquivalent: live?.curveWstDiemLegInDiem?.toString() ?? null,
      },
    }),
    bucket({
      id: "owner-position",
      label: "Owner position",
      status: ownerStatus,
      amount: ownerHeadlineAmount(owner),
      unit: "mixed",
      purpose: "owner-position",
      trustTier: 1,
      trustLabel: "owner-wallet-and-morpho",
      reason:
        ownerStatus === "not_configured"
          ? "position.owner not configured"
          : morphoUnread
            ? (owner?.reason ?? "Morpho collateral/debt unread; wallet is not a complete owner readout")
            : ownerStatus === "unavailable"
              ? (owner?.reason ?? "owner position unread")
              : "wallet wstDIEM is a vault claim; Morpho collateral is pledged wstDIEM; debt is borrowed DIEM",
      extras: {
        address: owner?.address ?? null,
        walletWstDiem: owner?.walletWstDiem?.toString() ?? null,
        walletValueDiem: owner?.walletValueDiem?.toString() ?? null,
        collateralWstDiem:
          owner?.collateralWstDiem?.toString() ??
          (owner?.morphoExpected === true ? "unread" : null),
        borrowedDiem:
          owner?.borrowedDiem?.toString() ?? (owner?.morphoExpected === true ? "unread" : null),
      },
    }),
  ];
}

export function buildLedgerLiveness(input: {
  nowSeconds: number;
  latestSnapshot: LedgerObservations["latestSnapshot"];
  lastHarvestAt: number | null;
  lastCreditEventAt: number | null;
  lastDiemCreditedAt: number | null;
  lastYieldRoutedAt: number | null;
  lastSettlementReceivedAt: number | null;
  live: LedgerLiveState | null;
  rpcConfigured: boolean;
  rpcHeaderTimestamp?: number | null;
  keeperFreshSeconds?: number;
  keeperStaleSeconds?: number;
}): LedgerLiveness {
  const keeperFresh = input.keeperFreshSeconds ?? LIVENESS_THRESHOLDS.keeperFreshSeconds;
  const keeperStale = input.keeperStaleSeconds ?? LIVENESS_THRESHOLDS.keeperStaleSeconds;
  const lumpy =
    "Lumpy keeper/routeYield cadence; age is not proof of no demand and not a yield forecast.";

  const liveVaultAssetsRead =
    input.live?.vaultTotalAssets !== null && input.live?.vaultTotalAssets !== undefined;
  const liveVaultAt = liveVaultAssetsRead ? (input.live?.blockTimestamp ?? null) : null;
  const vaultSample = classifyLiveness({
    nowSeconds: input.nowSeconds,
    observedAt: liveVaultAt ?? input.latestSnapshot?.timestamp ?? null,
    freshSeconds:
      liveVaultAt !== null ? LIVENESS_THRESHOLDS.chainFreshSeconds : LIVENESS_THRESHOLDS.samplingFreshSeconds,
    staleSeconds:
      liveVaultAt !== null ? LIVENESS_THRESHOLDS.chainStaleSeconds : LIVENESS_THRESHOLDS.samplingStaleSeconds,
    unavailableReason: "no live vault read and no sqlite vault sample",
    extraReason: liveVaultAt !== null ? "source=live-block" : "source=sqlite-sample",
  });

  return {
    vaultSample,
    lastDiemCredited: classifyLiveness({
      nowSeconds: input.nowSeconds,
      observedAt: input.lastDiemCreditedAt,
      freshSeconds: keeperFresh,
      staleSeconds: keeperStale,
      unavailableReason:
        "no DIEMCredited events in sqlite; not zero demand (forward-only series and lumpy routeYield)",
      extraReason: lumpy,
    }),
    lastYieldRouted: classifyLiveness({
      nowSeconds: input.nowSeconds,
      observedAt: input.lastYieldRoutedAt,
      freshSeconds: keeperFresh,
      staleSeconds: keeperStale,
      unavailableReason: "no YieldRouted events in sqlite; operator-triggered and lumpy",
      extraReason: lumpy,
    }),
    lastSettlementReceived: classifyLiveness({
      nowSeconds: input.nowSeconds,
      observedAt: input.lastSettlementReceivedAt,
      freshSeconds: keeperFresh,
      staleSeconds: keeperStale,
      unavailableReason: "no SettlementReceived events in sqlite (Tier 2; not inference demand)",
      extraReason: lumpy,
    }),
    sqliteSampling: classifyLiveness({
      nowSeconds: input.nowSeconds,
      observedAt: input.latestSnapshot?.timestamp ?? null,
      freshSeconds: LIVENESS_THRESHOLDS.samplingFreshSeconds,
      staleSeconds: LIVENESS_THRESHOLDS.samplingStaleSeconds,
      unavailableReason: "no valid metric_snapshots; run watch --once / sample-tick to start the series",
    }),
    rpcBlock: classifyLiveness({
      nowSeconds: input.nowSeconds,
      observedAt: input.rpcHeaderTimestamp ?? input.live?.blockTimestamp ?? null,
      freshSeconds: LIVENESS_THRESHOLDS.chainFreshSeconds,
      staleSeconds: LIVENESS_THRESHOLDS.chainStaleSeconds,
      configured: input.rpcConfigured,
      notConfiguredReason: "no RPC configured; header not read",
      unavailableReason: "RPC block header unread (RPC failed)",
      extraReason: "RPC header age only; not loop sizing --from-chain and not proof vault/Morpho/Curve reads succeeded",
    }),
    getDyQuote: classifyLiveness({
      nowSeconds: input.nowSeconds,
      observedAt: input.live?.getDyQuotedAt ?? null,
      freshSeconds: LIVENESS_THRESHOLDS.chainFreshSeconds,
      staleSeconds: LIVENESS_THRESHOLDS.chainStaleSeconds,
      configured: false,
      notConfiguredReason: "get_dy not queried for loop ledger (used by loop capacity/sizing --from-chain)",
    }),
    keeperHarvestCadence: classifyLiveness({
      nowSeconds: input.nowSeconds,
      observedAt: input.lastHarvestAt,
      freshSeconds: keeperFresh,
      staleSeconds: keeperStale,
      unavailableReason: "no harvest_events in sqlite; keeper is operator-triggered and lumpy",
      extraReason: lumpy,
    }),
    creditCadence: classifyLiveness({
      nowSeconds: input.nowSeconds,
      observedAt: input.lastCreditEventAt,
      freshSeconds: keeperFresh,
      staleSeconds: keeperStale,
      unavailableReason: "no credit_events in sqlite; credit path is lumpy",
      extraReason: lumpy,
    }),
  };
}

export function buildDiemLedger(obs: LedgerObservations): DiemLedgerResult {
  const windowSeconds = obs.windowHours * 3600;
  const windowEnd = obs.nowSeconds;
  const windowStart = windowEnd - windowSeconds;
  const liveMeta = obs.live?.adapters ?? [];

  const flows = buildInferenceFlows({
    credits: obs.credits,
    settlements: obs.settlements,
    nowSeconds: obs.nowSeconds,
    windowSeconds,
    configAdapters: obs.configAdapters,
    liveMeta,
    navStart: obs.latestSnapshot?.nav ?? null,
    navEnd: obs.live?.vaultNav ?? obs.latestSnapshot?.nav ?? null,
    sStart: obs.latestSnapshot?.totalSupply ?? null,
    yieldFeeBps: null,
    treasuryActive: true,
    firstSeenBlock: obs.firstSeenBlock,
  });

  const windowDiemCredited = sumInWindowCredits(obs.credits, windowStart, windowEnd, "DIEMCredited");
  const windowWstDiemCredited = sumInWindowCredits(obs.credits, windowStart, windowEnd, "WstDIEMCredited");
  const windowDiemFromYieldRouted = obs.settlements.reduce((sum, row) => {
    if (row.kind === "YieldRouted" && row.timestamp > windowStart && row.timestamp <= windowEnd) {
      return sum + (row.diemOut ?? 0n);
    }
    return sum;
  }, 0n);

  let unroutedUsdc: bigint | null = null;
  let unroutedReason: string | null = null;
  let unroutedIncomplete = false;
  if (liveMeta.length > 0) {
    let any = false;
    let total = 0n;
    for (const meta of liveMeta) {
      if (meta.unroutedUsdc !== null) {
        any = true;
        total += meta.unroutedUsdc;
      } else {
        unroutedIncomplete = true;
      }
    }
    if (obs.configAdapters.length > liveMeta.length) {
      unroutedIncomplete = true;
    }
    if (any) {
      unroutedUsdc = total;
      if (unroutedIncomplete) {
        unroutedReason = "partial-sum; some adapters unread";
      }
    } else {
      unroutedReason = "adapter USDC.balanceOf unread";
      unroutedIncomplete = true;
    }
  } else if (obs.configAdapters.length === 0) {
    unroutedReason = "not_configured";
  } else {
    unroutedReason = "live adapter balances unread";
    unroutedIncomplete = true;
  }

  const vaultStakedDiem = obs.live?.vaultTotalAssets ?? obs.latestSnapshot?.totalAssetsDiem ?? null;
  const denominatorOrigin: "live" | "sqlite" | null =
    obs.live?.vaultTotalAssets !== null && obs.live?.vaultTotalAssets !== undefined
      ? "live"
      : obs.latestSnapshot !== null
        ? "sqlite"
        : null;
  const keeperFresh = obs.keeperFreshSeconds ?? LIVENESS_THRESHOLDS.keeperFreshSeconds;
  const keeperStale = obs.keeperStaleSeconds ?? LIVENESS_THRESHOLDS.keeperStaleSeconds;
  const hasKeeperCadenceEvidence =
    (obs.lastHarvestAt !== null && obs.nowSeconds - obs.lastHarvestAt <= keeperStale) ||
    (obs.lastYieldRoutedAt !== null && obs.nowSeconds - obs.lastYieldRoutedAt <= keeperStale);

  const utilization = computeCapacityUtilization({
    windowHours: obs.windowHours,
    windowDiemCredited,
    vaultStakedDiem,
    unroutedUsdc,
    unroutedIncomplete,
    hasKeeperCadenceEvidence,
    creditUsdPerDiemPerDay: obs.creditUsdPerDiemPerDay,
    windowUsdcSettledAsReported: BigInt(flows.aggregate.usdcSettledAsReported),
    windowDiemFromYieldRouted,
    denominatorOrigin,
  });

  const buckets = buildLedgerBuckets({
    windowHours: obs.windowHours,
    windowDiemCredited,
    windowWstDiemCredited,
    unroutedUsdc,
    unroutedReason,
    unroutedIncomplete,
    latestSnapshot: obs.latestSnapshot,
    live: obs.live,
  });

  const liveness = buildLedgerLiveness({
    nowSeconds: obs.nowSeconds,
    latestSnapshot: obs.latestSnapshot,
    lastHarvestAt: obs.lastHarvestAt,
    lastCreditEventAt: obs.lastCreditEventAt,
    lastDiemCreditedAt: obs.lastDiemCreditedAt,
    lastYieldRoutedAt: obs.lastYieldRoutedAt,
    lastSettlementReceivedAt: obs.lastSettlementReceivedAt,
    live: obs.live,
    rpcConfigured: obs.rpcConfigured,
    rpcHeaderTimestamp: obs.rpcHeaderTimestamp ?? null,
    keeperFreshSeconds: keeperFresh,
    keeperStaleSeconds: keeperStale,
  });

  const caveats = [
    "decision-support-only",
    "not-advice",
    "not-a-yield-promise",
    "venice-credit-only-if-spent",
    "tier1-diem-credited-chain-proven",
    "tier2-settled-usdc-lower-trust",
    "lumpy-keeper-not-zero-demand",
    ...utilization.caveats.filter((c) => c === "zero-diem-credited-is-not-zero-demand"),
  ];

  return {
    banner: LEDGER_BANNER,
    disclaimer: LEDGER_DISCLAIMER,
    windowHours: obs.windowHours,
    windowStart,
    windowEnd,
    utilization,
    buckets,
    liveness,
    caveats,
    decisionSupportOnly: true,
    notAdvice: true,
    notAYieldPromise: true,
  };
}

const ZERO = `0x${"0".repeat(40)}` as Address;
const CURVE_DIEM_INDEX = 0n;
const CURVE_WSTDIEM_INDEX = 1n;

function toBigInt(value: unknown): bigint {
  return BigInt(value as bigint | number | string);
}

export interface LedgerLiveClient extends LoopPreflightClient {
  getBlockNumber(): Promise<bigint>;
}

/**
 * Fail-soft live reads for the ledger. Empty Curve/Morpho is a bucket value, not a hard fail.
 */
export async function collectLedgerLiveState(input: {
  config: AppConfig;
  client: LedgerLiveClient;
  blockTimestamp?: number;
  pinBlock?: bigint;
}): Promise<LedgerLiveState> {
  const { config, client } = input;
  const pin = input.pinBlock;
  const state: LedgerLiveState = {
    vaultTotalAssets: null,
    vaultTotalSupply: null,
    vaultNav: null,
    vaultReason: null,
    morphoSupply: null,
    morphoBorrow: null,
    morphoBorrowShares: null,
    morphoReason: null,
    curveDiemLeg: null,
    curveWstDiemLeg: null,
    curveWstDiemLegInDiem: null,
    curveReason: null,
    owner: {
      configured: config.position.owner !== null,
      morphoExpected: config.position.owner !== null && config.morpho.marketId !== null,
      address: config.position.owner,
      walletWstDiem: null,
      walletValueDiem: null,
      collateralWstDiem: null,
      borrowedDiem: null,
      reason: config.position.owner === null ? "position.owner not configured" : null,
    },
    adapters: [],
    blockNumber: null,
    blockTimestamp: input.blockTimestamp ?? null,
    getDyQuotedAt: null,
  };

  try {
    state.blockNumber = pin ?? (await client.getBlockNumber());
  } catch {
    /* optional */
  }

  const vault = config.contracts.inferenceVault;
  if (vault === null) {
    state.vaultReason = "inferenceVault not configured";
  } else {
    try {
      state.vaultTotalAssets = toBigInt(
        await client.readContract({
          address: vault,
          abi: inferenceVaultAbi,
          functionName: "totalAssets",
          blockNumber: pin,
        }),
      );
    } catch (error) {
      state.vaultReason = error instanceof Error ? error.message : String(error);
    }
    try {
      state.vaultTotalSupply = toBigInt(
        await client.readContract({
          address: vault,
          abi: inferenceVaultAbi,
          functionName: "totalSupply",
          blockNumber: pin,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.vaultReason = state.vaultReason ?? message;
    }
    try {
      state.vaultNav = toBigInt(
        await client.readContract({
          address: vault,
          abi: inferenceVaultAbi,
          functionName: "convertToAssets",
          args: [WAD],
          blockNumber: pin,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.vaultReason = state.vaultReason ?? message;
    }
  }

  if (config.morpho.marketId === null) {
    state.morphoReason = "marketId not configured";
  } else {
    try {
      const market = parseMorphoMarket(
        await client.readContract({
          address: config.contracts.morphoBlue,
          abi: morphoAbi,
          functionName: "market",
          args: [config.morpho.marketId],
          blockNumber: pin,
        }),
      );
      if (market === null) {
        state.morphoReason = "Morpho market returned an unsupported shape";
      } else {
        state.morphoSupply = market.totalSupplyAssets;
        state.morphoBorrow = market.totalBorrowAssets;
        state.morphoBorrowShares = market.totalBorrowShares;
      }
    } catch (error) {
      state.morphoReason = error instanceof Error ? error.message : String(error);
    }
  }

  const curvePool = config.contracts.curvePool;
  if (curvePool === null) {
    state.curveReason = "curvePool not configured";
  } else {
    try {
      const diemLeg = toBigInt(
        await client.readContract({
          address: curvePool,
          abi: curvePoolAbi,
          functionName: "balances",
          args: [CURVE_DIEM_INDEX],
          blockNumber: pin,
        }),
      );
      const wstLeg = toBigInt(
        await client.readContract({
          address: curvePool,
          abi: curvePoolAbi,
          functionName: "balances",
          args: [CURVE_WSTDIEM_INDEX],
          blockNumber: pin,
        }),
      );
      state.curveDiemLeg = diemLeg;
      state.curveWstDiemLeg = wstLeg;
      if (vault !== null) {
        try {
          state.curveWstDiemLegInDiem = toBigInt(
            await client.readContract({
              address: vault,
              abi: inferenceVaultAbi,
              functionName: "convertToAssets",
              args: [wstLeg],
              blockNumber: pin,
            }),
          );
        } catch {
          /* keep raw wstDIEM leg */
        }
      }
    } catch (error) {
      state.curveReason = error instanceof Error ? error.message : String(error);
    }
  }

  if (config.position.owner !== null) {
    const owner = config.position.owner;
    if (vault !== null) {
      try {
        const wallet = toBigInt(
          await client.readContract({
            address: vault,
            abi: [erc20BalanceOfAbi],
            functionName: "balanceOf",
            args: [owner],
            blockNumber: pin,
          }),
        );
        state.owner.walletWstDiem = wallet;
        try {
          state.owner.walletValueDiem = toBigInt(
            await client.readContract({
              address: vault,
              abi: inferenceVaultAbi,
              functionName: "convertToAssets",
              args: [wallet],
              blockNumber: pin,
            }),
          );
        } catch {
          /* NAV conversion optional */
        }
      } catch (error) {
        state.owner.reason = error instanceof Error ? error.message : String(error);
      }
    }
    if (config.morpho.marketId !== null) {
      try {
        const raw = await client.readContract({
          address: config.contracts.morphoBlue,
          abi: morphoAbi,
          functionName: "position",
          args: [config.morpho.marketId, owner],
          blockNumber: pin,
        });
        const position = parseMorphoPosition(raw);
        if (position === null) {
          state.owner.reason = state.owner.reason ?? "Morpho position returned an unsupported shape";
        } else {
          state.owner.collateralWstDiem = position.collateral;
          if (state.morphoBorrow !== null && state.morphoBorrowShares !== null) {
            state.owner.borrowedDiem = computeBorrowedDiem(
              {
                totalBorrowAssets: state.morphoBorrow,
                totalBorrowShares: state.morphoBorrowShares,
              },
              position,
            );
          } else if (position.borrowShares === 0n) {
            state.owner.borrowedDiem = 0n;
          } else {
            state.owner.reason =
              state.owner.reason ?? "Morpho market shares unread; owner debt not computed";
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.owner.reason = state.owner.reason ?? message;
      }
    }
  }

  for (const entry of config.contracts.venueAdapters ?? []) {
    const meta: AdapterLiveMeta = {
      address: entry.address,
      name: entry.name ?? null,
      isVenueAdapter: null,
      operatorFeeBps: null,
      unroutedUsdc: null,
    };
    try {
      if (meta.name === null) {
        meta.name = (await client.readContract({
          address: entry.address,
          abi: inferenceAdapterReadAbis,
          functionName: "inferenceName",
          blockNumber: pin,
        })) as string;
      }
    } catch {
      /* keep config name */
    }
    if (vault !== null) {
      try {
        meta.isVenueAdapter = (await client.readContract({
          address: vault,
          abi: inferenceVaultAbi,
          functionName: "isVenueAdapter",
          args: [entry.address],
          blockNumber: pin,
        })) as boolean;
      } catch {
        /* optional */
      }
    }
    if (config.contracts.usdc !== null && config.contracts.usdc.toLowerCase() !== ZERO) {
      try {
        meta.unroutedUsdc = toBigInt(
          await client.readContract({
            address: config.contracts.usdc,
            abi: [erc20BalanceOfAbi],
            functionName: "balanceOf",
            args: [entry.address],
            blockNumber: pin,
          }),
        );
      } catch {
        /* optional */
      }
    }
    state.adapters.push(meta);
  }

  return state;
}
