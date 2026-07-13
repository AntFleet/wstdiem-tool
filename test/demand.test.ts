import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { stringifyJson } from "../src/cli/output.js";
import {
  buildLoopDemand,
  computeDemandWindow,
  countDemandSamples,
  DEFAULT_VELOCITY_WINDOW_HOURS,
  isValidNavSample,
  MIN_SPAN_SECONDS,
  navGrowthFraction,
  type NavSample,
} from "../src/metrics/demand.js";
import { WAD } from "../src/metrics/math.js";
import { Storage } from "../src/storage/sqlite.js";
import { makeEmptySnapshot } from "../src/metrics/math.js";

const execFileAsync = promisify(execFile);

function sample(ts: number, nav: bigint, assets = 10n ** 20n): NavSample {
  return { timestamp: ts, nav, totalAssetsDiem: assets };
}

describe("SPEC008 demand velocity", () => {
  it("AC1: worked anchor 1.00→1.001 over 86400s → windowGrowth 10, velocity 3650", () => {
    const start = 1_000_000;
    const samples = [
      sample(start, 10n ** 18n),
      sample(start + 86_400, 10n ** 18n + 10n ** 15n), // 1.001e18
    ];
    const w = computeDemandWindow(samples, start, start + 86_400);
    expect(w.status).toBe("ok");
    expect(w.windowGrowthBps).toBe(10);
    expect(w.velocityBps).toBe(3650);
  });

  it("AC2: acceleration current 3650 − prior 2000 = 1650", () => {
    // Build series where prior and current windows produce known rates via span=86400.
    // prior: t0→t1 growth for ~2000 bps ann; current: t1→t2 for 3650.
    // velocity = growth * 365 for 1d span → growth_bps_ann = growth*10000*365
    // For 2000 bps: growth = 2000/10000/365 = 0.000547945...
    // Simpler: use buildLoopDemand with synthetic points at exact endpoints.
    const now = 2_000_000;
    const W = 86_400;
    const nav0 = 10n ** 18n;
    // prior span 1d, growth such that velocityBps=2000 → growth = 2000/1e4/365
    const gPrior = 2000 / 10_000 / 365;
    const nav1 = nav0 + BigInt(Math.round(gPrior * Number(nav0)));
    const gCurr = 3650 / 10_000 / 365;
    const nav2 = nav1 + BigInt(Math.round(gCurr * Number(nav1)));
    const samples = [
      sample(now - 2 * W, nav0),
      sample(now - W, nav1),
      sample(now, nav2),
    ];
    const result = buildLoopDemand({
      samples,
      nowSeconds: now,
      windowSeconds: W,
    });
    expect(result.current.status).toBe("ok");
    expect(result.prior.status).toBe("ok");
    expect(result.accelerationBps).not.toBeNull();
    // Allow small rounding on float growth construction
    expect(Math.abs((result.accelerationBps as number) - 1650)).toBeLessThan(30);
    expect(result.accelerationGloss).toBe("accelerating-proxy");
  });

  it("AC3: insufficient samples → null velocity", () => {
    const w = computeDemandWindow([sample(100, WAD)], 0, 100_000);
    // only anchor, no endpoint after → insufficient-samples
    expect(w.velocityBps).toBeNull();
    expect(["insufficient-samples", "no-anchor", "span-too-short"]).toContain(w.status);
  });

  it("AC4: no anchor → no-anchor", () => {
    const w = computeDemandWindow([sample(5000, WAD * 2n)], 0, 1000);
    expect(w.status).toBe("no-anchor");
    expect(w.velocityBps).toBeNull();
  });

  it("AC5: deposit doubles assets/supply style NAV flat → velocity ~0 (not totalAssets)", () => {
    // NAV flat while "assets" double — demand uses NAV only.
    const start = 1000;
    const samples = [
      sample(start, WAD, 100n * WAD),
      sample(start + 86_400, WAD, 200n * WAD), // assets doubled, nav flat
    ];
    const w = computeDemandWindow(samples, start, start + 86_400);
    expect(w.status).toBe("ok");
    expect(w.velocityBps).toBe(0);
    expect(w.windowGrowthBps).toBe(0);
  });

  it("AC6: negative NAV move → negative velocity", () => {
    const start = 1000;
    const samples = [
      sample(start, WAD + 10n ** 15n),
      sample(start + 86_400, WAD),
    ];
    const w = computeDemandWindow(samples, start, start + 86_400);
    expect(w.status).toBe("ok");
    expect(w.velocityBps).toBeLessThan(0);
    expect(w.windowGrowthBps).toBeLessThan(0);
  });

  it("AC7: prior missing → accelerationBps null not 0", () => {
    const now = 1_000_000;
    const W = 72 * 3600;
    const samples = [
      sample(now - W, WAD),
      sample(now, WAD + 10n ** 15n),
    ];
    const result = buildLoopDemand({ samples, nowSeconds: now, windowSeconds: W });
    // prior has no anchor before priorStart
    expect(result.prior.status).not.toBe("ok");
    expect(result.accelerationBps).toBeNull();
  });

  it("AC8: JSON honesty fields; bigint nav as strings; no outcome/exitCode", () => {
    const now = 1_000_000;
    const W = 72 * 3600;
    const samples = [
      sample(now - 2 * W, WAD),
      sample(now - W, WAD + 10n ** 14n),
      sample(now, WAD + 2n * 10n ** 14n),
    ];
    const result = buildLoopDemand({ samples, nowSeconds: now, windowSeconds: W });
    const json = JSON.parse(stringifyJson(result));
    expect(json.decisionSupportOnly).toBe(true);
    expect(json.notAYieldPromise).toBe(true);
    expect(json.demandKind).toBe("nav-ratchet-yield-velocity-proxy");
    expect(json.pasteLine).toContain("not AskSurplus demand");
    expect(json.headlineLabel).toBe("nav-ratchet-yield-velocity-bps-annualized-proxy");
    expect(json.outcome).toBeUndefined();
    expect(json.exitCode).toBeUndefined();
    if (json.current.navStart !== null) {
      expect(typeof json.current.navStart).toBe("string");
    }
  });

  it("AC13: ok + zero velocity → flat-nav-not-zero-demand warning", () => {
    const now = 1_000_000;
    const W = 72 * 3600;
    const samples = [
      sample(now - 2 * W, WAD),
      sample(now - W, WAD),
      sample(now, WAD),
    ];
    const result = buildLoopDemand({
      samples,
      nowSeconds: now,
      windowSeconds: W,
      creditSamples: [],
    });
    expect(result.current.status).toBe("ok");
    expect(result.current.velocityBps).toBe(0);
    expect(result.warnings.some((w) => w.startsWith("flat-nav-not-zero-demand"))).toBe(true);
  });

  it("AC14: window ≤48h → authoritative false + short-window-noisy", () => {
    const now = 1_000_000;
    const W = 24 * 3600;
    const samples = [
      sample(now - 2 * W, WAD),
      sample(now - W, WAD + 10n ** 14n),
      sample(now, WAD + 2n * 10n ** 14n),
    ];
    const result = buildLoopDemand({ samples, nowSeconds: now, windowSeconds: W });
    expect(result.authoritative).toBe(false);
    expect(result.warnings).toContain("short-window-noisy");
  });

  it("AC15: polluted tip (assets 0, nav WAD) is invalid", () => {
    expect(isValidNavSample({ timestamp: 1, nav: WAD, totalAssetsDiem: 0n })).toBe(false);
    expect(isValidNavSample({ timestamp: 1, nav: WAD, totalAssetsDiem: 10n ** 20n })).toBe(true);
  });

  it("AC16: span < 3600 → span-too-short", () => {
    const start = 1000;
    const samples = [sample(start, WAD), sample(start + 100, WAD + 10n ** 12n)];
    const w = computeDemandWindow(samples, start, start + 100);
    expect(w.status).toBe("span-too-short");
    expect(w.velocityBps).toBeNull();
    expect(MIN_SPAN_SECONDS).toBe(3600);
  });

  it("AC21: pre-start anchor + one in-window point, span ≥3600 → density ≥2 can be ok", () => {
    const start = 10_000;
    const end = start + 7200;
    const samples = [sample(start - 3600, WAD), sample(end, WAD + 10n ** 14n)];
    expect(countDemandSamples(samples, start, end)).toBe(2);
    const w = computeDemandWindow(samples, start, end);
    expect(w.status).toBe("ok");
  });

  it("AC22: short observed span vs configured 72h → not authoritative; paste has observed hours", () => {
    const now = 1_000_000;
    const W = 72 * 3600;
    // Only 2h of observed span inside the window (but >= MIN_SPAN)
    const samples = [
      sample(now - 2 * W - 100, WAD), // prior anchor
      sample(now - W - 100, WAD + 10n ** 12n),
      sample(now - 7200, WAD + 10n ** 12n), // current start-ish
      sample(now, WAD + 2n * 10n ** 12n),
    ];
    const result = buildLoopDemand({ samples, nowSeconds: now, windowSeconds: W });
    if (result.current.status === "ok" && result.current.spanSeconds !== null) {
      if (result.current.spanSeconds < 24 * 3600) {
        expect(result.authoritative).toBe(false);
      }
      expect(result.pasteLine).toMatch(/observed \d+h span/);
      expect(result.pasteLine).toContain("configured window 72h");
    }
  });

  it("AC23: flat velocity does not demote authoritative when spans pass", () => {
    const now = 1_000_000;
    const W = 72 * 3600;
    const samples = [
      sample(now - 2 * W, WAD),
      sample(now - W, WAD),
      sample(now, WAD),
    ];
    const result = buildLoopDemand({ samples, nowSeconds: now, windowSeconds: W });
    expect(result.current.velocityBps).toBe(0);
    // Both windows flat with full 72h span → authoritative (flat does not demote)
    expect(result.authoritative).toBe(true);
  });

  it("navGrowthFraction uses bigint delta path", () => {
    expect(navGrowthFraction(10n ** 18n, 10n ** 18n + 10n ** 15n)).toBeCloseTo(0.001, 9);
    expect(navGrowthFraction(10n ** 18n + 10n ** 15n, 10n ** 18n)).toBeCloseTo(-0.000999, 5);
  });

  it("listNavSamplesForWindow does not double-count exact windowStart", () => {
    const dir = mkdtempSync(join(tmpdir(), "wstdiem-demand-"));
    const dbPath = join(dir, "t.sqlite");
    try {
      const store = new Storage(dbPath);
      const snap = makeEmptySnapshot(1000);
      snap.nav = WAD;
      snap.vaultTotalAssetsDiem = 10n ** 20n;
      snap.timestamp = 1000;
      store.insertMetricSnapshot(snap);
      const snap2 = makeEmptySnapshot(2000);
      snap2.nav = WAD + 1n;
      snap2.vaultTotalAssetsDiem = 10n ** 20n;
      snap2.timestamp = 2000;
      store.insertMetricSnapshot(snap2);
      const list = store.listNavSamplesForWindow(1000);
      // anchor at 1000 + row after 1000 → 2 unique; not 3
      expect(list.length).toBe(2);
      expect(list.filter((r) => r.timestamp === 1000).length).toBe(1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("listNavSamplesForWindow skips dirty empty tip and keeps earlier valid anchor", () => {
    const dir = mkdtempSync(join(tmpdir(), "wstdiem-demand-dirty-"));
    const dbPath = join(dir, "t.sqlite");
    try {
      const store = new Storage(dbPath);
      const good = makeEmptySnapshot(900);
      good.nav = WAD + 10n ** 15n;
      good.vaultTotalAssetsDiem = 10n ** 20n;
      good.timestamp = 900;
      store.insertMetricSnapshot(good);
      // Failed watch tick at lookbackStart: nav=WAD default, assets=0
      const dirty = makeEmptySnapshot(1000);
      dirty.nav = WAD;
      dirty.vaultTotalAssetsDiem = 0n;
      dirty.timestamp = 1000;
      store.insertMetricSnapshot(dirty);
      const list = store.listNavSamplesForWindow(1000);
      expect(list.some((r) => r.timestamp === 1000)).toBe(false);
      expect(list.some((r) => r.timestamp === 900 && r.nav === WAD + 10n ** 15n)).toBe(true);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("AC20: default window hours is 72", () => {
    expect(DEFAULT_VELOCITY_WINDOW_HOURS).toBe(72);
  });
});

describe("SPEC008 loop demand CLI", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function offlineEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.BASE_RPC_URL;
    delete env.BASE_RPC_URL_FALLBACK_1;
    delete env.BASE_RPC_URL_FALLBACK_2;
    return env;
  }

  it(
    "AC9/AC10: empty DB exit 0 with n/a; invalid window-hours exit 1",
    async () => {
    const dir = mkdtempSync(join(tmpdir(), "wstdiem-demand-cli-"));
    dirs.push(dir);
    const dbPath = join(dir, "t.sqlite");
    const configPath = join(dir, "c.yaml");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      configPath,
      `chainId: 8453\nrpc:\n  primaryUrl: null\nstorage:\n  sqlitePath: ${dbPath}\n`,
    );

    // dist must already be built by CI/local gates; do not rebuild inside the test (race + timeout).
    const ok = await execFileAsync(
      "node",
      ["dist/cli/index.js", "--config", configPath, "loop", "demand", "--json"],
      { env: offlineEnv(), cwd: process.cwd() },
    );
    const envelope = JSON.parse(ok.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.current.velocityBps).toBeNull();
    expect(envelope.data.accelerationBps).toBeNull();
    expect(envelope.data.pasteLine).toContain("n/a");

    await expect(
      execFileAsync(
        "node",
        ["dist/cli/index.js", "--config", configPath, "loop", "demand", "--window-hours", "0"],
        { env: offlineEnv(), cwd: process.cwd() },
      ),
    ).rejects.toMatchObject({ code: 1 });

    await expect(
      execFileAsync(
        "node",
        ["dist/cli/index.js", "--config", configPath, "loop", "demand", "--window-hours", "200"],
        { env: offlineEnv(), cwd: process.cwd() },
      ),
    ).rejects.toMatchObject({ code: 1 });
  },
    30_000,
  );
});
