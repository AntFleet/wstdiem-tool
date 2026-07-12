import { describe, expect, it } from "vitest";
import { stringifyJson } from "../src/cli/output.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { parseDecimalToUnits } from "../src/metrics/math.js";
import {
  buildLoopSizingReport,
  defaultSizingValues,
  sizeLoopScenario,
} from "../src/loop/sizing.js";
import { buildLoopSizingScenarios } from "../src/loop/sizingScenarios.js";

// SPEC002 rev-2 acceptance criteria (§"Acceptance criteria" 1-9). Criterion 6 (seam-vs-rail
// via quoteCurveExitRoute + priceImpactBps) and 10 (SPEC003 Part B seeding) are Part B and are
// intentionally out of scope here — rev-2 only adds the injectable field + its plumbing.

function scenario(overrides: Partial<Parameters<typeof sizeLoopScenario>[0]> = {}) {
  return {
    ...defaultSizingValues(DEFAULT_CONFIG),
    id: "test",
    initialCollateralDiem: parseDecimalToUnits("100"),
    targetLeverageBps: 15_000,
    curveDiemLegDiem: parseDecimalToUnits("10000"),
    curveWstDiemLegDiem: parseDecimalToUnits("10000"),
    morphoSupplyDiem: parseDecimalToUnits("100"),
    vaultApyBps: 1500,
    borrowApyBps: 800,
    ...overrides,
  };
}

// A comfortably-viable base: deep balanced legs (total 100000) + deep Morpho supply, so gate
// changes come only from the field under test.
function viableBase(overrides: Partial<Parameters<typeof sizeLoopScenario>[0]> = {}) {
  return scenario({
    curveDiemLegDiem: parseDecimalToUnits("50000"),
    curveWstDiemLegDiem: parseDecimalToUnits("50000"),
    morphoSupplyDiem: parseDecimalToUnits("100000"),
    ...overrides,
  });
}

