import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildLoopReadiness } from "../src/loop/readiness.js";
import type { LoopSimulationClient } from "../src/loop/simulator.js";
import { WAD } from "../src/metrics/math.js";
import type { Address, AppConfig, Hex } from "../src/types/domain.js";

const owner = "0x0000000000000000000000000000000000000009" as const;
const loopExecutor = "0x0000000000000000000000000000000000000004" as const;

function completeConfig(): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    rpc: {
      ...DEFAULT_CONFIG.rpc,
      primaryUrl: "https://base.example.invalid",
    },
    contracts: {
      ...DEFAULT_CONFIG.contracts,
      loopExecutor,
    },
    position: { owner },
  };
}

class MockReadinessClient implements LoopSimulationClient {
  constructor(
    private readonly options: {
      curveDiem?: bigint;
      curveWstDiem?: bigint;
      marketSupply?: bigint;
      marketBorrowAssets?: bigint;
      marketBorrowShares?: bigint;
      collateral?: bigint;
      borrowShares?: bigint;
      authorized?: boolean;
      hasExecutorCode?: boolean;
      vaultAsset?: Address;
      vaultTotalSupply?: bigint;
      vaultTotalAssets?: bigint;
      vaultNav?: bigint;
      executorCurvePool?: Address;
      readFailureFunction?: string;
    } = {},
  ) {}

  readonly readBlockNumbers: Array<bigint | undefined> = [];

  async getBlockNumber(): Promise<bigint> {
    return 456n;
  }

  async getChainId(): Promise<number> {
    return 8453;
  }

  async getCode(_address: Address): Promise<Hex> {
    return this.options.hasExecutorCode === false ? "0x" : "0x01";
  }

  async readContract(args: {
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }): Promise<unknown> {
    this.readBlockNumbers.push(args.blockNumber);
    if (args.functionName === this.options.readFailureFunction) {
      throw new Error(`forced ${args.functionName} failure`);
    }
    if (args.functionName === "balances") {
      return args.args?.[0] === 0n
        ? (this.options.curveDiem ?? 0n)
        : (this.options.curveWstDiem ?? 0n);
    }
    if (args.functionName === "convertToAssets") {
      return this.options.vaultNav ?? WAD;
    }
    if (args.functionName === "asset") {
      return this.options.vaultAsset ?? DEFAULT_CONFIG.contracts.diem;
    }
    if (args.functionName === "totalSupply") {
      return this.options.vaultTotalSupply ?? WAD;
    }
    if (args.functionName === "totalAssets") {
      return this.options.vaultTotalAssets ?? WAD;
    }
    if (args.functionName === "market") {
      return [
        this.options.marketSupply ?? 0n,
        this.options.marketSupply ?? 0n,
        this.options.marketBorrowAssets ?? 0n,
        this.options.marketBorrowShares ?? 0n,
        0n,
        0n,
      ];
    }
    if (args.functionName === "canonicalFlashPool") {
      return DEFAULT_CONFIG.flashLoan.pool;
    }
    if (args.functionName === "expectedFlashFee") {
      return (50n * WAD * 10_000n - 1n) / 1_000_000n + 1n;
    }
    if (args.functionName === "loanTokenIsToken0") {
      return false;
    }
    if (args.functionName === "flashConfig") {
      return [
        DEFAULT_CONFIG.flashLoan.factory,
        DEFAULT_CONFIG.flashLoan.pool,
        DEFAULT_CONFIG.flashLoan.loanToken,
        DEFAULT_CONFIG.flashLoan.pairToken,
        DEFAULT_CONFIG.flashLoan.feeTier,
      ];
    }
    if (args.functionName === "protocolConfig") {
      return [
        DEFAULT_CONFIG.contracts.morphoBlue,
        this.options.executorCurvePool ?? DEFAULT_CONFIG.contracts.curvePool,
        DEFAULT_CONFIG.contracts.inferenceVault,
      ];
    }
    if (args.functionName === "position") {
      return [0n, this.options.borrowShares ?? 0n, this.options.collateral ?? 0n];
    }
    if (args.functionName === "isAuthorized") {
      return this.options.authorized ?? false;
    }
    throw new Error(`unexpected readContract ${args.functionName}`);
  }

  async simulateContract(): Promise<unknown> {
    return {};
  }

  async estimateContractGas(): Promise<bigint> {
    return 1n;
  }
}

