import Table from "cli-table3";
import type { AlertEvaluation, AppConfig, CliJsonOutput, MetricSnapshot } from "../types/domain.js";
import { formatWad } from "../metrics/math.js";
import type { LoopBriefResult } from "../loop/brief.js";
import type { LoopCapacityResult } from "../loop/capacity.js";
import type { LoopBasisResult } from "../metrics/basis.js";
import type { LoopDemandResult } from "../metrics/demand.js";
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
        // SPEC005 §5 — status/watch never read the position (validity.position is
        // always false here), so the unpopulated Infinity default is a false safety
        // signal. Display-only honesty fix; no position/oracle read added.
        !snapshot.validity.position
          ? "n/a (run monitor)"
          : Number.isFinite(snapshot.healthFactor)
            ? snapshot.healthFactor.toFixed(2)
            : "Infinity"
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
    [
      // SPEC005 §7 — headline liquidation row: HF + debt-growth headroom only.
      // Liquidation price + NAV caveat live in the detailed/--json view (OQ-B).
      "Liquidation",
      result.liquidation === null
        ? "n/a (no borrow)"
        : `HF ${
            Number.isFinite(result.liquidation.healthFactor)
              ? result.liquidation.healthFactor.toFixed(2)
              : "Infinity"
          }; debt-growth headroom ${(result.liquidation.debtGrowthHeadroomBps / 100).toFixed(2)}%`,
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
  // SPEC005 §6/§7/OQ-B — liquidation price + NAV-appreciating caveat surface in the
  // detailed monitor view only (not the headline row), on the normal (priced) branch.
  const liquidation = result.liquidation;
  if (liquidation !== null && liquidation.liquidationPriceDiemPerWstDiem !== null) {
    const oracleNow =
      liquidation.oraclePriceDiemPerWstDiem === null
        ? "n/a"
        : `${formatWad(liquidation.oraclePriceDiemPerWstDiem)} DIEM/wstDIEM`;
    const detailTable = new Table({ head: ["Liquidation detail", "Value"], wordWrap: true });
    detailTable.push(
      [
        "Liquidation price",
        `${formatWad(liquidation.liquidationPriceDiemPerWstDiem)} DIEM/wstDIEM (oracle now ${oracleNow}; LLTV ${(
          liquidation.lltvBps / 100
        ).toFixed(2)}%)`,
      ],
      [
        "Caveat",
        "wstDIEM is NAV-appreciating: an oracle decline to the liquidation price implies a vault/oracle fault, not ordinary volatility. The primary live liquidation path is debt accrual — see debt-growth headroom, not this price.",
      ],
    );
    return `${renderLoopReadinessTable(result)}\n${alertTable.toString()}\n${detailTable.toString()}`;
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

function formatSignedWad(value: bigint): string {
  if (value < 0n) {
    return `-${formatWad(-value)}`;
  }
  if (value > 0n) {
    return `+${formatWad(value)}`;
  }
  return formatWad(0n);
}

function formatHealthFactor(healthFactorBps: number | null): string {
  return healthFactorBps === null ? "Infinity" : (healthFactorBps / 10_000).toFixed(2);
}

// A DIEM shortfall that may be the number sentinel `Infinity` (the unclearable-slippage-depth case,
// SPEC002 rev-3 E1) rather than a bigint wei amount.
function formatShortfallDiem(value: bigint | number): string {
  if (typeof value === "number") {
    return Number.isFinite(value) ? `${formatWad(BigInt(Math.trunc(value)))} DIEM` : "Infinity";
  }
  return `${formatWad(value)} DIEM`;
}

/**
 * The `firstBlocker`'s distance-to-clear plus the structural liquidation margin (SPEC002 rev-3 E1/E2).
 * For a slippage block it surfaces the DIEM leg depth that clears the exit-slippage cap; for a Morpho
 * block the supply gap; for a net-APY block the yield gap. `structuralMarginToLiquidationBps` is always
 * shown so blocked/near-edge rows read "how far to liquidation" at a glance.
 */
function loopShortfallCell(result: LoopSizingResult): string {
  const parts: string[] = [];
  switch (result.firstBlocker) {
    case "curve_liquidity_insufficient":
      parts.push(`+${formatShortfallDiem(result.curveDiemLegSlippageShortfallDiem)} leg (exit slip)`);
      break;
    case "morpho_supply_insufficient":
      parts.push(`+${formatWad(result.morphoSupplyShortfallDiem)} DIEM supply`);
      break;
    case "net_apy_below_threshold":
      parts.push(`+${formatBps(result.netApyShortfallBps)} net APY`);
      break;
    default:
      break;
  }
  parts.push(
    `margin-to-liq ${
      result.structuralMarginToLiquidationBps === null
        ? "n/a"
        : formatBps(result.structuralMarginToLiquidationBps)
    }`,
  );
  return parts.join("; ");
}

/**
 * The rendered verdict token. When `authoritative` is false (a degraded chain seed,
 * SPEC003 §6) the token itself degrades — a `candidate` reads `candidate — unverified seed`
 * at the same glance as the verdict — while the underlying gate status is untouched. The
 * demotion is now carried by the `— unverified seed` suffix + the `UNVERIFIED SEED` banner
 * + `authoritative:false` (SPEC002 rev-3 E5: same root token, no fourth status term).
 */
function loopStatusToken(result: LoopSizingResult, authoritative: boolean | undefined): string {
  if (authoritative === false && result.status === "candidate") {
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
      "Shortfall/Margin-to-liq",
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
      loopShortfallCell(result),
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
      `${report.summary.candidate} candidate, ${report.summary.marginal} marginal, ${report.summary.blocked} blocked of ${report.summary.total} (candidate = clears all gates)`,
    ],
    [
      "First candidate by leverage",
      report.summary.firstCandidateByLeverage.length === 0
        ? "none"
        : report.summary.firstCandidateByLeverage
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
  );
  if (
    provenance.curveDiemLegDiem !== undefined &&
    provenance.curveWstDiemLegDiem !== undefined
  ) {
    seedTable.push([
      "Curve legs",
      `DIEM ${formatWad(provenance.curveDiemLegDiem)} / wstDIEM ${formatWad(
        provenance.curveWstDiemLegDiem,
      )} DIEM; exit slippage via live get_dy quote`,
    ]);
    if (provenance.curveImbalanceRatio !== undefined) {
      seedTable.push([
        "Curve imbalance",
        Number.isFinite(provenance.curveImbalanceRatio)
          ? `${provenance.curveImbalanceRatio.toFixed(2)}:1`
          : "∞:1 (a leg is empty)",
      ]);
    }
  }
  // Part B-2 vault-APY provenance (SPEC003 §4.3/§6). Present only when a store was supplied;
  // a `not-seeded` row (with the `authoritative:false` banner above) reads at the same glance
  // as the verdict that the vault APY is the default/grid, not a chain-measured value.
  if (provenance.vaultApySource !== undefined) {
    seedTable.push([
      "vaultApy",
      provenance.vaultApySource === "measured-7d"
        ? "measured-7d"
        : "not-seeded (using default/grid)",
    ]);
  }
  seedTable.push(
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

function capacityInputModeToken(mode: LoopCapacityResult["inputMode"]): string {
  switch (mode) {
    case "from-chain":
      return "CHAIN-SEEDED";
    case "explicit-flags":
      return "EXPLICIT FLAGS";
    case "offline-defaults":
      return "OFFLINE DEFAULTS";
  }
}

function bindingConstraintGloss(constraint: LoopCapacityResult["bindingConstraint"]): string {
  switch (constraint) {
    case "morpho-util-headroom":
      return "util-capped Morpho borrow headroom (not raw unborrowed)";
    case "health-factor":
      return "structural at this leverage; reduce leverage, not equity";
    case "marginal-band":
      return "near hard gates";
    case "unbounded-in-search-window":
      return "≥ maxProbe; not a market capacity claim";
    case "net-apy":
      return "often sensitive to vault-APY assumption";
    case "curve-exit-slippage":
      return "exit slippage over cap";
    case "curve-depth":
      return "curve depth share";
    case "unwind":
      return "unwind not covered";
    case "scenario-invalid":
      return "scenario invalid";
  }
}

/**
 * Human capacity table (SPEC006 §4). Banner above the number; "gates clear up to" lexicon.
 * Must never contain "deploy up to".
 */
export function renderLoopCapacityTable(result: LoopCapacityResult): string {
  const mode = capacityInputModeToken(result.inputMode);
  const offlineBanner =
    result.inputMode === "offline-defaults" ? "OFFLINE DEFAULTS — not live capacity\n" : "";
  const lev = formatLeverage(result.targetLeverageBps);

  let headline: string;
  if (result.bindingConstraint === "unbounded-in-search-window") {
    headline = `Gates clear up to ≥ ${formatWad(result.capacityEquityDiem)} DIEM equity @ ${lev} (notional ${formatWad(result.capacityNotionalDiem)} DIEM; search window — not a market limit). Not a deploy recommendation.`;
  } else if (result.capacityEquityDiem === 0n) {
    headline = `Gates clear up to 0 DIEM equity @ ${lev} (notional 0). Next: ${result.capacityStatus} via ${result.bindingConstraint}. Not a deploy recommendation.`;
  } else {
    const nextStatus = result.bindingEdge?.status ?? "non-candidate";
    headline = `Gates clear up to ${formatWad(result.capacityEquityDiem)} DIEM equity @ ${lev} (notional ${formatWad(result.capacityNotionalDiem)} DIEM). Next: ${nextStatus} via ${result.bindingConstraint}. Not a deploy recommendation.`;
  }
  if (result.search.truncated) {
    headline += " search truncated.";
  }

  const banner = `${offlineBanner}[${mode}] ${result.disclaimer}\n${headline}`;

  const table = new Table({
    head: ["Metric", "Value"],
    wordWrap: true,
  });
  table.push(
    ["Input mode", result.inputMode],
    ["Target leverage", lev],
    [
      "Capacity equity (last-candidate)",
      result.bindingConstraint === "unbounded-in-search-window"
        ? `≥ ${formatWad(result.capacityEquityDiem)} DIEM`
        : `${formatWad(result.capacityEquityDiem)} DIEM`,
    ],
    ["Capacity notional (last-candidate)", `${formatWad(result.capacityNotionalDiem)} DIEM`],
    ["Capacity status", result.capacityStatus],
    [
      "Binding constraint",
      `${result.bindingConstraint} — ${bindingConstraintGloss(result.bindingConstraint)}`,
    ],
    [
      "Headroom to hard block (includes marginal — riskier)",
      result.headroomToBlockEquityDiem === result.capacityEquityDiem
        ? `${formatWad(result.headroomToBlockEquityDiem)} DIEM (same as capacity)`
        : `${formatWad(result.headroomToBlockEquityDiem)} DIEM equity / ${formatWad(result.headroomToBlockNotionalDiem)} DIEM notional`,
    ],
    ["Morpho raw unborrowed (info)", `${formatWad(result.morphoRawAvailableDiem)} DIEM`],
    [
      "Util-capped borrow headroom (gate)",
      `${formatWad(result.availableMorphoBorrowDiem)} DIEM`,
    ],
    [
      "Search",
      `probes ${result.search.probes}, get_dy ${result.search.getDyQuotes}, resolution ${formatWad(result.search.resolutionDiem)} DIEM${result.search.truncated ? ", truncated" : ""}`,
    ],
    ["Authoritative", result.authoritative ? "yes" : "no"],
    ["Warnings", result.warnings.length === 0 ? "none" : result.warnings.join("; ")],
    [
      "Marginal reasons",
      result.marginalReasons.length === 0 ? "none" : result.marginalReasons.join("; "),
    ],
  );

  if (result.bindingEdge !== null) {
    table.push(
      ["morphoSupplyShortfallDiem", formatShortfallDiem(result.bindingEdge.morphoSupplyShortfallDiem)],
      [
        "curveDiemLegSlippageShortfallDiem",
        formatShortfallDiem(result.bindingEdge.curveDiemLegSlippageShortfallDiem),
      ],
      ["exitSlippageExcessBps", formatBps(result.bindingEdge.exitSlippageExcessBps)],
      ["netApyShortfallBps", formatBps(result.bindingEdge.netApyShortfallBps)],
    );
  }

  return `${banner}\n${table.toString()}`;
}

/**
 * Human brief: capacity rows + net APY grid + deltas (SPEC006 §3).
 * First run deltas render as n/a, never 0.
 */
export function renderLoopBrief(result: LoopBriefResult): string {
  const lines: string[] = [];
  const mode = capacityInputModeToken(result.current.inputMode);
  if (result.current.inputMode === "offline-defaults") {
    lines.push("OFFLINE DEFAULTS — not live capacity");
  }
  lines.push(`[${mode}] ${result.disclaimer}`);
  lines.push(
    `template ${result.current.templateFingerprint.slice(0, 12)}… · persistable ${result.current.persistable ? "yes" : "no"} · authoritative ${result.authoritative ? "yes" : "no"}`,
  );

  const capTable = new Table({
    head: ["Leverage", "Capacity equity", "Notional", "Status", "Binding", "Δ equity"],
    wordWrap: true,
  });
  for (const cap of result.capacities) {
    const snap = result.current.capacities.find(
      (row) => row.targetLeverageBps === cap.targetLeverageBps,
    );
    const deltaRow = result.deltas?.perLeverage.find(
      (row) => row.targetLeverageBps === cap.targetLeverageBps,
    );
    let deltaCell = "n/a";
    if (result.deltas !== null && deltaRow !== undefined) {
      deltaCell =
        deltaRow.capacityEquityDiem === null
          ? "n/a"
          : `${formatSignedWad(BigInt(deltaRow.capacityEquityDiem))} DIEM`;
    }
    const equityLabel =
      cap.bindingConstraint === "unbounded-in-search-window"
        ? `≥ ${formatWad(cap.capacityEquityDiem)} DIEM`
        : `${formatWad(cap.capacityEquityDiem)} DIEM`;
    capTable.push([
      formatLeverage(cap.targetLeverageBps),
      equityLabel,
      `${formatWad(cap.capacityNotionalDiem)} DIEM`,
      snap?.capacityStatus ?? cap.capacityStatus,
      cap.bindingConstraint,
      deltaCell,
    ]);
  }
  lines.push(capTable.toString());

  const apyTable = new Table({
    head: ["Leverage", "Equity", "Net APY", "Stressed net APY", "Status", "Δ net APY"],
    wordWrap: true,
  });
  for (const row of result.netApyGrid) {
    const deltaRow = result.deltas?.perLeverage.find(
      (d) => d.targetLeverageBps === row.scenario.targetLeverageBps,
    );
    const deltaApy =
      result.deltas === null
        ? "n/a"
        : deltaRow?.netApyBps === null || deltaRow?.netApyBps === undefined
          ? "n/a"
          : formatBps(deltaRow.netApyBps);
    apyTable.push([
      formatLeverage(row.scenario.targetLeverageBps),
      `${formatWad(row.equityDiem)} DIEM`,
      formatBps(row.netApyBps),
      formatBps(row.netApyStressedBps),
      row.status,
      deltaApy,
    ]);
  }
  lines.push(apyTable.toString());

  const deltaTable = new Table({
    head: ["Delta", "Value"],
    wordWrap: true,
  });
  if (result.previous === null || result.deltas === null) {
    deltaTable.push(
      ["Previous comparable run", "n/a"],
      ["Δ rateAtTarget", "n/a"],
      ["Δ vault APY", "n/a"],
      ["Δ morpho raw available", "n/a"],
      ["Δ curve DIEM leg", "n/a"],
    );
  } else {
    deltaTable.push(
      [
        "Previous comparable run",
        `ts ${result.previous.timestamp} fingerprint ${result.previous.templateFingerprint.slice(0, 12)}…`,
      ],
      [
        "Δ rateAtTarget",
        result.deltas.rateAtTargetApyBps === null
          ? "n/a"
          : `${result.deltas.rateAtTargetApyBps} bps`,
      ],
      [
        "Δ vault APY",
        result.deltas.vaultApyBps === null ? "n/a" : `${result.deltas.vaultApyBps} bps`,
      ],
      [
        "Δ morpho raw available",
        result.deltas.morphoRawAvailableDiem === null
          ? "n/a"
          : `${formatSignedWad(BigInt(result.deltas.morphoRawAvailableDiem))} DIEM`,
      ],
      [
        "Δ curve DIEM leg",
        result.deltas.curveDiemLegDiem === null
          ? "n/a"
          : `${formatSignedWad(BigInt(result.deltas.curveDiemLegDiem))} DIEM`,
      ],
    );
  }
  lines.push(deltaTable.toString());

  if (result.warnings.length > 0) {
    lines.push(`Warnings: ${result.warnings.join("; ")}`);
  }

  return lines.join("\n");
}

/**
 * SPEC008 demand proxy table. Banner above numbers; columns never bare "Demand".
 */
export function renderLoopDemandTable(result: LoopDemandResult): string {
  const configuredHours = result.windowSeconds / 3600;
  const noise =
    result.windowSeconds <= 48 * 3600 ? " short-window-noisy." : "";
  const banner =
    `${result.disclaimer}\n` +
    `[${result.sampleSource}] NAV-ratchet yield velocity (demand proxy) · configured ${configuredHours}h · ` +
    `authoritative ${result.authoritative ? "yes" : "no"}.${noise}\n` +
    result.pasteLine;

  const fmtVel = (bps: number | null): string =>
    bps === null ? "n/a" : `${bps} bps ann.`;
  const fmtGrowth = (bps: number | null): string =>
    bps === null ? "n/a" : `${bps} bps`;

  const table = new Table({
    head: ["Metric", "Value"],
    wordWrap: true,
  });
  const observedH =
    result.current.spanSeconds === null
      ? "n/a"
      : `${Math.round(result.current.spanSeconds / 3600)}h observed`;
  table.push(
    ["NAV velocity (proxy) bps", `${fmtVel(result.current.velocityBps)} @ ${observedH} (configured ${configuredHours}h)`],
    ["Window growth (non-annualized)", fmtGrowth(result.current.windowGrowthBps)],
    ["Prior velocity (proxy) bps", fmtVel(result.prior.velocityBps)],
    [
      "Acceleration (proxy)",
      result.accelerationBps === null
        ? "n/a"
        : `${result.accelerationBps} bps${result.accelerationGloss ? ` (${result.accelerationGloss})` : ""}`,
    ],
    ["Current window status", `${result.current.status} · samples ${result.current.sampleCount}`],
    ["Prior window status", `${result.prior.status} · samples ${result.prior.sampleCount}`],
    [
      "Reference 7d velocity",
      result.reference7d.status === "ok"
        ? fmtVel(result.reference7d.velocityBps)
        : `n/a (${result.reference7d.status})`,
    ],
    [
      "NAV start → end (current)",
      result.current.navStart === null || result.current.navEnd === null
        ? "n/a"
        : `${formatWad(BigInt(result.current.navStart))} → ${formatWad(BigInt(result.current.navEnd))}`,
    ],
    [
      "Credit inflow (FeeRouter→vault; not NAV rate; not AskSurplus volume)",
      result.creditInflowDiemCurrent === null
        ? "n/a"
        : `${formatWad(BigInt(result.creditInflowDiemCurrent))} DIEM`,
    ],
    ["Warnings", result.warnings.length === 0 ? "none" : result.warnings.join("; ")],
  );

  const ban = ["deploy up to", "AskSurplus demand is", "demand is up", "size larger", "demand collapsed"];
  const out = `${banner}\n${table.toString()}`;
  for (const phrase of ban) {
    if (out.toLowerCase().includes(phrase.toLowerCase())) {
      // Defensive: never ship banned solicitation/overclaim copy.
      throw new Error(`renderLoopDemandTable produced banned phrase: ${phrase}`);
    }
  }
  return out;
}

/**
 * SPEC007 secondary-market basis table. Banner above number; dual framing; ban-list guard.
 */
export function renderLoopBasisTable(result: LoopBasisResult): string {
  const banner =
    "Secondary-market basis (market vs NAV) — decision-support only. " +
    "Discount can be stress/illiquidity or edge; tool cannot tell which. " +
    "Morpho oracle is not market price. OPERATOR-SUPPLIED MARKET PRICE in v1 — not a live feed; may be stale.\n" +
    `${result.disclaimer}\n` +
    result.pasteLine;

  const table = new Table({
    head: ["Metric", "Value"],
    wordWrap: true,
  });
  const fmtPrice = (s: string | null): string =>
    s === null ? "n/a" : `${formatWad(BigInt(s))} DIEM/wstDIEM`;
  const basisCell =
    result.basisBps === null
      ? "n/a"
      : `${result.basisBps} bps (signed)` +
        (result.basisGloss ? ` · ${result.basisGloss}` : "");
  table.push(
    ["Market price", `${fmtPrice(result.marketPriceDiemPerWstDiem)} (${result.marketPriceSource})`],
    ["NAV", `${fmtPrice(result.nav)} (${result.navSource})`],
    ["NAV totals cross-check", fmtPrice(result.navTotals)],
    ["Basis (market vs NAV)", basisCell],
    [
      "Human gloss",
      result.basisBps === null
        ? "n/a"
        : result.basisBps < 0
          ? "discount — stress/illiquidity and possible edge; tool cannot tell which"
          : result.basisBps > 0
            ? "premium — secondary prints above NAV"
            : "flat at NAV",
    ],
    [
      "Alerts",
      result.alerts.length === 0
        ? "none"
        : result.alerts.map((a) => `${a.level} ${a.alertKey}`).join("; "),
    ],
    ["Arithmetic complete", result.arithmeticComplete ? "yes" : "no"],
    ["Authoritative (v1 always false)", "no"],
    ["Block", result.blockNumber ?? "n/a"],
    ["Warnings", result.warnings.length === 0 ? "none" : result.warnings.join("; ")],
  );

  const ban = [
    "free money",
    "risk-free discount",
    "arbitrage guaranteed",
    "buy now",
    "buy the discount",
    "deploy into the discount",
    "oracle price is market",
  ];
  const out = `${banner}\n${table.toString()}`;
  for (const phrase of ban) {
    if (out.toLowerCase().includes(phrase.toLowerCase())) {
      throw new Error(`renderLoopBasisTable produced banned phrase: ${phrase}`);
    }
  }
  return out;
}