describe("SPEC002 rev-2 — leg-aware slippage (R1)", () => {
  // Criterion 1: exit divides by the DIEM leg, entry by the wstDIEM leg (verified direction map).
  it("divides exit by the DIEM leg and entry by the wstDIEM leg", () => {
    // 100 DIEM @1.5x -> position 150, borrow 50. DIEM leg 20000, wstDIEM leg 5000.
    const result = sizeLoopScenario(
      scenario({
        curveDiemLegDiem: parseDecimalToUnits("20000"),
        curveWstDiemLegDiem: parseDecimalToUnits("5000"),
      }),
    );

    // exit = 4 + ratioBps(150, 20000) = 4 + 75 = 79  (drawn DIEM leg)
    expect(result.exitSlippageBps).toBe(79);
    // entry = 4 + ratioBps(50, 5000) = 4 + 100 = 104  (drawn wstDIEM leg)
    expect(result.estimatedEntrySlippageBps).toBe(104);
    // If the map were inverted, exit would read 104 and entry 79 — it does not.
    expect(result.exitSlippageBps).not.toBe(104);
    expect(result.exitSlippageSource).toBe("estimate");
  });

  // Criterion 2: an imbalanced pool -> high exit / low entry; the mirror pool reverses it.
  it("prices a DIEM-drained pool as costly to exit and cheap to enter; the mirror reverses", () => {
    const diemDrained = sizeLoopScenario(
      scenario({
        curveDiemLegDiem: parseDecimalToUnits("1000"),
        curveWstDiemLegDiem: parseDecimalToUnits("50000"),
      }),
    );
    // exit = 4 + ratioBps(150, 1000) = 1504; entry = 4 + ratioBps(50, 50000) = 14
    expect(diemDrained.exitSlippageBps).toBe(1504);
    expect(diemDrained.estimatedEntrySlippageBps).toBe(14);
    expect(diemDrained.exitSlippageBps).toBeGreaterThan(diemDrained.estimatedEntrySlippageBps);

    const wstDiemDrained = sizeLoopScenario(
      scenario({
        curveDiemLegDiem: parseDecimalToUnits("50000"),
        curveWstDiemLegDiem: parseDecimalToUnits("1000"),
      }),
    );
    // exit = 4 + ratioBps(150, 50000) = 34; entry = 4 + ratioBps(50, 1000) = 504
    expect(wstDiemDrained.exitSlippageBps).toBe(34);
    expect(wstDiemDrained.estimatedEntrySlippageBps).toBe(504);
    expect(wstDiemDrained.estimatedEntrySlippageBps).toBeGreaterThan(wstDiemDrained.exitSlippageBps);
  });

  // Criterion 3: --curve-depth-diem T -> balanced legs T/2, exit = fee + ratioBps(trade, T/2),
  // and that per-leg term is exactly 2x the (rejected) divide-by-total term.
  it("splits --curve-depth-diem into balanced legs and applies the intended 2x correction", () => {
    const [built] = buildLoopSizingScenarios(DEFAULT_CONFIG, {
      initialDiem: "100",
      targetLeverage: "1.5",
      curveDepthDiem: "20000",
    });
    expect(built.curveDiemLegDiem).toBe(parseDecimalToUnits("10000"));
    expect(built.curveWstDiemLegDiem).toBe(parseDecimalToUnits("10000"));

    const result = sizeLoopScenario(built);
    // exit = 4 + ratioBps(150, 10000) = 154 (per-leg); the divide-by-total term would be
    // ratioBps(150, 20000) = 75, so the per-leg ratio term (150) is exactly 2x it (75).
    expect(result.exitSlippageBps).toBe(154);
    const perLegRatioTerm = result.exitSlippageBps - built.curveFeeBps; // 150
    const totalRatioTerm = 75; // ratioBps(150, 20000)
    expect(perLegRatioTerm).toBe(2 * totalRatioTerm);
  });

  it("sends the odd-WAD remainder of a balanced split to the wstDIEM leg", () => {
    // 3 wei total -> DIEM leg 1 wei, wstDIEM leg 2 wei.
    const [built] = buildLoopSizingScenarios(DEFAULT_CONFIG, {
      initialDiem: "100",
      targetLeverage: "1.5",
      curveDepthDiem: "0.000000000000000003",
    });
    expect(built.curveDiemLegDiem).toBe(1n);
    expect(built.curveWstDiemLegDiem).toBe(2n);
  });

  // Criterion 4: --curve-depth-diem with either leg flag is rejected (mutual exclusion). This
  // throws at grid-build time (mirroring --initial-diem/--initial-wstdiem); the CLI maps it to
  // INVALID_INPUT.
  it("rejects --curve-depth-diem combined with a leg flag", () => {
    expect(() =>
      buildLoopSizingScenarios(DEFAULT_CONFIG, {
        curveDepthDiem: "10000",
        curveDiemLeg: "5000",
      }),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      buildLoopSizingScenarios(DEFAULT_CONFIG, {
        curveDepthDiem: "10000",
        curveWstdiemLeg: "5000",
      }),
    ).toThrow(/mutually exclusive/);
  });

  // A preset that supplies a curve total also conflicts with a leg flag. Without this guard the
  // preset's curve intent would be silently dropped (the unspecified leg expands to the default
  // grid), so grid-build rejects it rather than honor a contradictory combination.
  it("rejects a preset-supplied curve total combined with a leg flag", () => {
    expect(() =>
      buildLoopSizingScenarios(DEFAULT_CONFIG, {
        preset: "current-zero",
        curveDiemLeg: "5000",
      }),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      buildLoopSizingScenarios(DEFAULT_CONFIG, {
        preset: "liquidity-sweep",
        curveWstdiemLeg: "5000",
      }),
    ).toThrow(/mutually exclusive/);
  });

  // Criterion 4 corollary: the balanced default preset maps its curve total to per-leg halves.
  // `current-zero` -> total 0 -> legs 0/0 (a fully drained pool), with no leg flags present.
  it("maps --preset current-zero to balanced 0/0 curve legs", () => {
    const scenarios = buildLoopSizingScenarios(DEFAULT_CONFIG, {
      initialDiem: "100",
      targetLeverage: "1.5",
      preset: "current-zero",
    });
    expect(scenarios.length).toBeGreaterThan(0);
    expect(
      scenarios.every((s) => s.curveDiemLegDiem === 0n && s.curveWstDiemLegDiem === 0n),
    ).toBe(true);
  });

  it("expands the two leg flags as an independent Cartesian grid", () => {
    const scenarios = buildLoopSizingScenarios(DEFAULT_CONFIG, {
      initialDiem: "100",
      targetLeverage: "1.5",
      curveDiemLeg: "1000,50000",
      curveWstdiemLeg: "2000,60000",
      morphoSupplyDiem: "1000",
    });
    // 1 initial x 1 leverage x (2 x 2 legs) x 1 supply x 1 vaultApy x 1 borrowDim = 4.
    expect(scenarios).toHaveLength(4);
    expect(scenarios.map((s) => [s.curveDiemLegDiem, s.curveWstDiemLegDiem])).toEqual([
      [parseDecimalToUnits("1000"), parseDecimalToUnits("2000")],
      [parseDecimalToUnits("1000"), parseDecimalToUnits("60000")],
      [parseDecimalToUnits("50000"), parseDecimalToUnits("2000")],
      [parseDecimalToUnits("50000"), parseDecimalToUnits("60000")],
    ]);
  });

  // Criterion 9: a zero DRAWN leg -> +Infinity, and JSON serializes it as "Infinity".
  it("returns +Infinity when the drawn leg is empty and serializes it as a string", () => {
    const emptyDiemLeg = sizeLoopScenario(
      scenario({ curveDiemLegDiem: 0n, curveWstDiemLegDiem: parseDecimalToUnits("50000") }),
    );
    expect(emptyDiemLeg.exitSlippageBps).toBe(Number.POSITIVE_INFINITY);
    // Entry draws the (non-empty) wstDIEM leg, so it stays finite.
    expect(Number.isFinite(emptyDiemLeg.estimatedEntrySlippageBps)).toBe(true);

    const emptyWstDiemLeg = sizeLoopScenario(
      scenario({ curveDiemLegDiem: parseDecimalToUnits("50000"), curveWstDiemLegDiem: 0n }),
    );
    expect(emptyWstDiemLeg.estimatedEntrySlippageBps).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isFinite(emptyWstDiemLeg.exitSlippageBps)).toBe(true);

    const report = buildLoopSizingReport([
      scenario({ curveDiemLegDiem: 0n, curveWstDiemLegDiem: parseDecimalToUnits("50000") }),
    ]);
    const parsed = JSON.parse(stringifyJson(report)) as {
      results: Array<{ exitSlippageBps: string }>;
    };
    expect(parsed.results[0].exitSlippageBps).toBe("Infinity");
  });

  it("labels the report curveDepthModel as linear-per-leg-depth-share", () => {
    const report = buildLoopSizingReport([scenario()]);
    expect(report.assumptions.curveDepthModel).toBe("linear-per-leg-depth-share");
  });

  // Criterion 8: the reconstructed total (diemLeg + wstDiemLeg) feeds gate 1's depth check.
  it("feeds gate 1's depth-sufficiency check from the reconstructed leg total", () => {
    // required depth for 100 @1.5x is 1000. Relax the slippage cap so ONLY the depth
    // sub-condition can trip gate 1.
    const sufficient = sizeLoopScenario(
      scenario({
        curveDiemLegDiem: parseDecimalToUnits("600"),
        curveWstDiemLegDiem: parseDecimalToUnits("600"),
        morphoSupplyDiem: parseDecimalToUnits("100000"),
        maxSlippageBps: 100_000,
      }),
    );
    const insufficient = sizeLoopScenario(
      scenario({
        curveDiemLegDiem: parseDecimalToUnits("400"),
        curveWstDiemLegDiem: parseDecimalToUnits("400"),
        morphoSupplyDiem: parseDecimalToUnits("100000"),
        maxSlippageBps: 100_000,
      }),
    );
    // Neither single leg reaches 1000; only the SUM (1200 vs 800) decides depth sufficiency.
    expect(sufficient.blockers).not.toContain("curve_liquidity_insufficient");
    expect(insufficient.blockers).toContain("curve_liquidity_insufficient");
    expect(sufficient.requiredCurveDepthDiem).toBe(parseDecimalToUnits("1000"));
  });

  // R3: the imbalance warning rides the verdict when the pool is materially lopsided.
  it("warns on a materially imbalanced pool and stays quiet on a balanced one", () => {
    const imbalanced = sizeLoopScenario(
      scenario({
        curveDiemLegDiem: parseDecimalToUnits("1000"),
        curveWstDiemLegDiem: parseDecimalToUnits("50000"),
        gasCostDiem: parseDecimalToUnits("1"),
      }),
    );
    expect(imbalanced.warnings).toContain("curve legs imbalanced");

    const balanced = sizeLoopScenario(
      scenario({
        curveDiemLegDiem: parseDecimalToUnits("10000"),
        curveWstDiemLegDiem: parseDecimalToUnits("10000"),
        gasCostDiem: parseDecimalToUnits("1"),
      }),
    );
    expect(balanced.warnings).not.toContain("curve legs imbalanced");
  });
});

