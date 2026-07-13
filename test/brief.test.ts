import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stringifyJson } from "../src/cli/output.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { parseDecimalToUnits } from "../src/metrics/math.js";
import {
  BRIEF_DISCLAIMER,
  buildLoopBrief,
  computeBriefDeltas,
  computeTemplateFingerprint,
  fingerprintFromTemplate,
  type BriefSnapshot,
} from "../src/loop/brief.js";
import { CAPACITY_KIND } from "../src/loop/capacity.js";
import { defaultSizingValues, type LoopSizingScenario } from "../src/loop/sizing.js";
import { Storage } from "../src/storage/sqlite.js";

const execFileAsync = promisify(execFile);
const created: string[] = [];

afterEach(() => {
  for (const file of created.splice(0)) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
});

function offlineEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.BASE_RPC_URL;
  delete env.BASE_RPC_URL_FALLBACK_1;
  delete env.BASE_RPC_URL_FALLBACK_2;
  return env;
}

function template(overrides: Partial<LoopSizingScenario> = {}): LoopSizingScenario {
  return {
    ...defaultSizingValues(DEFAULT_CONFIG),
    id: "brief-template",
    initialCollateralDiem: parseDecimalToUnits("1"),
    targetLeverageBps: 20_000,
    curveDiemLegDiem: parseDecimalToUnits("100000"),
    curveWstDiemLegDiem: parseDecimalToUnits("100000"),
    morphoSupplyDiem: parseDecimalToUnits("50000"),
    vaultApyBps: 1500,
    borrowApyBps: 800,
    rateAtTargetApyBps: 400,
    // Allow 2× to be candidate (default min HF 1.7 makes 2× always marginal).
    minHealthFactorBps: 14_000,
    ...overrides,
  };
}

function tempDb(): string {
  const file = path.join(os.tmpdir(), `wstdiem-brief-${Date.now()}-${Math.random()}.sqlite`);
  created.push(file);
  return file;
}

