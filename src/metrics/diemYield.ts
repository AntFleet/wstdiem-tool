import { CliError } from "../cli/errors.js";
import type { LoopDemandResult } from "./demand.js";
import { REALIZED_DISCLAIMER } from "./demand.js";

export const DIEM_YIELD_BANNER =
  "DIEM route comparison. Decision-support only; not advice; not a ranking. Vault figure is REALIZED NAV growth, not a forward yield. Surplus is a third party; compounding is the keeper, not an agent.";

export const DEFAULT_DIEM_YIELD_WINDOW_HOURS = 552;

export const VENICE_CREDIT_PRIMARY =
  "$1/day per DIEM (API credit if spent; $0 token yield if unused)";

export type DiemYieldTier = "MEASURED" | "STATED" | "MODELED" | "UNAVAILABLE" | "MARKETED";

export interface DiemYieldRow {
  id: "hold" | "venice" | "vault" | "loop";
  label: string;
  tier: DiemYieldTier;
  primary: string;
  extras: Record<string, string | null>;
}

export interface DiemYieldAudit {
  tier: "MARKETED";
  source: string;
  claim: string;
  line: string;
}

export interface DiemYieldResult {
  banner: string;
  windowHours: number;
  windowKind: "realized";
  rows: DiemYieldRow[];
  audit: DiemYieldAudit | null;
  disclaimer: string;
  notAdvice: true;
}

export interface DiemYieldMarketed {
  claim: string;
  source: string;
}

export type DiemYieldLoopInput =
  | {
      kind: "leftover";
      message: string;
      extras: Record<string, string | null>;
    }
  | {
      kind: "modeled";
      primary: string;
      extras: Record<string, string | null>;
    }
  | {
      kind: "unavailable";
      reason: string;
    };

export function isLeftoverSeedError(error: unknown): error is CliError {
  if (!(error instanceof CliError) || error.code !== "FROM_CHAIN_SEED_BLOCKED") {
    return false;
  }
  const data = error.data;
  return (
    typeof data === "object" &&
    data !== null &&
    "dustFloorWei" in data &&
    typeof (data as { dustFloorWei?: unknown }).dustFloorWei === "string"
  );
}

export function veniceCreditPrimary(diemUsd?: number): string {
  if (diemUsd === undefined) {
    return VENICE_CREDIT_PRIMARY;
  }
  const pct = ((365 / diemUsd) * 100).toFixed(2);
  return `${VENICE_CREDIT_PRIMARY}; upper-bound ${pct}% only if fully used`;
}

export function buildDiemYield(input: {
  windowHours: number;
  diemAmount: number;
  diemUsd?: number;
  demand: LoopDemandResult;
  liveNavDecimal?: string | null;
  loop: DiemYieldLoopInput;
  marketed: DiemYieldMarketed;
}): DiemYieldResult {
  const { windowHours, diemAmount, diemUsd, demand, liveNavDecimal, loop, marketed } = input;
  const hold: DiemYieldRow = {
    id: "hold",
    label: "Hold idle",
    tier: "STATED",
    primary: "0 token yield",
    extras: { diem: String(diemAmount) },
  };
  const venice: DiemYieldRow = {
    id: "venice",
    label: "Stake for credit (Venice)",
    tier: "STATED",
    primary: veniceCreditPrimary(diemUsd),
    extras: {
      usdPerDay:
        diemUsd === undefined ? null : (diemAmount * 1).toString(),
      citation: "Venice documented constant; DIEM token views revert (2026-07-16)",
    },
  };

  const vaultOk = demand.current.status === "ok" && demand.current.velocityBps !== null;
  const vault: DiemYieldRow = vaultOk
    ? {
        id: "vault",
        label: "wstDIEM vault (unlevered)",
        tier: "MEASURED",
        primary: demand.pasteLine,
        extras: {
          navStart: demand.current.navStart,
          navEnd: demand.current.navEnd,
          liveNav: liveNavDecimal ?? null,
          sampleCount: String(demand.current.sampleCount),
          observedHours:
            demand.current.spanSeconds === null
              ? null
              : String(Math.round(demand.current.spanSeconds / 3600)),
          windowHours: String(windowHours),
          windowDays: String(windowHours / 24),
        },
      }
    : {
        id: "vault",
        label: "wstDIEM vault (unlevered)",
        tier: "UNAVAILABLE",
        primary: `n/a (${demand.current.status}, samples ${demand.current.sampleCount})`,
        extras: { sampleCount: String(demand.current.sampleCount) },
      };

  let loopRow: DiemYieldRow;
  if (loop.kind === "leftover") {
    loopRow = {
      id: "loop",
      label: "wstDIEM loop (levered)",
      tier: "UNAVAILABLE",
      primary: loop.message,
      extras: loop.extras,
    };
  } else if (loop.kind === "modeled") {
    loopRow = {
      id: "loop",
      label: "wstDIEM loop (levered)",
      tier: "MODELED",
      primary: loop.primary,
      extras: loop.extras,
    };
  } else {
    loopRow = {
      id: "loop",
      label: "wstDIEM loop (levered)",
      tier: "UNAVAILABLE",
      primary: loop.reason,
      extras: {},
    };
  }

  let audit: DiemYieldAudit | null = null;
  if (vaultOk && demand.current.velocityBps !== null) {
    const pct = (demand.current.velocityBps / 100).toFixed(2);
    const observed =
      demand.current.spanSeconds === null
        ? "n/a"
        : `${Math.round(demand.current.spanSeconds / 3600)}h`;
    audit = {
      tier: "MARKETED",
      source: marketed.source,
      claim: marketed.claim,
      line: `marketed ${marketed.claim} (external, ${marketed.source}) vs realized ${demand.current.velocityBps} bps (${pct}%) over observed ${observed}`,
    };
  }

  return {
    banner: DIEM_YIELD_BANNER,
    windowHours,
    windowKind: "realized",
    rows: [hold, venice, vault, loopRow],
    audit,
    disclaimer: vaultOk ? REALIZED_DISCLAIMER : DIEM_YIELD_BANNER,
    notAdvice: true,
  };
}
