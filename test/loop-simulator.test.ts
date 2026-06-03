import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { simulateMorphoAuthorization } from "../src/loop/authorization.js";
import { buildConfiguredMarketParams, buildLoopRebalanceParams } from "../src/loop/params.js";
import { runLoopPreflight, type LoopPreflightClient } from "../src/loop/preflight.js";
import { simulateLoopExecutorCall, type LoopSimulationClient } from "../src/loop/simulator.js";
import type { LoopSafetyEvidence } from "../src/loop/types.js";
import { WAD } from "../src/metrics/math.js";
import type { Address, AppConfig, Hex } from "../src/types/domain.js";

const owner = "0x0000000000000000000000000000000000000009" as const;

function safetyEvidence(baseApy = 0.2): LoopSafetyEvidence {
  return {
    signer: {
      source: "test",
      address: owner,
      verified: true,
    },
    baseApy: {
      source: "test",
      chainId: 8453,
      blockNumber: 1n,
      windowSeconds: 604_800,
      baseApy,
      valid: true,
    },
  };
}

function completeConfig(): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    rpc: {
      ...DEFAULT_CONFIG.rpc,
      primaryUrl: "https://base.example.invalid",
    },
    contracts: {
      ...DEFAULT_CONFIG.contracts,
      inferenceVault: "0x0000000000000000000000000000000000000001",
      feeRouter: "0x0000000000000000000000000000000000000002",
      curvePool: "0x0000000000000000000000000000000000000003",
      morphoOracle: "0x0000000000000000000000000000000000000004",
      loopExecutor: "0x0000000000000000000000000000000000000005",
    },
    morpho: {
      ...DEFAULT_CONFIG.morpho,
      marketId: `0x${"11".repeat(32)}` as Hex,
    },
    position: {
      owner,
    },
  };
}

class MockPreflightClient implements LoopPreflightClient {
  constructor(
    private readonly options: {
      chainId?: number;
      code?: Hex;
      vaultAsset?: Address;
      authorized?: boolean;
      marketParams?: readonly [Address, Address, Address, Address, bigint];
      positionCollateral?: bigint;
      positionBorrowShares?: bigint;
      marketTotalBorrowAssets?: bigint;
      marketTotalBorrowShares?: bigint;
      curveDiemBalance?: bigint;
      curveWstDiemBalance?: bigint;
      navWad?: bigint;
      borrowRatePerSecond?: bigint;
    } = {},
  ) {}

  async getChainId(): Promise<number> {
    return this.options.chainId ?? 8453;
  }

  async getCode(_address: Address): Promise<Hex> {
    return this.options.code ?? "0x01";
  }

  async readContract(args: { functionName: string; args?: readonly unknown[] }): Promise<unknown> {
    if (args.functionName === "asset") {
      return this.options.vaultAsset ?? DEFAULT_CONFIG.contracts.diem;
    }
    if (args.functionName === "convertToAssets") {
      const shares = BigInt(args.args?.[0] as bigint | number | string);
      return (shares * (this.options.navWad ?? WAD)) / WAD;
    }
    if (args.functionName === "balances") {
      return args.args?.[0] === 0n
        ? (this.options.curveDiemBalance ?? 500n * WAD)
        : (this.options.curveWstDiemBalance ?? 500n * WAD);
    }
    if (args.functionName === "isAuthorized") {
      return this.options.authorized ?? true;
    }
    if (args.functionName === "position") {
      return [0n, this.options.positionBorrowShares ?? 0n, this.options.positionCollateral ?? 100n * WAD];
    }
    if (args.functionName === "market") {
      return [
        1_000n * WAD,
        1_000n * WAD,
        this.options.marketTotalBorrowAssets ?? 100n * WAD,
        this.options.marketTotalBorrowShares ?? 100n * WAD,
        0n,
        0n,
      ];
    }
    if (args.functionName === "borrowRateView") {
      return this.options.borrowRatePerSecond ?? 0n;
    }
    if (args.functionName === "idToMarketParams") {
      return (
        this.options.marketParams ?? [
          DEFAULT_CONFIG.contracts.diem,
          "0x0000000000000000000000000000000000000001",
          "0x0000000000000000000000000000000000000004",
          DEFAULT_CONFIG.contracts.adaptiveCurveIrm,
          BigInt(DEFAULT_CONFIG.morpho.lltvWad),
        ]
      );
    }
    throw new Error(`unexpected readContract ${args.functionName}`);
  }
}

