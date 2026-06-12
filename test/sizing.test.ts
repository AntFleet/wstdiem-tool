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
    curveDepthDiem: parseDecimalToUnits("10000"),
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
        curveDepthDiem: 0n,
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
        curveDepthDiem: parseDecimalToUnits("10000"),
        morphoSupplyDiem: 0n,
      }),
    );

    expect(result.status).toBe("blocked");
    expect(result.firstBlocker).toBe("morpho_supply_insufficient");
    expect(result.requiredMorphoSupplyDiem).toBe(parseDecimalToUnits("62.5"));
  });

  it("blocks on net APY when borrow cost overwhelms vault yield", () => {
    const result = sizeLoopScenario(
      scenario({
        curveDepthDiem: parseDecimalToUnits("20000"),
        morphoSupplyDiem: parseDecimalToUnits("10000"),
        targetLeverageBps: 20_000,
        borrowApyBps: 5000,
      }),
    );

    expect(result.status).toBe("blocked");
    expect(result.firstBlocker).toBe("net_apy_below_threshold");
    expect(result.netApyBps).toBeLessThan(0);
  });

  it("marks a sufficiently liquid positive-spread scenario viable", () => {
    const result = sizeLoopScenario(scenario());

    expect(result.status).toBe("viable");
    expect(result.firstBlocker).toBeNull();
    expect(result.borrowAmountDiem).toBe(parseDecimalToUnits("50"));
    expect(result.healthFactorBps).toBe(25_800);
  });

  it("expands scenario grids and summarizes first viable assumptions by leverage", () => {
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
    expect(report.summary.firstViableByLeverage).toEqual([
      {
        targetLeverageBps: 15_000,
        requiredCurveDepthDiem: parseDecimalToUnits("1000"),
        requiredMorphoSupplyDiem: parseDecimalToUnits("62.5"),
        status: "viable",
        scenarioId: "scenario-0004",
      },
      {
        targetLeverageBps: 20_000,
        requiredCurveDepthDiem: parseDecimalToUnits("1333.333333333333333334"),
        requiredMorphoSupplyDiem: parseDecimalToUnits("125"),
        status: "marginal",
        scenarioId: "scenario-0010",
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
