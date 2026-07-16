import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildStatus, type StatusDeps } from "../src/cli/status.js";
import {
  classifyMonitoringOutcome,
  isMonitorAssessed,
} from "../src/cli/exitCode.js";
import { WAD } from "../src/metrics/math.js";
import type { AppConfig, Severity } from "../src/types/domain.js";
import type { LoopReadinessResult } from "../src/loop/readiness.js";
import type { LoopSimulationClient } from "../src/loop/simulator.js";
import type { MetricsReadClient } from "../src/metrics/collector.js";

/** collectVaultMetrics only calls readContract; cast the minimal mock to the seam type. */
function asLoopClient(client: MetricsReadClient): LoopSimulationClient {
  return client as unknown as LoopSimulationClient;
}

const execFileAsync = promisify(execFile);
const created: string[] = [];

afterEach(() => {
  for (const file of created.splice(0)) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
});

// --- helpers -----------------------------------------------------------------

function crit(): { level: Severity } {
  return { level: "CRITICAL" };
}
function warn(): { level: Severity } {
  return { level: "WARN" };
}
function info(): { level: Severity } {
  return { level: "INFO" };
}

/** A config whose RPC branch is entered but backed only by injected StatusDeps. */
function mockRpcConfig(sqlitePath: string): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    rpc: { ...DEFAULT_CONFIG.rpc, primaryUrl: "http://mock", fallbackUrls: [] },
    storage: { sqlitePath },
  };
}

function goodBlockStatus(): StatusDeps["readBlockStatus"] {
  return async () => ({
    chainId: DEFAULT_CONFIG.chainId,
    blockNumber: 100n,
    blockTimestamp: Math.floor(Date.now() / 1000),
    rpcName: "mock",
  });
}

/** A vault client whose position/market reads throw — models a partial read. */
const throwingVaultClient: MetricsReadClient = {
  readContract: async () => {
    throw new Error("mock: contract read rate-limited");
  },
};

/** A vault client that returns a healthy, alert-free vault state. */
const healthyVaultClient: MetricsReadClient = {
  readContract: async ({ functionName }) => {
    if (functionName === "asset") return DEFAULT_CONFIG.contracts.diem;
    if (functionName === "totalAssets") return WAD;
    if (functionName === "totalSupply") return WAD;
    if (functionName === "convertToAssets") return WAD;
    throw new Error(`unexpected read ${functionName}`);
  },
};

/**
 * A vault client whose asset() is NOT the configured DIEM — collectVaultMetrics
 * early-returns WITHOUT throwing and WITHOUT setting validity.vault. Models a
 * wrong/migrated vault: the read did not complete, so liveAssessed must stay false.
 */
const wrongAssetVaultClient: MetricsReadClient = {
  readContract: async ({ functionName }) => {
    if (functionName === "asset") return "0x000000000000000000000000000000000000dEaD";
    throw new Error(`unexpected read ${functionName}`);
  },
};

function readiness(overrides: Partial<LoopReadinessResult>): LoopReadinessResult {
  return {
    status: "blocked",
    blockNumber: 123n,
    liquidation: null,
    checks: [{ key: "audit-gate", status: "fail", message: "audit gate closed" }],
    blockers: ["broadcast disabled pending production executor audit/review"],
    ownerConfigured: false,
    leverage: "unknown",
    ownerLeverageUndeterminable: false,
    broadcastAvailable: false,
    auditRequired: true,
    ...overrides,
  };
}

function writeOfflineConfig(): string {
  const file = path.join(
    os.tmpdir(),
    `wstdiem-exit-${Date.now()}-${Math.random().toString(16).slice(2)}.yaml`,
  );
  created.push(file);
  fs.writeFileSync(
    file,
    [
      "rpc:",
      "  primaryUrl:",
      "  fallbackUrls: []",
      "contracts:",
      '  inferenceVault: "0x0000000000000000000000000000000000000001"',
      "position:",
      '  owner: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"',
    ].join("\n"),
  );
  return file;
}

function offlineEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BASE_RPC_URL;
  delete env.BASE_RPC_URL_FALLBACK_1;
  delete env.BASE_RPC_URL_FALLBACK_2;
  return env;
}

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync("node", ["dist/cli/index.js", ...args], {
      env: offlineEnv(),
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

// --- unit: classifyMonitoringOutcome -----------------------------------------

describe("classifyMonitoringOutcome (SPEC004 §3)", () => {
  it("nominal → 0 when assessed and no WARN/CRITICAL", () => {
    expect(classifyMonitoringOutcome({ assessed: true, alerts: [] })).toEqual({
      outcome: "nominal",
      exitCode: 0,
    });
    expect(classifyMonitoringOutcome({ assessed: true, alerts: [info()] })).toEqual({
      outcome: "nominal",
      exitCode: 0,
    });
  });

  it("warn → 10 when assessed and worst is WARN", () => {
    expect(classifyMonitoringOutcome({ assessed: true, alerts: [warn()] })).toEqual({
      outcome: "warn",
      exitCode: 10,
    });
  });

  it("critical → 30 when assessed and any CRITICAL (incl. WARN+CRITICAL mix)", () => {
    expect(classifyMonitoringOutcome({ assessed: true, alerts: [crit()] })).toEqual({
      outcome: "critical",
      exitCode: 30,
    });
    expect(classifyMonitoringOutcome({ assessed: true, alerts: [warn(), crit()] })).toEqual({
      outcome: "critical",
      exitCode: 30,
    });
  });

  it("indeterminate → 20 short-circuits BEFORE alert severity when not assessed", () => {
    // The read-completed gate wins even over a CRITICAL alert (AC5 logic).
    expect(classifyMonitoringOutcome({ assessed: false, alerts: [crit()] })).toEqual({
      outcome: "indeterminate",
      exitCode: 20,
    });
    expect(classifyMonitoringOutcome({ assessed: false, alerts: [] })).toEqual({
      outcome: "indeterminate",
      exitCode: 20,
    });
  });
});

describe("isMonitorAssessed (SPEC004 §3)", () => {
  it("true when a block was read and no rpc-* check failed", () => {
    expect(
      isMonitorAssessed(readiness({ blockNumber: 5n, checks: [{ key: "vault", status: "pass", message: "" }] })),
    ).toBe(true);
  });

  it("false when blockNumber is undefined", () => {
    expect(isMonitorAssessed(readiness({ blockNumber: undefined }))).toBe(false);
  });

  it("false when rpc-client or rpc-read failed", () => {
    expect(
      isMonitorAssessed(readiness({ blockNumber: 5n, checks: [{ key: "rpc-client", status: "fail", message: "" }] })),
    ).toBe(false);
    expect(
      isMonitorAssessed(readiness({ blockNumber: 5n, checks: [{ key: "rpc-read", status: "fail", message: "" }] })),
    ).toBe(false);
  });
});

// --- status / watch: liveAssessed wiring (in-process) ------------------------

describe("status/watch liveAssessed → exit class (SPEC004 §3, the C1 fix)", () => {
  it("AC4: partial read (block ok, collectVaultMetrics throws) → liveAssessed false → 20", async () => {
    const file = path.join(os.tmpdir(), `wstdiem-exit-partial-${Date.now()}.sqlite`);
    created.push(file);
    const deps: StatusDeps = {
      readBlockStatus: goodBlockStatus(),
      createLoopClient: async () => asLoopClient(throwingVaultClient),
    };
    const result = await buildStatus(mockRpcConfig(file), deps);
    // block header WAS read on the right chain...
    expect(result.snapshot.validity.rpcFreshness).toBe(true);
    // ...but the position reads did NOT complete → liveAssessed stays false.
    expect(result.snapshot.validity.liveAssessed).toBe(false);
    const classification = classifyMonitoringOutcome({
      assessed: result.snapshot.validity.liveAssessed,
      alerts: result.alerts,
    });
    expect(classification).toEqual({ outcome: "indeterminate", exitCode: 20 });
  });

  it("incomplete read (asset()!=DIEM, no throw) → liveAssessed false → 20, not a false 0", async () => {
    const file = path.join(os.tmpdir(), `wstdiem-exit-wrongasset-${Date.now()}.sqlite`);
    created.push(file);
    const deps: StatusDeps = {
      readBlockStatus: goodBlockStatus(),
      createLoopClient: async () => asLoopClient(wrongAssetVaultClient),
    };
    const result = await buildStatus(mockRpcConfig(file), deps);
    // block header read on the right chain, collectVaultMetrics returned WITHOUT throwing...
    expect(result.snapshot.validity.rpcFreshness).toBe(true);
    // ...but bailed at asset()!=DIEM, so the vault read did NOT complete.
    expect(result.snapshot.validity.vault).toBe(false);
    expect(result.snapshot.validity.liveAssessed).toBe(false);
    const classification = classifyMonitoringOutcome({
      assessed: result.snapshot.validity.liveAssessed,
      alerts: result.alerts,
    });
    expect(classification).toEqual({ outcome: "indeterminate", exitCode: 20 });
  });

  it("AC1: completed read with no alerts → liveAssessed true → 0", async () => {
    const file = path.join(os.tmpdir(), `wstdiem-exit-nominal-${Date.now()}.sqlite`);
    created.push(file);
    const deps: StatusDeps = {
      readBlockStatus: goodBlockStatus(),
      createLoopClient: async () => asLoopClient(healthyVaultClient),
    };
    const result = await buildStatus(mockRpcConfig(file), deps);
    expect(result.snapshot.validity.liveAssessed).toBe(true);
    expect(result.alerts).toEqual([]);
    const classification = classifyMonitoringOutcome({
      assessed: result.snapshot.validity.liveAssessed,
      alerts: result.alerts,
    });
    expect(classification).toEqual({ outcome: "nominal", exitCode: 0 });
  });
});

// --- monitor: readiness gate + alert-level ladder (in-process) ---------------

describe("monitor classification via evaluateReadinessAlerts (SPEC004 §3)", () => {
  it("AC2: executor_missing WARN, read completed → 10 (no-blocker-rule fix, NOT 30)", () => {
    const alerts = [{ level: "WARN" as Severity }]; // executor_missing / owner_missing shape
    const assessed = isMonitorAssessed(
      readiness({ blockNumber: 9n, checks: [{ key: "executor-config", status: "fail", message: "" }] }),
    );
    expect(assessed).toBe(true);
    expect(classifyMonitoringOutcome({ assessed, alerts })).toEqual({
      outcome: "warn",
      exitCode: 10,
    });
  });

  it("AC5: blockNumber undefined + live_rpc_unavailable CRITICAL → 20 (gate short-circuits, NOT 30)", () => {
    const alerts = [{ level: "CRITICAL" as Severity }]; // live_rpc_unavailable
    const assessed = isMonitorAssessed(
      readiness({ blockNumber: undefined, checks: [{ key: "rpc-client", status: "fail", message: "" }] }),
    );
    expect(assessed).toBe(false);
    expect(classifyMonitoringOutcome({ assessed, alerts })).toEqual({
      outcome: "indeterminate",
      exitCode: 20,
    });
  });

  it("AC3: assessed + CRITICAL → 30", () => {
    const assessed = isMonitorAssessed(readiness({ blockNumber: 9n, checks: [] }));
    expect(classifyMonitoringOutcome({ assessed, alerts: [crit()] })).toEqual({
      outcome: "critical",
      exitCode: 30,
    });
  });

  it("AC8: assessed with only the closed audit gate (no alert) → 0", () => {
    // evaluateReadinessAlerts emits nothing for the audit gate → empty alerts.
    const assessed = isMonitorAssessed(
      readiness({ blockNumber: 9n, checks: [{ key: "audit-gate", status: "fail", message: "" }] }),
    );
    expect(assessed).toBe(true);
    expect(classifyMonitoringOutcome({ assessed, alerts: [] })).toEqual({
      outcome: "nominal",
      exitCode: 0,
    });
  });
});

// --- compiled CLI: real process exit codes -----------------------------------

describe("compiled CLI real exit codes (SPEC004 §11)", () => {
  beforeAll(async () => {
    await execFileAsync("npm", ["run", "build"]);
  }, 60_000);

  it("AC4: status with no RPC configured → exit 20 (indeterminate), not 0", async () => {
    const config = writeOfflineConfig();
    const run = await runCli(["--config", config, "status"]);
    expect(run.code).toBe(20);
  }, 20_000);

  it("AC7: status --json and non-json set the same exit code; data.exitCode/outcome agree with $?", async () => {
    const config = writeOfflineConfig();
    const jsonRun = await runCli(["--config", config, "--json", "status"]);
    expect(jsonRun.code).toBe(20);
    const parsed = JSON.parse(jsonRun.stdout) as {
      ok: boolean;
      data: { outcome: string; exitCode: number };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.exitCode).toBe(20);
    expect(parsed.data.outcome).toBe("indeterminate");
    expect(parsed.data.exitCode).toBe(jsonRun.code);

    const stringRun = await runCli(["--config", config, "status"]);
    expect(stringRun.code).toBe(jsonRun.code);
  }, 25_000);

  it("AC5: monitor with no RPC (blockNumber undefined + CRITICAL alert) → exit 20, not 30", async () => {
    const config = writeOfflineConfig();
    const run = await runCli(["--config", config, "--json", "monitor"]);
    expect(run.code).toBe(20);
    const parsed = JSON.parse(run.stdout) as { data: { outcome: string; exitCode: number } };
    expect(parsed.data.outcome).toBe("indeterminate");
    expect(parsed.data.exitCode).toBe(20);
  }, 20_000);

  it("AC6: tool-error (invalid --owner) → exit 1, not overridden by the ladder", async () => {
    const config = writeOfflineConfig();
    const run = await runCli(["--config", config, "status", "--owner", "0xnotanaddress"]);
    expect(run.code).toBe(1);
    const monitorRun = await runCli(["--config", config, "monitor", "--owner", "0xnotanaddress"]);
    expect(monitorRun.code).toBe(1);
  }, 20_000);

  it("AC9: loop sizing is unaffected by the severity ladder → exit 0", async () => {
    const config = writeOfflineConfig();
    const run = await runCli(["--config", config, "loop", "sizing"]);
    expect(run.code).toBe(0);
  }, 20_000);
});
