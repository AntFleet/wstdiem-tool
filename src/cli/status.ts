import type { AppConfig } from "../types/domain.js";
import { evaluateAlerts } from "../alerts/evaluate.js";
import { deliverConfiguredAlerts } from "../alerts/deliver.js";
import { missingDeploymentKeys } from "../config/load.js";
import { createViemBackfillClient } from "../contracts/backfillClient.js";
import { createViemLoopSimulationClient } from "../contracts/loopSimulationClient.js";
import { readBestRpcBlockStatus, type RpcBlockStatus } from "../contracts/rpc.js";
import type { LoopSimulationClient } from "../loop/simulator.js";
import { backfillCreditAndHarvestEvents, type BackfillClient } from "../metrics/backfill.js";
import { YIELD_WINDOW_SECONDS, applyYieldWindowMetrics, collectVaultMetrics } from "../metrics/collector.js";
import { makeEmptySnapshot } from "../metrics/math.js";
import { Storage } from "../storage/sqlite.js";

export interface StatusResult {
  snapshot: ReturnType<typeof makeEmptySnapshot>;
  readiness: string[];
  alerts: ReturnType<typeof evaluateAlerts>;
}

export interface StatusDeps {
  readBlockStatus?: (config: AppConfig) => Promise<RpcBlockStatus>;
  createLoopClient?: (config: AppConfig) => Promise<LoopSimulationClient | null>;
  createBackfillClient?: (config: AppConfig) => Promise<BackfillClient | null>;
}

export async function buildStatus(config: AppConfig, deps: StatusDeps = {}): Promise<StatusResult> {
  const readBlockStatus = deps.readBlockStatus ?? readBestRpcBlockStatus;
  const createLoopClient = deps.createLoopClient ?? createViemLoopSimulationClient;
  const readiness: string[] = [];
  const missing = missingDeploymentKeys(config);
  if (missing.length > 0) {
    readiness.push(`missing deployment config: ${missing.join(", ")}`);
  }
  if (config.rpc.primaryUrl === null && config.rpc.fallbackUrls.length === 0) {
    readiness.push("missing BASE_RPC_URL/rpc.primaryUrl; on-chain status unavailable");
  }

  let snapshot = makeEmptySnapshot();
  if (config.rpc.primaryUrl !== null || config.rpc.fallbackUrls.length > 0) {
    try {
      const blockStatus = await readBlockStatus(config);
      if (blockStatus.chainId !== config.chainId) {
        readiness.push(`unexpected chainId ${blockStatus.chainId}; expected ${config.chainId}`);
      }
      snapshot.blockNumber = blockStatus.blockNumber;
      snapshot.latestBlockAgeSeconds = Math.max(0, Math.floor(Date.now() / 1000) - blockStatus.blockTimestamp);
      snapshot.validity.rpcFreshness = blockStatus.chainId === config.chainId;
      if (snapshot.validity.rpcFreshness && config.contracts.inferenceVault !== null) {
        const client = await createLoopClient(config);
        if (client !== null) {
          const vaultMetrics = await collectVaultMetrics(config, client, snapshot);
          // liveAssessed flips true ONLY when the vault read actually COMPLETED — keyed off
          // validity.vault, which collectVaultMetrics sets solely on its full-success path
          // (SPEC004 §3, the C1 fix). Two ways it stays false: (a) a partial read where an
          // eth_call throws propagates to the catch below with the pre-collect snapshot intact;
          // (b) collectVaultMetrics EARLY-RETURNS without throwing when asset()!=DIEM (wrong/
          // migrated vault) — validity.vault stays false, so liveAssessed does too → the tick
          // is indeterminate, never a false nominal on a vault we could not read. Distinct from
          // rpcFreshness, which is only a block-header flag.
          snapshot = {
            ...vaultMetrics.snapshot,
            validity: {
              ...vaultMetrics.snapshot.validity,
              liveAssessed: vaultMetrics.snapshot.validity.vault,
            },
          };
          readiness.push(...vaultMetrics.readiness);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      readiness.push(`RPC read failed: ${message}`);
    }
  }

  const alerts = evaluateAlerts(snapshot, config.thresholds);
  return { snapshot, readiness, alerts };
}

export async function runWatchOnce(config: AppConfig, deps: StatusDeps = {}): Promise<StatusResult> {
  const createBackfillClient = deps.createBackfillClient ?? createViemBackfillClient;
  let result = await buildStatus(config, deps);
  const storage = new Storage(config.storage.sqlitePath);
  try {
    if (result.snapshot.validity.rpcFreshness) {
      try {
        const backfillClient = await createBackfillClient(config);
        if (backfillClient !== null) {
          const backfill = await backfillCreditAndHarvestEvents({
            config,
            client: backfillClient,
            storage,
            finalizedBlock: result.snapshot.blockNumber,
          });
          result = {
            ...result,
            readiness: [...result.readiness, ...backfill.readiness],
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result = {
          ...result,
          readiness: [...result.readiness, `event backfill failed: ${message}`],
        };
      }
    }
    const windowStart = result.snapshot.timestamp - YIELD_WINDOW_SECONDS;
    const vaultAssetSamples = storage.listVaultAssetSamplesForWindow(windowStart);
    if (result.snapshot.validity.vault) {
      vaultAssetSamples.push({
        timestamp: result.snapshot.timestamp,
        totalAssetsDiem: result.snapshot.vaultTotalAssetsDiem,
      });
    }
    const yieldWindow = applyYieldWindowMetrics({
      config,
      snapshot: result.snapshot,
      creditSamples: storage.listCreditSamplesSince(windowStart),
      vaultAssetSamples,
    });
    result = {
      ...result,
      snapshot: yieldWindow.snapshot,
      readiness: [...result.readiness, ...yieldWindow.readiness],
      alerts: evaluateAlerts(yieldWindow.snapshot, config.thresholds),
    };
    storage.insertMetricSnapshot(result.snapshot);
    for (const alert of result.alerts) {
      const positionAddress = config.position.owner ?? "unknown";
      const dedupeKey = `${config.chainId}:${positionAddress}:${alert.alertKey}:${alert.level}`;
      const lastDeliveredAt = storage.getLastAlertDelivery(dedupeKey);
      const canDeliver =
        lastDeliveredAt === null || result.snapshot.timestamp - lastDeliveredAt >= alert.cooldownSeconds;
      if (!canDeliver) {
        storage.insertAlert(alert, result.snapshot.timestamp, ["suppressed:cooldown"]);
        continue;
      }
      const delivered = await deliverConfiguredAlerts(
        config,
        [alert],
        result.snapshot.blockNumber,
        result.snapshot.timestamp,
      );
      storage.insertAlert(alert, result.snapshot.timestamp, delivered);
      storage.setLastAlertDelivery(dedupeKey, result.snapshot.timestamp);
    }
    storage.setMeta("lastObservedBlock", result.snapshot.blockNumber.toString());
  } finally {
    storage.close();
  }
  return result;
}