describe("SPEC002 rev-2 — externalExitSlippageBps seam (R2)", () => {
  // Criterion 5: the injected value replaces the exit value at ALL FOUR consumption sites.
  it("replaces the exit value at gate 1", () => {
    const base = sizeLoopScenario(viableBase());
    expect(base.blockers).not.toContain("curve_liquidity_insufficient");
    expect(base.exitSlippageSource).toBe("estimate");

    // 500 bps > the 300 bps cap trips gate 1's exit sub-condition (depth is ample).
    const injected = sizeLoopScenario(viableBase({ externalExitSlippageBps: 500 }));
    expect(injected.exitSlippageSource).toBe("get_dy");
    expect(injected.exitSlippageBps).toBe(500);
    expect(injected.blockers).toContain("curve_liquidity_insufficient");
  });

  it("replaces the exit value in the exit-slippage cost feeding netApy", () => {
    const base = sizeLoopScenario(viableBase());
    // 250 bps stays under the cap (no gate-1 block) but raises the exit cost, so netApy drops.
    const injected = sizeLoopScenario(viableBase({ externalExitSlippageBps: 250 }));
    expect(injected.blockers).not.toContain("curve_liquidity_insufficient");
    expect(injected.netApyBps).toBeLessThan(base.netApyBps);
  });

  it("replaces the exit value in the unwind_not_covered backstop", () => {
    // Relax the slippage cap so gate 1 does not pre-empt the unwind backstop (SPEC002 §5).
    const base = sizeLoopScenario(viableBase({ maxSlippageBps: 10_000 }));
    expect(base.blockers).not.toContain("unwind_not_covered");

    const injected = sizeLoopScenario(
      viableBase({ maxSlippageBps: 10_000, externalExitSlippageBps: 9000 }),
    );
    // unwindDiemOut = floor(150 * (10000-9000)/10000) = 15 < unwindRepayRequired 51.5.
    expect(injected.unwindDiemOut).toBe(parseDecimalToUnits("15"));
    expect(injected.blockers).toContain("unwind_not_covered");
  });

  it("replaces the exit value in the isMarginal band", () => {
    const base = sizeLoopScenario(viableBase());
    expect(base.status).toBe("viable");
    // 260 bps > 0.8*300 = 240 (near the cap) but <= cap -> classifies marginal, not blocked.
    const injected = sizeLoopScenario(viableBase({ externalExitSlippageBps: 260 }));
    expect(injected.blockers).toHaveLength(0);
    expect(injected.status).toBe("marginal");
  });

  it("marks a negative or >10000 injected value as scenario_invalid, and keeps the bounds valid", () => {
    const negative = sizeLoopScenario(viableBase({ externalExitSlippageBps: -1 }));
    expect(negative.firstBlocker).toBe("scenario_invalid");
    const tooLarge = sizeLoopScenario(viableBase({ externalExitSlippageBps: 10_001 }));
    expect(tooLarge.firstBlocker).toBe("scenario_invalid");

    // The [0, 10000] bounds are valid.
    expect(sizeLoopScenario(viableBase({ externalExitSlippageBps: 0 })).blockers).not.toContain(
      "scenario_invalid",
    );
    expect(sizeLoopScenario(viableBase({ externalExitSlippageBps: 10_000 })).blockers).not.toContain(
      "scenario_invalid",
    );
  });
});

