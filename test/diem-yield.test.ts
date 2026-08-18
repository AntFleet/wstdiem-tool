import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { renderDiemYieldTable } from "../src/cli/output.js";
import { CliError } from "../src/cli/errors.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildLoopDemand } from "../src/metrics/demand.js";
import { WAD } from "../src/metrics/math.js";
import {
  buildDiemYield,
  DEFAULT_DIEM_YIELD_WINDOW_HOURS,
  DIEM_YIELD_BANNER,
  isLeftoverSeedError,
  veniceCreditPrimary,
} from "../src/metrics/diemYield.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sample(ts: number, nav: bigint) {
  return { timestamp: ts, nav, totalAssetsDiem: 10n ** 20n };
}

function okDemand(now = 10_000_000, hours = 552) {
  const W = hours * 3600;
  return buildLoopDemand({
    samples: [
      sample(now - W, WAD),
      sample(now, WAD + 10n ** 15n),
    ],
    nowSeconds: now,
    windowSeconds: W,
  });
}

describe("SPEC011 diem yield", () => {
  it("AC1/15: four rows; audit footer only when vault ok; no Δ", () => {
    const result = buildDiemYield({
      windowHours: 552,
      diemAmount: 1,
      demand: okDemand(),
      loop: {
        kind: "leftover",
        message:
          "Morpho market not currently enterable as of block 1: supply 0.000520023189765570 DIEM, borrow 0.000520023189765570 DIEM (below this tool's 0.001 DIEM minimum probe). Curve depth was not read. Point-in-time seed, not a forecast, not advice.",
        extras: { dustFloorWei: "1000000000000000" },
      },
      marketed: { claim: "7-12% APR", source: "@_proxystudio 2026-08-18" },
    });
    expect(result.banner).toBe(DIEM_YIELD_BANNER);
    expect(result.rows).toHaveLength(4);
    expect(result.rows.map((r) => r.id)).toEqual(["hold", "venice", "vault", "loop"]);
    expect(result.audit).not.toBeNull();
    expect(result.audit?.tier).toBe("MARKETED");
    expect(result.audit?.line).toContain("marketed 7-12% APR (external");
    expect(result.audit?.line).toContain("vs realized");
    expect(result.audit?.line).not.toMatch(/delta/i);
    expect(result.audit?.line).not.toContain("Δ");
    expect(result.rows[2]?.tier).toBe("MEASURED");
    expect(result.rows[2]?.primary).toContain("REALIZED NAV growth");
    expect(result.rows[3]?.tier).toBe("UNAVAILABLE");
    expect(result.notAdvice).toBe(true);
    expect(JSON.stringify(result)).not.toContain("depositFeeBps");
  });

  it("AC3: vault not-ok → n/a, no audit, no 7-12 in vault cell", () => {
    const demand = buildLoopDemand({
      samples: [sample(9_000_000, WAD)],
      nowSeconds: 10_000_000,
      windowSeconds: 552 * 3600,
    });
    const result = buildDiemYield({
      windowHours: 552,
      diemAmount: 1,
      demand,
      loop: { kind: "unavailable", reason: "UNAVAILABLE: no realized window to seed vault APY" },
      marketed: { claim: "7-12% APR", source: "@_proxystudio 2026-08-18" },
    });
    expect(result.rows[2]?.tier).toBe("UNAVAILABLE");
    expect(result.rows[2]?.primary).toMatch(/^n\/a/);
    expect(result.rows[2]?.primary).not.toMatch(/7[-–]12/);
    expect(result.audit).toBeNull();
  });

  it("AC4: venice both poles; --diem-usd adds upper-bound on same primary", () => {
    expect(veniceCreditPrimary()).toContain("if spent");
    expect(veniceCreditPrimary()).toContain("$0 token yield if unused");
    const priced = veniceCreditPrimary(1400);
    expect(priced).toContain("upper-bound");
    expect(priced).toContain("only if fully used");
    expect(priced).toContain("%");
  });

  it("leftover detector requires dustFloorWei", () => {
    expect(
      isLeftoverSeedError(
        new CliError("FROM_CHAIN_SEED_BLOCKED", "rpc down"),
      ),
    ).toBe(false);
    expect(
      isLeftoverSeedError(
        new CliError("FROM_CHAIN_SEED_BLOCKED", "leftover", undefined, {
          dustFloorWei: "1000000000000000",
        }),
      ),
    ).toBe(true);
  });

  it("AC8/13/14: human render banner first, 23d/552h, no superlatives", () => {
    const result = buildDiemYield({
      windowHours: 552,
      diemAmount: 1,
      demand: okDemand(),
      loop: {
        kind: "leftover",
        message: "Morpho market not currently enterable as of block 1: leftover",
        extras: {},
      },
      marketed: { claim: "7-12% APR", source: "@_proxystudio 2026-08-18" },
    });
    const human = renderDiemYieldTable(result);
    expect(human.split("\n")[0]).toBe(DIEM_YIELD_BANNER);
    expect(human).toContain("552h");
    expect(human).toContain("23d");
    expect(human.toLowerCase()).not.toContain("opportunity");
    expect(human.toLowerCase()).not.toMatch(/\bbest\b/);
    expect(human.toLowerCase()).not.toContain("winner");
    const h840 = renderDiemYieldTable({ ...result, windowHours: 840 });
    expect(h840).toContain("840h");
    expect(h840).toContain("35d");
  });

  it("AC17: default marketed config is 7-12, not 21/56", () => {
    expect(DEFAULT_CONFIG.diemYield.historicalMarketed).toBe(false);
    expect(DEFAULT_CONFIG.diemYield.marketedClaim).toBe("7-12% APR");
    expect(DEFAULT_CONFIG.diemYield.marketedClaim).not.toContain("21");
    expect(DEFAULT_CONFIG.diemYield.marketedClaim).not.toContain("56");
  });

  it("AC9: --diem 10 does not change vault percent in compose", () => {
    const demand = okDemand();
    const a = buildDiemYield({
      windowHours: 552,
      diemAmount: 1,
      demand,
      loop: { kind: "unavailable", reason: "x" },
      marketed: { claim: "7-12% APR", source: "s" },
    });
    const b = buildDiemYield({
      windowHours: 552,
      diemAmount: 10,
      demand,
      loop: { kind: "unavailable", reason: "x" },
      marketed: { claim: "7-12% APR", source: "s" },
    });
    expect(a.rows[2]?.primary).toBe(b.rows[2]?.primary);
  });

  it("AC7/12/18: CLI rejects 72; help is route comparison; default 552", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wstdiem-diem-yield-"));
    dirs.push(dir);
    const dbPath = join(dir, "t.sqlite");
    const configPath = join(dir, "c.yaml");
    writeFileSync(
      configPath,
      `chainId: 8453\nrpc:\n  primaryUrl: null\nstorage:\n  sqlitePath: ${dbPath}\n`,
    );
    const env = { ...process.env };
    delete env.BASE_RPC_URL;
    delete env.BASE_RPC_URL_FALLBACK_1;
    delete env.BASE_RPC_URL_FALLBACK_2;

    const help = await execFileAsync(
      "node",
      ["dist/cli/index.js", "diem", "yield", "--help"],
      { env, cwd: process.cwd() },
    );
    expect(help.stdout.toLowerCase()).toContain("route comparison");
    expect(help.stdout.toLowerCase()).toContain("not advice");
    expect(help.stdout).toContain("23d=552");
    expect(help.stdout).toContain("35d=840");
    expect(help.stdout.toLowerCase()).not.toContain("opportunity");
    expect(help.stdout.toLowerCase()).not.toContain("finder");
    expect(help.stdout).not.toMatch(/7-12/);

    await expect(
      execFileAsync(
        "node",
        ["dist/cli/index.js", "--config", configPath, "diem", "yield", "--window-hours", "72"],
        { env, cwd: process.cwd() },
      ),
    ).rejects.toMatchObject({ code: 1 });

    expect(DEFAULT_DIEM_YIELD_WINDOW_HOURS).toBe(552);
  }, 30_000);
});
