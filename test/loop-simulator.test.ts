import { describe, expect, it } from "vitest";
import { encodeAbiParameters, pad, toEventHash } from "viem";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { simulateMorphoAuthorization } from "../src/loop/authorization.js";
import { buildLiveLoopExitPlan } from "../src/loop/exitPlan.js";
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

function safetyEvidenceWithRoute(baseApy = 0.2, priceImpactBps = 25): LoopSafetyEvidence {
  return {
    ...safetyEvidence(baseApy),
    routeSlippage: {
      source: "test",
      action: "rebalance",
      chainId: 8453,
      blockNumber: 1n,
      maxSlippageBps: 25,
      priceImpactBps,
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

function loopExitExecutedSimulationResult(args: {
  repayAmountDiem: bigint;
  flashFee: bigint;
  totalFlashRepaymentDiem: bigint;
  wstDiemSold: bigint;
  diemReceived: bigint;
  diemDustRefunded: bigint;
  wstDiemDustRefunded: bigint;
}): { logs: Array<{ data: Hex; topics: Hex[] }> } {
  return {
    logs: [
      {
        data: encodeAbiParameters(
          [
            { name: "repayAmountDiem", type: "uint256" },
            { name: "flashFee", type: "uint256" },
            { name: "totalFlashRepaymentDiem", type: "uint256" },
            { name: "wstDiemSold", type: "uint256" },
            { name: "diemReceived", type: "uint256" },
            { name: "diemDustRefunded", type: "uint256" },
            { name: "wstDiemDustRefunded", type: "uint256" },
          ],
          [
            args.repayAmountDiem,
            args.flashFee,
            args.totalFlashRepaymentDiem,
            args.wstDiemSold,
            args.diemReceived,
            args.diemDustRefunded,
            args.wstDiemDustRefunded,
          ],
        ),
        topics: [
          toEventHash("LoopExitExecuted(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256)"),
          pad(owner),
        ],
      },
    ],
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
      morphoOraclePrice?: bigint;
      curveDiemBalance?: bigint;
      curveWstDiemBalance?: bigint;
      curveExitQuote?: bigint;
      flashPoolDiemBalance?: bigint;
      executorFlashPool?: Address;
      executorFlashFee?: bigint;
      executorLoanTokenIsToken0?: boolean;
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

  async readContract(args: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> {
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
    if (args.functionName === "get_dy") {
      return this.options.curveExitQuote ?? 99n * WAD;
    }
    if (args.functionName === "balanceOf") {
      return this.options.flashPoolDiemBalance ?? 1_000n * WAD;
    }
    if (args.functionName === "canonicalFlashPool") {
      return this.options.executorFlashPool ?? DEFAULT_CONFIG.flashLoan.pool;
    }
    if (args.functionName === "expectedFlashFee") {
      return this.options.executorFlashFee ?? 500_000_000_000_000_000n;
    }
    if (args.functionName === "loanTokenIsToken0") {
      return this.options.executorLoanTokenIsToken0 ?? false;
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
    if (args.functionName === "price") {
      return this.options.morphoOraclePrice ?? WAD * WAD;
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
      simulationResult?: unknown;
      gas?: bigint;
    } = {},
  ) {
    super(options);
    this.simulateError = options.simulateError;
    this.simulationResult = options.simulationResult ?? {};
    this.gas = options.gas ?? 123_456n;
  }

  private readonly simulateError: Error | undefined;
  private readonly simulationResult: unknown;
  private readonly gas: bigint;
  public lastSimulateBlockNumber: bigint | undefined;
  public lastEstimateBlockNumber: bigint | undefined;

  async getBlockNumber(): Promise<bigint> {
    return 1n;
  }

  async simulateContract(args?: { blockNumber?: bigint }): Promise<unknown> {
    this.lastSimulateBlockNumber = args?.blockNumber;
    if (this.simulateError !== undefined) {
      throw this.simulateError;
    }
    return this.simulationResult;
  }

  async estimateContractGas(args?: { blockNumber?: bigint }): Promise<bigint> {
    this.lastEstimateBlockNumber = args?.blockNumber;
    return this.gas;
  }
}

describe("loop preflight and simulation", () => {
  it("reports static preflight failures before on-chain checks", async () => {
    const checks = await runLoopPreflight(
      {
        ...DEFAULT_CONFIG,
        contracts: {
          ...DEFAULT_CONFIG.contracts,
          loopExecutor: null,
        },
      },
      null,
      new MockPreflightClient(),
    );
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

  it("blocks live simulation until SPEC001 strategy risk gates and executor support are available", async () => {
    const config = completeConfig();
    const params = buildLoopRebalanceParams({ config, owner, targetLeverage: 2.1, slippageBps: 25, nowSeconds: 1 });
    const result = await simulateLoopExecutorCall({
      config,
      action: "rebalance",
      owner,
      from: owner,
      params,
      client: new MockSimulationClient({ gas: 999n }),
    });
    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("UNSUPPORTED_EXECUTOR_ACTION");
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
    expect(result.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain("oracle-deviation:pass");
    expect(result.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain("route-slippage:fail");
  });

  it("fails net APY when base APY evidence is older than the planning block tolerance", async () => {
    const config: AppConfig = {
      ...completeConfig(),
      execution: {
        ...completeConfig().execution,
        maxBaseApyStalenessBlocks: 0,
      },
    };
    const params = buildLoopRebalanceParams({ config, owner, targetLeverage: 1.7, slippageBps: 25, nowSeconds: 1 });
    const result = await simulateLoopExecutorCall({
      config,
      action: "rebalance",
      owner,
      from: owner,
      params,
      safetyEvidence: {
        ...safetyEvidence(0.2),
        baseApy: {
          source: "test",
          chainId: 8453,
          blockNumber: 0n,
          windowSeconds: 604_800,
          baseApy: 0.2,
          valid: true,
        },
      },
      client: new MockSimulationClient({ borrowRatePerSecond: 0n }),
    });
    const netApy = result.preflightChecks.find((check) => check.key === "net-apy");
    expect(netApy?.status).toBe("fail");
    expect(netApy?.message).toContain("1 blocks old");
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

  it("blocks live rebalance simulation even when every safety gate has evidence because the executor is exit-only", async () => {
    const config = completeConfig();
    const params = buildLoopRebalanceParams({ config, owner, targetLeverage: 1.7, slippageBps: 25, nowSeconds: 1 });
    const result = await simulateLoopExecutorCall({
      config,
      action: "rebalance",
      owner,
      from: owner,
      params,
      safetyEvidence: safetyEvidenceWithRoute(0.2, 25),
      client: new MockSimulationClient({ gas: 999n, borrowRatePerSecond: 0n }),
    });
    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("UNSUPPORTED_EXECUTOR_ACTION");
    expect(result.gasEstimate).toBeUndefined();
    expect(result.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain("route-slippage:pass");
    expect(result.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain("executor-action:fail");
  });

  it("passes live exit simulation with exact exit params and route quote evidence", async () => {
    const config = completeConfig();
    const client = new MockSimulationClient({
      gas: 999n,
      positionBorrowShares: 50n * WAD,
      marketTotalBorrowAssets: 100n * WAD,
      marketTotalBorrowShares: 100n * WAD,
      simulationResult: loopExitExecutedSimulationResult({
        repayAmountDiem: 50n * WAD,
        flashFee: 510_000_000_000_000_000n,
        totalFlashRepaymentDiem: 51_510_000_000_000_000_000n,
        wstDiemSold: 100n * WAD,
        diemReceived: 98_752_500_000_000_000_000n,
        diemDustRefunded: 48_242_500_000_000_000_000n,
        wstDiemDustRefunded: 0n,
      }),
    });
    const exitPlan = await buildLiveLoopExitPlan({
      config,
      owner,
      preflightClient: client,
      routeQuoteClient: client,
      slippageBps: 25,
      nowSeconds: 1,
    });
    expect(exitPlan.params).not.toBeNull();

    const result = await simulateLoopExecutorCall({
      config,
      action: "exit",
      owner,
      from: owner,
      params: exitPlan.params,
      safetyEvidence: {
        ...safetyEvidence(0.2),
        routeSlippage: exitPlan.routeSlippage,
        flashLoanLiquidity: exitPlan.flashLoanLiquidity,
      },
      client,
    });

    expect(result.status).toBe("passed");
    expect(result.gasEstimate).toBe("999");
    expect(result.exitFlashFeeProof).toMatchObject({
      repayAmountDiem: "51000000000000000000",
      flashFee: "510000000000000000",
      flashFeeSource: "uniswap-v3-fee-tier",
      flashLoanProvider: "uniswap-v3",
      flashLoanPool: "0x80d995189ecc593672aD4703b250a5e82672EB1D",
      flashLoanFactory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
      flashLoanFeeTier: 10_000,
      flashLoanLiquidityBlockNumber: "1",
      flashLoanAvailableDiem: "1000000000000000000000",
      flashLoanRequestedDiem: "51000000000000000000",
      flashLoanLiquidityCovered: true,
      totalFlashRepaymentDiem: "51510000000000000000",
      minDiemOut: "98752500000000000000",
      morphoRepayCovered: true,
      feeInclusiveRepayCovered: true,
    });
    expect(result.exitExecutionEvidence).toMatchObject({
      source: "executor-event-log",
      owner,
      repayAmountDiem: 50n * WAD,
      flashFee: 510_000_000_000_000_000n,
      totalFlashRepaymentDiem: 51_510_000_000_000_000_000n,
      wstDiemSold: 100n * WAD,
      diemReceived: 98_752_500_000_000_000_000n,
      diemDustRefunded: 48_242_500_000_000_000_000n,
      wstDiemDustRefunded: 0n,
    });
    expect(client.lastSimulateBlockNumber).toBe(1n);
    expect(client.lastEstimateBlockNumber).toBe(1n);
    expect(result.exitFlashFeeProof?.reason).toContain("computed from configured Uniswap V3 fee tier");
    expect(result.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain(
      "projected-health-factor:skip",
    );
    expect(result.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain("curve-depth:skip");
    expect(result.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain("net-apy:skip");
    expect(result.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain("route-slippage:pass");
  });

  it("blocks live exit simulation when deployed executor flash config does not match CLI config", async () => {
    const config = completeConfig();
    const client = new MockSimulationClient({
      gas: 999n,
      positionBorrowShares: 50n * WAD,
      marketTotalBorrowAssets: 100n * WAD,
      marketTotalBorrowShares: 100n * WAD,
      executorFlashPool: "0x00000000000000000000000000000000000000aa",
    });
    const exitPlan = await buildLiveLoopExitPlan({
      config,
      owner,
      preflightClient: client,
      routeQuoteClient: client,
      slippageBps: 25,
      nowSeconds: 1,
    });

    const result = await simulateLoopExecutorCall({
      config,
      action: "exit",
      owner,
      from: owner,
      params: exitPlan.params,
      safetyEvidence: {
        ...safetyEvidence(0.2),
        routeSlippage: exitPlan.routeSlippage,
        flashLoanLiquidity: exitPlan.flashLoanLiquidity,
      },
      client,
    });

    expect(result.status).toBe("blocked");
    expect(result.preflightChecks).toContainEqual({
      key: "executor-flash-config",
      status: "fail",
      message: "loopExecutor flash config mismatch: canonicalFlashPool",
    });
  });

  it("fails live exit simulation when executor event fee conflicts with off-chain proof", async () => {
    const config = completeConfig();
    const client = new MockSimulationClient({
      gas: 999n,
      positionBorrowShares: 50n * WAD,
      marketTotalBorrowAssets: 100n * WAD,
      marketTotalBorrowShares: 100n * WAD,
      simulationResult: loopExitExecutedSimulationResult({
        repayAmountDiem: 50n * WAD,
        flashFee: 1n,
        totalFlashRepaymentDiem: 50_000_000_000_000_000_001n,
        wstDiemSold: 100n * WAD,
        diemReceived: 99n * WAD,
        diemDustRefunded: 49n * WAD,
        wstDiemDustRefunded: 0n,
      }),
    });
    const exitPlan = await buildLiveLoopExitPlan({
      config,
      owner,
      preflightClient: client,
      routeQuoteClient: client,
      slippageBps: 25,
      nowSeconds: 1,
    });

    const result = await simulateLoopExecutorCall({
      config,
      action: "exit",
      owner,
      from: owner,
      params: exitPlan.params,
      safetyEvidence: {
        ...safetyEvidence(0.2),
        routeSlippage: exitPlan.routeSlippage,
        flashLoanLiquidity: exitPlan.flashLoanLiquidity,
      },
      client,
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("EXIT_EXECUTION_EVIDENCE_MISMATCH");
    expect(result.error?.message).toContain("flashFee does not match");
  });

  it("passes live exit simulation when standard eth_call returns no LoopExitExecuted logs", async () => {
    const config = completeConfig();
    const client = new MockSimulationClient({
      gas: 999n,
      positionBorrowShares: 50n * WAD,
      marketTotalBorrowAssets: 100n * WAD,
      marketTotalBorrowShares: 100n * WAD,
      simulationResult: {},
    });
    const exitPlan = await buildLiveLoopExitPlan({
      config,
      owner,
      preflightClient: client,
      routeQuoteClient: client,
      slippageBps: 25,
      nowSeconds: 1,
    });

    const result = await simulateLoopExecutorCall({
      config,
      action: "exit",
      owner,
      from: owner,
      params: exitPlan.params,
      safetyEvidence: {
        ...safetyEvidence(0.2),
        routeSlippage: exitPlan.routeSlippage,
        flashLoanLiquidity: exitPlan.flashLoanLiquidity,
      },
      client,
    });

    expect(result.status).toBe("passed");
    expect(result.error).toBeUndefined();
    expect(result.exitExecutionEvidence).toBeUndefined();
  });

  it("passes forced live exit simulation when route impact exceeds the configured cap", async () => {
    const config = completeConfig();
    const client = new MockSimulationClient({
      gas: 999n,
      positionBorrowShares: 50n * WAD,
      marketTotalBorrowAssets: 100n * WAD,
      marketTotalBorrowShares: 100n * WAD,
      curveExitQuote: 98n * WAD,
      simulationResult: loopExitExecutedSimulationResult({
        repayAmountDiem: 50n * WAD,
        flashFee: 510_000_000_000_000_000n,
        totalFlashRepaymentDiem: 51_510_000_000_000_000_000n,
        wstDiemSold: 100n * WAD,
        diemReceived: 97_755_000_000_000_000_000n,
        diemDustRefunded: 47_245_000_000_000_000_000n,
        wstDiemDustRefunded: 0n,
      }),
    });
    const exitPlan = await buildLiveLoopExitPlan({
      config,
      owner,
      preflightClient: client,
      routeQuoteClient: client,
      slippageBps: 25,
      force: true,
      nowSeconds: 1,
    });
    expect(exitPlan.params?.force).toBe(true);
    expect(exitPlan.routeSlippage?.valid).toBe(false);

    const result = await simulateLoopExecutorCall({
      config,
      action: "exit",
      owner,
      from: owner,
      params: exitPlan.params,
      safetyEvidence: {
        ...safetyEvidence(0.2),
        routeSlippage: exitPlan.routeSlippage,
        flashLoanLiquidity: exitPlan.flashLoanLiquidity,
      },
      client,
    });
    const routeSlippage = result.preflightChecks.find((check) => check.key === "route-slippage");

    expect(result.status).toBe("passed");
    expect(result.exitFlashFeeProof).toMatchObject({
      flashFee: "510000000000000000",
      feeInclusiveRepayCovered: true,
      morphoRepayCovered: true,
    });
    expect(routeSlippage?.status).toBe("pass");
    expect(routeSlippage?.message).toContain("force override active");
  });

  it("fails route slippage when quote evidence exceeds configured price impact cap", async () => {
    const config = completeConfig();
    const params = buildLoopRebalanceParams({ config, owner, targetLeverage: 1.7, slippageBps: 25, nowSeconds: 1 });
    const result = await simulateLoopExecutorCall({
      config,
      action: "rebalance",
      owner,
      from: owner,
      params,
      safetyEvidence: safetyEvidenceWithRoute(0.2, 101),
      client: new MockSimulationClient({ borrowRatePerSecond: 0n }),
    });
    const routeSlippage = result.preflightChecks.find((check) => check.key === "route-slippage");
    expect(result.status).toBe("blocked");
    expect(routeSlippage?.status).toBe("fail");
    expect(routeSlippage?.message).toContain("exceeds configured max 100 bps");
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

  it("fails oracle deviation when Morpho oracle price diverges from vault NAV", async () => {
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
        morphoOraclePrice: (WAD * WAD * 102n) / 100n,
      }),
    });
    const oracleDeviation = result.preflightChecks.find((check) => check.key === "oracle-deviation");
    expect(oracleDeviation?.status).toBe("fail");
    expect(oracleDeviation?.message).toContain("exceeds 1.00%");
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
        async getBlockNumber() {
          return 1n;
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
