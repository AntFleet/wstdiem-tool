import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { stringifyJson } from "../src/cli/output.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/load.js";
import {
  buildLoopBasis,
  computeBasis,
  evaluateBasisAlerts,
  resolveNavForBasis,
} from "../src/metrics/basis.js";
import { WAD } from "../src/metrics/math.js";

const execFileAsync = promisify(execFile);

describe("SPEC007 basis math", () => {
  it("AC1: market 0.95 / nav 1.00 → basisBps -500", () => {
    const r = computeBasis(WAD, (WAD * 95n) / 100n);
    expect(r.basisBps).toBe(-500);
    expect(r.basisGloss).toBe("discount-stress-and-edge-proxy");
  });

  it("AC2: market 1.05 / nav 1.00 → basisBps +500", () => {
    const r = computeBasis(WAD, (WAD * 105n) / 100n);
    expect(r.basisBps).toBe(500);
    expect(r.basisGloss).toBe("premium-secondary-above-nav");
  });

  it("AC3: market === nav → 0 flat", () => {
    const r = computeBasis(WAD, WAD);
    expect(r.basisBps).toBe(0);
    expect(r.basisGloss).toBe("flat-at-nav");
  });

  it("AC4: no market → null basis not 0", () => {
    const r = computeBasis(WAD, null);
    expect(r.basisBps).toBeNull();
    expect(r.basisGloss).toBeNull();
  });

  it("AC5: empty vault (supply 0) → nav unavailable even if convert returns WAD", () => {
    const resolved = resolveNavForBasis({
      totalAssets: 0n,
      totalSupply: 0n,
      navConvert: WAD,
    });
    expect(resolved.navSource).toBe("unavailable");
    expect(resolved.nav).toBeNull();
    const built = buildLoopBasis({
      totalAssets: 0n,
      totalSupply: 0n,
      navConvert: WAD,
      marketPrice: (WAD * 95n) / 100n,
      marketPriceSource: "cli-flag",
      thresholds: DEFAULT_CONFIG.thresholds,
    });
    expect(built.basisBps).toBeNull();
  });

  it("AC6/7: discount CRITICAL at -500 and WARN at -100; abs in message", () => {
    const critical = evaluateBasisAlerts({
      basisBps: -500,
      nav: WAD,
      marketPrice: (WAD * 95n) / 100n,
      marketPriceSource: "cli-flag",
      thresholds: { basisDiscountWarnBps: 100, basisDiscountCriticalBps: 500 },
    });
    expect(critical).toHaveLength(1);
    expect(critical[0].level).toBe("CRITICAL");
    expect(critical[0].message).toContain("discount 500 bps");
    expect(critical[0].message).not.toContain("-500");

    const warn = evaluateBasisAlerts({
      basisBps: -100,
      nav: WAD,
      marketPrice: (WAD * 99n) / 100n,
      marketPriceSource: "config",
      thresholds: { basisDiscountWarnBps: 100, basisDiscountCriticalBps: 500 },
    });
    expect(warn).toHaveLength(1);
    expect(warn[0].level).toBe("WARN");
  });

  it("AC8: -99 no alert; 0 no alert; premium no alert", () => {
    const thresholds = { basisDiscountWarnBps: 100, basisDiscountCriticalBps: 500 };
    expect(
      evaluateBasisAlerts({
        basisBps: -99,
        nav: WAD,
        marketPrice: WAD,
        marketPriceSource: "cli-flag",
        thresholds,
      }),
    ).toHaveLength(0);
    expect(
      evaluateBasisAlerts({
        basisBps: 0,
        nav: WAD,
        marketPrice: WAD,
        marketPriceSource: "cli-flag",
        thresholds,
      }),
    ).toHaveLength(0);
    expect(
      evaluateBasisAlerts({
        basisBps: 500,
        nav: WAD,
        marketPrice: (WAD * 105n) / 100n,
        marketPriceSource: "cli-flag",
        thresholds,
      }),
    ).toHaveLength(0);
  });

  it("AC7b: nav-source-mismatch warning; arithmeticComplete still true", () => {
    const convert = WAD + 10n ** 15n;
    const totalsNav = WAD; // different
    // totalAssets/totalSupply that yield totalsNav ≈ WAD
    const totalSupply = 10n ** 18n;
    const totalAssets = totalsNav; // computeNav = totalAssets * WAD / totalSupply = totalsNav
    const resolved = resolveNavForBasis({
      totalAssets,
      totalSupply,
      navConvert: convert,
    });
    expect(resolved.navSource).toBe("convertToAssets");
    expect(resolved.warnings).toContain("nav-source-mismatch");

    const built = buildLoopBasis({
      totalAssets,
      totalSupply,
      navConvert: convert,
      marketPrice: (convert * 95n) / 100n,
      marketPriceSource: "cli-flag",
      thresholds: DEFAULT_CONFIG.thresholds,
    });
    expect(built.warnings).toContain("nav-source-mismatch");
    expect(built.arithmeticComplete).toBe(true);
    expect(built.basisBps).not.toBeNull();
  });

  it("AC10: JSON honesty; authoritative false; caveats; paste dual framing", () => {
    const built = buildLoopBasis({
      totalAssets: 10n ** 20n,
      totalSupply: 10n ** 20n,
      navConvert: WAD,
      marketPrice: (WAD * 95n) / 100n,
      marketPriceSource: "cli-flag",
      thresholds: DEFAULT_CONFIG.thresholds,
    });
    const json = JSON.parse(stringifyJson(built));
    expect(json.authoritative).toBe(false);
    expect(json.decisionSupportOnly).toBe(true);
    expect(json.notATradeRecommendation).toBe(true);
    expect(json.basisKind).toBe("secondary-market-vs-nav");
    expect(json.modelCaveats).toContain("operator-supplied-market-price");
    expect(json.modelCaveats).toContain("v1-not-authoritative-market");
    expect(json.pasteLine).toContain("stress/illiquidity");
    expect(json.pasteLine).toContain("possible edge");
    expect(json.pasteLine).toContain("500 bps discount");
    expect(json.pasteLine).not.toMatch(/free money/i);
    expect(json.outcome).toBeUndefined();
    expect(json.exitCode).toBeUndefined();
    expect(typeof json.nav).toBe("string");
  });

  it("convert preferred over totals when both available", () => {
    const convert = WAD + 10n ** 16n;
    const r = resolveNavForBasis({
      totalAssets: 10n ** 20n,
      totalSupply: 10n ** 20n,
      navConvert: convert,
    });
    expect(r.navSource).toBe("convertToAssets");
    expect(r.nav).toBe(convert);
  });

  it("defaults include basis thresholds 100/500", () => {
    expect(DEFAULT_CONFIG.thresholds.basisDiscountWarnBps).toBe(100);
    expect(DEFAULT_CONFIG.thresholds.basisDiscountCriticalBps).toBe(500);
    expect(DEFAULT_CONFIG.basis.marketPriceDiemPerWstDiem).toBeNull();
  });

  it("AC19: zod rejects critical < warn", () => {
    expect(() =>
      loadConfig({
        configPath: "/tmp/does-not-exist-wstdiem-basis.yaml",
        overrides: {
          thresholds: {
            ...DEFAULT_CONFIG.thresholds,
            basisDiscountWarnBps: 500,
            basisDiscountCriticalBps: 100,
          },
        },
      }),
    ).toThrow();
  });
});

describe("SPEC007 loop basis CLI", () => {
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
    "AC11: no RPC + no market → n/a exit 0; market-price 0 → exit 1",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "wstdiem-basis-cli-"));
      dirs.push(dir);
      const configPath = join(dir, "c.yaml");
      writeFileSync(
        configPath,
        `chainId: 8453\nrpc:\n  primaryUrl: null\nstorage:\n  sqlitePath: ${join(dir, "t.sqlite")}\n`,
      );

      const ok = await execFileAsync(
        "node",
        ["dist/cli/index.js", "--config", configPath, "loop", "basis", "--json"],
        { env: offlineEnv(), cwd: process.cwd() },
      );
      const envelope = JSON.parse(ok.stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.data.basisBps).toBeNull();
      expect(envelope.data.authoritative).toBe(false);
      expect(envelope.data.pasteLine).toContain("n/a");

      await expect(
        execFileAsync(
          "node",
          [
            "dist/cli/index.js",
            "--config",
            configPath,
            "loop",
            "basis",
            "--market-price",
            "0",
          ],
          { env: offlineEnv(), cwd: process.cwd() },
        ),
      ).rejects.toMatchObject({ code: 1 });
    },
    30_000,
  );
});
