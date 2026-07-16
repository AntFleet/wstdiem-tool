import type { Severity } from "../types/domain.js";
import type { LoopReadinessResult } from "../loop/readiness.js";

/**
 * SPEC004 — Scheduler exit-code contract.
 *
 * Severity-ordered process exit codes for the three live-monitoring commands
 * (`status`, `watch --once`, `monitor`) so a cron/systemd keeper can gate on `$?`.
 * `tool-error (1)` is NOT modelled here — it stays in runAction's catch (§3 step 1).
 */
export type MonitoringOutcome = "nominal" | "warn" | "indeterminate" | "critical";

export type MonitoringExitCode = 0 | 10 | 20 | 30;

export interface MonitoringClassification {
  outcome: MonitoringOutcome;
  exitCode: MonitoringExitCode;
}

/**
 * Classify a monitoring tick into an outcome + exit code (SPEC004 §3).
 *
 * A short-circuit GATE, not a numeric max: alerts derived from a read that did not
 * complete are untrustworthy, so `!assessed` short-circuits to `indeterminate (20)`
 * BEFORE any alert severity is consulted (a `critical` requires a completed read).
 *
 *   1. !assessed                         → indeterminate (20)
 *   2. any alert level === "CRITICAL"    → critical (30)
 *   3. any alert level === "WARN"        → warn (10)
 *   4. otherwise                         → nominal (0)
 *
 * There is NO separate "readiness blocker forces critical" rule — classification is
 * purely from alert levels (`evaluateReadinessAlerts` already assigns the intended
 * level to each condition; the closed audit gate is never an alert).
 */
export function classifyMonitoringOutcome(input: {
  assessed: boolean;
  alerts: ReadonlyArray<{ level: Severity }>;
}): MonitoringClassification {
  if (!input.assessed) {
    return { outcome: "indeterminate", exitCode: 20 };
  }
  if (input.alerts.some((entry) => entry.level === "CRITICAL")) {
    return { outcome: "critical", exitCode: 30 };
  }
  if (input.alerts.some((entry) => entry.level === "WARN")) {
    return { outcome: "warn", exitCode: 10 };
  }
  return { outcome: "nominal", exitCode: 0 };
}

/**
 * Whether a `monitor` tick completed the live read (SPEC004 §3 / SPEC010 §3):
 * a block was read, no `rpc-client`/`rpc-read` check failed, AND the owner's
 * leverage is determinable when an owner is configured (blind ⇒ unassessed → 20).
 *
 * A failed `rpc-*` check (or undefined blockNumber) means the position was not
 * assessed → indeterminate. SPEC010 adds the blind gate: owner configured but
 * Morpho position unreadable must never resolve as warn(10) / "safe".
 */
export function isMonitorAssessed(
  readiness: Pick<
    LoopReadinessResult,
    "blockNumber" | "checks" | "ownerLeverageUndeterminable"
  >,
): boolean {
  if (readiness.blockNumber === undefined) {
    return false;
  }
  if (readiness.ownerLeverageUndeterminable === true) {
    return false;
  }
  return !readiness.checks.some(
    (check) =>
      (check.key === "rpc-client" || check.key === "rpc-read") && check.status === "fail",
  );
}
