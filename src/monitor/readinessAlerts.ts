import type { AlertEvaluation, ThresholdConfig } from "../types/domain.js";
import type { LoopReadinessResult, LeverageState, ReadinessCheck } from "../loop/readiness.js";

type HealthFactorThresholds = Pick<ThresholdConfig, "healthFactorWarn" | "healthFactorCritical">;

const DEFAULT_HEALTH_FACTOR_THRESHOLDS: HealthFactorThresholds = {
  healthFactorWarn: 1.6,
  healthFactorCritical: 1.4,
};

function alert(
  alertKey: string,
  level: AlertEvaluation["level"],
  message: string,
  suggestedAction: string,
  metrics: Record<string, unknown> = {},
): AlertEvaluation {
  return {
    alertKey,
    level,
    message,
    suggestedAction,
    cooldownSeconds: level === "CRITICAL" ? 5 * 60 : 30 * 60,
    metrics,
  };
}

function checkStatus(
  result: LoopReadinessResult,
  key: string,
): ReadinessCheck["status"] | undefined {
  return result.checks.find((check) => check.key === key)?.status;
}

/**
 * SPEC010 §4.B — leveraged-exit alerts are CRITICAL only when leverage is not
 * affirmatively unlevered. `unknown` keeps CRITICAL (no downgrade).
 */
function leveragedExitLevel(
  leverage: LeverageState,
  criticalLevel: "CRITICAL" = "CRITICAL",
): AlertEvaluation["level"] {
  return leverage === "unlevered" ? "WARN" : criticalLevel;
}

