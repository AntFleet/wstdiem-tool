import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildLiveLoopExitPlan } from "../src/loop/exitPlan.js";
import type { LoopPreflightClient } from "../src/loop/preflight.js";
import type { RouteQuoteClient } from "../src/loop/routeQuote.js";
import { WAD } from "../src/metrics/math.js";
import type { Address, AppConfig, Hex } from "../src/types/domain.js";

const owner = "0x0000000000000000000000000000000000000009" as const;

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
      curvePool: "0x0000000000000000000000000000000000000002",
      morphoOracle: "0x0000000000000000000000000000000000000003",
      loopExecutor: "0x0000000000000000000000000000000000000004",
    },
    morpho: {
      ...DEFAULT_CONFIG.morpho,
      marketId: `0x${"11".repeat(32)}` as Hex,
    },
    position: { owner },
  };
}

class MockExitPlanClient implements LoopPreflightClient, RouteQuoteClient {
  constructor(
    private readonly options: {
      blockNumber?: bigint;
      chainId?: number;
      collateral?: bigint;
      borrowShares?: bigint;
      totalBorrowAssets?: bigint;
      totalBorrowShares?: bigint;
      expectedDiemOutAtNav?: bigint;
      quotedDiemOut?: bigint;
      flashPoolDiemBalance?: bigint;
    } = {},
  ) {}

  async getBlockNumber(): Promise<bigint> {
    return this.options.blockNumber ?? 321n;
  }

  async getChainId(): Promise<number> {
    return this.options.chainId ?? 8453;
  }

  async getCode(_address: Address): Promise<Hex> {
    return "0x01";
  }

