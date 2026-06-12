import type { AlertEvaluation } from "../types/domain.js";
import type { LoopReadinessResult, ReadinessCheck } from "../loop/readiness.js";

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

export function evaluateReadinessAlerts(result: LoopReadinessResult): AlertEvaluation[] {
  const alerts: AlertEvaluation[] = [];

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
        "CRITICAL",
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
        "CRITICAL",
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
          "CRITICAL",
          "Configured LoopExecutor has no deployed bytecode.",
          "Replace the executor address with a real Base deployment.",
        ),
      );
    } else if (!result.executor.verified) {
      alerts.push(
        alert(
          "executor_config_mismatch",
          "CRITICAL",
          "Configured LoopExecutor runtime config does not match expected Base evidence.",
          "Stop deployment gating and investigate flashConfig()/protocolConfig() before proceeding.",
          {
            executor: result.executor.address,
          },
        ),
      );
    }
  }

  if (result.owner === undefined) {
    alerts.push(
      alert(
        "owner_missing",
        "WARN",
        "Owner is not configured for exit-readiness monitoring.",
        "Set position.owner or pass --owner once a funded owner position exists.",
      ),
    );
  } else {
    if (!result.owner.hasExitPosition) {
      alerts.push(
        alert(
          "owner_position_missing",
          "WARN",
          "Owner does not have an exit-ready Morpho position.",
          "Create or fund the owner position with wstDIEM collateral and DIEM debt before full-unwind evidence.",
          {
            owner: result.owner.address,
            collateralWstDiem: result.owner.collateralWstDiem.toString(),
            borrowedDiem: result.owner.borrowedDiem.toString(),
          },
        ),
      );
    }
    if (result.owner.executorAuthorized === false) {
      alerts.push(
        alert(
          "executor_not_authorized",
          "CRITICAL",
          "Owner has not authorized the LoopExecutor in Morpho.",
          "Have the owner submit Morpho setAuthorization(executor, true) before evidence collection.",
          {
            owner: result.owner.address,
          },
        ),
      );
    }
  }

  return alerts;
}
