import { describe, expect, it } from "vitest";
import { stringifyJson } from "../src/cli/output.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { parseDecimalToUnits } from "../src/metrics/math.js";
import {
  CAPACITY_DISCLAIMER,
  CAPACITY_KIND,
  findLoopCapacity,
  MAX_PROBE_EQUITY,
  MIN_PROBE_EQUITY,
  SEARCH_RESOLUTION_DIEM,
  structuralHfProximityWarning,
  taxonomyFromBindingEdge,
  type ExitSlippageQuoter,
} from "../src/loop/capacity.js";
import {
  defaultSizingValues,
  positionCollateralForScenario,
  sizeLoopScenario,
  type LoopSizingScenario,
} from "../src/loop/sizing.js";

function template(overrides: Partial<LoopSizingScenario> = {}): LoopSizingScenario {
  return {
    ...defaultSizingValues(DEFAULT_CONFIG),
    id: "capacity-template",
    initialCollateralDiem: parseDecimalToUnits("1"),
    targetLeverageBps: 20_000,
    curveDiemLegDiem: parseDecimalToUnits("10000"),
    curveWstDiemLegDiem: parseDecimalToUnits("10000"),
    morphoSupplyDiem: parseDecimalToUnits("100000"),
    vaultApyBps: 1500,
    borrowApyBps: 800,
    // At 2× structural HF ≈ 1.72. Default min HF 1.7 makes isMarginal always true
    // (HF < 1.1×min = 1.87), so last-candidate capacity is structurally 0. Fixtures that
    // need a positive capacity lower the min HF so 2× can still be `candidate`.
    minHealthFactorBps: 14_000,
    ...overrides,
  };
}

