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

function writeLiveConfig(): string {
  const file = path.join(os.tmpdir(), `wstdiem-live-${Date.now()}-${Math.random().toString(16).slice(2)}.yaml`);
  created.push(file);
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
      '  loopExecutor: "0x0000000000000000000000000000000000000005"',
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
