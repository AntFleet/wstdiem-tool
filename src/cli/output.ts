import Table from "cli-table3";
import type { AlertEvaluation, AppConfig, CliJsonOutput, MetricSnapshot } from "../types/domain.js";
import { formatWad } from "../metrics/math.js";
import type { LoopReadinessResult } from "../loop/readiness.js";
import type { LoopSizingReport, LoopSizingResult } from "../loop/sizing.js";

export function stringifyJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, entry) => {
      if (typeof entry === "bigint") {
        return entry.toString();
      }
      if (typeof entry === "number" && !Number.isFinite(entry)) {
        return entry > 0 ? "Infinity" : "-Infinity";
      }
      return entry;
    },
    2,
  );
}

export function jsonEnvelope<T>(
  config: Pick<AppConfig, "chainId">,
  command: string,
  data: T,
  blockNumber?: bigint,
): CliJsonOutput<T> {
  return {
    ok: true,
    command,
    chainId: config.chainId,
    blockNumber: blockNumber?.toString(),
    data,
  };
}

export function printJson(value: unknown): void {
  console.log(stringifyJson(value));
}

export function renderStatusTable(snapshot: MetricSnapshot, readiness: string[]): string {
  const table = new Table({
    head: ["Row", "Values"],
    wordWrap: true,
  });
  table.push(
    [
      "Vault",
      `NAV ${snapshot.navDisplay} (${snapshot.navSource}), total block ${snapshot.blockNumber}`,
    ],
    [
      "Yield",
      `baseAPY ${(snapshot.baseApy * 100).toFixed(2)}%, netAPY(3.5x) ${(
        snapshot.netApy35 * 100
      ).toFixed(2)}%, spread ${(snapshot.spreadScore * 100).toFixed(2)}%`,
    ],
    [
      "Morpho",
      `utilization ${(snapshot.utilization * 100).toFixed(2)}%, borrowRate ${(
        snapshot.borrowRate * 100
      ).toFixed(2)}%, HF ${
        Number.isFinite(snapshot.healthFactor) ? snapshot.healthFactor.toFixed(2) : "Infinity"
      }`,
    ],
    [
      "Curve",
      `TVL ${formatWad(snapshot.curveTvlDiem)} DIEM, position/depth ${
        Number.isFinite(snapshot.positionSizeVsCurveDepth)
          ? `${(snapshot.positionSizeVsCurveDepth * 100).toFixed(2)}%`
          : "unavailable"
      }`,
    ],
    ["Risk", `oracleDeviation ${(snapshot.oracleDeviation * 100).toFixed(2)}%`],
    ["Readiness", readiness.length === 0 ? "ready" : readiness.join("; ")],
  );
  return table.toString();
}

export function renderLoopReadinessTable(result: LoopReadinessResult): string {
  const table = new Table({
    head: ["Area", "Status"],
    wordWrap: true,
  });
  table.push(
    [
      "Overall",
      `${result.status}; broadcast ${result.broadcastAvailable ? "available" : "disabled"}; audit required ${result.auditRequired}`,
    ],
    [
      "Vault",
      result.vault === undefined
        ? "unavailable"
        : `${result.vault.address}; asset ${result.vault.asset ?? "unavailable"}; supply ${formatWad(
            result.vault.totalSupply,
          )} wstDIEM; assets ${formatWad(result.vault.totalAssets)} DIEM; NAV ${formatWad(
            result.vault.wstDiemNav,
          )} DIEM`,
    ],
    [
      "Curve",
      result.curve === undefined
        ? "unavailable"
        : `DIEM ${formatWad(result.curve.diemBalance)}, wstDIEM ${formatWad(result.curve.wstDiemBalance)}, TVL ${formatWad(result.curve.tvlDiem)} DIEM`,
    ],
    [
      "Morpho",
      result.morpho === undefined
        ? "unavailable"
        : `supply ${formatWad(result.morpho.totalSupplyAssets)} DIEM, borrow ${formatWad(result.morpho.totalBorrowAssets)} DIEM`,
    ],
    [
      "Executor",
      result.executor === undefined
        ? "unavailable"
        : `${result.executor.address}; code ${result.executor.hasCode ? "yes" : "no"}; config ${
            result.executor.verified ? "verified" : "not verified"
          }`,
    ],
    [
      "Owner",
      result.owner === undefined
        ? "unavailable"
        : `${result.owner.address}; collateral ${formatWad(result.owner.collateralWstDiem)} wstDIEM, debt ${formatWad(
            result.owner.borrowedDiem,
          )} DIEM, authorized ${result.owner.executorAuthorized === true ? "yes" : "no"}`,
    ],
    ["Checks", result.checks.map((entry) => `${entry.key}:${entry.status}`).join("; ")],
    ["Blockers", result.blockers.length === 0 ? "none" : result.blockers.join("; ")],
  );
  return table.toString();
}

export function renderMonitorDashboard(
  result: LoopReadinessResult,
  alerts: AlertEvaluation[],
  delivered: string[] = [],
): string {
  const alertTable = new Table({
    head: ["Alert", "Status"],
    wordWrap: true,
  });
  if (alerts.length === 0) {
    alertTable.push(["Alerts", "none"]);
  } else {
    for (const alert of alerts) {
      alertTable.push([
        `${alert.level} ${alert.alertKey}`,
        `${alert.message} ${alert.suggestedAction}`,
      ]);
    }
  }
  if (delivered.length > 0) {
    alertTable.push(["Delivery", delivered.join("; ")]);
  }
  return `${renderLoopReadinessTable(result)}\n${alertTable.toString()}`;
}

