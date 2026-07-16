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

/** Error that looks like a viem contract-revert chain (SPEC010 §4.D). */
function contractRevert(message: string): Error {
  const err = new Error(message);
  err.name = "ExecutionRevertedError";
  return err;
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
      walletWstDiem?: bigint;
      executorCurvePool?: Address;
      readFailureFunction?: string;
      /** When true, failure is a contract revert (degrade); else transport (re-raise). */
      readFailureIsRevert?: boolean;
      executorReadReverts?: boolean;
      positionReadReverts?: boolean;
      walletReadReverts?: boolean;
      noVaultCode?: boolean;
    } = {},
  ) {}

  readonly readBlockNumbers: Array<bigint | undefined> = [];

  async getBlockNumber(): Promise<bigint> {
    return 456n;
  }

  async getChainId(): Promise<number> {
    return 8453;
  }

  async getCode(address: Address): Promise<Hex> {
    if (
      this.options.noVaultCode &&
      address.toLowerCase() === DEFAULT_CONFIG.contracts.inferenceVault?.toLowerCase()
    ) {
      return "0x";
    }
    if (
      this.options.hasExecutorCode === false &&
      address.toLowerCase() === loopExecutor.toLowerCase()
    ) {
      return "0x";
    }
    // Default: code present (vault + executor).
    if (this.options.hasExecutorCode === false) {
      // Only executor has no code; vault still has code unless noVaultCode.
      return "0x01";
    }
    return "0x01";
  }

  async readContract(args: {
    functionName: string;
    args?: readonly unknown[];
    blockNumber?: bigint;
  }): Promise<unknown> {
    this.readBlockNumbers.push(args.blockNumber);
    if (args.functionName === this.options.readFailureFunction) {
      if (this.options.readFailureIsRevert) {
        throw contractRevert(`forced ${args.functionName} failure`);
      }
      throw new Error(`forced ${args.functionName} failure`);
    }
    if (args.functionName === "balances") {
      return args.args?.[0] === 0n
        ? (this.options.curveDiem ?? 0n)
        : (this.options.curveWstDiem ?? 0n);
    }
    if (args.functionName === "balanceOf") {
      if (this.options.walletReadReverts) {
        throw contractRevert("balanceOf reverted");
      }
      return this.options.walletWstDiem ?? 0n;
    }
    if (args.functionName === "convertToAssets") {
      const shares = BigInt((args.args?.[0] as bigint | number | string | undefined) ?? WAD);
      const nav = this.options.vaultNav ?? WAD;
      return (shares * nav) / WAD;
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
    if (
      args.functionName === "canonicalFlashPool" ||
      args.functionName === "expectedFlashFee" ||
      args.functionName === "loanTokenIsToken0" ||
      args.functionName === "flashConfig" ||
      args.functionName === "protocolConfig"
    ) {
      if (this.options.executorReadReverts) {
        throw contractRevert("executor flash getter reverted");
      }
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
      if (this.options.positionReadReverts) {
        throw contractRevert("position reverted");
      }
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

  it("SPEC010: unlevered wallet holder gets leverage unlevered + wallet fields", async () => {
    const wallet = 42n * WAD;
    const result = await buildLoopReadiness({
      config: { ...completeConfig(), contracts: { ...completeConfig().contracts, loopExecutor: null } },
      owner,
      client: new MockReadinessClient({
        walletWstDiem: wallet,
        collateral: 0n,
        borrowShares: 0n,
        marketSupply: 1n * WAD,
      }),
    });

    expect(result.leverage).toBe("unlevered");
    expect(result.ownerLeverageUndeterminable).toBe(false);
    expect(result.ownerConfigured).toBe(true);
    expect(result.owner).toMatchObject({
      address: owner,
      walletWstDiem: wallet,
      walletValueDiem: wallet,
      borrowShares: 0n,
      borrowedDiem: 0n,
      hasExitPosition: false,
    });
  });

  it("SPEC010: executor flash-getter revert degrades executor row (not rpc-read fail)", async () => {
    const result = await buildLoopReadiness({
      config: completeConfig(),
      owner,
      client: new MockReadinessClient({
        executorReadReverts: true,
        collateral: 0n,
        borrowShares: 0n,
        marketSupply: 1n * WAD,
        walletWstDiem: WAD,
      }),
    });

    expect(result.checks.some((c) => c.key === "rpc-read" && c.status === "fail")).toBe(false);
    expect(result.executor?.readReverted).toBe(true);
    expect(result.executor?.verified).toBe(false);
    expect(result.owner?.walletWstDiem).toBe(WAD);
    expect(result.leverage).toBe("unlevered");
  });

  it("SPEC010: Morpho position revert leaves wallet visible and leverage undeterminable", async () => {
    const result = await buildLoopReadiness({
      config: completeConfig(),
      owner,
      client: new MockReadinessClient({
        positionReadReverts: true,
        marketSupply: 1n * WAD,
        walletWstDiem: 7n * WAD,
      }),
    });

    expect(result.owner?.walletWstDiem).toBe(7n * WAD);
    expect(result.owner?.borrowShares).toBeNull();
    expect(result.leverage).toBe("unknown");
    expect(result.ownerLeverageUndeterminable).toBe(true);
    expect(result.checks.some((c) => c.key === "rpc-read" && c.status === "fail")).toBe(false);
  });

  it("SPEC010: transport failure on executor re-raises to rpc-read fail", async () => {
    const result = await buildLoopReadiness({
      config: completeConfig(),
      owner,
      client: new MockReadinessClient({
        readFailureFunction: "canonicalFlashPool",
        readFailureIsRevert: false,
      }),
    });

    expect(result.checks).toContainEqual({
      key: "rpc-read",
      status: "fail",
      message: "live readiness read failed: forced canonicalFlashPool failure",
    });
  });

  it("SPEC010: vault no-code → wallet n/a (never ≈ 0 DIEM)", async () => {
    const result = await buildLoopReadiness({
      config: completeConfig(),
      owner,
      client: new MockReadinessClient({
        noVaultCode: true,
        marketSupply: 1n * WAD,
        collateral: 0n,
        borrowShares: 0n,
      }),
    });

    expect(result.vault?.hasCode).toBe(false);
    // Owner may still be present from Morpho; wallet must be null.
    expect(result.owner?.walletWstDiem ?? null).toBeNull();
    expect(result.owner?.walletValueDiem ?? null).toBeNull();
  });
});
