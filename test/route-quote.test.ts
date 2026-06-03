import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { quoteCurveExitRoute, type RouteQuoteClient } from "../src/loop/routeQuote.js";
import { WAD } from "../src/metrics/math.js";
import type { AppConfig, Address } from "../src/types/domain.js";

class MockRouteQuoteClient implements RouteQuoteClient {
  constructor(
    private readonly options: {
      blockNumber?: bigint;
      expectedDiemOutAtNav?: bigint;
      quotedDiemOut?: bigint;
    } = {},
  ) {}

  async getBlockNumber(): Promise<bigint> {
    return this.options.blockNumber ?? 123n;
  }

  async readContract(args: { functionName: string }): Promise<unknown> {
    if (args.functionName === "convertToAssets") {
      return this.options.expectedDiemOutAtNav ?? 100n * WAD;
    }
    if (args.functionName === "get_dy") {
      return this.options.quotedDiemOut ?? 99n * WAD;
    }
    throw new Error(`unexpected readContract ${args.functionName}`);
  }
}

function completeConfig(): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    contracts: {
      ...DEFAULT_CONFIG.contracts,
      inferenceVault: "0x0000000000000000000000000000000000000001" as Address,
      curvePool: "0x0000000000000000000000000000000000000002" as Address,
    },
  };
}

describe("Curve route quote evidence", () => {
  it("quotes exit swaps with protected min-out and price-impact evidence", async () => {
    const result = await quoteCurveExitRoute({
      config: completeConfig(),
      client: new MockRouteQuoteClient(),
      wstDiemIn: 100n * WAD,
      slippageBps: 50,
    });

    expect(result.readiness).toEqual([]);
    expect(result.quote).toMatchObject({
      action: "exit",
      wstDiemIn: 100n * WAD,
      expectedDiemOutAtNav: 100n * WAD,
      quotedDiemOut: 99n * WAD,
      minDiemOut: (99n * WAD * 9_950n) / 10_000n,
      maxSlippageBps: 50,
      priceImpactBps: 100,
      blockNumber: 123n,
    });
    expect(result.evidence).toMatchObject({
      source: "route-quote",
      action: "exit",
      chainId: 8453,
      blockNumber: 123n,
      maxSlippageBps: 50,
      priceImpactBps: 100,
      amountIn: 100n * WAD,
      expectedOut: 100n * WAD,
      quotedOut: 99n * WAD,
      protectedMinOut: (99n * WAD * 9_950n) / 10_000n,
      valid: true,
    });
  });

  it("marks evidence invalid when Curve impact exceeds the configured cap", async () => {
    const result = await quoteCurveExitRoute({
      config: completeConfig(),
      client: new MockRouteQuoteClient({ quotedDiemOut: 98n * WAD }),
      wstDiemIn: 100n * WAD,
      slippageBps: 50,
    });

    expect(result.quote?.priceImpactBps).toBe(200);
    expect(result.evidence?.valid).toBe(false);
  });

  it("does not emit evidence when required deployment config is missing", async () => {
    const config = completeConfig();
    config.contracts.curvePool = null;

    const result = await quoteCurveExitRoute({
      config,
      client: new MockRouteQuoteClient(),
      wstDiemIn: 100n * WAD,
      slippageBps: 50,
    });

    expect(result.quote).toBeUndefined();
    expect(result.evidence).toBeUndefined();
    expect(result.readiness).toEqual(["curvePool and inferenceVault are required for Curve exit route quotes"]);
  });

  it("does not emit evidence for zero NAV or zero Curve quotes", async () => {
    const zeroNav = await quoteCurveExitRoute({
      config: completeConfig(),
      client: new MockRouteQuoteClient({ expectedDiemOutAtNav: 0n }),
      wstDiemIn: 100n * WAD,
      slippageBps: 50,
    });
    const zeroCurveQuote = await quoteCurveExitRoute({
      config: completeConfig(),
      client: new MockRouteQuoteClient({ quotedDiemOut: 0n }),
      wstDiemIn: 100n * WAD,
      slippageBps: 50,
    });

    expect(zeroNav.evidence).toBeUndefined();
    expect(zeroNav.readiness).toEqual(["InferenceVault.convertToAssets returned zero for Curve exit route quote"]);
    expect(zeroCurveQuote.evidence).toBeUndefined();
    expect(zeroCurveQuote.readiness).toEqual(["Curve get_dy returned zero for Curve exit route quote"]);
  });
});