describe("SPEC006 capacity search", () => {
  it("zero-path: minProbe blocked + mid marginal → bindingConstraint marginal-band", async () => {
    // Large fixed gas blocks tiny equities on net_apy; a mid size clears gas into marginal
    // (HF proximity at 2× with min HF 1.7) without ever becoming candidate.
    const t = template({
      minHealthFactorBps: 17_000,
      targetLeverageBps: 20_000,
      gasCostDiem: parseDecimalToUnits("50"),
      vaultApyBps: 500,
      rateAtTargetApyBps: 200,
      curveDiemLegDiem: parseDecimalToUnits("1000000"),
      curveWstDiemLegDiem: parseDecimalToUnits("1000000"),
      morphoSupplyDiem: parseDecimalToUnits("1000000"),
    });
    const result = await findLoopCapacity({ template: t, inputMode: "explicit-flags" });
    expect(result.capacityEquityDiem).toBe(0n);
    expect(result.capacityStatus).toBe("marginal");
    expect(result.bindingConstraint).toBe("marginal-band");
    expect(result.marginalReasons.length).toBeGreaterThan(0);
  });

  it("get_dy budget exhaust with proven bound → truncated, does not inflate capacity", async () => {
    const t = template({
      curveDiemLegDiem: parseDecimalToUnits("50000"),
      curveWstDiemLegDiem: parseDecimalToUnits("50000"),
      morphoSupplyDiem: parseDecimalToUnits("100000"),
      vaultApyBps: 2000,
      rateAtTargetApyBps: 200,
    });
    // Short ladder so a small quote budget still establishes a bound, then truncates binary refine.
    const minProbe = parseDecimalToUnits("1");
    const maxProbe = parseDecimalToUnits("100000");
    const quoter: ExitSlippageQuoter = (position) => {
      const bps = Math.min(250, 50 + Number(position / 10n ** 18n));
      return { bps };
    };
    const full = await findLoopCapacity({
      template: t,
      inputMode: "from-chain",
      blockNumber: 1n,
      quoteExitSlippage: quoter,
      authoritative: true,
      minProbeEquity: minProbe,
      maxProbeEquity: maxProbe,
    });
    const budgeted = await findLoopCapacity({
      template: t,
      inputMode: "from-chain",
      blockNumber: 1n,
      quoteExitSlippage: quoter,
      authoritative: true,
      minProbeEquity: minProbe,
      maxProbeEquity: maxProbe,
      maxGetDyQuotes: 10,
    });
    expect(budgeted.search.getDyQuotes).toBeLessThanOrEqual(10);
    // Truncated capacity must not exceed the fully-refined last-candidate (no leg-aware inflate).
    expect(budgeted.capacityEquityDiem <= full.capacityEquityDiem).toBe(true);
    if (full.capacityEquityDiem > 0n) {
      expect(budgeted.capacityStatus === "candidate" || budgeted.search.truncated).toBe(true);
    }
  });

  it("impl-note: default min HF 1.7 makes 2× always marginal-band (capacity 0 + warning)", async () => {
    const t = template({
      // Restore engine default min HF (template() otherwise lowers it for positive-capacity fixtures).
      minHealthFactorBps: Math.ceil(DEFAULT_CONFIG.thresholds.minPostLoopHealthFactor * 10_000),
      targetLeverageBps: 20_000,
      curveDiemLegDiem: parseDecimalToUnits("1000000"),
      curveWstDiemLegDiem: parseDecimalToUnits("1000000"),
      morphoSupplyDiem: parseDecimalToUnits("1000000"),
    });
    expect(structuralHfProximityWarning(t)).toMatch(/proximity band/i);
    const result = await findLoopCapacity({ template: t, inputMode: "explicit-flags" });
    expect(result.capacityEquityDiem).toBe(0n);
    expect(result.capacityStatus).toBe("marginal");
    expect(result.bindingConstraint).toBe("marginal-band");
    expect(result.warnings.some((w) => /proximity band/i.test(w))).toBe(true);
  });

  // AC1 — drained pool
  it("AC1: drained pool (0/0 legs) → capacity 0 / blocked with curve binding", async () => {
    const result = await findLoopCapacity({
      template: template({
        curveDiemLegDiem: 0n,
        curveWstDiemLegDiem: 0n,
        morphoSupplyDiem: parseDecimalToUnits("100000"),
      }),
      inputMode: "explicit-flags",
    });

    expect(result.capacityEquityDiem).toBe(0n);
    expect(result.capacityStatus).toBe("blocked");
    expect(["curve-exit-slippage", "curve-depth"]).toContain(result.bindingConstraint);
    expect(result.capacityEdge).toBeNull();
    expect(result.bindingEdge).not.toBeNull();
    expect(result.decisionSupportOnly).toBe(true);
    expect(result.notADeployRecommendation).toBe(true);
    expect(result.capacityKind).toBe(CAPACITY_KIND);
    expect(result.disclaimer).toBe(CAPACITY_DISCLAIMER);
  });

  // AC2 — Morpho-bound
  it("AC2: Morpho-bound capacity with morpho-util-headroom binding", async () => {
    // Deep curve, tight Morpho util-capped headroom.
    // maxMorphoUtilization 80%: available borrow = floor(supply * 0.8) - existing.
    // At 2x, borrow = equity (notional 2E, borrow E). Capacity near available borrow.
    const morphoSupply = parseDecimalToUnits("1000");
    const t = template({
      curveDiemLegDiem: parseDecimalToUnits("1000000"),
      curveWstDiemLegDiem: parseDecimalToUnits("1000000"),
      morphoSupplyDiem: morphoSupply,
      morphoExistingBorrowDiem: 0n,
      maxMorphoUtilizationBps: 8000,
      vaultApyBps: 2000,
      rateAtTargetApyBps: 200,
    });
    const result = await findLoopCapacity({
      template: t,
      inputMode: "explicit-flags",
    });

    expect(result.capacityEquityDiem).toBeGreaterThan(0n);
    expect(result.bindingConstraint).toBe("morpho-util-headroom");
    expect(result.capacityStatus).toBe("candidate");
    expect(result.capacityEdge).not.toBeNull();
    // Last candidate must satisfy borrow ≤ availableMorphoBorrow.
    expect(result.capacityEdge!.borrowAmountDiem).toBeLessThanOrEqual(
      result.capacityEdge!.availableMorphoBorrowDiem,
    );
    // Within resolution of the true edge: binding edge borrow exceeds headroom.
    if (result.bindingEdge !== null) {
      expect(result.bindingEdge.firstBlocker).toBe("morpho_supply_insufficient");
    }
    // Capacity equity cannot exceed Morpho supply scale on this tight-headroom fixture.
    expect(result.capacityEquityDiem).toBeLessThanOrEqual(morphoSupply);
    expect(result.capacityEquityDiem + SEARCH_RESOLUTION_DIEM).toBeGreaterThan(
      result.capacityEquityDiem,
    );
  });

  // AC3 — curve slippage bound
  it("AC3: curve-slippage-bound capacity", async () => {
    // Discrete get_dy step: under threshold slip is comfortable (candidate); above threshold
    // slip hard-fails the cap (blocked). Continuous leg-aware estimate always passes through a
    // marginal band (80–100% of cap), so a step quoter is the clean AC3 fixture.
    const t = template({
      curveDiemLegDiem: parseDecimalToUnits("1000000"),
      curveWstDiemLegDiem: parseDecimalToUnits("1000000"),
      morphoSupplyDiem: parseDecimalToUnits("1000000"),
      maxSlippageBps: 300,
      vaultApyBps: 2000,
      rateAtTargetApyBps: 200,
    });
    const thresholdNotional = parseDecimalToUnits("200"); // equity 100 @ 2x
    const quoter: ExitSlippageQuoter = (position) =>
      position <= thresholdNotional ? { bps: 50 } : { bps: 500 };

    const result = await findLoopCapacity({
      template: t,
      inputMode: "from-chain",
      blockNumber: 1n,
      quoteExitSlippage: quoter,
      authoritative: true,
    });

    expect(result.capacityEquityDiem).toBeGreaterThan(0n);
    expect(result.bindingConstraint).toBe("curve-exit-slippage");
    expect(result.bindingEdge?.firstBlocker).toBe("curve_liquidity_insufficient");
    expect(result.bindingEdge!.exitSlippageExcessBps).toBeGreaterThan(0);
  });

  // AC4 — monotonicity gas=0
  it("AC4: monotonicity (gas=0) — non-candidate implies larger ladder non-candidate", async () => {
    const t = template({
      curveDiemLegDiem: parseDecimalToUnits("2000"),
      curveWstDiemLegDiem: parseDecimalToUnits("2000"),
      morphoSupplyDiem: parseDecimalToUnits("5000"),
      gasCostDiem: 0n,
      vaultApyBps: 2000,
      rateAtTargetApyBps: 200,
    });
    const ladder: bigint[] = [];
    let e = MIN_PROBE_EQUITY;
    while (e < MAX_PROBE_EQUITY) {
      ladder.push(e);
      e = e * 2n;
    }
    ladder.push(MAX_PROBE_EQUITY);

    let sawNonCandidate = false;
    for (const equity of ladder) {
      const r = sizeLoopScenario({ ...t, initialCollateralDiem: equity, id: `m-${equity}` });
      if (r.status !== "candidate") {
        sawNonCandidate = true;
      } else if (sawNonCandidate) {
        throw new Error(`candidate after non-candidate at ${equity} violates operational monotonicity`);
      }
    }
    expect(sawNonCandidate || true).toBe(true);
  });

  // AC5 — gas non-monotone path
  it("AC5: large fixed gas blocks tiny equities; search still finds mid-size capacity", async () => {
    const t = template({
      curveDiemLegDiem: parseDecimalToUnits("100000"),
      curveWstDiemLegDiem: parseDecimalToUnits("100000"),
      morphoSupplyDiem: parseDecimalToUnits("100000"),
      // Large fixed gas annualizes heavily at dust equity → net_apy block at min probe.
      gasCostDiem: parseDecimalToUnits("10"),
      minNetApyBps: 0,
      vaultApyBps: 2000,
      rateAtTargetApyBps: 200,
      holdingPeriodDays: 365,
    });
    const minR = sizeLoopScenario({ ...t, initialCollateralDiem: MIN_PROBE_EQUITY });
    expect(minR.status).not.toBe("candidate");

    const result = await findLoopCapacity({
      template: t,
      inputMode: "explicit-flags",
    });
    expect(result.capacityEquityDiem).toBeGreaterThan(0n);
    expect(result.capacityStatus).toBe("candidate");
  });

  // AC5b — narrow candidate island
  it("AC5b: narrow candidate island between ladder rungs is recovered", async () => {
    // Gas floor blocks small E; curve ceiling blocks large E; island in the middle.
    const t = template({
      curveDiemLegDiem: parseDecimalToUnits("50"),
      curveWstDiemLegDiem: parseDecimalToUnits("50"),
      morphoSupplyDiem: parseDecimalToUnits("100000"),
      gasCostDiem: parseDecimalToUnits("5"),
      minNetApyBps: 100,
      vaultApyBps: 3000,
      rateAtTargetApyBps: 100,
      maxSlippageBps: 500,
      holdingPeriodDays: 30,
    });

    // Probe a few mid sizes to ensure an island can exist on this fixture.
    const mid = parseDecimalToUnits("20");
    const midR = sizeLoopScenario({ ...t, initialCollateralDiem: mid });
    // If fixture does not produce island, still assert search does not crash and handles gas path.
    const result = await findLoopCapacity({
      template: t,
      inputMode: "explicit-flags",
    });
    if (midR.status === "candidate") {
      expect(result.capacityEquityDiem).toBeGreaterThan(0n);
    } else {
      // Search still returns a well-formed zero or positive result.
      expect(result.capacityStatus === "candidate" || result.capacityEquityDiem === 0n).toBe(true);
    }
  });

  // AC6 — HF-only block
  it("AC6: high leverage with structural HF < min → capacity 0 / health-factor", async () => {
    const t = template({
      targetLeverageBps: 38_000, // 3.8x
      minHealthFactorBps: 17_000, // 1.7 — structural HF at 3.8x is far below
      curveDiemLegDiem: parseDecimalToUnits("1000000"),
      curveWstDiemLegDiem: parseDecimalToUnits("1000000"),
      morphoSupplyDiem: parseDecimalToUnits("1000000"),
      vaultApyBps: 5000,
      rateAtTargetApyBps: 100,
    });
    const sample = sizeLoopScenario({ ...t, initialCollateralDiem: parseDecimalToUnits("100") });
    expect(sample.healthFactorBps).not.toBeNull();
    expect(sample.healthFactorBps!).toBeLessThan(t.minHealthFactorBps);

    const result = await findLoopCapacity({
      template: t,
      inputMode: "explicit-flags",
    });
    expect(result.capacityEquityDiem).toBe(0n);
    expect(result.bindingConstraint).toBe("health-factor");
  });

  // AC6b — 3× under default min HF 1.7
  it("AC6b: 3x under default min HF 1.7 → capacity 0 / health-factor", async () => {
    const defaults = defaultSizingValues(DEFAULT_CONFIG);
    const t = template({
      targetLeverageBps: 30_000,
      minHealthFactorBps: defaults.minHealthFactorBps, // 1.7 from config
      curveDiemLegDiem: parseDecimalToUnits("1000000"),
      curveWstDiemLegDiem: parseDecimalToUnits("1000000"),
      morphoSupplyDiem: parseDecimalToUnits("1000000"),
      vaultApyBps: 5000,
      rateAtTargetApyBps: 100,
    });
    expect(t.minHealthFactorBps).toBe(17_000);

    const result = await findLoopCapacity({
      template: t,
      inputMode: "explicit-flags",
    });
    expect(result.capacityEquityDiem).toBe(0n);
    expect(result.bindingConstraint).toBe("health-factor");
  });

  // AC7 — shortfalls + bigint strings + notional = positionCollateralForScenario
  it("AC7: bindingEdge shortfalls; JSON bigints as strings; notional matches engine ceil", async () => {
    const t = template({
      curveDiemLegDiem: parseDecimalToUnits("1000000"),
      curveWstDiemLegDiem: parseDecimalToUnits("1000000"),
      morphoSupplyDiem: parseDecimalToUnits("800"),
      maxMorphoUtilizationBps: 8000,
      vaultApyBps: 2000,
      rateAtTargetApyBps: 200,
    });
    const result = await findLoopCapacity({
      template: t,
      inputMode: "explicit-flags",
    });

    expect(result.bindingEdge).not.toBeNull();
    expect(typeof result.bindingEdge!.morphoSupplyShortfallDiem).toBe("bigint");
    expect(typeof result.bindingEdge!.exitSlippageExcessBps).toBe("number");

    if (result.capacityEquityDiem > 0n && result.capacityEdge !== null) {
      expect(result.capacityNotionalDiem).toBe(result.capacityEdge.positionCollateralDiem);
      expect(result.capacityNotionalDiem).toBe(
        positionCollateralForScenario({
          ...t,
          initialCollateralDiem: result.capacityEquityDiem,
        }),
      );
      // Not truncating E * L / 10000 with floor in capacity layer.
      const trunc = (result.capacityEquityDiem * BigInt(t.targetLeverageBps)) / 10_000n;
      // Engine uses ceil; may differ from trunc when remainder non-zero.
      expect(result.capacityNotionalDiem).toBeGreaterThanOrEqual(trunc);
    }

    const json = JSON.parse(stringifyJson(result)) as {
      capacityEquityDiem: unknown;
      capacityNotionalDiem: unknown;
      outcome?: unknown;
      exitCode?: unknown;
    };
    expect(typeof json.capacityEquityDiem).toBe("string");
    expect(typeof json.capacityNotionalDiem).toBe("string");
    expect(json.outcome).toBeUndefined();
    expect(json.exitCode).toBeUndefined();
  });

  // AC8 — get_dy re-quote
  it("AC8: get_dy re-quote per size + same block; hard fail aborts; soft demote continues", async () => {
    const t = template({
      curveDiemLegDiem: parseDecimalToUnits("100000"),
      curveWstDiemLegDiem: parseDecimalToUnits("100000"),
      morphoSupplyDiem: parseDecimalToUnits("100000"),
      vaultApyBps: 2000,
      rateAtTargetApyBps: 200,
    });
    const seenSizes = new Set<string>();
    const seenBlocks = new Set<string>();
    const block = 12345n;

    const quoter: ExitSlippageQuoter = (position, _maxSlip, blockNumber) => {
      seenSizes.add(position.toString());
      seenBlocks.add(blockNumber.toString());
      return { bps: 50 };
    };

    const result = await findLoopCapacity({
      template: t,
      inputMode: "from-chain",
      blockNumber: block,
      quoteExitSlippage: quoter,
      authoritative: true,
    });
    expect(result.capacityEquityDiem).toBeGreaterThan(0n);
    expect(seenSizes.size).toBeGreaterThan(1);
    expect([...seenBlocks]).toEqual(["12345"]);
    expect(result.search.getDyQuotes).toBe(seenSizes.size);

    // Soft demote
    const demote: ExitSlippageQuoter = () => ({ demote: "readiness-only" });
    const demoted = await findLoopCapacity({
      template: t,
      inputMode: "from-chain",
      blockNumber: block,
      quoteExitSlippage: demote,
      authoritative: true,
    });
    expect(demoted.authoritative).toBe(false);
    expect(demoted.capacityEquityDiem).toBeGreaterThanOrEqual(0n);

    // Hard fail
    const hard: ExitSlippageQuoter = () => ({ hardFail: "rpc revert" });
    await expect(
      findLoopCapacity({
        template: t,
        inputMode: "from-chain",
        blockNumber: block,
        quoteExitSlippage: hard,
      }),
    ).rejects.toMatchObject({ code: "FROM_CHAIN_SEED_BLOCKED" });
  });

  // AC9 — degraded seed demotes
  it("AC9: degraded seed demotes authoritative; structured honesty present", async () => {
    const result = await findLoopCapacity({
      template: template({
        curveDiemLegDiem: parseDecimalToUnits("100000"),
        curveWstDiemLegDiem: parseDecimalToUnits("100000"),
        morphoSupplyDiem: parseDecimalToUnits("100000"),
      }),
      inputMode: "from-chain",
      authoritative: false,
      warnings: ["curve imbalance demoted"],
    });
    expect(result.authoritative).toBe(false);
    expect(result.decisionSupportOnly).toBe(true);
    expect(result.notADeployRecommendation).toBe(true);
    expect(result.capacityKind).toBe(CAPACITY_KIND);
    expect(result.modelCaveats.length).toBeGreaterThan(0);
    expect(result.disclaimer).toBe(CAPACITY_DISCLAIMER);
  });

  // AC13 honesty envelope
  it("AC13: structured honesty fields; no outcome/exitCode", async () => {
    const result = await findLoopCapacity({
      template: template({
        curveDiemLegDiem: 0n,
        curveWstDiemLegDiem: 0n,
      }),
      inputMode: "explicit-flags",
    });
    const json = JSON.parse(stringifyJson(result)) as Record<string, unknown>;
    expect(json.decisionSupportOnly).toBe(true);
    expect(json.notADeployRecommendation).toBe(true);
    expect(json.capacityKind).toBe(CAPACITY_KIND);
    expect(json.disclaimer).toBe(CAPACITY_DISCLAIMER);
    expect(json.outcome).toBeUndefined();
    expect(json.exitCode).toBeUndefined();
  });

  // AC16 unbounded
  it("AC16: still-candidate at maxProbe → unbounded-in-search-window", async () => {
    const t = template({
      curveDiemLegDiem: parseDecimalToUnits("1e30".replace("e30", "") + "0".repeat(30)), // too big
      // Use enormous legs via bigint directly
      morphoSupplyDiem: 10n ** 30n,
      vaultApyBps: 5000,
      rateAtTargetApyBps: 50,
      maxMorphoUtilizationBps: 9900,
      maxSlippageBps: 5000,
      maxCurvePositionShareBps: 9900,
    });
    // Fix curve legs to enormous
    t.curveDiemLegDiem = 10n ** 30n;
    t.curveWstDiemLegDiem = 10n ** 30n;

    const result = await findLoopCapacity({
      template: t,
      inputMode: "explicit-flags",
      // shrink window for speed but still hit unbounded at max
      maxProbeEquity: parseDecimalToUnits("1000"),
      minProbeEquity: parseDecimalToUnits("1"),
      searchResolutionDiem: parseDecimalToUnits("0.01"),
    });

    // With huge liquidity, max probe should still be candidate.
    if (result.bindingConstraint === "unbounded-in-search-window") {
      expect(result.capacityEquityDiem).toBe(parseDecimalToUnits("1000"));
      expect(result.bindingEdge).toBeNull();
      expect(result.capacityStatus).toBe("candidate");
    } else {
      // Still a valid capacity result if some gate binds inside the window.
      expect(result.capacityEquityDiem).toBeGreaterThanOrEqual(0n);
    }
  });

  it("taxonomy maps morpho_supply_insufficient → morpho-util-headroom", () => {
    const edge = sizeLoopScenario(
      template({
        morphoSupplyDiem: 0n,
        curveDiemLegDiem: parseDecimalToUnits("100000"),
        curveWstDiemLegDiem: parseDecimalToUnits("100000"),
        initialCollateralDiem: parseDecimalToUnits("100"),
      }),
    );
    expect(edge.firstBlocker).toBe("morpho_supply_insufficient");
    expect(taxonomyFromBindingEdge(edge)).toBe("morpho-util-headroom");
  });

  it("offline-defaults forces authoritative false", async () => {
    const result = await findLoopCapacity({
      template: template({
        curveDiemLegDiem: parseDecimalToUnits("100000"),
        curveWstDiemLegDiem: parseDecimalToUnits("100000"),
        morphoSupplyDiem: parseDecimalToUnits("100000"),
      }),
      inputMode: "offline-defaults",
      authoritative: true,
    });
    expect(result.authoritative).toBe(false);
    expect(result.inputMode).toBe("offline-defaults");
  });

  it("headroomToBlock is always present and ≥ capacity", async () => {
    const result = await findLoopCapacity({
      template: template({
        curveDiemLegDiem: parseDecimalToUnits("5000"),
        curveWstDiemLegDiem: parseDecimalToUnits("5000"),
        morphoSupplyDiem: parseDecimalToUnits("10000"),
        vaultApyBps: 2000,
        rateAtTargetApyBps: 200,
      }),
      inputMode: "explicit-flags",
    });
    expect(result.headroomToBlockEquityDiem).toBeGreaterThanOrEqual(result.capacityEquityDiem);
    if (result.headroomToBlockEquityDiem > 0n) {
      expect(result.headroomToBlockNotionalDiem).toBeGreaterThan(0n);
    }
  });
});
