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
  it("keeps whole-value missing env placeholders optional but rejects partial unresolved strings", () => {
    delete process.env.DOES_NOT_EXIST_FOR_WSTDIEM_TEST;
    expect(interpolateEnv("${DOES_NOT_EXIST_FOR_WSTDIEM_TEST}")).toBeNull();
    expect(() => interpolateEnv("https://rpc.example/${DOES_NOT_EXIST_FOR_WSTDIEM_TEST}")).toThrow(
      /Unresolved env var/,
    );
  });

  it("loads SPEC001 v6 defaults", () => {
    const config = loadConfig({ configPath: "/tmp/does-not-exist-wstdiem.yaml" });
    expect(config.chainId).toBe(8453);
    expect(config.contracts.inferenceVault).toBe("0xe49FA849cB37b0e7A42B2335e333fb99474167ba");
    expect(config.contracts.feeRouter).toBe("0xa13a6e75d696bAceB38236389eeFD6eCa5FD4ED3");
    expect(config.contracts.agentTgeRegistry).toBe("0xb13830e7f72Eef167A7F188285feBa5f7C1198Ef");
    expect(config.contracts.curvePool).toBe("0x21c33a1Bb5f6Eb43563e1fB9e7AA1D4E90C1A0CD");
    expect(config.contracts.morphoOracle).toBe("0xAF29776f93FE0bf21282bF792A52AC212f20F45c");
    // SPEC010: loopExecutor is optional and defaults to null (Router was wrong).
    expect(config.contracts.loopExecutor).toBeNull();
    expect(config.morpho.marketId).toBe("0xdd6b9f10bf69445ebba0626ef54042af628cdf65dda98ff68df4d235d4d56c76");
    expect(config.morpho.lltvWad).toBe("860000000000000000");
    expect(config.execution.exitRepayBufferBps).toBe(200);
    expect(config.execution.maxBaseApyStalenessBlocks).toBe(7_200);
    expect(config.flashLoan).toMatchObject({
      provider: "uniswap-v3",
      factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
      pool: "0x80d995189ecc593672aD4703b250a5e82672EB1D",
      loanToken: DEFAULT_CONFIG.contracts.diem,
      pairToken: DEFAULT_CONFIG.contracts.weth,
      feeTier: 10_000,
    });
    // SPEC010 AC10: null loopExecutor is not a missing deployment key.
    expect(missingDeploymentKeys(config)).not.toContain("loopExecutor");
    expect(missingDeploymentKeys(config)).not.toContain("morphoOracle");
    expect(missingDeploymentKeys(config)).not.toContain("marketId");
  });

  it("SPEC010: loopExecutor null parses and passes deployment-config", () => {
    const config = loadConfig({
      configPath: "/tmp/does-not-exist-wstdiem.yaml",
      overrides: { contracts: { ...DEFAULT_CONFIG.contracts, loopExecutor: null } },
    });
    expect(config.contracts.loopExecutor).toBeNull();
    expect(missingDeploymentKeys(config)).toEqual([]);
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

  it("keeps the checked-in config example parseable", () => {
    const config = loadConfig({ configPath: path.resolve("config.example.yaml") });
    expect(config.flashLoan.provider).toBe("uniswap-v3");
    expect(config.flashLoan.loanToken).toBe(config.contracts.diem);
    expect(config.flashLoan.pairToken).toBe(config.contracts.weth);
    expect(config.morpho.lltvWad).toBe("860000000000000000");
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
            exitRepayBufferBps: 200,
            maxBaseApyStalenessBlocks: 7_200,
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
            exitRepayBufferBps: 200,
            maxBaseApyStalenessBlocks: 7_200,
            transactionDeadlineSeconds: 300,
          },
        },
      }),
    ).toThrow(/defaultSlippageBps/);

    expect(() =>
      loadConfig({
        configPath: "/tmp/does-not-exist-wstdiem.yaml",
        overrides: {
          execution: {
            ...DEFAULT_CONFIG.execution,
            exitRepayBufferBps: 0,
          },
        },
      }),
    ).toThrow(/exitRepayBufferBps/);

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

  it("rejects incomplete or mismatched Uniswap V3 flash provider config", () => {
    expect(() =>
      loadConfig({
        configPath: "/tmp/does-not-exist-wstdiem.yaml",
        overrides: {
          flashLoan: {
            ...DEFAULT_CONFIG.flashLoan,
            pool: null,
          },
        },
      }),
    ).toThrow(/pool is required/);

    expect(() =>
      loadConfig({
        configPath: "/tmp/does-not-exist-wstdiem.yaml",
        overrides: {
          flashLoan: {
            ...DEFAULT_CONFIG.flashLoan,
            loanToken: DEFAULT_CONFIG.contracts.weth,
          },
        },
      }),
    ).toThrow(/loanToken must match/);

    expect(() =>
      loadConfig({
        configPath: "/tmp/does-not-exist-wstdiem.yaml",
        overrides: {
          flashLoan: {
            ...DEFAULT_CONFIG.flashLoan,
            pairToken: DEFAULT_CONFIG.contracts.diem,
          },
        },
      }),
    ).toThrow(/pairToken must differ/);

    expect(() =>
      loadConfig({
        configPath: "/tmp/does-not-exist-wstdiem.yaml",
        overrides: {
          flashLoan: {
            ...DEFAULT_CONFIG.flashLoan,
            feeTier: 100_000,
          },
        },
      }),
    ).toThrow(/supported Uniswap V3 tier/);
  });
});
