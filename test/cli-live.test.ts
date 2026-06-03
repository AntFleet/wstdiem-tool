import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("compiled CLI live simulation mode", () => {
  it("returns a blocked liveSimulation when no RPC URL is configured", async () => {
    await execFileAsync("npm", ["run", "build"]);
    const { stdout } = await execFileAsync("node", [
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
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      data: {
        liveSimulation: {
          status: string;
          error: { code: string };
        };
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.liveSimulation.status).toBe("blocked");
    expect(parsed.data.liveSimulation.error.code).toBe("SIMULATION_CLIENT_MISSING");
  });
});