function formatBps(value: number): string {
  if (!Number.isFinite(value)) {
    return "unavailable";
  }
  return `${(value / 100).toFixed(2)}%`;
}

function formatLeverage(targetLeverageBps: number): string {
  return `${(targetLeverageBps / 10_000).toFixed(2)}x`;
}

function formatHealthFactor(healthFactorBps: number | null): string {
  return healthFactorBps === null ? "Infinity" : (healthFactorBps / 10_000).toFixed(2);
}

/**
 * The rendered verdict token. When `authoritative` is false (a degraded chain seed,
 * SPEC003 §6) the token itself degrades — a `viable` reads `candidate — unverified seed`
 * at the same glance as the verdict — while the underlying gate status is untouched.
 */
function loopStatusToken(result: LoopSizingResult, authoritative: boolean | undefined): string {
  if (authoritative === false && result.status === "viable") {
    return "candidate — unverified seed";
  }
  if (authoritative === false && result.status === "marginal") {
    return "marginal — unverified seed";
  }
  return `${result.status}${result.firstBlocker === null ? "" : `: ${result.firstBlocker}`}`;
}

export function renderLoopSizingTable(report: LoopSizingReport): string {
  const table = new Table({
    head: [
      "Scenario",
      "Lev",
      "Equity",
      "Borrow",
      "Curve req/actual",
      "Morpho req/actual",
      "Slip entry/exit",
      "HF",
      "Util→Borrow APR",
      "Net APY",
      "Status",
    ],
    wordWrap: true,
  });
  for (const result of report.results) {
    const curveTotalDiem = result.scenario.curveDiemLegDiem + result.scenario.curveWstDiemLegDiem;
    const verdict = loopStatusToken(result, report.authoritative);
    const statusCell =
      result.warnings.length === 0 ? verdict : `${verdict} [${result.warnings.join("; ")}]`;
    table.push([
      result.scenario.id,
      formatLeverage(result.scenario.targetLeverageBps),
      `${formatWad(result.equityDiem)} DIEM`,
      `${formatWad(result.borrowAmountDiem)} DIEM`,
      `${formatWad(result.requiredCurveDepthDiem)}/${formatWad(curveTotalDiem)} DIEM (D ${formatWad(
        result.scenario.curveDiemLegDiem,
      )}/W ${formatWad(result.scenario.curveWstDiemLegDiem)})`,
      `${formatWad(result.requiredMorphoSupplyDiem)}/${formatWad(result.scenario.morphoSupplyDiem)} DIEM`,
      `${formatBps(result.estimatedEntrySlippageBps)}/${formatBps(result.exitSlippageBps)} (${result.exitSlippageSource})`,
      formatHealthFactor(result.healthFactorBps),
      `${formatBps(result.postDrawUtilizationBps)}→${formatBps(result.effectiveBorrowApyBps)}`,
      formatBps(result.netApyBps),
      statusCell,
    ]);
  }

  const summaryTable = new Table({
    head: ["Summary", "Value"],
    wordWrap: true,
  });
  summaryTable.push(
    [
      "Totals",
      `${report.summary.viable} viable, ${report.summary.marginal} marginal, ${report.summary.blocked} blocked of ${report.summary.total}`,
    ],
    [
      "First viable by leverage",
      report.summary.firstViableByLeverage.length === 0
        ? "none"
        : report.summary.firstViableByLeverage
            .map(
              (entry) =>
                `${formatLeverage(entry.targetLeverageBps)}: curve ${formatWad(
                  entry.requiredCurveDepthDiem,
                )} DIEM, Morpho ${formatWad(entry.requiredMorphoSupplyDiem)} DIEM (${entry.status})`,
            )
            .join("; "),
    ],
    [
      "Borrow model",
      report.assumptions.borrowRateModel === "flat"
        ? "flat: borrow APY used as given"
        : report.results[0]
          ? `adaptive-curve: rateAtTarget curve = ${formatBps(
              report.results[0].borrowAprAtTargetBps,
            )} @90% util, ${formatBps(report.results[0].borrowAprAtFullUtilizationBps)} @100% util`
          : "adaptive-curve",
    ],
    [
      "Read-only",
      `broadcast ${report.assumptions.broadcastAvailable ? "available" : "disabled"}; audit required ${report.assumptions.auditRequired}`,
    ],
  );

  if (report.seedProvenance === undefined) {
    return `${table.toString()}\n${summaryTable.toString()}`;
  }

  const provenance = report.seedProvenance;
  const seedTable = new Table({
    head: ["Seed provenance", "Value"],
    wordWrap: true,
  });
  seedTable.push(
    ["Source", `seeded from block ${provenance.blockNumber} (chainId ${provenance.chainId})`],
    [
      "Fields",
      Object.entries(provenance.seededFields)
        .map(([field, source]) => `${field}:${source}`)
        .join("; "),
    ],
    ["rateAtTarget", provenance.rateAtTargetSource],
    [
      "Authoritative",
      provenance.authoritative
        ? "yes"
        : "no — verdicts shown as unverified candidates",
    ],
    ["Warnings", provenance.warnings.length === 0 ? "none" : provenance.warnings.join("; ")],
  );
  const banner = provenance.authoritative
    ? ""
    : "UNVERIFIED SEED: chain-seeded verdicts are candidates, not authoritative (see seed provenance)\n";
  return `${banner}${table.toString()}\n${summaryTable.toString()}\n${seedTable.toString()}`;
}
