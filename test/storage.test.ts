import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "../src/storage/sqlite.js";
import { makeEmptySnapshot, WAD } from "../src/metrics/math.js";

const created: string[] = [];

afterEach(() => {
  for (const file of created.splice(0)) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
});

describe("SQLite persistence", () => {
  it("initializes schema and stores metric snapshots, alerts, meta, and tx history", () => {
    const file = path.join(os.tmpdir(), `wstdiem-storage-${Date.now()}.sqlite`);
    created.push(file);
    const storage = new Storage(file);
    storage.setMeta("lastProcessedBlock", "123");
    expect(storage.getMeta("lastProcessedBlock")).toBe("123");
    storage.insertMetricSnapshot({ ...makeEmptySnapshot(10), vaultTotalAssetsDiem: 100n * WAD });
    storage.insertMetricSnapshot({ ...makeEmptySnapshot(20), vaultTotalAssetsDiem: 110n * WAD });
    storage.insertAlert(
      {
        alertKey: "test",
        level: "INFO",
        message: "hello",
        suggestedAction: "none",
        cooldownSeconds: 0,
        metrics: {},
      },
      1,
      ["stderr"],
    );
    storage.setLastAlertDelivery("8453:unknown:test:INFO", 10);
    expect(storage.getLastAlertDelivery("8453:unknown:test:INFO")).toBe(10);
    storage.insertCreditEvent({
      txHash: "0xabc",
      logIndex: 0,
      blockNumber: 1n,
      timestamp: 1,
      source: "vvv",
      amountDiem: 1n,
    });
    expect(storage.listCreditSamplesSince(0)).toEqual([{ timestamp: 1, amountDiem: 1n }]);
    expect(storage.listVaultAssetSamplesForWindow(15)).toEqual([
      { timestamp: 10, totalAssetsDiem: 100n * WAD },
      { timestamp: 20, totalAssetsDiem: 110n * WAD },
    ]);
    storage.insertHarvestEvent({
      txHash: "0xdef",
      logIndex: 0,
      blockNumber: 1n,
      timestamp: 1,
      eventName: "VVVHarvested",
      amountIn: 1n,
      amountOut: 2n,
    });
    storage.insertCurveSwap({
      txHash: "0x123",
      logIndex: 0,
      blockNumber: 1n,
      timestamp: 1,
      soldId: 0,
      boughtId: 1,
      tokensSold: 1n,
      tokensBought: 1n,
      volumeDiem: 1n,
    });
    storage.insertPositionSnapshot({
      timestamp: 1,
      blockNumber: 1n,
      owner: "0x0000000000000000000000000000000000000001",
      collateralWstDiem: 1n,
      borrowedDiem: 0n,
      leverage: 1,
      healthFactor: Number.POSITIVE_INFINITY,
    });
    storage.insertTxHistory({
      txHash: "0xabc",
      timestamp: 1,
      command: "loop authorize-executor",
      status: "success",
      params: {},
      projectedMetrics: {},
    });
    expect(storage.listTxHistory(10)).toHaveLength(1);
    storage.close();
  });

  it("returns a sample exactly at windowStart once (anchor only, not duplicated by the range)", () => {
    const file = path.join(os.tmpdir(), `wstdiem-storage-boundary-${Date.now()}.sqlite`);
    created.push(file);
    const storage = new Storage(file);
    // A sample whose timestamp is EXACTLY windowStart satisfies both the `<= windowStart` anchor
    // query and (before the fix) the `>= windowStart` range query, so it appeared twice in the
    // merged array. With a strict `> windowStart` range it is only the anchor — exactly once.
    storage.insertMetricSnapshot({ ...makeEmptySnapshot(100), vaultTotalAssetsDiem: 100n * WAD });
    storage.insertMetricSnapshot({ ...makeEmptySnapshot(200), vaultTotalAssetsDiem: 110n * WAD });
    const samples = storage.listVaultAssetSamplesForWindow(100);
    expect(samples).toEqual([
      { timestamp: 100, totalAssetsDiem: 100n * WAD },
      { timestamp: 200, totalAssetsDiem: 110n * WAD },
    ]);
    expect(samples.filter((sample) => sample.timestamp === 100)).toHaveLength(1);
    storage.close();
  });
});
