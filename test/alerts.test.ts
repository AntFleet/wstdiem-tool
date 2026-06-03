import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { evaluateAlerts } from "../src/alerts/evaluate.js";
import { makeEmptySnapshot } from "../src/metrics/math.js";

describe("SPEC001 alert thresholds", () => {
  it("emits health factor critical before warning", () => {
    const snapshot = {
      ...makeEmptySnapshot(),
      validity: { ...makeEmptySnapshot().validity, position: true },
      healthFactor: 1.39,
    };
    const alerts = evaluateAlerts(snapshot, DEFAULT_CONFIG.thresholds);
    expect(alerts.find((alert) => alert.alertKey === "health_factor")?.level).toBe("CRITICAL");
  });

  it("emits spread compression and Curve depth alerts", () => {
    const snapshot = {
      ...makeEmptySnapshot(),
      validity: { ...makeEmptySnapshot().validity, yieldWindow: true, morphoMarket: true, position: true, curve: true },
      netApy35: 0.1,
      positionSizeVsCurveDepth: 0.16,
    };
    const alerts = evaluateAlerts(snapshot, DEFAULT_CONFIG.thresholds);
    expect(alerts.map((alert) => `${alert.alertKey}:${alert.level}`)).toContain(
      "spread_compression:WARN",
    );
    expect(alerts.map((alert) => `${alert.alertKey}:${alert.level}`)).toContain("curve_depth:WARN");
  });

  it("emits oracle, borrow spike, harvest silence, and stale RPC alerts", () => {
    const now = 1_800_000_000;
    const snapshot = {
      ...makeEmptySnapshot(now),
      validity: {
        ...makeEmptySnapshot().validity,
        yieldWindow: true,
        morphoMarket: true,
        oracle: true,
        rpcFreshness: true,
        harvestHistory: true,
      },
      baseApy: 0.1,
      borrowRate: 0.08,
      oracleDeviation: 0.02,
      latestBlockAgeSeconds: 61,
      lastHarvestAt: now - 15 * 24 * 60 * 60,
    };
    const keys = evaluateAlerts(snapshot, DEFAULT_CONFIG.thresholds, now).map(
      (alert) => `${alert.alertKey}:${alert.level}`,
    );
    expect(keys).toContain("oracle_deviation:CRITICAL");
    expect(keys).toContain("borrow_spike:WARN");
    expect(keys).toContain("harvest_silence:CRITICAL");
    expect(keys).toContain("rpc_stale:WARN");
  });

  it("suppresses strategy risk alerts when metrics are placeholder-only", () => {
    const alerts = evaluateAlerts(makeEmptySnapshot(), DEFAULT_CONFIG.thresholds);
    expect(alerts).toEqual([]);
  });
});
