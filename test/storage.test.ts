import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "../src/storage/sqlite.js";
import { makeEmptySnapshot } from "../src/metrics/math.js";

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
    storage.insertMetricSnapshot(makeEmptySnapshot());
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
});
