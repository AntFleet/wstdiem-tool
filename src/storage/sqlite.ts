import Database from "better-sqlite3";
import type {
  AlertEvaluation,
  MetricSnapshot,
  StoredCreditEvent,
  StoredCurveSwap,
  StoredHarvestEvent,
  StoredPositionSnapshot,
} from "../types/domain.js";

export interface StoredCreditSample {
  timestamp: number;
  amountDiem: bigint;
}

export interface StoredVaultAssetSample {
  timestamp: number;
  totalAssetsDiem: bigint;
}

export class Storage {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  close(): void {
    this.db.close();
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metric_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        nav TEXT NOT NULL,
        base_apy REAL NOT NULL,
        borrow_rate REAL NOT NULL,
        net_apy_35 REAL NOT NULL,
        spread_score REAL NOT NULL,
        health_factor REAL,
        curve_tvl_diem TEXT NOT NULL,
        oracle_deviation REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS credit_events (
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        source TEXT NOT NULL,
        amount_diem TEXT NOT NULL,
        PRIMARY KEY (tx_hash, log_index)
      );

      CREATE TABLE IF NOT EXISTS harvest_events (
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        event_name TEXT NOT NULL,
        token_in TEXT,
        amount_in TEXT,
        amount_out TEXT,
        PRIMARY KEY (tx_hash, log_index)
      );

      CREATE TABLE IF NOT EXISTS curve_swaps (
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        sold_id INTEGER NOT NULL,
        bought_id INTEGER NOT NULL,
        tokens_sold TEXT NOT NULL,
        tokens_bought TEXT NOT NULL,
        volume_diem TEXT NOT NULL,
        PRIMARY KEY (tx_hash, log_index)
      );

      CREATE TABLE IF NOT EXISTS position_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        owner TEXT NOT NULL,
        collateral_wstdiem TEXT NOT NULL,
        borrowed_diem TEXT NOT NULL,
        leverage REAL NOT NULL,
        health_factor REAL
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        alert_key TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        delivered_channels_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alert_state (
        dedupe_key TEXT PRIMARY KEY,
        last_delivered_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tx_history (
        tx_hash TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        command TEXT NOT NULL,
        status TEXT NOT NULL,
        params_json TEXT NOT NULL,
        projected_metrics_json TEXT NOT NULL,
        receipt_json TEXT
      );
    `);
    this.ensureColumn("metric_snapshots", "vault_total_assets_diem", "TEXT NOT NULL DEFAULT '0'");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  insertMetricSnapshot(snapshot: MetricSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO metric_snapshots (
          timestamp, block_number, nav, vault_total_assets_diem, base_apy, borrow_rate, net_apy_35,
          spread_score, health_factor, curve_tvl_diem, oracle_deviation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.timestamp,
        Number(snapshot.blockNumber),
        snapshot.nav.toString(),
        snapshot.vaultTotalAssetsDiem.toString(),
        snapshot.baseApy,
        snapshot.borrowRate,
        snapshot.netApy35,
        snapshot.spreadScore,
        Number.isFinite(snapshot.healthFactor) ? snapshot.healthFactor : null,
        snapshot.curveTvlDiem.toString(),
        snapshot.oracleDeviation,
      );
  }

  listCreditSamplesSince(timestamp: number): StoredCreditSample[] {
    const rows = this.db
      .prepare(
        `SELECT timestamp, amount_diem
         FROM credit_events
         WHERE timestamp >= ?
         ORDER BY timestamp ASC`,
      )
      .all(timestamp) as Array<{ timestamp: number; amount_diem: string }>;
    return rows.map((row) => ({
      timestamp: row.timestamp,
      amountDiem: BigInt(row.amount_diem),
    }));
  }

  listVaultAssetSamplesForWindow(windowStart: number): StoredVaultAssetSample[] {
    // The window is assembled from two non-overlapping partitions: the `initial` anchor is the last
    // sample AT OR BEFORE `windowStart` (the vault state entering the window), and `rows` are the
    // samples STRICTLY AFTER it. The range must use `>` (not `>=`): a sample whose timestamp is
    // exactly `windowStart` already qualifies as the anchor, so `>=` would return it in both queries
    // and duplicate it in the merged array — inflating any length-based consumer (e.g. the
    // MIN_VAULT_APY_WINDOW_SAMPLES density floor in loop/fromChainSeed.ts).
    const initial = this.db
      .prepare(
        `SELECT timestamp, vault_total_assets_diem
         FROM metric_snapshots
         WHERE timestamp <= ?
         ORDER BY timestamp DESC
         LIMIT 1`,
      )
      .get(windowStart) as { timestamp: number; vault_total_assets_diem: string } | undefined;
    const rows = this.db
      .prepare(
        `SELECT timestamp, vault_total_assets_diem
         FROM metric_snapshots
         WHERE timestamp > ?
         ORDER BY timestamp ASC`,
      )
      .all(windowStart) as Array<{ timestamp: number; vault_total_assets_diem: string }>;
    return [initial, ...rows].filter((row): row is { timestamp: number; vault_total_assets_diem: string } => row !== undefined).map((row) => ({
      timestamp: row.timestamp,
      totalAssetsDiem: BigInt(row.vault_total_assets_diem),
    }));
  }

  insertAlert(alert: AlertEvaluation, timestamp: number, deliveredChannels: string[]): void {
    this.db
      .prepare(
        `INSERT INTO alerts (
          timestamp, alert_key, severity, message, metrics_json, delivered_channels_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        timestamp,
        alert.alertKey,
        alert.level,
        alert.message,
        JSON.stringify(alert.metrics),
        JSON.stringify(deliveredChannels),
      );
  }

