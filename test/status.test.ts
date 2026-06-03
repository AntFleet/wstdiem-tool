import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildStatus, runWatchOnce } from "../src/cli/status.js";
import { Storage } from "../src/storage/sqlite.js";

const created: string[] = [];

afterEach(() => {
  for (const file of created.splice(0)) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
});

describe("status/watch safety", () => {
  it("does not evaluate strategy risk alerts from placeholder metrics", async () => {
    const result = await buildStatus(DEFAULT_CONFIG);
    expect(result.alerts).toEqual([]);
    expect(result.snapshot.validity.yieldWindow).toBe(false);
  });

  it("does not advance lastProcessedBlock without log indexing", async () => {
    const file = path.join(os.tmpdir(), `wstdiem-watch-${Date.now()}.sqlite`);
    created.push(file);
    const config = { ...DEFAULT_CONFIG, storage: { sqlitePath: file } };
    await runWatchOnce(config);
    const storage = new Storage(file);
    try {
      expect(storage.getMeta("lastProcessedBlock")).toBeNull();
      expect(storage.getMeta("lastObservedBlock")).toBe("0");
    } finally {
      storage.close();
    }
  });
});
