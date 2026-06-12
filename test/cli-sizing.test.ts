import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("compiled CLI loop sizing", () => {
  it("runs offline with JSON output and expands scenario grids", async () => {
    await execFileAsync("npm", ["run", "build"]);
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.BASE_RPC_URL;
    delete env.BASE_RPC_URL_FALLBACK_1;
    delete env.BASE_RPC_URL_FALLBACK_2;

    const result = await execFileAsync(
      "node",
      [
        "dist/cli/index.js",
        "loop",
        "sizing",
        "--json",
        "--initial-diem",
        "100",
        "--target-leverage",
        "2,3",
        "--curve-depth-diem",
        "0,1000",
        "--morpho-supply-diem",
        "0,1000",
        "--vault-apy-bps",
        "1500",
        "--borrow-apy-bps",
        "800",
      ],
      { env },
    );
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      data: {
        assumptions: {
          readOnly: boolean;
          broadcastAvailable: boolean;
          auditRequired: boolean;
        };
        summary: {
          total: number;
          blocked: number;
        };
        results: Array<{
          scenario: {
            initialCollateralDiem: string;
            curveDepthDiem: string;
          };
          firstBlocker: string | null;
          borrowAmountDiem: string;
        }>;
      };
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("loop sizing");
    expect(parsed.data.assumptions).toMatchObject({
      readOnly: true,
      broadcastAvailable: false,
      auditRequired: true,
    });
    expect(parsed.data.summary.total).toBe(8);
    expect(parsed.data.summary.blocked).toBe(8);
    expect(parsed.data.results[0].scenario.initialCollateralDiem).toBe("100000000000000000000");
    expect(parsed.data.results[0].scenario.curveDepthDiem).toBe("0");
    expect(parsed.data.results[0].firstBlocker).toBe("curve_liquidity_insufficient");
    expect(parsed.data.results[0].borrowAmountDiem).toBe("100000000000000000000");
  }, 15_000);
});
