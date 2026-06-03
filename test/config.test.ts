import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { interpolateEnv, loadConfig, missingDeploymentKeys } from "../src/config/load.js";

const created: string[] = [];

afterEach(() => {
  for (const file of created.splice(0)) {
    fs.rmSync(file, { force: true });
  }
});

describe("config loading", () => {
  it("interpolates empty environment placeholders as null", () => {
    delete process.env.DOES_NOT_EXIST_FOR_WSTDIEM_TEST;
    expect(interpolateEnv("${DOES_NOT_EXIST_FOR_WSTDIEM_TEST}")).toBeNull();
  });

  it("loads SPEC001 defaults and reports required deployment gaps", () => {
    const config = loadConfig({ configPath: "/tmp/does-not-exist-wstdiem.yaml" });
    expect(config.chainId).toBe(8453);
    expect(missingDeploymentKeys(config)).toContain("inferenceVault");
    expect(missingDeploymentKeys(config)).toContain("marketId");
  });

  it("loads YAML overrides", () => {
    const file = path.join(os.tmpdir(), `wstdiem-config-${Date.now()}.yaml`);
    created.push(file);
    fs.writeFileSync(
      file,
      [
        "storage:",
        `  sqlitePath: "${file}.sqlite"`,
        "position:",
        '  owner: "0x0000000000000000000000000000000000000001"',
      ].join("\n"),
    );
    const config = loadConfig({ configPath: file });
    expect(config.storage.sqlitePath).toBe(`${file}.sqlite`);
    expect(config.position.owner).toBe("0x0000000000000000000000000000000000000001");
  });
});
