import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const created: string[] = [];
const owner = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const privateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

afterEach(() => {
  for (const file of created.splice(0)) {
    fs.rmSync(file, { force: true });
  }
});

function writeLiveConfig(options: { loopExecutor?: string | null } = {}): string {
  const file = path.join(os.tmpdir(), `wstdiem-live-${Date.now()}-${Math.random().toString(16).slice(2)}.yaml`);
  created.push(file);
  const loopExecutorConfig =
    options.loopExecutor === null
      ? "  loopExecutor: null"
      : `  loopExecutor: "${options.loopExecutor ?? "0x0000000000000000000000000000000000000005"}"`;
  fs.writeFileSync(
    file,
    [
      "rpc:",
      "  primaryUrl:",
      "  fallbackUrls: []",
      "contracts:",
      '  inferenceVault: "0x0000000000000000000000000000000000000001"',
      '  feeRouter: "0x0000000000000000000000000000000000000002"',
      '  curvePool: "0x0000000000000000000000000000000000000003"',
      '  morphoOracle: "0x0000000000000000000000000000000000000004"',
      loopExecutorConfig,
      "morpho:",
      `  marketId: "0x${"11".repeat(32)}"`,
      "wallet:",
      '  privateKeyEnv: "WSTDIEM_TEST_PRIVATE_KEY"',
      "position:",
      `  owner: "${owner}"`,
    ].join("\n"),
  );
  return file;
}

describe("compiled CLI live simulation mode", () => {
  it("allows loop readiness to override owner and loopExecutor evidence", async () => {
    await execFileAsync("npm", ["run", "build"]);
    const configPath = writeLiveConfig({ loopExecutor: null });
    const overrideExecutor = "0x00000000000000000000000000000000000000A5";
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.BASE_RPC_URL;
    delete env.BASE_RPC_URL_FALLBACK_1;
    delete env.BASE_RPC_URL_FALLBACK_2;
    const missingExecutor = await execFileAsync(
      "node",
      ["dist/cli/index.js", "--config", configPath, "--json", "loop", "readiness", "--owner", owner],
      { env },
    );
    const missingParsed = JSON.parse(missingExecutor.stdout) as {
      ok: boolean;
      data: {
        checks: Array<{ key: string; status: string }>;
      };
    };
    expect(missingParsed.ok).toBe(true);
    expect(missingParsed.data.checks).toContainEqual({
      key: "deployment-config",
      status: "fail",
      message: "missing: loopExecutor",
    });

    const result = await execFileAsync(
      "node",
      [
        "dist/cli/index.js",
        "--config",
        configPath,
        "--json",
        "loop",
        "readiness",
        "--owner",
        owner,
        "--loop-executor",
        overrideExecutor,
      ],
      { env },
    );
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      data: {
        checks: Array<{ key: string; status: string }>;
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.checks).toContainEqual({
      key: "deployment-config",
      status: "pass",
      message: "required deployment config is present",
    });
  }, 15_000);

  it("fails strict readiness evidence when live readiness is blocked", async () => {
    await execFileAsync("npm", ["run", "build"]);
    const configPath = writeLiveConfig({ loopExecutor: null });
    let stdout = "";
    const overrideExecutor = "0x00000000000000000000000000000000000000A5";
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.BASE_RPC_URL;
    delete env.BASE_RPC_URL_FALLBACK_1;
    delete env.BASE_RPC_URL_FALLBACK_2;
    try {
      await execFileAsync(
        "node",
        [
          "dist/cli/index.js",
          "--config",
          configPath,
          "--json",
          "loop",
          "readiness",
          "--owner",
          owner,
          "--loop-executor",
          overrideExecutor,
          "--strict-evidence",
        ],
        { env },
      );
    } catch (error) {
      stdout = (error as { stdout: string }).stdout;
    }
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      data: {
        checks: Array<{ key: string; status: string }>;
      };
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("READINESS_EVIDENCE_BLOCKED");
    expect(parsed.data.checks).toContainEqual({
      key: "rpc-client",
      status: "fail",
      message: "live RPC client is required for loop readiness",
    });
  }, 15_000);

  it("returns ok:false with blocked liveSimulation details when no RPC URL is configured", async () => {
    await execFileAsync("npm", ["run", "build"]);
    let stdout = "";
    try {
      await execFileAsync("node", [
        "dist/cli/index.js",
        "--json",
        "loop",
        "simulate",
        "--action",
        "open",
        "--target-leverage",
        "3",
        "--initial-diem",
        "100",
        "--live",
      ]);
    } catch (error) {
      stdout = (error as { stdout: string }).stdout;
    }
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      data: {
        liveSimulation: {
          status: string;
          error: { code: string };
        };
      };
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("LIVE_SIMULATION_BLOCKED");
    expect(parsed.data.liveSimulation.status).toBe("blocked");
    expect(parsed.data.liveSimulation.error.code).toBe("SIMULATION_CLIENT_MISSING");
  }, 15_000);

  it("passes signer evidence from configured private key into blocked live simulation output", async () => {
    await execFileAsync("npm", ["run", "build"]);
    const configPath = writeLiveConfig();
    let stdout = "";
    const env: NodeJS.ProcessEnv = { ...process.env, WSTDIEM_TEST_PRIVATE_KEY: privateKey };
    delete env.BASE_RPC_URL;
    delete env.BASE_RPC_URL_FALLBACK_1;
    delete env.BASE_RPC_URL_FALLBACK_2;
    try {
      await execFileAsync(
        "node",
        [
          "dist/cli/index.js",
          "--config",
          configPath,
          "--json",
          "loop",
          "simulate",
          "--action",
          "rebalance",
          "--target-leverage",
          "1.7",
          "--from",
          owner,
          "--live",
        ],
        { env },
      );
    } catch (error) {
      stdout = (error as { stdout: string }).stdout;
    }
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      data: {
        liveSimulation: {
          preflightChecks: Array<{ key: string; status: string }>;
        };
      };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.data.liveSimulation.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain(
      "tx-signer:pass",
    );
  }, 15_000);
});
