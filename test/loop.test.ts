import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { assertBroadcastNotAllowed, buildLoopExecutorParamsForCommand, projectLoopCommand } from "../src/cli/loop.js";

describe("loop safety behavior", () => {
  it("blocks open when SPEC001 deployment config is missing", () => {
    const projection = projectLoopCommand(DEFAULT_CONFIG, {
      action: "open",
      targetLeverage: 3,
      initialDiem: "100",
      dryRun: true,
    });
    expect(projection.blocked).toBe(true);
    expect(projection.safeToProceed).toBe(false);
    expect(projection.kind).toBe("projection");
    expect(projection.simulation.status).toBe("not_run");
    expect(projection.executorParamsAvailable).toBe(false);
    expect(projection.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain(
      "deployment-config:fail",
    );
    expect(projection.blockers.join(" ")).toContain("LoopExecutor");
    expect(projection.blockers.join(" ")).toContain("projection-only");
    expect(projection.projectedPositionNotionalDiemWei).toBe("300000000000000000000");
  });

  it("rejects invalid leverage and excessive slippage", () => {
    expect(() =>
      projectLoopCommand(DEFAULT_CONFIG, {
        action: "open",
        targetLeverage: 4,
        initialDiem: "100",
      }),
    ).toThrow(/targetLeverage/);
    expect(() =>
      projectLoopCommand(DEFAULT_CONFIG, {
        action: "rebalance",
        targetLeverage: 2,
        slippageBps: 301,
      }),
    ).toThrow(/hard max/);
  });

  it("returns Morpho authorization calldata when owner and executor are configured", () => {
    const config = {
      ...DEFAULT_CONFIG,
      contracts: {
        ...DEFAULT_CONFIG.contracts,
        inferenceVault: "0x0000000000000000000000000000000000000001" as const,
        feeRouter: "0x0000000000000000000000000000000000000002" as const,
        curvePool: "0x0000000000000000000000000000000000000003" as const,
        morphoOracle: "0x0000000000000000000000000000000000000004" as const,
        loopExecutor: "0x0000000000000000000000000000000000000005" as const,
      },
      morpho: {
        ...DEFAULT_CONFIG.morpho,
        marketId: `0x${"11".repeat(32)}` as const,
      },
      position: {
        owner: "0x0000000000000000000000000000000000000006" as const,
      },
    };
    const projection = projectLoopCommand(config, {
      action: "rebalance",
      targetLeverage: 2,
      dryRun: true,
    });
    expect(projection.blocked).toBe(true);
    expect(projection.executorParamsAvailable).toBe(true);
    expect(projection.executorCalldata?.startsWith("0x")).toBe(true);
    expect(projection.blockers.join(" ")).toContain("executor simulation unavailable");
    expect(projection.authorizationCalldata?.to).toBe(DEFAULT_CONFIG.contracts.morphoBlue);
    expect(projection.authorizationCalldata?.data.startsWith("0x")).toBe(true);
  });

  it("does not build unprotected open or exit calldata without live quote bounds", () => {
    const config = {
      ...DEFAULT_CONFIG,
      contracts: {
        ...DEFAULT_CONFIG.contracts,
        inferenceVault: "0x0000000000000000000000000000000000000001" as const,
        morphoOracle: "0x0000000000000000000000000000000000000004" as const,
      },
      position: {
        owner: "0x0000000000000000000000000000000000000006" as const,
      },
    };
    const built = buildLoopExecutorParamsForCommand(config, {
      action: "open",
      targetLeverage: 3,
      initialDiem: "100",
    });
    expect(built.owner).toBe(config.position.owner);
    expect(built.params).toBeNull();

    const exit = buildLoopExecutorParamsForCommand(config, {
      action: "exit",
    });
    expect(exit.params).toBeNull();
  });

  it("builds typed executor params for configured rebalance commands", () => {
    const config = {
      ...DEFAULT_CONFIG,
      contracts: {
        ...DEFAULT_CONFIG.contracts,
        inferenceVault: "0x0000000000000000000000000000000000000001" as const,
        morphoOracle: "0x0000000000000000000000000000000000000004" as const,
      },
      position: {
        owner: "0x0000000000000000000000000000000000000006" as const,
      },
    };
    const built = buildLoopExecutorParamsForCommand(config, {
      action: "rebalance",
      targetLeverage: 2,
      slippageBps: 25,
      nowSeconds: 100,
    });
    expect(built.owner).toBe(config.position.owner);
    expect(built.params).toMatchObject({
      owner: config.position.owner,
      targetLeverageWad: 2_000_000_000_000_000_000n,
      maxSlippageBps: 25n,
      deadline: 400n,
    });
  });

  it("throws a typed safety error before broadcast", () => {
    const projection = projectLoopCommand(DEFAULT_CONFIG, {
      action: "open",
      targetLeverage: 2,
      initialDiem: "1",
      dryRun: false,
    });
    expect(() => assertBroadcastNotAllowed(projection)).toThrow(/missing deployment config/);
  });

  it("rejects non-finite leverage", () => {
    expect(() =>
      projectLoopCommand(DEFAULT_CONFIG, {
        action: "rebalance",
        targetLeverage: Number.NaN,
      }),
    ).toThrow(/finite/);
  });
});