  async readContract(args: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> {
    if (args.functionName === "market") {
      return [
        1_000n * WAD,
        1_000n * WAD,
        this.options.totalBorrowAssets ?? 200n * WAD,
        this.options.totalBorrowShares ?? 200n * WAD,
        0n,
        0n,
      ];
    }
    if (args.functionName === "position") {
      return [0n, this.options.borrowShares ?? 50n * WAD, this.options.collateral ?? 100n * WAD];
    }
    if (args.functionName === "convertToAssets") {
      return this.options.expectedDiemOutAtNav ?? 100n * WAD;
    }
    if (args.functionName === "get_dy") {
      return this.options.quotedDiemOut ?? 99n * WAD;
    }
    if (args.functionName === "balanceOf") {
      expect(args.args?.[0]).toBe(DEFAULT_CONFIG.flashLoan.pool);
      return this.options.flashPoolDiemBalance ?? 1_000n * WAD;
    }
    throw new Error(`unexpected readContract ${args.functionName}`);
  }
}

describe("live exit plan builder", () => {
  it("builds exact LoopExitParams from Morpho debt, collateral, and Curve quote", async () => {
    const client = new MockExitPlanClient();
    const result = await buildLiveLoopExitPlan({
      config: completeConfig(),
      owner,
      preflightClient: client,
      routeQuoteClient: client,
      slippageBps: 50,
      nowSeconds: 1_000,
    });

    expect(result.readiness).toEqual([]);
    expect(result.morphoDebtBlockNumber).toBe(321n);
    expect(result.flashLoanLiquidity).toMatchObject({
      source: "uniswap-v3-pool-balance",
      provider: "uniswap-v3",
      chainId: 8453,
      blockNumber: 321n,
      factory: DEFAULT_CONFIG.flashLoan.factory,
      pool: DEFAULT_CONFIG.flashLoan.pool,
      loanToken: DEFAULT_CONFIG.contracts.diem,
      requestedLoan: 51n * WAD,
      availableLoan: 1_000n * WAD,
      valid: true,
    });
    expect(result.params).toMatchObject({
      owner,
      repayAmountDiem: 51n * WAD,
      maxWstDiemToSell: 100n * WAD,
      minDiemOut: (99n * WAD * 9_950n) / 10_000n,
      force: false,
      deadline: 1_300n,
    });
    expect(result.routeSlippage).toMatchObject({
      source: "route-quote",
      action: "exit",
      blockNumber: 321n,
      priceImpactBps: 100,
      protectedMinOut: (99n * WAD * 9_950n) / 10_000n,
      valid: true,
    });
  });

  it("does not build exit params for zero debt or zero collateral", async () => {
    const zeroDebt = await buildLiveLoopExitPlan({
      config: completeConfig(),
      owner,
      preflightClient: new MockExitPlanClient({ borrowShares: 0n }),
      routeQuoteClient: new MockExitPlanClient(),
      slippageBps: 50,
    });
    const zeroCollateral = await buildLiveLoopExitPlan({
      config: completeConfig(),
      owner,
      preflightClient: new MockExitPlanClient({ collateral: 0n }),
      routeQuoteClient: new MockExitPlanClient(),
      slippageBps: 50,
    });

    expect(zeroDebt.params).toBeNull();
    expect(zeroDebt.readiness).toEqual(["position borrowed DIEM is zero; live exit params are unavailable"]);
    expect(zeroCollateral.params).toBeNull();
    expect(zeroCollateral.readiness).toEqual(["position collateral is zero; live exit params are unavailable"]);
  });

  it("blocks unsafe Curve impact unless force is explicit", async () => {
    const preflightClient = new MockExitPlanClient({ quotedDiemOut: 98n * WAD });
    const routeQuoteClient = new MockExitPlanClient({ quotedDiemOut: 98n * WAD });
    const blocked = await buildLiveLoopExitPlan({
      config: completeConfig(),
      owner,
      preflightClient,
      routeQuoteClient,
      slippageBps: 50,
    });
    const forced = await buildLiveLoopExitPlan({
      config: completeConfig(),
      owner,
      preflightClient,
      routeQuoteClient,
      slippageBps: 50,
      force: true,
    });

    expect(blocked.params).toBeNull();
    expect(blocked.routeSlippage?.valid).toBe(false);
    expect(blocked.readiness).toEqual([
      "Curve exit route price impact exceeds configured cap; use force only after external review",
    ]);
    expect(forced.params?.force).toBe(true);
    expect(forced.routeSlippage?.valid).toBe(false);
  });

  it("blocks exit params when protected Curve output cannot cover Morpho repay", async () => {
    const client = new MockExitPlanClient({
      totalBorrowAssets: 300n * WAD,
      totalBorrowShares: 100n * WAD,
      borrowShares: 50n * WAD,
      quotedDiemOut: 100n * WAD,
    });

    const result = await buildLiveLoopExitPlan({
      config: completeConfig(),
      owner,
      preflightClient: client,
      routeQuoteClient: client,
      slippageBps: 50,
    });

    expect(result.params).toBeNull();
    expect(result.routeQuote?.minDiemOut).toBe((100n * WAD * 9_950n) / 10_000n);
    expect(result.readiness).toEqual(["Curve exit route minDiemOut does not cover Morpho repay amount"]);
  });

  it("blocks exit params when protected Curve output covers repay but not Uniswap V3 flash fee", async () => {
    const client = new MockExitPlanClient({
      totalBorrowAssets: 100n * WAD,
      totalBorrowShares: 100n * WAD,
      borrowShares: 50n * WAD,
      quotedDiemOut: 51_300_000_000_000_000_000n,
    });

    const result = await buildLiveLoopExitPlan({
      config: completeConfig(),
      owner,
      preflightClient: client,
      routeQuoteClient: client,
      slippageBps: 0,
    });

    expect(result.params).toBeNull();
    expect(result.routeQuote?.minDiemOut).toBe(51_300_000_000_000_000_000n);
    expect(result.readiness).toEqual([
      "Curve exit route minDiemOut does not cover Morpho repay amount plus Uniswap V3 flash fee",
    ]);
  });

  it("blocks exit params when configured Uniswap V3 pool cannot fund the DIEM flash loan", async () => {
    const client = new MockExitPlanClient({
      totalBorrowAssets: 100n * WAD,
      totalBorrowShares: 100n * WAD,
      borrowShares: 50n * WAD,
      quotedDiemOut: 99n * WAD,
      flashPoolDiemBalance: 49n * WAD,
    });

    const result = await buildLiveLoopExitPlan({
      config: completeConfig(),
      owner,
      preflightClient: client,
      routeQuoteClient: client,
      slippageBps: 0,
    });

    expect(result.params).toBeNull();
    expect(result.flashLoanLiquidity).toMatchObject({
      blockNumber: 321n,
      requestedLoan: 51n * WAD,
      availableLoan: 49n * WAD,
      valid: false,
    });
    expect(result.readiness).toEqual([
      "configured Uniswap V3 DIEM pool balance does not cover requested flash loan amount",
    ]);
  });

  it("blocks exit params when flash provider config is unavailable", async () => {
    const config = {
      ...completeConfig(),
      flashLoan: {
        ...completeConfig().flashLoan,
        provider: "unconfigured" as const,
        factory: null,
        pool: null,
        loanToken: null,
        pairToken: null,
        feeTier: null,
      },
    };
    const client = new MockExitPlanClient();

    const result = await buildLiveLoopExitPlan({
      config,
      owner,
      preflightClient: client,
      routeQuoteClient: client,
      slippageBps: 50,
    });

    expect(result.params).toBeNull();
    expect(result.readiness).toEqual(["flash-loan provider config is required for fee-inclusive exit proof"]);
  });
});