  getLastAlertDelivery(dedupeKey: string): number | null {
    const row = this.db.prepare("SELECT last_delivered_at FROM alert_state WHERE dedupe_key = ?").get(dedupeKey) as
      | { last_delivered_at: number }
      | undefined;
    return row?.last_delivered_at ?? null;
  }

  setLastAlertDelivery(dedupeKey: string, timestamp: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO alert_state (dedupe_key, last_delivered_at) VALUES (?, ?)")
      .run(dedupeKey, timestamp);
  }

  insertCreditEvent(event: StoredCreditEvent): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO credit_events (
          tx_hash, log_index, block_number, timestamp, source, amount_diem
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.txHash,
        event.logIndex,
        Number(event.blockNumber),
        event.timestamp,
        event.source,
        event.amountDiem.toString(),
      );
  }

  insertHarvestEvent(event: StoredHarvestEvent): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO harvest_events (
          tx_hash, log_index, block_number, timestamp, event_name, token_in, amount_in, amount_out
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.txHash,
        event.logIndex,
        Number(event.blockNumber),
        event.timestamp,
        event.eventName,
        event.tokenIn ?? null,
        event.amountIn?.toString() ?? null,
        event.amountOut?.toString() ?? null,
      );
  }

  insertCurveSwap(event: StoredCurveSwap): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO curve_swaps (
          tx_hash, log_index, block_number, timestamp, sold_id, bought_id,
          tokens_sold, tokens_bought, volume_diem
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.txHash,
        event.logIndex,
        Number(event.blockNumber),
        event.timestamp,
        event.soldId,
        event.boughtId,
        event.tokensSold.toString(),
        event.tokensBought.toString(),
        event.volumeDiem.toString(),
      );
  }

  insertPositionSnapshot(snapshot: StoredPositionSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO position_snapshots (
          timestamp, block_number, owner, collateral_wstdiem, borrowed_diem, leverage, health_factor
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.timestamp,
        Number(snapshot.blockNumber),
        snapshot.owner,
        snapshot.collateralWstDiem.toString(),
        snapshot.borrowedDiem.toString(),
        snapshot.leverage,
        Number.isFinite(snapshot.healthFactor) ? snapshot.healthFactor : null,
      );
  }

  insertTxHistory(row: {
    txHash: string;
    timestamp: number;
    command: string;
    status: string;
    params: unknown;
    projectedMetrics: unknown;
    receipt?: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tx_history (
          tx_hash, timestamp, command, status, params_json, projected_metrics_json, receipt_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.txHash,
        row.timestamp,
        row.command,
        row.status,
        JSON.stringify(row.params),
        JSON.stringify(row.projectedMetrics),
        row.receipt === undefined ? null : JSON.stringify(row.receipt),
      );
  }

  listTxHistory(limit: number): unknown[] {
    return this.db
      .prepare(
        `SELECT tx_hash, timestamp, command, status, params_json, projected_metrics_json, receipt_json
         FROM tx_history ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(limit);
  }
}