describe("SPEC002 rev-2 — gas in one-time cost (R3)", () => {
  // Criterion 7: gas folds into oneTimeCostDiem -> netApy; gasCostDiem == 0 emits the warning.
  it("folds gasCostDiem into oneTimeCostDiem and flips a viable scenario on large-enough gas", () => {
    const noGas = sizeLoopScenario(viableBase());
    expect(noGas.warnings).toContain("gas unmodeled");
    expect(noGas.netApyBps).toBeGreaterThan(0);
    expect(noGas.blockers).not.toContain("net_apy_below_threshold");

    const withGas = sizeLoopScenario(viableBase({ gasCostDiem: parseDecimalToUnits("25") }));
    // Exact fold: the only delta is the 25 DIEM gas term.
    expect(withGas.oneTimeCostDiem).toBe(noGas.oneTimeCostDiem + parseDecimalToUnits("25"));
    expect(withGas.netApyBps).toBeLessThan(noGas.netApyBps);
    expect(withGas.blockers).toContain("net_apy_below_threshold");
    // A supplied gas figure clears the unmodeled warning.
    expect(withGas.warnings).not.toContain("gas unmodeled");
  });

  it("wires --gas-cost-diem through the grid builder as a single value", () => {
    const scenarios = buildLoopSizingScenarios(DEFAULT_CONFIG, {
      initialDiem: "100",
      targetLeverage: "1.5",
      curveDepthDiem: "20000",
      gasCostDiem: "3",
    });
    expect(scenarios.every((s) => s.gasCostDiem === parseDecimalToUnits("3"))).toBe(true);
  });
});