describe("loop readiness", () => {
  it("returns a blocked readiness report when RPC is unavailable", async () => {
    const result = await buildLoopReadiness({ config: completeConfig(), owner, client: undefined });

    expect(result.status).toBe("blocked");
    expect(result.broadcastAvailable).toBe(false);
    expect(result.auditRequired).toBe(true);
    expect(result.checks).toContainEqual({
      key: "rpc-client",
      status: "fail",
      message: "live RPC client is required for loop readiness",
    });
  });

  it("reports empty Curve and Morpho state as blockers", async () => {
    const result = await buildLoopReadiness({
      config: completeConfig(),
      owner,
      client: new MockReadinessClient(),
    });

    expect(result.status).toBe("blocked");
    expect(result.vault).toMatchObject({
      address: DEFAULT_CONFIG.contracts.inferenceVault,
      asset: DEFAULT_CONFIG.contracts.diem,
      totalSupply: WAD,
      totalAssets: WAD,
      wstDiemNav: WAD,
      assetMatchesDiem: true,
      hasSupply: true,
    });
    expect(result.curve?.liquid).toBe(false);
    expect(result.morpho?.totalSupplyAssets).toBe(0n);
    expect(result.owner?.hasExitPosition).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "Curve DIEM/wstDIEM liquidity is not ready",
        "Morpho market has no DIEM supply assets",
        "owner does not have an exit-ready position",
        "owner has not authorized loopExecutor",
        "broadcast disabled pending production executor audit/review",
      ]),
    );
  });

  it("passes live dependency checks but remains broadcast-blocked by audit gate", async () => {
    const client = new MockReadinessClient({
      curveDiem: 1_000n * WAD,
      curveWstDiem: 1_000n * WAD,
      marketSupply: 2_000n * WAD,
      marketBorrowAssets: 500n * WAD,
      marketBorrowShares: 500n * WAD,
      collateral: 100n * WAD,
      borrowShares: 50n * WAD,
      authorized: true,
    });
    const result = await buildLoopReadiness({
      config: completeConfig(),
      owner,
      client,
    });

    expect(result.checks.filter((entry) => entry.status === "fail")).toEqual([
      {
        key: "audit-gate",
        status: "fail",
        message: "broadcast remains disabled until production executor audit/review is complete",
      },
    ]);
    expect(result.status).toBe("blocked");
    expect(result.executor?.verified).toBe(true);
    expect(result.vault?.hasSupply).toBe(true);
    expect(result.executor?.protocolConfig).toMatchObject({
      morpho: DEFAULT_CONFIG.contracts.morphoBlue,
      curvePool: DEFAULT_CONFIG.contracts.curvePool,
      wstDiem: DEFAULT_CONFIG.contracts.inferenceVault,
    });
    expect(result.owner).toMatchObject({
      address: owner,
      borrowedDiem: 50n * WAD,
      hasExitPosition: true,
      executorAuthorized: true,
    });
    expect(result.blockers).toEqual([
      "broadcast disabled pending production executor audit/review",
    ]);
    expect(client.readBlockNumbers.every((blockNumber) => blockNumber === 456n)).toBe(true);
  });

  it("blocks readiness when deployed executor protocol config does not match config", async () => {
    const result = await buildLoopReadiness({
      config: completeConfig(),
      owner,
      client: new MockReadinessClient({
        curveDiem: 1_000n * WAD,
        curveWstDiem: 1_000n * WAD,
        marketSupply: 2_000n * WAD,
        marketBorrowAssets: 500n * WAD,
        marketBorrowShares: 500n * WAD,
        collateral: 100n * WAD,
        borrowShares: 50n * WAD,
        authorized: true,
        executorCurvePool: "0x00000000000000000000000000000000000000A5",
      }),
    });

    expect(result.executor?.verified).toBe(false);
    expect(result.checks).toContainEqual({
      key: "executor-config",
      status: "fail",
      message: "loopExecutor runtime config mismatch: protocolConfig.curvePool",
    });
    expect(result.blockers).toContain("loopExecutor runtime config mismatch");
  });

  it("returns blocked readiness when a live read fails", async () => {
    const result = await buildLoopReadiness({
      config: completeConfig(),
      owner,
      client: new MockReadinessClient({ readFailureFunction: "balances" }),
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual({
      key: "rpc-read",
      status: "fail",
      message: "live readiness read failed: forced balances failure",
    });
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "live readiness read failed: forced balances failure",
        "broadcast disabled pending production executor audit/review",
      ]),
    );
  });
});
