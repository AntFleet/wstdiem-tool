import type { AlertEvaluation, MetricSnapshot, ThresholdConfig } from "../types/domain.js";

function cooldown(minutes: number): number {
  return minutes * 60;
}

function daysAgoSeconds(days: number): number {
  return days * 24 * 60 * 60;
}

export function evaluateAlerts(
  metrics: MetricSnapshot,
  thresholds: ThresholdConfig,
  now = Math.floor(Date.now() / 1000),
): AlertEvaluation[] {
  const alerts: AlertEvaluation[] = [];

  if (metrics.validity.position && metrics.healthFactor < thresholds.healthFactorCritical) {
    alerts.push({
      alertKey: "health_factor",
      level: "CRITICAL",
      message: "HF below 1.40: immediate deleveraging required.",
      suggestedAction: "Trigger auto-deleverager or run `loop rebalance --target-leverage`.",
      cooldownSeconds: cooldown(5),
      metrics: { healthFactor: metrics.healthFactor },
    });
  } else if (metrics.validity.position && metrics.healthFactor < thresholds.healthFactorWarn) {
    alerts.push({
      alertKey: "health_factor",
      level: "WARN",
      message: "HF below 1.60: position nearing liquidation buffer.",
      suggestedAction: "Rebalance down to HF >= 1.7 or add collateral.",
      cooldownSeconds: cooldown(15),
      metrics: { healthFactor: metrics.healthFactor },
    });
  }

  if (
    metrics.validity.yieldWindow &&
    metrics.validity.morphoMarket &&
    metrics.netApy35 < thresholds.spreadCriticalNetApy35
  ) {
    alerts.push({
      alertKey: "spread_compression",
      level: "CRITICAL",
      message: "3.5x net APY below 8%. Carry no longer compensates risk.",
      suggestedAction: "Deleverage to target HF 1.7.",
      cooldownSeconds: cooldown(15),
      metrics: { netApy35: metrics.netApy35 },
    });
  } else if (
    metrics.validity.yieldWindow &&
    metrics.validity.morphoMarket &&
    metrics.netApy35 < thresholds.spreadWarnNetApy35
  ) {
    alerts.push({
      alertKey: "spread_compression",
      level: "WARN",
      message: "3.5x net APY below 15%. Loop carry is compressed.",
      suggestedAction: "Stop adding leverage; consider partial unwind.",
      cooldownSeconds: 60 * 60,
      metrics: { netApy35: metrics.netApy35 },
    });
  }

  if (
    metrics.validity.position &&
    metrics.validity.curve &&
    metrics.positionSizeVsCurveDepth > thresholds.curveDepthCritical
  ) {
    alerts.push({
      alertKey: "curve_depth",
      level: "CRITICAL",
      message: "Position exceeds 20% of Curve depth.",
      suggestedAction: "Do not open/increase; unwind only with strict simulation.",
      cooldownSeconds: cooldown(10),
      metrics: { positionSizeVsCurveDepth: metrics.positionSizeVsCurveDepth },
    });
  } else if (
    metrics.validity.position &&
    metrics.validity.curve &&
    metrics.positionSizeVsCurveDepth > thresholds.curveDepthWarn
  ) {
    alerts.push({
      alertKey: "curve_depth",
      level: "WARN",
      message: "Position exceeds 15% of Curve depth.",
      suggestedAction: "Reduce target leverage or split execution.",
      cooldownSeconds: cooldown(30),
      metrics: { positionSizeVsCurveDepth: metrics.positionSizeVsCurveDepth },
    });
  }

  if (metrics.validity.harvestHistory && metrics.lastHarvestAt !== null) {
    const harvestAge = now - metrics.lastHarvestAt;
    if (harvestAge > daysAgoSeconds(thresholds.harvestSilenceCriticalDays)) {
      alerts.push({
        alertKey: "harvest_silence",
        level: "CRITICAL",
        message: "No harvest observed for more than 14 days.",
        suggestedAction: "Escalate to protocol ops; APY assumptions stale.",
        cooldownSeconds: 6 * 60 * 60,
        metrics: { harvestAgeSeconds: harvestAge },
      });
    } else if (harvestAge > daysAgoSeconds(thresholds.harvestSilenceWarnDays)) {
      alerts.push({
        alertKey: "harvest_silence",
        level: "WARN",
        message: "No harvest observed for more than 7 days.",
        suggestedAction: "Check FeeRouter pending balances and keeper health.",
        cooldownSeconds: 12 * 60 * 60,
        metrics: { harvestAgeSeconds: harvestAge },
      });
    }
  }

  if (metrics.validity.oracle && metrics.oracleDeviation > thresholds.oracleDeviationCritical) {
    alerts.push({
      alertKey: "oracle_deviation",
      level: "CRITICAL",
      message: "Morpho oracle differs from computed NAV by more than 1%.",
      suggestedAction: "Disable loop txs; verify oracle contract and vault accounting.",
      cooldownSeconds: cooldown(5),
      metrics: { oracleDeviation: metrics.oracleDeviation },
    });
  }

  if (
    metrics.validity.yieldWindow &&
    metrics.validity.morphoMarket &&
    metrics.borrowRate > thresholds.borrowSpikeBaseApyRatio * metrics.baseApy
  ) {
    alerts.push({
      alertKey: "borrow_spike",
      level: "WARN",
      message: "Borrow rate exceeds 70% of base APY.",
      suggestedAction: "Avoid new leverage; monitor utilization.",
      cooldownSeconds: cooldown(30),
      metrics: { borrowRate: metrics.borrowRate, baseApy: metrics.baseApy },
    });
  }

  if (metrics.validity.rpcFreshness && metrics.latestBlockAgeSeconds > 60) {
    alerts.push({
      alertKey: "rpc_stale",
      level: "WARN",
      message: "RPC appears stale.",
      suggestedAction: "Fail over to fallback RPC.",
      cooldownSeconds: cooldown(5),
      metrics: { latestBlockAgeSeconds: metrics.latestBlockAgeSeconds },
    });
  }

  return alerts;
}