// SPEC002 rev-3 Wave 1 — additive shortfall/legibility fields (E1/E2). Purely additive: these tests
// assert new fields only and never re-assert a status/blocker (Wave 1 changes zero verdicts).
describe("SPEC002 rev-3 — E1 shortfall fields", () => {
  // AC1: a passing gate → every shortfall is exactly 0 (the "0 iff sub-condition passes" invariant).
  it("reports every shortfall as 0 on a passing (candidate) scenario", () => {
    const result = sizeLoopScenario(scenario());
    expect(result.status).toBe("viable"); // unchanged verdict (Wave 1 additive)
    expect(result.curveDiemLegSlippageShortfallDiem).toBe(0n);
    expect(result.curveDiemLegShortfallDiem).toBe(0n);
    expect(result.curveWstDiemLegShortfallDiem).toBe(0n);
    expect(result.exitSlippageExcessBps).toBe(0);
    expect(result.morphoSupplyShortfallDiem).toBe(0n);
    expect(result.netApyShortfallBps).toBe(0);
  });

  // AC1: on a slippage-blocked scenario the DIEM-leg slippage shortfall is exact AND directional —
  // adding it to the DIEM leg brings the (offline/linear) exit slippage to ≤ the cap.
  it("computes an exact, directional curveDiemLegSlippageShortfallDiem for a slippage block", () => {
    const thinDiemLeg = sizeLoopScenario(
      scenario({
        curveFeeBps: 4,
        maxSlippageBps: 300,
        curveDiemLegDiem: parseDecimalToUnits("5000"),
        curveWstDiemLegDiem: parseDecimalToUnits("50000"),
        morphoSupplyDiem: parseDecimalToUnits("100000"),
      }),
    );
    // Blocks on the curve gate via the exit-slippage sub-condition (154bps cap exceeded).
    expect(thinDiemLeg.firstBlocker).toBe("curve_liquidity_insufficient");
    // position = ceil(100 × 1.5) = 150 DIEM; required leg = ceil(150·BPS/(300−4)).
    const position = parseDecimalToUnits("150");
    const requiredDiemLeg =
      (position * 10_000n + (296n - 1n)) / 296n; // ceilDiv(position*BPS, maxSlip−fee)
    const expectedShortfall = requiredDiemLeg - parseDecimalToUnits("5000");
    expect(thinDiemLeg.curveDiemLegSlippageShortfallDiem).toBe(expectedShortfall);
    expect(typeof thinDiemLeg.curveDiemLegSlippageShortfallDiem).toBe("bigint");
    // exitSlippageExcessBps > 0 iff exitSlippageBps > cap: 4 + 300 = 304 → excess 4.
    expect(thinDiemLeg.exitSlippageExcessBps).toBe(thinDiemLeg.exitSlippageBps - 300);
    expect(thinDiemLeg.exitSlippageExcessBps).toBeGreaterThan(0);
    // Directional: leg + shortfall clears the cap (offline/linear).
    const cured = sizeLoopScenario(
      scenario({
        curveFeeBps: 4,
        maxSlippageBps: 300,
        curveDiemLegDiem: parseDecimalToUnits("5000") + expectedShortfall,
        curveWstDiemLegDiem: parseDecimalToUnits("50000"),
        morphoSupplyDiem: parseDecimalToUnits("100000"),
      }),
    );
    expect(cured.exitSlippageBps).toBeLessThanOrEqual(300);
    expect(cured.exitSlippageExcessBps).toBe(0);
    expect(cured.curveDiemLegSlippageShortfallDiem).toBe(0n);
  });

  // AC1 (E4-backstop depth-SHARE gap): a thin-TOTAL-depth pool reports exact per-leg shortfalls,
  // and on a BALANCED pool each is HALF the TOTAL shortfall (not half the pool) — SPEC002 §E1.
  it("computes exact per-leg curve depth-share shortfalls, split evenly on a balanced pool", () => {
    const thinDepth = sizeLoopScenario(
      scenario({
        curveDiemLegDiem: parseDecimalToUnits("10"),
        curveWstDiemLegDiem: parseDecimalToUnits("10"),
        morphoSupplyDiem: parseDecimalToUnits("100000"),
      }),
    );
    // position = ceil(100 × 1.5) = 150; requiredCurveDepthDiem = ceil(150·BPS/1500) = 1000; per-leg = 500.
    const requiredPerLeg = parseDecimalToUnits("500");
    const leg = parseDecimalToUnits("10");
    expect(thinDepth.curveDiemLegShortfallDiem).toBe(requiredPerLeg - leg); // 490
    expect(thinDepth.curveWstDiemLegShortfallDiem).toBe(requiredPerLeg - leg); // 490
    // Balanced → each leg shortfall is HALF the TOTAL shortfall (requiredTotal 1000 − actualTotal 20).
    const totalShortfall = parseDecimalToUnits("1000") - parseDecimalToUnits("20"); // 980
    expect(thinDepth.curveDiemLegShortfallDiem + thinDepth.curveWstDiemLegShortfallDiem).toBe(
      totalShortfall,
    );
    // Directional: raising each leg to its per-leg requirement clears both shortfalls.
    const cured = sizeLoopScenario(
      scenario({
        curveDiemLegDiem: requiredPerLeg,
        curveWstDiemLegDiem: requiredPerLeg,
        morphoSupplyDiem: parseDecimalToUnits("100000"),
      }),
    );
    expect(cured.curveDiemLegShortfallDiem).toBe(0n);
    expect(cured.curveWstDiemLegShortfallDiem).toBe(0n);
  });

  // AC1: curveDiemLegSlippageShortfallDiem is the number sentinel Infinity when maxSlippage ≤ fee
  // (the cap can never be cleared by depth), and the existing JSON replacer emits "Infinity".
  it("emits Infinity for curveDiemLegSlippageShortfallDiem when maxSlippageBps ≤ curveFeeBps", () => {
    const unclearable = sizeLoopScenario(
      scenario({ curveFeeBps: 4, maxSlippageBps: 4 }),
    );
    expect(unclearable.curveDiemLegSlippageShortfallDiem).toBe(Number.POSITIVE_INFINITY);
    const json = JSON.parse(stringifyJson(unclearable));
    expect(json.curveDiemLegSlippageShortfallDiem).toBe("Infinity");
  });

  // AC1: a zero drawn (DIEM) leg → exitSlippageBps is +Infinity offline, so exitSlippageExcessBps is
  // +Infinity too (NOT clamped to 0), serialized "Infinity". The slippage-depth shortfall stays a
  // finite bigint (maxSlippage 300 > fee 4).
  it("keeps exitSlippageExcessBps Infinity on a zero drawn leg (never clamped to 0)", () => {
    const drained = sizeLoopScenario(
      scenario({ curveDiemLegDiem: 0n, curveWstDiemLegDiem: 0n }),
    );
    expect(drained.exitSlippageBps).toBe(Number.POSITIVE_INFINITY);
    expect(drained.exitSlippageExcessBps).toBe(Number.POSITIVE_INFINITY);
    expect(typeof drained.curveDiemLegSlippageShortfallDiem).toBe("bigint");
    const json = JSON.parse(stringifyJson(drained));
    expect(json.exitSlippageExcessBps).toBe("Infinity");
  });

  // AC1: morpho + net-apy shortfalls are max(0, req − actual) and directional.
  it("reports morphoSupplyShortfallDiem and netApyShortfallBps as max(0, req − actual)", () => {
    const morphoShort = sizeLoopScenario(
      scenario({
        curveDiemLegDiem: parseDecimalToUnits("50000"),
        curveWstDiemLegDiem: parseDecimalToUnits("50000"),
        morphoSupplyDiem: parseDecimalToUnits("10"),
      }),
    );
    expect(morphoShort.firstBlocker).toBe("morpho_supply_insufficient");
    expect(morphoShort.morphoSupplyShortfallDiem).toBe(
      morphoShort.requiredMorphoSupplyDiem - parseDecimalToUnits("10"),
    );
    expect(morphoShort.morphoSupplyShortfallDiem).toBeGreaterThan(0n);

    const apyShort = sizeLoopScenario(
      scenario({
        curveDiemLegDiem: parseDecimalToUnits("50000"),
        curveWstDiemLegDiem: parseDecimalToUnits("50000"),
        morphoSupplyDiem: parseDecimalToUnits("100000"),
        minNetApyBps: 100_000, // unreachable → guaranteed net-apy block
      }),
    );
    expect(apyShort.firstBlocker).toBe("net_apy_below_threshold");
    expect(apyShort.netApyShortfallBps).toBe(100_000 - apyShort.netApyBps);
    expect(apyShort.netApyShortfallBps).toBeGreaterThan(0);
  });
});

