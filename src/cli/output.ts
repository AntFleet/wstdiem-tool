import Table from "cli-table3";
import type { AppConfig, CliJsonOutput, MetricSnapshot } from "../types/domain.js";
import { formatWad } from "../metrics/math.js";

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
    ["Vault", `NAV ${snapshot.navDisplay} (${snapshot.navSource}), total block ${snapshot.blockNumber}`],
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
