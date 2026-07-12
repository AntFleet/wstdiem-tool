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

function scenario(overrides: Partial<Parameters<typeof sizeLoopScenario>[0]> = {}) {
  return {
    ...defaultSizingValues(DEFAULT_CONFIG),
    id: "test",
    initialCollateralDiem: parseDecimalToUnits("100"),
    targetLeverageBps: 15_000,
    // SPEC002 rev-2: legs 10000/10000 (total 20000). The canonical candidate case re-pins from a
    // total of 10000 to 20000 so the leg-aware exit slippage (4 + ratioBps(150, 10000) = 154 bps)
    // stays under the 300 bps cap.
    curveDiemLegDiem: parseDecimalToUnits("10000"),
    curveWstDiemLegDiem: parseDecimalToUnits("10000"),
    morphoSupplyDiem: parseDecimalToUnits("100"),
    vaultApyBps: 1500,
    borrowApyBps: 800,
    ...overrides,
  };
}

describe("loop sizing simulator", () => {
  it("blocks on Curve liquidity first when depth is too low", () => {
    const result = sizeLoopScenario(
      scenario({
        curveDiemLegDiem: 0n,
        curveWstDiemLegDiem: 0n,
        morphoSupplyDiem: parseDecimalToUnits("10000"),
      }),
    );

    expect(result.status).toBe("blocked");
    expect(result.firstBlocker).toBe("curve_liquidity_insufficient");
    expect(result.requiredCurveDepthDiem).toBe(parseDecimalToUnits("1000"));
  });

  it("blocks on Morpho supply first when borrow liquidity is unavailable", () => {
    const result = sizeLoopScenario(
      scenario({
        // Total 20000 (legs 10000) so exit slip 154 bps < 300 cap — Curve passes and Morpho
        // (supply 0) is the first blocker. rev-1 used total 10000, which under leg-aware
        // slippage would itself block on exit slip (304 bps).
        curveDiemLegDiem: parseDecimalToUnits("10000"),
        curveWstDiemLegDiem: parseDecimalToUnits("10000"),
        morphoSupplyDiem: 0n,
      }),
    );

    expect(result.status).toBe("blocked");
    expect(result.firstBlocker).toBe("morpho_supply_insufficient");
    expect(result.requiredMorphoSupplyDiem).toBe(parseDecimalToUnits("62.5"));
  });

  it("blocks on net APY when borrow cost overwhelms vault yield (flat model)", () => {
    const result = sizeLoopScenario(
      scenario({
        curveDiemLegDiem: parseDecimalToUnits("10000"),
        curveWstDiemLegDiem: parseDecimalToUnits("10000"),
        morphoSupplyDiem: parseDecimalToUnits("10000"),
        targetLeverageBps: 20_000,
        borrowRateModel: "flat",
        borrowApyBps: 5000,
      }),
    );

    expect(result.status).toBe("blocked");
    expect(result.firstBlocker).toBe("net_apy_below_threshold");
    expect(result.netApyBps).toBeLessThan(0);
  });

  it("prices borrow cost from post-draw utilization under the adaptive-curve model", () => {
    const shallow = sizeLoopScenario(
      scenario({ morphoSupplyDiem: parseDecimalToUnits("60"), rateAtTargetApyBps: 400 }),
    );
    const deep = sizeLoopScenario(
      scenario({ morphoSupplyDiem: parseDecimalToUnits("100000"), rateAtTargetApyBps: 400 }),
    );

    // Same 50 DIEM borrow, but the shallow pool is driven to a far higher
    // utilization, so its effective borrow APR and cost are strictly higher.
    expect(shallow.borrowRateModel).toBe("adaptive-curve");
    expect(shallow.postDrawUtilizationBps).toBeGreaterThan(deep.postDrawUtilizationBps);
    expect(shallow.effectiveBorrowApyBps).toBeGreaterThan(deep.effectiveBorrowApyBps);
    // Curve reference points depend only on rateAtTarget: 4x steeper at 100% vs 90%.
    expect(deep.borrowAprAtFullUtilizationBps).toBeGreaterThan(deep.borrowAprAtTargetBps);
  });

  it("adaptive-curve blocks a loop whose own draw spikes the borrow rate that flat misses", () => {
    const base = {
      curveDiemLegDiem: parseDecimalToUnits("50000"),
      curveWstDiemLegDiem: parseDecimalToUnits("50000"),
      morphoSupplyDiem: parseDecimalToUnits("250"),
      initialCollateralDiem: parseDecimalToUnits("100"),
      targetLeverageBps: 30_000, // 3x -> borrow 200 against 250 supply = 80% post-draw util
      vaultApyBps: 1500,
      rateAtTargetApyBps: 3000,
    };
    const flat = sizeLoopScenario(scenario({ ...base, borrowRateModel: "flat", borrowApyBps: 400 }));
    const adaptive = sizeLoopScenario(scenario({ ...base, borrowRateModel: "adaptive-curve" }));

    // A flat 4% borrow assumption pencils the loop out positive...
    expect(flat.netApyBps).toBeGreaterThan(0);
    // ...but pricing the borrow at the ~80% utilization it actually creates
    // (rateAtTarget 30% -> ~27% APR near the cap) flips net APY negative and blocks it.
    expect(adaptive.effectiveBorrowApyBps).toBeGreaterThan(flat.effectiveBorrowApyBps);
    expect(adaptive.netApyBps).toBeLessThan(0);
    expect(adaptive.blockers).toContain("net_apy_below_threshold");
  });

  it("labels the borrow model in report assumptions", () => {
    const adaptive = buildLoopSizingReport(
      buildLoopSizingScenarios(DEFAULT_CONFIG, { rateAtTargetApyBps: "217" }),
    );
    expect(adaptive.assumptions.borrowRateModel).toBe("adaptive-curve-instantaneous");
    const flat = buildLoopSizingReport(
      buildLoopSizingScenarios(DEFAULT_CONFIG, { borrowRateModel: "flat" }),
    );
    expect(flat.assumptions.borrowRateModel).toBe("flat");
  });

  it("marks a sufficiently liquid positive-spread scenario candidate", () => {
    const result = sizeLoopScenario(scenario());

    expect(result.status).toBe("candidate");
    expect(result.firstBlocker).toBeNull();
    expect(result.borrowAmountDiem).toBe(parseDecimalToUnits("50"));
    expect(result.healthFactorBps).toBe(25_800);
  });

  it("expands scenario grids and summarizes first candidate assumptions by leverage", () => {
    const scenarios = buildLoopSizingScenarios(DEFAULT_CONFIG, {
      initialDiem: "100",
      targetLeverage: "1.5,2",
      curveDepthDiem: "0,10000,20000",
      morphoSupplyDiem: "0,10000",
      vaultApyBps: "1500",
      borrowApyBps: "800",
    });
    const report = buildLoopSizingReport(scenarios);

    expect(scenarios).toHaveLength(12);
    expect(report.summary.total).toBe(12);
    // rev-2 re-baseline: under leg-aware slippage the total-10000 scenarios (balanced legs 5000)
    // now block on exit slip (1.5x -> 304 bps, 2x -> 404 bps), so the cheapest UNBLOCKED
    // scenario per leverage shifts to the total-20000 rows (scenario-0006, scenario-0012). The
    // required-depth / required-supply / status values are unchanged (required depth is a pure
    // function of position size, not actual depth).
    expect(report.summary.firstCandidateByLeverage).toEqual([
      {
        targetLeverageBps: 15_000,
        requiredCurveDepthDiem: parseDecimalToUnits("1000"),
        requiredMorphoSupplyDiem: parseDecimalToUnits("62.5"),
        status: "candidate",
        scenarioId: "scenario-0006",
      },
      {
        targetLeverageBps: 20_000,
        requiredCurveDepthDiem: parseDecimalToUnits("1333.333333333333333334"),
        requiredMorphoSupplyDiem: parseDecimalToUnits("125"),
        status: "marginal",
        scenarioId: "scenario-0012",
      },
    ]);
  });

  it("serializes token amounts as JSON strings", () => {
    const report = buildLoopSizingReport([scenario()]);
    const parsed = JSON.parse(stringifyJson(report)) as {
      results: Array<{ borrowAmountDiem: string; scenario: { initialCollateralDiem: string } }>;
    };

    expect(parsed.results[0].scenario.initialCollateralDiem).toBe("100000000000000000000");
    expect(parsed.results[0].borrowAmountDiem).toBe("50000000000000000000");
  });
});