class MockSimulationClient extends MockPreflightClient implements LoopSimulationClient {
  constructor(
    options: ConstructorParameters<typeof MockPreflightClient>[0] & {
      simulateError?: Error;
      gas?: bigint;
    } = {},
  ) {
    super(options);
    this.simulateError = options.simulateError;
    this.gas = options.gas ?? 123_456n;
  }

  private readonly simulateError: Error | undefined;
  private readonly gas: bigint;

  async simulateContract(): Promise<unknown> {
    if (this.simulateError !== undefined) {
      throw this.simulateError;
    }
    return {};
  }

  async estimateContractGas(): Promise<bigint> {
    return this.gas;
  }
}

describe("loop preflight and simulation", () => {
  it("reports static preflight failures before on-chain checks", async () => {
    const checks = await runLoopPreflight(DEFAULT_CONFIG, null, new MockPreflightClient());
    expect(checks.map((check) => `${check.key}:${check.status}`)).toContain("deployment-config:fail");
    expect(checks.map((check) => `${check.key}:${check.status}`)).toContain("owner:fail");
    expect(checks.map((check) => `${check.key}:${check.status}`)).toContain("onchain-preflight:fail");
  });

  it("checks chain id, contract code, vault asset, and Morpho authorization", async () => {
    const checks = await runLoopPreflight(completeConfig(), owner, new MockPreflightClient({ authorized: false }));
    expect(checks.map((check) => `${check.key}:${check.status}`)).toContain("chain-id:pass");
    expect(checks.filter((check) => check.key === "contract-code" && check.status === "pass").length).toBeGreaterThan(
      0,
    );
    expect(checks.map((check) => `${check.key}:${check.status}`)).toContain("vault-asset:pass");
    expect(checks.map((check) => `${check.key}:${check.status}`)).toContain("morpho-authorization:fail");
    expect(checks.map((check) => `${check.key}:${check.status}`)).toContain("morpho-market-params:pass");
  });

  it("fails preflight when Morpho market params do not match config", async () => {
    const checks = await runLoopPreflight(
      completeConfig(),
      owner,
      new MockPreflightClient({
        marketParams: [
          DEFAULT_CONFIG.contracts.weth,
          "0x0000000000000000000000000000000000000001",
          "0x0000000000000000000000000000000000000004",
          DEFAULT_CONFIG.contracts.adaptiveCurveIrm,
          BigInt(DEFAULT_CONFIG.morpho.lltvWad),
        ],
      }),
    );
    const marketCheck = checks.find((check) => check.key === "morpho-market-params");
    expect(marketCheck?.status).toBe("fail");
    expect(marketCheck?.message).toContain("loanToken");
  });

  it("blocks simulation when no client is provided", async () => {
    const config = completeConfig();
    const params = buildLoopRebalanceParams({ config, owner, targetLeverage: 2, slippageBps: 25, nowSeconds: 1 });
    const result = await simulateLoopExecutorCall({ config, action: "rebalance", owner, from: owner, params });
    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("SIMULATION_CLIENT_MISSING");
  });

  it("blocks live simulation until SPEC001 strategy risk gates are implemented", async () => {
    const config = completeConfig();
    const params = buildLoopRebalanceParams({ config, owner, targetLeverage: 2, slippageBps: 25, nowSeconds: 1 });
    const result = await simulateLoopExecutorCall({
      config,
      action: "rebalance",
      owner,
      from: owner,
      params,
      client: new MockSimulationClient({ gas: 999n }),
    });
    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("PREFLIGHT_FAILED");
    expect(result.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain(
      "projected-health-factor:fail",
    );
    expect(result.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain(
      "morpho-market-params:pass",
    );
    expect(result.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain("route-slippage:fail");
  });

  it("passes projected health factor for conservative target leverage", async () => {
    const config = completeConfig();
    const params = buildLoopRebalanceParams({ config, owner, targetLeverage: 1.7, slippageBps: 25, nowSeconds: 1 });
    const result = await simulateLoopExecutorCall({
      config,
      action: "rebalance",
      owner,
      from: owner,
      params,
      client: new MockSimulationClient({ gas: 999n }),
    });
    expect(result.status).toBe("blocked");
    expect(result.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain(
      "projected-health-factor:pass",
    );
    expect(result.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain("curve-depth:pass");
    expect(result.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain("net-apy:fail");
  });

  it("passes net APY when base APY evidence covers live borrow rate", async () => {
    const config = completeConfig();
    const params = buildLoopRebalanceParams({ config, owner, targetLeverage: 1.7, slippageBps: 25, nowSeconds: 1 });
    const result = await simulateLoopExecutorCall({
      config,
      action: "rebalance",
      owner,
      from: owner,
      params,
      safetyEvidence: safetyEvidence(0.2),
      client: new MockSimulationClient({ borrowRatePerSecond: 0n }),
    });
    expect(result.status).toBe("blocked");
    expect(result.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain("net-apy:pass");
    expect(result.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain("oracle-deviation:fail");
  });

  it("fails net APY when target leverage carry is compressed", async () => {
    const config = completeConfig();
    const params = buildLoopRebalanceParams({ config, owner, targetLeverage: 1.7, slippageBps: 25, nowSeconds: 1 });
    const result = await simulateLoopExecutorCall({
      config,
      action: "rebalance",
      owner,
      from: owner,
      params,
      safetyEvidence: safetyEvidence(0.02),
      client: new MockSimulationClient({ borrowRatePerSecond: 0n }),
    });
    const netApy = result.preflightChecks.find((check) => check.key === "net-apy");
    expect(netApy?.status).toBe("fail");
    expect(netApy?.message).toContain("required 8.00%");
  });

  it("fails Curve depth when projected position exceeds 20 percent of pool TVL", async () => {
    const config = completeConfig();
    const params = buildLoopRebalanceParams({ config, owner, targetLeverage: 1.7, slippageBps: 25, nowSeconds: 1 });
    const result = await simulateLoopExecutorCall({
      config,
      action: "rebalance",
      owner,
      from: owner,
      params,
      safetyEvidence: safetyEvidence(),
      client: new MockSimulationClient({
        positionCollateral: 100n * WAD,
        curveDiemBalance: 200n * WAD,
        curveWstDiemBalance: 0n,
      }),
    });
    const curveDepth = result.preflightChecks.find((check) => check.key === "curve-depth");
    expect(curveDepth?.status).toBe("fail");
    expect(curveDepth?.message).toContain("max is 20.00%");
  });

  it("fails Curve depth against projected target notional instead of current collateral", async () => {
    const config = completeConfig();
    const params = buildLoopRebalanceParams({ config, owner, targetLeverage: 1.7, slippageBps: 25, nowSeconds: 1 });
    const result = await simulateLoopExecutorCall({
      config,
      action: "rebalance",
      owner,
      from: owner,
      params,
      safetyEvidence: safetyEvidence(),
      client: new MockSimulationClient({
        positionCollateral: 100n * WAD,
        curveDiemBalance: 600n * WAD,
        curveWstDiemBalance: 0n,
      }),
    });
    const curveDepth = result.preflightChecks.find((check) => check.key === "curve-depth");
    expect(curveDepth?.status).toBe("fail");
    expect(curveDepth?.message).toContain("28.33%");
  });

  it("uses position equity for Curve depth when a rebalance reduces gross notional", async () => {
    const config = completeConfig();
    const params = buildLoopRebalanceParams({ config, owner, targetLeverage: 1.7, slippageBps: 25, nowSeconds: 1 });
    const result = await simulateLoopExecutorCall({
      config,
      action: "rebalance",
      owner,
      from: owner,
      params,
      safetyEvidence: safetyEvidence(),
      client: new MockSimulationClient({
        positionCollateral: 500n * WAD,
        positionBorrowShares: 300n * WAD,
        marketTotalBorrowAssets: 300n * WAD,
        marketTotalBorrowShares: 300n * WAD,
        curveDiemBalance: 1_800n * WAD,
        curveWstDiemBalance: 0n,
      }),
    });
    const curveDepth = result.preflightChecks.find((check) => check.key === "curve-depth");
    expect(curveDepth?.status).toBe("pass");
    expect(curveDepth?.message).toContain("18.88%");
  });

  it("fails Curve depth when pool TVL is zero", async () => {
    const config = completeConfig();
    const params = buildLoopRebalanceParams({ config, owner, targetLeverage: 1.7, slippageBps: 25, nowSeconds: 1 });
    const result = await simulateLoopExecutorCall({
      config,
      action: "rebalance",
      owner,
      from: owner,
      params,
      client: new MockSimulationClient({
        curveDiemBalance: 0n,
        curveWstDiemBalance: 0n,
      }),
    });
    const curveDepth = result.preflightChecks.find((check) => check.key === "curve-depth");
    expect(curveDepth?.status).toBe("fail");
    expect(curveDepth?.message).toContain("TVL is zero");
  });

  it("blocks live simulation without a transaction sender", async () => {
    const config = completeConfig();
    const params = buildLoopRebalanceParams({ config, owner, targetLeverage: 2, slippageBps: 25, nowSeconds: 1 });
    const result = await simulateLoopExecutorCall({
      config,
      action: "rebalance",
      owner,
      from: null,
      params,
      client: new MockSimulationClient(),
    });
    expect(result.status).toBe("blocked");
    expect(result.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain("tx-sender:fail");
  });

  it("blocks live simulation without verified signer evidence matching the transaction sender", async () => {
    const config = completeConfig();
    const params = buildLoopRebalanceParams({ config, owner, targetLeverage: 1.7, slippageBps: 25, nowSeconds: 1 });
    const result = await simulateLoopExecutorCall({
      config,
      action: "rebalance",
      owner,
      from: owner,
      params,
      safetyEvidence: {
        ...safetyEvidence(),
        signer: {
          source: "test",
          address: "0x0000000000000000000000000000000000000010",
          verified: true,
        },
      },
      client: new MockSimulationClient(),
    });
    expect(result.status).toBe("blocked");
    expect(result.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain("tx-signer:fail");
  });

  it("fails direct open simulation until collateral and debt bound evidence exists", async () => {
    const config = completeConfig();
    const marketParams = buildConfiguredMarketParams(config);
    expect(marketParams).not.toBeNull();
    const result = await simulateLoopExecutorCall({
      config,
      action: "open",
      owner,
      from: owner,
      params:
        marketParams === null
          ? null
          : {
              owner,
              marketParams,
              initialDiem: 100n * WAD,
              flashDiem: 70n * WAD,
              minWstDiemReceived: 169n * WAD,
              minBorrowedDiem: 70n * WAD,
              maxCurvePriceImpactBps: 100n,
              deadline: 301n,
            },
      safetyEvidence: safetyEvidence(),
      client: new MockSimulationClient(),
    });
    const healthFactor = result.preflightChecks.find((check) => check.key === "projected-health-factor");
    expect(healthFactor?.status).toBe("fail");
    expect(healthFactor?.message).toContain("collateral and debt bound evidence");
  });

  it("returns structured failure when RPC-backed preflight reads fail", async () => {
    const config = completeConfig();
    const params = buildLoopRebalanceParams({ config, owner, targetLeverage: 2, slippageBps: 25, nowSeconds: 1 });
    const result = await simulateLoopExecutorCall({
      config,
      action: "rebalance",
      owner,
      from: owner,
      params,
      client: new MockSimulationClient({ chainId: 8453, simulateError: new Error("unused") }),
    });
    expect(result.status).toBe("blocked");

    const readFailure = await simulateLoopExecutorCall({
      config,
      action: "rebalance",
      owner,
      from: owner,
      params,
      client: {
        async getChainId() {
          throw new Error("rpc timeout");
        },
        async getCode() {
          return "0x01" as Hex;
        },
        async readContract() {
          return true;
        },
        async simulateContract() {
          return {};
        },
        async estimateContractGas() {
          return 1n;
        },
      },
    });
    expect(readFailure.status).toBe("failed");
    expect(readFailure.error?.code).toBe("PREFLIGHT_READ_FAILED");
  });

  it("blocks live authorization when no simulation client is provided", async () => {
    const config = completeConfig();
    const result = await simulateMorphoAuthorization({ config, owner });
    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("SIMULATION_CLIENT_MISSING");
    expect(result.authorizationCalldata?.data.startsWith("0x")).toBe(true);
  });

  it("reads existing authorization before simulating setAuthorization", async () => {
    const config = completeConfig();
    const result = await simulateMorphoAuthorization({
      config,
      owner,
      client: new MockSimulationClient({ authorized: true }),
    });
    expect(result.status).toBe("passed");
    expect(result.alreadyAuthorized).toBe(true);
    expect(result.gasEstimate).toBeUndefined();
  });

  it("simulates authorization calldata and gas when not already authorized", async () => {
    const config = completeConfig();
    const result = await simulateMorphoAuthorization({
      config,
      owner,
      client: new MockSimulationClient({ authorized: false, gas: 888n }),
    });
    expect(result.status).toBe("passed");
    expect(result.alreadyAuthorized).toBe(false);
    expect(result.gasEstimate).toBe("888");
    expect(result.authorizationCalldata?.to).toBe(config.contracts.morphoBlue);
  });
});
