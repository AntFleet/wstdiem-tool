import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { interpolateEnv, loadConfig, missingDeploymentKeys } from "../src/config/load.js";

const created: string[] = [];

afterEach(() => {
  for (const file of created.splice(0)) {
    fs.rmSync(file, { force: true });
  }
});

describe("config loading", () => {
  it("interpolates empty environment placeholders as null", () => {
    delete process.env.DOES_NOT_EXIST_FOR_WSTDIEM_TEST;
    expect(interpolateEnv("${DOES_NOT_EXIST_FOR_WSTDIEM_TEST}")).toBeNull();
  });

  it("loads SPEC001 defaults and reports required deployment gaps", () => {
    const config = loadConfig({ configPath: "/tmp/does-not-exist-wstdiem.yaml" });
    expect(config.chainId).toBe(8453);
    expect(missingDeploymentKeys(config)).toContain("inferenceVault");
    expect(missingDeploymentKeys(config)).toContain("marketId");
  });

  it("loads YAML overrides", () => {
    const file = path.join(os.tmpdir(), `wstdiem-config-${Date.now()}.yaml`);
    created.push(file);
    fs.writeFileSync(
      file,
      [
        "storage:",
        `  sqlitePath: "${file}.sqlite"`,
        "position:",
        '  owner: "0x0000000000000000000000000000000000000001"',
      ].join("\n"),
    );
    const config = loadConfig({ configPath: file });
    expect(config.storage.sqlitePath).toBe(`${file}.sqlite`);
    expect(config.position.owner).toBe("0x0000000000000000000000000000000000000001");
  });

  it("rejects configuration that weakens SPEC001 safety thresholds", () => {
    expect(() =>
      loadConfig({
        configPath: "/tmp/does-not-exist-wstdiem.yaml",
        overrides: {
          execution: {
            defaultSlippageBps: 50,
            maxSlippageBps: 301,
            maxCurvePriceImpactBps: 100,
            transactionDeadlineSeconds: 300,
          },
        },
      }),
    ).toThrow(/maxSlippageBps/);

    expect(() =>
      loadConfig({
        configPath: "/tmp/does-not-exist-wstdiem.yaml",
        overrides: {
          thresholds: {
            ...DEFAULT_CONFIG.thresholds,
            minPostLoopHealthFactor: 1.69,
          },
        },
      }),
    ).toThrow(/minPostLoopHealthFactor/);

    expect(() =>
      loadConfig({
        configPath: "/tmp/does-not-exist-wstdiem.yaml",
        overrides: {
          thresholds: {
            ...DEFAULT_CONFIG.thresholds,
            oracleDeviationCritical: 0.02,
          },
        },
      }),
    ).toThrow(/oracleDeviationCritical/);
  });

  it("rejects internally inconsistent execution and alert thresholds", () => {
    expect(() =>
      loadConfig({
        configPath: "/tmp/does-not-exist-wstdiem.yaml",
        overrides: {
          execution: {
            defaultSlippageBps: 150,
            maxSlippageBps: 100,
            maxCurvePriceImpactBps: 100,
            transactionDeadlineSeconds: 300,
          },
        },
      }),
    ).toThrow(/defaultSlippageBps/);

    expect(() =>
      loadConfig({
        configPath: "/tmp/does-not-exist-wstdiem.yaml",
        overrides: {
          thresholds: {
            ...DEFAULT_CONFIG.thresholds,
            curveDepthWarn: 0.2,
            curveDepthCritical: 0.15,
          },
        },
      }),
    ).toThrow(/curveDepthWarn/);
  });
});
