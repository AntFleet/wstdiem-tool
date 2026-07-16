import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { parseDecimalToUnits } from "../src/metrics/math.js";

const execFileAsync = promisify(execFile);

function offlineEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BASE_RPC_URL;
  delete env.BASE_RPC_URL_FALLBACK_1;
  delete env.BASE_RPC_URL_FALLBACK_2;
  return env;
}

describe("compiled CLI loop sizing", () => {
  beforeAll(async () => {
    await execFileAsync("npm", ["run", "build"]);
  }, 60_000);

  it("runs offline with JSON output and expands scenario grids", async () => {
    const result = await execFileAsync(
      "node",
      [
        "dist/cli/index.js",
        "loop",
        "sizing",
        "--json",
        "--initial-diem",
        "100",
        "--target-leverage",
        "2,3",
        "--curve-depth-diem",
        "0,1000",
        "--morpho-supply-diem",
        "0,1000",
        "--vault-apy-bps",
        "1500",
        "--borrow-apy-bps",
        "800",
      ],
      { env: offlineEnv() },
    );
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      data: {
        assumptions: {
          readOnly: boolean;
          broadcastAvailable: boolean;
          auditRequired: boolean;
        };
        summary: {
          total: number;
          blocked: number;
        };
        results: Array<{
          scenario: {
            initialCollateralDiem: string;
            curveDiemLegDiem: string;
            curveWstDiemLegDiem: string;
          };
          firstBlocker: string | null;
          borrowAmountDiem: string;
        }>;
      };
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("loop sizing");
    expect(parsed.data.assumptions).toMatchObject({
      readOnly: true,
      broadcastAvailable: false,
      auditRequired: true,
    });
    expect(parsed.data.summary.total).toBe(8);
    expect(parsed.data.summary.blocked).toBe(8);
    expect(parsed.data.results[0].scenario.initialCollateralDiem).toBe("100000000000000000000");
    // --curve-depth-diem 0 splits into balanced legs of 0/0 (SPEC002 rev-2 R1).
    expect(parsed.data.results[0].scenario.curveDiemLegDiem).toBe("0");
    expect(parsed.data.results[0].scenario.curveWstDiemLegDiem).toBe("0");
    expect(parsed.data.results[0].firstBlocker).toBe("curve_liquidity_insufficient");
    expect(parsed.data.results[0].borrowAmountDiem).toBe("100000000000000000000");
  }, 15_000);

  // SPEC002 rev-2 R1/R3 flags, verified end-to-end through commander (guards against a future
  // flag-name/camelCase-field typo that unit tests passing object fields would not catch).
  it("wires --curve-diem-leg / --curve-wstdiem-leg / --gas-cost-diem through commander", async () => {
    const result = await execFileAsync(
      "node",
      [
        "dist/cli/index.js",
        "loop",
        "sizing",
        "--json",
        "--initial-diem",
        "100",
        "--target-leverage",
        "1.5",
        "--curve-diem-leg",
        "20000",
        "--curve-wstdiem-leg",
        "5000",
        "--gas-cost-diem",
        "3",
        "--morpho-supply-diem",
        "1000",
        "--vault-apy-bps",
        "1500",
        "--rate-at-target-apy-bps",
        "400",
      ],
      { env: offlineEnv() },
    );
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      data: {
        summary: { total: number };
        results: Array<{
          scenario: {
            curveDiemLegDiem: string;
            curveWstDiemLegDiem: string;
            gasCostDiem: string;
          };
        }>;
      };
    };

    expect(parsed.ok).toBe(true);
    // Single point on every dimension -> exactly one scenario (no leg Cartesian blow-up).
    expect(parsed.data.summary.total).toBe(1);
    const scenario = parsed.data.results[0].scenario;
    // The two independent leg flags land on their own fields (not swapped, not merged).
    expect(scenario.curveDiemLegDiem).toBe(parseDecimalToUnits("20000").toString());
    expect(scenario.curveWstDiemLegDiem).toBe(parseDecimalToUnits("5000").toString());
    // --gas-cost-diem propagates as a single wei-denominated value.
    expect(scenario.gasCostDiem).toBe(parseDecimalToUnits("3").toString());
  }, 15_000);

  it("--compact renders the narrow share view (decision columns only)", async () => {
    const result = await execFileAsync(
      "node",
      [
        "dist/cli/index.js",
        "loop",
        "sizing",
        "--initial-diem",
        "50",
        "--curve-depth-diem",
        "20000",
        "--morpho-supply-diem",
        "500",
        "--rate-at-target-apy-bps",
        "217",
        "--vault-apy-bps",
        "1200",
        "--target-leverage",
        "1.5,2,2.5",
        "--min-health-factor",
        "1.7",
        "--compact",
      ],
      { env: offlineEnv() },
    );
    const out = result.stdout;
    // Compact decision columns present.
    for (const header of ["Lev", "Net APY", "HF", "Margin→liq", "Verdict"]) {
      expect(out).toContain(header);
    }
    // The wide-table-only columns are gone — proving this is the compact view, not the full readout.
    expect(out).not.toContain("Scenario");
    expect(out).not.toContain("Curve req/actual");
    expect(out).not.toContain("Morpho req/actual");
    // Verdicts across the tiers, including the short blocker tag.
    expect(out).toContain("candidate");
    expect(out).toContain("marginal");
    expect(out).toContain("blocked (HF)");
    // Self-explanatory footer (modeled assumptions + read-only rigor).
    expect(out).toContain("modeled:");
    expect(out).toContain("borrow 2.17% @target");
    expect(out).toContain("read-only");
    // Funded scenario (curve 20000 + morpho 500) → the pool claim is truthful here.
    expect(out).toContain("funded curve+morpho pool");
  }, 15_000);

  it("--compact does NOT claim a funded pool when depth is zero (honesty guard)", async () => {
    const result = await execFileAsync(
      "node",
      [
        "dist/cli/index.js",
        "loop",
        "sizing",
        "--initial-diem",
        "100",
        "--target-leverage",
        "2",
        "--curve-depth-diem",
        "0",
        "--morpho-supply-diem",
        "0",
        "--compact",
      ],
      { env: offlineEnv() },
    );
    // The row is blocked precisely because the pool is empty; the footer must not assert it is funded.
    expect(result.stdout).not.toContain("funded curve+morpho pool");
    expect(result.stdout).toContain("modeled:");
  }, 15_000);

  it("without --compact still renders the full risk table (additive flag)", async () => {
    const result = await execFileAsync(
      "node",
      [
        "dist/cli/index.js",
        "loop",
        "sizing",
        "--initial-diem",
        "50",
        "--curve-depth-diem",
        "20000",
        "--morpho-supply-diem",
        "500",
        "--target-leverage",
        "1.5",
      ],
      { env: offlineEnv() },
    );
    // The full renderer keeps its wide columns when --compact is absent.
    expect(result.stdout).toContain("Curve req/actual");
    expect(result.stdout).toContain("Scenario");
  }, 15_000);
});