export function evaluateReadinessAlerts(
  result: LoopReadinessResult,
  thresholds: HealthFactorThresholds = DEFAULT_HEALTH_FACTOR_THRESHOLDS,
): AlertEvaluation[] {
  const alerts: AlertEvaluation[] = [];
  const leverage = result.leverage;
  // Prefer explicit result.ownerConfigured; fall back for partial test fixtures.
  const ownerConfigured = result.ownerConfigured === true;

  if (checkStatus(result, "rpc-client") === "fail" || checkStatus(result, "rpc-read") === "fail") {
    alerts.push(
      alert(
        "live_rpc_unavailable",
        "CRITICAL",
        "Live Base RPC reads are unavailable.",
        "Check BASE_RPC_URL and fallback RPC health.",
      ),
    );
  }

  if (result.curve !== undefined && !result.curve.liquid) {
    alerts.push(
      alert(
        "curve_liquidity_empty",
        leveragedExitLevel(leverage),
        "Curve DIEM/wstDIEM liquidity is not ready.",
        "Add DIEM and wstDIEM liquidity before any full-unwind evidence run.",
        {
          diemBalance: result.curve.diemBalance.toString(),
          wstDiemBalance: result.curve.wstDiemBalance.toString(),
          tvlDiem: result.curve.tvlDiem.toString(),
        },
      ),
    );
  }

  if (checkStatus(result, "vault") === "fail") {
    alerts.push(
      alert(
        "vault_not_ready",
        "CRITICAL",
        "wstDIEM vault tracking is not ready.",
        "Verify the configured InferenceVault address, DIEM asset, total supply, and NAV before proceeding.",
        result.vault === undefined
          ? {}
          : {
              vault: result.vault.address,
              asset: result.vault.asset,
              totalSupply: result.vault.totalSupply.toString(),
              totalAssets: result.vault.totalAssets.toString(),
              wstDiemNav: result.vault.wstDiemNav.toString(),
            },
      ),
    );
  }

  if (result.morpho !== undefined && result.morpho.totalSupplyAssets === 0n) {
    alerts.push(
      alert(
        "morpho_liquidity_empty",
        leveragedExitLevel(leverage),
        "Morpho DIEM market has no supply assets.",
        "Supply DIEM liquidity to the configured Morpho market before owner debt can exist.",
        {
          totalSupplyAssets: result.morpho.totalSupplyAssets.toString(),
          totalBorrowAssets: result.morpho.totalBorrowAssets.toString(),
        },
      ),
    );
  }

  if (checkStatus(result, "executor-config") === "fail") {
    if (result.executor === undefined) {
      alerts.push(
        alert(
          "executor_missing",
          "WARN",
          "LoopExecutor is not configured.",
          "Deploy or identify the audited LoopExecutor and set contracts.loopExecutor or --loop-executor.",
        ),
      );
    } else if (!result.executor.hasCode) {
      alerts.push(
        alert(
          "executor_no_code",
          leveragedExitLevel(leverage),
          "Configured LoopExecutor has no deployed bytecode.",
          "Replace the executor address with a real Base deployment.",
        ),
      );
    } else if (result.executor.readReverted === true) {
      // SPEC010 §4.F — mutually exclusive with executor_config_mismatch (pre-empts !verified).
      // WARN in all leverage states (config-identity, not a live danger).
      alerts.push(
        alert(
          "executor_read_reverted",
          "WARN",
          result.executor.reason ??
            "Configured LoopExecutor flash getters reverted (not a LoopExecutor).",
          "Point contracts.loopExecutor at a real LoopExecutor or leave it null until one is deployed.",
          {
            executor: result.executor.address,
            reason: result.executor.reason,
          },
        ),
      );
    } else if (!result.executor.verified) {
      alerts.push(
        alert(
          "executor_config_mismatch",
          leveragedExitLevel(leverage),
          "Configured LoopExecutor runtime config does not match expected Base evidence.",
          "Stop deployment gating and investigate flashConfig()/protocolConfig() before proceeding.",
          {
            executor: result.executor.address,
          },
        ),
      );
    }
  }

  // SPEC010 §4.F — owner_missing is config-gated, not result.owner-gated.
  if (!ownerConfigured) {
    alerts.push(
      alert(
        "owner_missing",
        "WARN",
        "Owner is not configured for exit-readiness monitoring.",
        "Set position.owner or pass --owner once a funded owner position exists.",
      ),
    );
  } else if (
    result.owner === undefined ||
    result.owner.borrowShares === null
  ) {
    // Configured but unreadable (full miss or partial Morpho miss) — never the
    // "not configured" copy. Blind ⇒ exit 20 is driven by ownerLeverageUndeterminable.
    alerts.push(
      alert(
        "owner_unreadable",
        "WARN",
        "Owner position could not be read.",
        "Verify Morpho marketId, RPC health, and the owner address; position safety is unassessed.",
        result.owner === undefined ? {} : { owner: result.owner.address },
      ),
    );
  } else {
    // Morpho position readable (borrowShares !== null).
    // SPEC010 §4.B/§4.F: suppress owner_position_missing when unlevered;
    // never evaluate it when borrowShares was null (handled above).
    if (leverage !== "unlevered" && result.owner.hasExitPosition === false) {
      alerts.push(
        alert(
          "owner_position_missing",
          "WARN",
          "Owner does not have an exit-ready Morpho position.",
          "Create or fund the owner position with wstDIEM collateral and DIEM debt before full-unwind evidence.",
          {
            owner: result.owner.address,
            collateralWstDiem: result.owner.collateralWstDiem?.toString() ?? null,
            borrowedDiem: result.owner.borrowedDiem?.toString() ?? null,
          },
        ),
      );
    }
    if (result.owner.executorAuthorized === false) {
      alerts.push(
        alert(
          "executor_not_authorized",
          leveragedExitLevel(leverage),
          "Owner has not authorized the LoopExecutor in Morpho.",
          "Have the owner submit Morpho setAuthorization(executor, true) before evidence collection.",
          {
            owner: result.owner.address,
          },
        ),
      );
    }
  }

  // SPEC005 §3 — live liquidation alerts, emitted only when `includeLiquidation`
  // populated `result.liquidation` (null on the `loop readiness` path → no alert).
  // A null `liquidationPriceDiemPerWstDiem` discriminates the §2 fault branch (the
  // price formula was never computed) from the §2 normal branch.
  const liquidation = result.liquidation;
  if (liquidation !== null) {
    const headroomPercent = (liquidation.debtGrowthHeadroomBps / 100).toFixed(2);
    if (liquidation.liquidationPriceDiemPerWstDiem === null) {
      // §3b — deterministic protocol fault; Morpho values collateral at ~0.
      alerts.push(
        alert(
          "position_liquidation_fault",
          "CRITICAL",
          `Position liquidation fault: Morpho values the collateral at ~0 (HF ${liquidation.healthFactor.toFixed(
            2,
          )}, debt-growth headroom ${headroomPercent}%). There is no automated protection — act out-of-band now.`,
          "Investigate the market oracle/LLTV or an underwater (bad-debt) position immediately; the tool cannot deleverage.",
          {
            healthFactor: liquidation.healthFactor,
            debtGrowthHeadroomBps: liquidation.debtGrowthHeadroomBps,
            oraclePriceDiemPerWstDiem:
              liquidation.oraclePriceDiemPerWstDiem === null
                ? null
                : liquidation.oraclePriceDiemPerWstDiem.toString(),
            lltvBps: liquidation.lltvBps,
          },
        ),
      );
    } else if (Number.isFinite(liquidation.healthFactor)) {
      // §3a — live position health factor (finite HF on the normal branch).
      const level =
        liquidation.healthFactor < thresholds.healthFactorCritical
          ? "CRITICAL"
          : liquidation.healthFactor < thresholds.healthFactorWarn
            ? "WARN"
            : null;
      if (level !== null) {
        alerts.push(
          alert(
            "position_health_factor",
            level,
            `Owner position health factor ${liquidation.healthFactor.toFixed(
              2,
            )} (debt-growth headroom ${headroomPercent}%) is below the ${
              level === "CRITICAL"
                ? thresholds.healthFactorCritical
                : thresholds.healthFactorWarn
            } ${level.toLowerCase()} line. There is no automated protection — act out-of-band now.`,
            "Reduce leverage out-of-band (repay DIEM debt or add wstDIEM collateral); the tool cannot deleverage.",
            {
              healthFactor: liquidation.healthFactor,
              debtGrowthHeadroomBps: liquidation.debtGrowthHeadroomBps,
              liquidationPriceDiemPerWstDiem: liquidation.liquidationPriceDiemPerWstDiem.toString(),
              oraclePriceDiemPerWstDiem:
                liquidation.oraclePriceDiemPerWstDiem === null
                  ? null
                  : liquidation.oraclePriceDiemPerWstDiem.toString(),
              lltvBps: liquidation.lltvBps,
            },
          ),
        );
      }
    }
  }

  return alerts;
}
