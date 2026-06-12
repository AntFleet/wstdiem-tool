import { describe, expect, it } from "vitest";
import { evaluateReadinessAlerts } from "../src/monitor/readinessAlerts.js";
import type { LoopReadinessResult } from "../src/loop/readiness.js";

const owner = "0x0000000000000000000000000000000000000009" as const;
const executor = "0x0000000000000000000000000000000000000004" as const;

function baseResult(): LoopReadinessResult {
  return {
    status: "blocked",
    blockNumber: 123n,
    checks: [
      {
        key: "audit-gate",
        status: "fail",
        message: "broadcast remains disabled until production executor audit/review is complete",
      },
    ],
    blockers: ["broadcast disabled pending production executor audit/review"],
    vault: {
      address: "0xe49FA849cB37b0e7A42B2335e333fb99474167ba",
      asset: "0xF4d97F2da56e8c3098f3a8D538DB630A2606a024",
      totalSupply: 1n,
      totalAssets: 1n,
      wstDiemNav: 1n,
      hasCode: true,
      assetMatchesDiem: true,
      hasSupply: true,
    },
    curve: {
      diemBalance: 1n,
      wstDiemBalance: 1n,
      wstDiemNav: 1n,
      tvlDiem: 2n,
      liquid: true,
    },
    morpho: {
      totalSupplyAssets: 1n,
      totalBorrowAssets: 1n,
      totalBorrowShares: 1n,
      empty: false,
    },
    executor: {
      address: executor,
      hasCode: true,
      verified: true,
    },
    owner: {
      address: owner,
      collateralWstDiem: 1n,
      borrowShares: 1n,
      borrowedDiem: 1n,
      hasExitPosition: true,
      executorAuthorized: true,
    },
    broadcastAvailable: false,
    auditRequired: true,
  };
}

describe("monitor readiness alerts", () => {
  it("does not alert when only the production audit gate is blocking", () => {
    expect(evaluateReadinessAlerts(baseResult())).toEqual([]);
  });

  it("alerts on zero Curve and Morpho liquidity plus missing owner/executor", () => {
    const result: LoopReadinessResult = {
      ...baseResult(),
      checks: [
        {
          key: "curve-liquidity",
          status: "fail",
          message: "Curve DIEM/wstDIEM liquidity is not ready",
        },
        {
          key: "morpho-market-liquidity",
          status: "fail",
          message: "Morpho market has no DIEM supply assets",
        },
        { key: "executor-config", status: "fail", message: "loopExecutor is not configured" },
        {
          key: "owner-position",
          status: "skip",
          message: "owner not configured; position readiness not checked",
        },
        ...baseResult().checks,
      ],
      curve: {
        ...baseResult().curve!,
        diemBalance: 0n,
        wstDiemBalance: 0n,
        tvlDiem: 0n,
        liquid: false,
      },
      morpho: {
        ...baseResult().morpho!,
        totalSupplyAssets: 0n,
        totalBorrowAssets: 0n,
        totalBorrowShares: 0n,
        empty: true,
      },
      executor: undefined,
      owner: undefined,
    };

    expect(
      evaluateReadinessAlerts(result).map((alert) => `${alert.alertKey}:${alert.level}`),
    ).toEqual([
      "curve_liquidity_empty:CRITICAL",
      "morpho_liquidity_empty:CRITICAL",
      "executor_missing:WARN",
      "owner_missing:WARN",
    ]);
  });

  it("alerts when a configured executor address has no code", () => {
    const result: LoopReadinessResult = {
      ...baseResult(),
      checks: [
        { key: "executor-config", status: "fail", message: "loopExecutor has no deployed code" },
      ],
      executor: {
        address: executor,
        hasCode: false,
        verified: false,
      },
    };

    expect(evaluateReadinessAlerts(result).map((alert) => alert.alertKey)).toEqual([
      "executor_no_code",
    ]);
  });

  it("alerts when vault tracking is not ready", () => {
    const result: LoopReadinessResult = {
      ...baseResult(),
      checks: [
        {
          key: "vault",
          status: "fail",
          message: "wstDIEM vault asset, supply, or NAV is not ready",
        },
      ],
      vault: {
        ...baseResult().vault!,
        totalSupply: 0n,
        totalAssets: 0n,
        wstDiemNav: 0n,
        hasSupply: false,
      },
    };

    expect(evaluateReadinessAlerts(result).map((alert) => alert.alertKey)).toEqual([
      "vault_not_ready",
    ]);
  });
});