describe("SPEC002 rev-3 — E2 structuralMarginToLiquidationBps", () => {
  // AC2: 10000×(HF−10000)/HF rounded; HF 25800 → 6124.
  it("re-expresses a finite HF as structural liquidation distance (25800 → 6124)", () => {
    const result = sizeLoopScenario(scenario());
    expect(result.healthFactorBps).toBe(25_800);
    expect(result.structuralMarginToLiquidationBps).toBe(6124);
  });

  // AC2: null mirrors a debt-free (HF null) position — never +Infinity.
  it("is null when healthFactorBps is null (debt-free position)", () => {
    const debtFree = sizeLoopScenario(scenario({ targetLeverageBps: 10_000 }));
    expect(debtFree.healthFactorBps).toBeNull();
    expect(debtFree.structuralMarginToLiquidationBps).toBeNull();
  });

  // AC2: 0 when HF ≤ 10000 (leverage/LLTV puts the position at or past liquidation at entry).
  it("is 0 when HF ≤ 10000", () => {
    const lowHf = sizeLoopScenario(
      scenario({ lltvBps: 5000, targetLeverageBps: 30_000 }),
    );
    expect(lowHf.healthFactorBps).toBe(7500);
    expect(lowHf.structuralMarginToLiquidationBps).toBe(0);
  });
});

