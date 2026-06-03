import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { simulateMorphoAuthorization } from "../src/loop/authorization.js";
import { buildLoopRebalanceParams } from "../src/loop/params.js";
import { runLoopPreflight, type LoopPreflightClient } from "../src/loop/preflight.js";
import { simulateLoopExecutorCall, type LoopSimulationClient } from "../src/loop/simulator.js";
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
    } = {},
  ) {}

  async getChainId(): Promise<number> {
    return this.options.chainId ?? 8453;
  }

  async getCode(_address: Address): Promise<Hex> {
    return this.options.code ?? "0x01";
  }

  async readContract(args: { functionName: string }): Promise<unknown> {
    if (args.functionName === "asset") {
      return this.options.vaultAsset ?? DEFAULT_CONFIG.contracts.diem;
    }
    if (args.functionName === "isAuthorized") {
      return this.options.authorized ?? true;
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
    expect(result.preflightChecks.map((check) => `${check.key}:${check.status}`)).toContain("route-slippage:fail");
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
