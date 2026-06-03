import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("compiled CLI live simulation mode", () => {
  it("returns ok:false with blocked liveSimulation details when no RPC URL is configured", async () => {
    await execFileAsync("npm", ["run", "build"]);
    let stdout = "";
    try {
      await execFileAsync("node", [
        "dist/cli/index.js",
        "--json",
        "loop",
        "simulate",
        "--action",
        "open",
        "--target-leverage",
        "3",
        "--initial-diem",
        "100",
        "--live",
      ]);
    } catch (error) {
      stdout = (error as { stdout: string }).stdout;
    }
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      data: {
        liveSimulation: {
          status: string;
          error: { code: string };
        };
      };
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("LIVE_SIMULATION_BLOCKED");
    expect(parsed.data.liveSimulation.status).toBe("blocked");
    expect(parsed.data.liveSimulation.error.code).toBe("SIMULATION_CLIENT_MISSING");
  }, 15_000);
});
