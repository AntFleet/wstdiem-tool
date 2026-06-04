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

  it("loads SPEC001 v5 defaults", () => {
    const config = loadConfig({ configPath: "/tmp/does-not-exist-wstdiem.yaml" });
    expect(config.chainId).toBe(8453);
    expect(config.contracts.inferenceVault).toBe("0xb9f23c33FfD2213f31C0cFb6c9e2fDf525a9Dd2D");
    expect(config.contracts.feeRouter).toBe("0x3b8d968DCca09E319fac7Df741804Af5644E3a60");
    expect(config.contracts.agentTgeRegistry).toBe("0x09a4227935FF15b261533238F79935CCcA0e7941");
    expect(config.contracts.curvePool).toBe("0xB9c7F62e4EeC145bFa1C6bBc5fFdFf246181FdA2");
    expect(config.contracts.morphoOracle).toBe("0xBAEC9cccba9884d403dBcee15455e28781f1FD72");
    expect(config.contracts.loopExecutor).toBe("0x6fF481F4B3B0E2ADa548D454F7011D1ed51532B6");
    expect(config.morpho.marketId).toBe("0x12fd8d51cd36807382afd6128a32e117955d6d065b27a578687142478e81f894");
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
    expect(missingDeploymentKeys(config)).not.toContain("loopExecutor");
    expect(missingDeploymentKeys(config)).not.toContain("morphoOracle");
    expect(missingDeploymentKeys(config)).not.toContain("marketId");
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