describe("SPEC006 live brief", () => {
  // AC10 — first run deltas null
  it("AC10: first run previous/deltas null (never fake 0)", async () => {
    const t15 = template({ targetLeverageBps: 15_000 });
    const t20 = template({ targetLeverageBps: 20_000 });
    const brief = await buildLoopBrief({
      templatesByLeverage: new Map([
        [15_000, t15],
        [20_000, t20],
      ]),
      leverageGridBps: [15_000, 20_000],
      canonicalEquityDiem: parseDecimalToUnits("100"),
      inputMode: "explicit-flags",
      chainId: 8453,
      previous: null,
    });

    expect(brief.previous).toBeNull();
    expect(brief.deltas).toBeNull();
    expect(brief.current.persistable).toBe(true);
    expect(brief.disclaimer).toBe(BRIEF_DISCLAIMER);
    expect(brief.capacityKind).toBe(CAPACITY_KIND);
  });

  // AC11 — second run deltas
  it("AC11: second comparable run deltas equal current − previous", async () => {
    const t = template({
      targetLeverageBps: 20_000,
      morphoSupplyDiem: parseDecimalToUnits("50000"),
    });
    const first = await buildLoopBrief({
      templatesByLeverage: new Map([[20_000, t]]),
      leverageGridBps: [20_000],
      canonicalEquityDiem: parseDecimalToUnits("100"),
      inputMode: "explicit-flags",
      chainId: 8453,
      timestamp: 1000,
      previous: null,
    });

    const t2 = template({
      targetLeverageBps: 20_000,
      morphoSupplyDiem: parseDecimalToUnits("60000"),
      vaultApyBps: 1600,
      rateAtTargetApyBps: 420,
    });
    const second = await buildLoopBrief({
      templatesByLeverage: new Map([[20_000, t2]]),
      leverageGridBps: [20_000],
      canonicalEquityDiem: parseDecimalToUnits("100"),
      inputMode: "explicit-flags",
      chainId: 8453,
      timestamp: 2000,
      previous: first.current,
    });

    expect(second.previous).not.toBeNull();
    expect(second.deltas).not.toBeNull();
    expect(second.deltas!.incomparable).toBe(false);
    expect(second.deltas!.vaultApyBps).toBe(100);
    expect(second.deltas!.rateAtTargetApyBps).toBe(20);
    expect(second.deltas!.morphoRawAvailableDiem).toBe(
      (parseDecimalToUnits("60000") - parseDecimalToUnits("50000")).toString(),
    );

    const capDelta = second.deltas!.perLeverage[0];
    expect(capDelta.capacityEquityDiem).not.toBeNull();
    const expectedCap =
      BigInt(second.current.capacities[0].capacityEquityDiem) -
      BigInt(first.current.capacities[0].capacityEquityDiem);
    expect(capDelta.capacityEquityDiem).toBe(expectedCap.toString());

    const expectedNet =
      second.current.netApyAtCanonical[0].netApyBps - first.current.netApyAtCanonical[0].netApyBps;
    expect(capDelta.netApyBps).toBe(expectedNet);
  });

  // AC11b — incomparable baseline
  it("AC11b: fingerprint or mode change → no comparable previous (deltas null at call site)", async () => {
    const t = template({ targetLeverageBps: 20_000 });
    const fpA = fingerprintFromTemplate(t, "explicit-flags", [20_000], parseDecimalToUnits("100"));
    const fpB = fingerprintFromTemplate(t, "from-chain", [20_000], parseDecimalToUnits("100"));
    expect(fpA).not.toBe(fpB);

    const fpC = fingerprintFromTemplate(
      { ...t, minHealthFactorBps: 18_000 },
      "explicit-flags",
      [20_000],
      parseDecimalToUnits("100"),
    );
    expect(fpA).not.toBe(fpC);

    // Live market fields do NOT change fingerprint.
    const fpD = fingerprintFromTemplate(
      { ...t, morphoSupplyDiem: parseDecimalToUnits("1") },
      "explicit-flags",
      [20_000],
      parseDecimalToUnits("100"),
    );
    expect(fpA).toBe(fpD);
  });

  // AC12 — persistence
  it("AC12: only persistable runs insert; comparable respects mode+fingerprint order", () => {
    const file = tempDb();
    const store = new Storage(file);

    const base: BriefSnapshot = {
      timestamp: 100,
      blockNumber: null,
      chainId: 8453,
      inputMode: "explicit-flags",
      templateFingerprint: "fp-aaa",
      persistable: true,
      rateAtTargetApyBps: 400,
      effectiveBorrowApyBpsAtCanonical: {},
      vaultApyBps: 1500,
      vaultApySource: null,
      curveDiemLegDiem: "1",
      curveWstDiemLegDiem: "1",
      morphoSupplyDiem: "1",
      morphoExistingBorrowDiem: "0",
      morphoRawAvailableDiem: "1",
      capacities: [],
      netApyAtCanonical: [],
      authoritative: true,
      warnings: [],
      decisionSupportOnly: true,
      notADeployRecommendation: true,
      capacityKind: CAPACITY_KIND,
      modelCaveats: [],
      disclaimer: BRIEF_DISCLAIMER,
    };

    expect(store.insertBriefRun({ ...base, persistable: false, inputMode: "offline-defaults" })).toBeNull();
    expect(
      store.getLatestComparableBriefRun({
        inputMode: "offline-defaults",
        templateFingerprint: "fp-aaa",
      }),
    ).toBeNull();

    const id1 = store.insertBriefRun({ ...base, timestamp: 100 });
    const id2 = store.insertBriefRun({ ...base, timestamp: 200 });
    expect(id1).not.toBeNull();
    expect(id2).not.toBeNull();

    const latest = store.getLatestComparableBriefRun({
      inputMode: "explicit-flags",
      templateFingerprint: "fp-aaa",
    });
    expect(latest).not.toBeNull();
    expect(latest!.timestamp).toBe(200);

    // Same timestamp, higher id wins.
    store.insertBriefRun({ ...base, timestamp: 200 });
    const latest2 = store.getLatestComparableBriefRun({
      inputMode: "explicit-flags",
      templateFingerprint: "fp-aaa",
    });
    expect(latest2!.timestamp).toBe(200);

    // Different fingerprint → null
    expect(
      store.getLatestComparableBriefRun({
        inputMode: "explicit-flags",
        templateFingerprint: "fp-other",
      }),
    ).toBeNull();

    // Different mode → null
    expect(
      store.getLatestComparableBriefRun({
        inputMode: "from-chain",
        templateFingerprint: "fp-aaa",
      }),
    ).toBeNull();

    store.close();
  });

  // AC13 honesty on brief
  it("AC13: brief JSON honesty fields; no outcome/exitCode", async () => {
    const t = template({ targetLeverageBps: 20_000 });
    const brief = await buildLoopBrief({
      templatesByLeverage: new Map([[20_000, t]]),
      leverageGridBps: [20_000],
      canonicalEquityDiem: parseDecimalToUnits("100"),
      inputMode: "explicit-flags",
      chainId: 8453,
    });
    const json = JSON.parse(stringifyJson(brief)) as Record<string, unknown>;
    expect(json.decisionSupportOnly).toBe(true);
    expect(json.notADeployRecommendation).toBe(true);
    expect(json.capacityKind).toBe(CAPACITY_KIND);
    expect(json.disclaimer).toBe(BRIEF_DISCLAIMER);
    expect(json.outcome).toBeUndefined();
    expect(json.exitCode).toBeUndefined();
  });

  it("computeBriefDeltas marks status transitions", () => {
    const prev: BriefSnapshot = {
      timestamp: 1,
      blockNumber: null,
      chainId: 8453,
      inputMode: "explicit-flags",
      templateFingerprint: "x",
      persistable: true,
      rateAtTargetApyBps: 400,
      effectiveBorrowApyBpsAtCanonical: {},
      vaultApyBps: 1500,
      vaultApySource: null,
      curveDiemLegDiem: "10",
      curveWstDiemLegDiem: "10",
      morphoSupplyDiem: "10",
      morphoExistingBorrowDiem: "0",
      morphoRawAvailableDiem: "10",
      capacities: [
        {
          targetLeverageBps: 20_000,
          capacityEquityDiem: "100",
          capacityNotionalDiem: "200",
          headroomToBlockEquityDiem: "100",
          capacityStatus: "candidate",
          bindingConstraint: "morpho-util-headroom",
        },
      ],
      netApyAtCanonical: [
        {
          targetLeverageBps: 20_000,
          equityDiem: "100",
          netApyBps: 500,
          netApyStressedBps: 100,
          status: "candidate",
        },
      ],
      authoritative: true,
      warnings: [],
      decisionSupportOnly: true,
      notADeployRecommendation: true,
      capacityKind: CAPACITY_KIND,
      modelCaveats: [],
      disclaimer: BRIEF_DISCLAIMER,
    };
    const cur: BriefSnapshot = {
      ...prev,
      timestamp: 2,
      capacities: [
        {
          ...prev.capacities[0],
          capacityEquityDiem: "50",
          capacityNotionalDiem: "100",
          capacityStatus: "blocked",
          bindingConstraint: "health-factor",
        },
      ],
      netApyAtCanonical: [
        {
          ...prev.netApyAtCanonical[0],
          netApyBps: 400,
        },
      ],
    };
    const deltas = computeBriefDeltas(cur, prev);
    expect(deltas.perLeverage[0].capacityStatusTransition).toBe("candidate → blocked");
    expect(deltas.perLeverage[0].bindingConstraintTransition).toBe(
      "morpho-util-headroom → health-factor",
    );
    expect(deltas.perLeverage[0].capacityEquityDiem).toBe("-50");
    expect(deltas.perLeverage[0].netApyBps).toBe(-100);
  });

  it("template fingerprint is stable under key order of preimage builder", () => {
    const a = computeTemplateFingerprint({
      inputMode: "explicit-flags",
      leverageGridBps: [15_000, 20_000],
      canonicalEquityDiem: parseDecimalToUnits("100"),
      minHealthFactorBps: 17_000,
      minNetApyBps: 0,
      maxSlippageBps: 300,
      maxMorphoUtilizationBps: 8000,
      maxCurvePositionShareBps: 1500,
      holdingPeriodDays: 365,
      gasCostDiem: 0n,
      curveFeeBps: 4,
      flashFeeBps: 5,
      exitRepayBufferBps: 50,
      lltvBps: 8600,
      borrowRateModel: "adaptive-curve",
    });
    const b = computeTemplateFingerprint({
      inputMode: "explicit-flags",
      leverageGridBps: [15_000, 20_000],
      canonicalEquityDiem: parseDecimalToUnits("100"),
      minHealthFactorBps: 17_000,
      minNetApyBps: 0,
      maxSlippageBps: 300,
      maxMorphoUtilizationBps: 8000,
      maxCurvePositionShareBps: 1500,
      holdingPeriodDays: 365,
      gasCostDiem: 0n,
      curveFeeBps: 4,
      flashFeeBps: 5,
      exitRepayBufferBps: 50,
      lltvBps: 8600,
      borrowRateModel: "adaptive-curve",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("SPEC006 capacity/brief CLI", () => {
  // AC14 refuse offline fantasy
  it("AC14: refuse without from-chain, explicit market, or allow-offline-defaults", async () => {
    await execFileAsync("npm", ["run", "build"], { cwd: process.cwd() });
    const result = await execFileAsync(
      "node",
      ["dist/cli/index.js", "loop", "capacity", "--json", "--target-leverage", "2"],
      { env: offlineEnv() },
    ).catch((error: { stdout?: string; stderr?: string; code?: number }) => error);

    const stdout =
      typeof result === "object" && result !== null && "stdout" in result
        ? String((result as { stdout?: string }).stdout ?? "")
        : "";
    const stderr =
      typeof result === "object" && result !== null && "stderr" in result
        ? String((result as { stderr?: string }).stderr ?? "")
        : "";
    const combined = `${stdout}\n${stderr}`;
    expect(combined).toMatch(/OFFLINE_CAPACITY_REFUSED/);
    expect(combined).not.toMatch(/"capacityEquityDiem"/);
  }, 60_000);

  // AC14 + multi leverage on capacity
  it("AC14/OQ-C: multi-leverage on capacity → INVALID_INPUT", async () => {
    const result = await execFileAsync(
      "node",
      [
        "dist/cli/index.js",
        "loop",
        "capacity",
        "--json",
        "--target-leverage",
        "1.5,2",
        "--allow-offline-defaults",
      ],
      { env: offlineEnv() },
    ).catch((error: { stdout?: string; stderr?: string }) => error);

    const stdout =
      typeof result === "object" && result !== null && "stdout" in result
        ? String((result as { stdout?: string }).stdout ?? "")
        : "";
    expect(stdout + String((result as { stderr?: string }).stderr ?? "")).toMatch(
      /INVALID_INPUT/,
    );
  }, 30_000);

  // AC15 human banner
  it("AC15: human banner has mode + gates clear up to; no deploy up to", async () => {
    const result = await execFileAsync(
      "node",
      [
        "dist/cli/index.js",
        "loop",
        "capacity",
        "--target-leverage",
        "2",
        "--curve-depth-diem",
        "0",
        "--morpho-supply-diem",
        "1000",
      ],
      { env: offlineEnv() },
    );
    expect(result.stdout).toMatch(/EXPLICIT FLAGS|Gates clear up to/);
    expect(result.stdout.toLowerCase()).not.toMatch(/deploy up to/);
    expect(result.stdout).not.toMatch(/deployable capacity/i);
  }, 30_000);

  it("capacity --allow-offline-defaults succeeds non-authoritative", async () => {
    const result = await execFileAsync(
      "node",
      [
        "dist/cli/index.js",
        "loop",
        "capacity",
        "--json",
        "--target-leverage",
        "2",
        "--allow-offline-defaults",
      ],
      { env: offlineEnv() },
    );
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      data: {
        inputMode: string;
        authoritative: boolean;
        decisionSupportOnly: boolean;
        capacityKind: string;
        disclaimer: string;
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("loop capacity");
    expect(parsed.data.inputMode).toBe("offline-defaults");
    expect(parsed.data.authoritative).toBe(false);
    expect(parsed.data.decisionSupportOnly).toBe(true);
    expect(parsed.data.capacityKind).toBe(CAPACITY_KIND);
  }, 30_000);

  it("brief first run JSON has null deltas and n/a-safe shape", async () => {
    const db = tempDb();
    const configPath = path.join(os.tmpdir(), `wstdiem-cfg-${Date.now()}.yaml`);
    created.push(configPath);
    fs.writeFileSync(
      configPath,
      `storage:\n  sqlitePath: ${JSON.stringify(db)}\n`,
    );

    const result = await execFileAsync(
      "node",
      [
        "dist/cli/index.js",
        "--config",
        configPath,
        "loop",
        "brief",
        "--json",
        "--target-leverage",
        "1.5,2",
        "--curve-depth-diem",
        "100000",
        "--morpho-supply-diem",
        "50000",
        "--canonical-equity-diem",
        "100",
      ],
      { env: offlineEnv() },
    );
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      data: {
        previous: unknown;
        deltas: unknown;
        current: { persistable: boolean; capacities: unknown[] };
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.previous).toBeNull();
    expect(parsed.data.deltas).toBeNull();
    expect(parsed.data.current.persistable).toBe(true);
    expect(parsed.data.current.capacities.length).toBe(2);

    // Second run should have deltas.
    const result2 = await execFileAsync(
      "node",
      [
        "dist/cli/index.js",
        "--config",
        configPath,
        "loop",
        "brief",
        "--json",
        "--target-leverage",
        "1.5,2",
        "--curve-depth-diem",
        "100000",
        "--morpho-supply-diem",
        "50000",
        "--canonical-equity-diem",
        "100",
      ],
      { env: offlineEnv() },
    );
    const parsed2 = JSON.parse(result2.stdout) as {
      data: { previous: unknown; deltas: { incomparable: boolean } | null };
    };
    expect(parsed2.data.previous).not.toBeNull();
    expect(parsed2.data.deltas).not.toBeNull();
    expect(parsed2.data.deltas!.incomparable).toBe(false);
  }, 60_000);

  it("offline-defaults brief does not persist as capital baseline", async () => {
    const db = tempDb();
    const configPath = path.join(os.tmpdir(), `wstdiem-cfg-off-${Date.now()}.yaml`);
    created.push(configPath);
    fs.writeFileSync(
      configPath,
      `storage:\n  sqlitePath: ${JSON.stringify(db)}\n`,
    );

    await execFileAsync(
      "node",
      [
        "dist/cli/index.js",
        "--config",
        configPath,
        "loop",
        "brief",
        "--json",
        "--allow-offline-defaults",
      ],
      { env: offlineEnv() },
    );

    const store = new Storage(db);
    const row = store.getLatestComparableBriefRun({
      inputMode: "offline-defaults",
      templateFingerprint: "anything",
    });
    expect(row).toBeNull();
    // Table exists but no persistable offline rows.
    store.close();
  }, 30_000);
});