describe("SPEC002 rev-3 — E3 stressed-rate netAPY (output + proximity-gated verdict-ride)", () => {
  // A high-utilization loop (util > 70%) whose base netAPY passes but whose stressed netAPY (borrow at
  // 4×rateAtTarget) misses the floor. supply 63 → borrow 50 → util ~79%. flat borrow 200 (base) vs the
  // full-util APR ~1600 (stressed); gross = round(1.5·340) = 510, so base netApy > 0 but stressed < 0.
  function highUtilStressedFail(
    overrides: Partial<Parameters<typeof sizeLoopScenario>[0]> = {},
  ) {
    return scenario({
      curveDiemLegDiem: parseDecimalToUnits("50000"),
      curveWstDiemLegDiem: parseDecimalToUnits("50000"),
      morphoSupplyDiem: parseDecimalToUnits("63"),
      borrowRateModel: "flat",
      borrowApyBps: 200,
      vaultApyBps: 340,
      ...overrides,
    });
  }

  // AC3: netApyStressedBps uses borrowAprAtFullUtilizationBps (4× rateAtTarget), differs from netApyBps
  // ONLY by the borrow term, and is well-defined in flat mode (full-util APR, not the flat borrowApyBps).
  it("emits netApyStressedBps = gross − round((lev−1)·fullUtilApr) − annualizedOneTime (flat mode)", () => {
    const result = sizeLoopScenario(highUtilStressedFail());
    const lev = result.scenario.targetLeverageBps / 10_000;
    const expected =
      result.grossVaultApyBps -
      Math.round((lev - 1) * result.borrowAprAtFullUtilizationBps) -
      result.annualizedOneTimeCostBps;
    expect(result.netApyStressedBps).toBe(expected);
    // Well-defined in flat mode: it prices at the full-util APR (~1600), NOT the flat borrowApyBps (200).
    expect(result.borrowAprAtFullUtilizationBps).not.toBe(result.scenario.borrowApyBps);
    expect(result.effectiveBorrowApyBps).toBe(result.scenario.borrowApyBps);
    // The two netAPYs differ ONLY by the borrow term (same gross / annualizedOneTime).
    expect(result.netApyBps - result.netApyStressedBps).toBe(
      Math.round((lev - 1) * result.borrowAprAtFullUtilizationBps) - result.borrowCostApyBps,
    );
  });

  // AC3: netApyStressedBps ≤ netApyBps whenever the stressed (full-util) rate ≥ the effective rate.
  it("is ≤ netApyBps when the stressed rate ≥ the effective rate", () => {
    const result = sizeLoopScenario(highUtilStressedFail());
    expect(result.borrowAprAtFullUtilizationBps).toBeGreaterThanOrEqual(
      result.effectiveBorrowApyBps,
    );
    expect(result.netApyStressedBps).toBeLessThanOrEqual(result.netApyBps);
  });

  // AC3: proximity gate, HIGH-util direction — passes all gates but stressedNearFail → marginal + warning.
  it("demotes a clean-pass high-util scenario to marginal and rides the warning (util > 7000)", () => {
    const result = sizeLoopScenario(highUtilStressedFail());
    expect(result.blockers).toEqual([]); // passes every gate
    expect(result.postDrawUtilizationBps).toBeGreaterThan(7000);
    expect(result.netApyBps).toBeGreaterThanOrEqual(result.scenario.minNetApyBps); // base passes
    expect(result.netApyStressedBps).toBeLessThan(result.scenario.minNetApyBps); // stressed fails
    expect(result.status).toBe("marginal");
    expect(result.warnings).toContain("net apy negative under sustained max utilization");
  });

  // AC3: proximity gate, LOW-util direction — the SAME scenario at ≤7000 util (deeper Morpho supply)
  // stays the clean-pass status with NO warning/demotion, yet still emits the SAME netApyStressedBps.
  it("keeps the clean-pass status with no warning below the band, still emitting netApyStressedBps", () => {
    const highUtil = sizeLoopScenario(highUtilStressedFail());
    // Deeper supply → util collapses below the band; borrow-cost/gross/oneTime are supply-independent,
    // so grossVaultApyBps / annualizedOneTimeCostBps / netApyStressedBps are unchanged.
    const lowUtil = sizeLoopScenario(
      highUtilStressedFail({ morphoSupplyDiem: parseDecimalToUnits("100000") }),
    );
    expect(lowUtil.blockers).toEqual([]);
    expect(lowUtil.postDrawUtilizationBps).toBeLessThanOrEqual(7000);
    expect(lowUtil.status).toBe("viable"); // clean-pass (pre-E5 token); NOT marginal
    expect(lowUtil.warnings).not.toContain("net apy negative under sustained max utilization");
    // The number is still emitted, and is identical to the high-util case (supply-independent).
    expect(lowUtil.netApyStressedBps).toBe(highUtil.netApyStressedBps);
    expect(lowUtil.netApyStressedBps).toBeLessThan(lowUtil.scenario.minNetApyBps);
  });

  // AC3: the warning is independent of status (like `gas unmodeled`), so it rides a BLOCKED verdict too.
  // supply 62 blocks the Morpho gate while base netApy still passes; util ~81% + stressed < min → warning.
  it("rides a blocked verdict when stressedNearFail (warning is status-independent)", () => {
    const result = sizeLoopScenario(
      highUtilStressedFail({ morphoSupplyDiem: parseDecimalToUnits("62") }),
    );
    expect(result.status).toBe("blocked");
    expect(result.blockers).toContain("morpho_supply_insufficient");
    expect(result.postDrawUtilizationBps).toBeGreaterThan(7000);
    expect(result.netApyBps).toBeGreaterThanOrEqual(result.scenario.minNetApyBps); // not a netApy block
    expect(result.netApyStressedBps).toBeLessThan(result.scenario.minNetApyBps);
    expect(result.warnings).toContain("net apy negative under sustained max utilization");
  });
});
