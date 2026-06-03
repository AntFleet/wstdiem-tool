import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildLoopOpenParams } from "../src/loop/params.js";
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
    const params = buildLoopOpenParams({ config, owner, targetLeverage: 2, initialDiem: "10", nowSeconds: 1 });
    const result = await simulateLoopExecutorCall({ config, action: "open", owner, params });
    expect(result.status).toBe("blocked");
    expect(result.error?.code).toBe("SIMULATION_CLIENT_MISSING");
  });

  it("returns passed simulation and gas estimate when preflight and client pass", async () => {
    const config = completeConfig();
    const params = buildLoopOpenParams({ config, owner, targetLeverage: 2, initialDiem: "10", nowSeconds: 1 });
    const result = await simulateLoopExecutorCall({
      config,
      action: "open",
      owner,
      params,
      client: new MockSimulationClient({ gas: 999n }),
    });
    expect(result.status).toBe("passed");
    expect(result.gasEstimate).toBe("999");
    expect(result.calldata?.startsWith("0x")).toBe(true);
  });

  it("returns failed simulation when simulateContract reverts", async () => {
    const config = completeConfig();
    const params = buildLoopOpenParams({ config, owner, targetLeverage: 2, initialDiem: "10", nowSeconds: 1 });
    const result = await simulateLoopExecutorCall({
      config,
      action: "open",
      owner,
      params,
      client: new MockSimulationClient({ simulateError: new Error("execution reverted") }),
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("SIMULATION_FAILED");
  });
});
