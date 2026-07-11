import { curvePoolAbi } from "../abi/curvePool.js";
import { inferenceVaultAbi } from "../abi/inferenceVault.js";
import { morphoIrmAbi } from "../abi/morphoIrm.js";
import { formatWad, makeEmptySnapshot } from "../metrics/math.js";
import {
  applyYieldWindowMetrics,
  collectVaultMetrics,
  YIELD_WINDOW_SECONDS,
  type CreditWindowSample,
  type VaultAssetWindowSample,
} from "../metrics/collector.js";
import type { Address, AppConfig, Hex } from "../types/domain.js";
import { CliError } from "../cli/errors.js";
import {
  MORPHO_INITIAL_RATE_AT_TARGET_APR_BPS,
  MORPHO_MAX_RATE_AT_TARGET_APR_BPS,
  MORPHO_MIN_RATE_AT_TARGET_APR_BPS,
  perSecWadToAprBps,
} from "./morphoRate.js";
import { readMorphoMarket, type LoopPreflightClient } from "./preflight.js";
import { quoteCurveExitRoute } from "./routeQuote.js";
import {
  buildLoopSizingReport,
  positionCollateralForScenario,
  type LoopSizingReport,
  type SeedProvenance,
} from "./sizing.js";
import { buildLoopSizingScenarios, type LoopSizingGridOptions } from "./sizingScenarios.js";

/** Structured fail-closed error code for every `--from-chain` seed failure. */
const SEED_BLOCKED = "FROM_CHAIN_SEED_BLOCKED";

const ZERO_ADDRESS = `0x${"0".repeat(40)}` as Address;

const CURVE_POOL_DIEM_INDEX = 0n;
const CURVE_POOL_WSTDIEM_INDEX = 1n;

/**
 * Above this DIEM/wstDIEM leg ratio the chain-seeded curve verdict is demoted to
 * non-authoritative (SPEC003 §6, Open Question 4 — tunable). Deliberately STRICTER than the
 * engine's 20%-leg-deviation warning: a mild imbalance still warns via the engine, but a
 * 2×-lopsided pool degrades the verdict token itself.
 */
const CURVE_IMBALANCE_AUTHORITATIVE_THRESHOLD = 2.0;

/**
 * A read client for the on-chain seed reads. It reuses the injectable-client shape from
 * `preflight.ts` (so tests mock it) and adds `getBlockNumber` for resolving the `latest`
 * pinned block. The production `createViemLoopSimulationClient` satisfies this.
 */
export interface FromChainSeedClient extends LoopPreflightClient {
  getBlockNumber(): Promise<bigint>;
}

/**
 * The chain seeds populated onto a `LoopSizingScenario`. The three Part-A safe seeds are always
 * present; the two Curve legs (Part B-1, SPEC003 §4.2) are present only when the curve is
 * chain-seeded (no explicit curve flag, not `--preset liquidity-sweep`). Both legs are
 * DIEM-denominated (`curveWstDiemLegInDiem` is the wstDIEM leg valued at NAV).
 */
export interface FromChainSeeds {
  rateAtTargetApyBps: number;
  morphoSupplyDiem: bigint;
  morphoExistingBorrowDiem: bigint;
  curveDiemLegDiem?: bigint;
  curveWstDiemLegInDiem?: bigint;
}

export interface FromChainSeedResult {
  seeds: FromChainSeeds;
  provenance: SeedProvenance;
}

/**
 * Which sizing dims the operator supplied explicitly (a flag wins over a chain seed). The curve
 * flags are optional so Part-A callers/tests need not enumerate them; an absent flag reads as
 * "not explicit" and the curve is chain-seeded.
 */
export interface FromChainExplicitFlags {
  rateAtTargetApyBps: boolean;
  morphoSupplyDiem: boolean;
  morphoExistingBorrowDiem: boolean;
  curveDepthDiem?: boolean;
  curveDiemLeg?: boolean;
  curveWstdiemLeg?: boolean;
  // Part B-2: the operator passed `--vault-apy-bps`. Optional so Part-A/B-1 callers/tests need
  // not enumerate it; absent reads as "not explicit" and the vault APY is chain-seeded.
  vaultApyBps?: boolean;
}

/**
 * The minimal read seam `loadVaultApyWindow` needs onto SQLite storage (SPEC003 §4.3). The real
 * `Storage` satisfies it structurally, and tests inject a fake — so the vault-APY window logic is
 * exercised without a live DB. Mirrors the two reads `status.ts` uses to assemble the same window.
 */
export interface VaultApyWindowStore {
  listVaultAssetSamplesForWindow(windowStart: number): VaultAssetWindowSample[];
  listCreditSamplesSince(ts: number): CreditWindowSample[];
}

/**
 * SPEC003 OQ2 sample-density floor (tunable). ≥ N samples across the window before a
 * chain-measured vault APY is stamped authoritative — a 7-day span with 1-2 points is not enough
 * to trust a leverage-amplified APY. Fails SAFE: below the floor → not-seeded (never a 0 seed).
 */
export const MIN_VAULT_APY_WINDOW_SAMPLES = 4;

/** Result of the 7-day vault-APY DB window adapter (SPEC003 §4.3). */
export type VaultApyWindowResult =
  | { source: "measured-7d"; vaultApyBps: number; sampleCount: number }
  | { source: "not-seeded"; sampleCount: number; reason: string };

function toBigInt(value: unknown): bigint {
  return BigInt(value as bigint | number | string);
}

/** Clamp a NON-ZERO rate to Morpho's `[MIN, MAX]` bounds (a zero read is handled upstream). */
function clampNonZeroRateAtTargetApyBps(raw: number): number {
  return Math.min(
    Math.max(raw, MORPHO_MIN_RATE_AT_TARGET_APR_BPS),
    MORPHO_MAX_RATE_AT_TARGET_APR_BPS,
  );
}

/** Full-precision (18-decimal) render of a WAD amount so a re-parse round-trips exactly. */
function seedAmountToGridValue(value: bigint): string {
  return formatWad(value, 18);
}

/**
 * SPEC003 §2 address validation for the two contracts the seed reads hit directly
 * (`adaptiveCurveIrm`, `morphoBlue`): nonzero AND has code, mirroring the bytecode check
 * `preflight.ts` runs for every configured contract. Fails closed with a clear message
 * instead of relying on the raw read to revert.
 */
async function assertContractHasCode(
  client: FromChainSeedClient,
  name: string,
  address: Address,
): Promise<void> {
  if (address.toLowerCase() === ZERO_ADDRESS) {
    throw new CliError(SEED_BLOCKED, `${name} address ${address} has no code`);
  }
  let code: Hex;
  try {
    code = await client.getCode(address);
  } catch (error) {
    throw new CliError(SEED_BLOCKED, `${name} getCode failed: ${message(error)}`);
  }
  if (code === "0x") {
    throw new CliError(SEED_BLOCKED, `${name} address ${address} has no code`);
  }
}

/**
 * Seed the three Part-A safe inputs from live Base reads (SPEC003 §3), fail-closed.
 *
 * (a) resolves the pinned block once (`latest` or `planningBlock`), (b) reads
 * `rateAtTarget(marketId)` and `market(marketId)` BOTH pinned to that same block,
 * (c) derives `rateAtTargetApyBps = perSecWadToAprBps(rateAtTarget)`, (d) returns
 * `{ seeds, provenance }`. Throws a structured `CliError` and emits no report on: RPC
 * unavailable, `chainId !== 8453`, `marketId` null, any read revert, `totalSupplyAssets == 0`.
 */
export async function seedFromChain(input: {
  config: AppConfig;
  client: FromChainSeedClient;
  planningBlock?: bigint;
  seedCurve?: boolean;
}): Promise<FromChainSeedResult> {
  const { config, client, planningBlock, seedCurve = false } = input;

  if (config.morpho.marketId === null) {
    throw new CliError(SEED_BLOCKED, "marketId is required to seed sizing inputs from chain");
  }

  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch (error) {
    throw new CliError(SEED_BLOCKED, `RPC unavailable for --from-chain seeding: ${message(error)}`);
  }
  if (chainId !== config.chainId) {
    throw new CliError(
      SEED_BLOCKED,
      `unexpected chainId ${chainId}; --from-chain requires ${config.chainId}`,
    );
  }

  await assertContractHasCode(client, "adaptiveCurveIrm", config.contracts.adaptiveCurveIrm);
  await assertContractHasCode(client, "morphoBlue", config.contracts.morphoBlue);

  let blockNumber: bigint;
  if (planningBlock !== undefined) {
    blockNumber = planningBlock;
  } else {
    try {
      blockNumber = await client.getBlockNumber();
    } catch (error) {
      throw new CliError(SEED_BLOCKED, `failed to resolve latest block: ${message(error)}`);
    }
  }

  // Both on-chain seed reads are pinned to the SAME resolved block (SPEC003 §2/§8 crit 7).
  let rateAtTargetPerSecWad: bigint;
  try {
    rateAtTargetPerSecWad = toBigInt(
      await client.readContract({
        address: config.contracts.adaptiveCurveIrm,
        abi: morphoIrmAbi,
        functionName: "rateAtTarget",
        args: [config.morpho.marketId],
        blockNumber,
      }),
    );
  } catch (error) {
    throw new CliError(SEED_BLOCKED, `rateAtTarget read reverted: ${message(error)}`);
  }

  let market;
  try {
    market = await readMorphoMarket(config, client, blockNumber);
  } catch (error) {
    throw new CliError(SEED_BLOCKED, `Morpho market read reverted: ${message(error)}`);
  }
  if (market === null) {
    throw new CliError(SEED_BLOCKED, "Morpho market returned an unsupported shape");
  }
  if (market.totalSupplyAssets === 0n) {
    throw new CliError(SEED_BLOCKED, "Morpho market has no DIEM supply assets; cannot size an empty market");
  }

  const warnings: string[] = [];
  let rateAtTargetApyBps: number;
  let rateAtTargetSource: SeedProvenance["rateAtTargetSource"];
  let authoritative = true;

  if (rateAtTargetPerSecWad === 0n) {
    // Uninitialized IRM: the mapping is 0 until first accrual. Fail-closed to the genesis
    // default (NOT clamp-to-10, which would silently seed 0.1% APR and inflate netApy).
    rateAtTargetApyBps = MORPHO_INITIAL_RATE_AT_TARGET_APR_BPS;
    rateAtTargetSource = "uninitialized-default";
    authoritative = false;
    warnings.push(
      "rateAtTarget read as 0 (uninitialized IRM); seeded the Morpho genesis 400 bps default — verdict is not authoritative",
    );
  } else {
    const rawBps = perSecWadToAprBps(rateAtTargetPerSecWad);
    rateAtTargetApyBps = clampNonZeroRateAtTargetApyBps(rawBps);
    rateAtTargetSource = "direct";
    if (rateAtTargetApyBps !== rawBps) {
      warnings.push(
        `rateAtTarget ${rawBps} bps clamped to [${MORPHO_MIN_RATE_AT_TARGET_APR_BPS}, ${MORPHO_MAX_RATE_AT_TARGET_APR_BPS}] bps`,
      );
    }
  }

  // Part B-1 (SPEC003 §4.2): seed the two Curve legs, pinned to the SAME block. Only when the
  // caller has decided to chain-seed the curve (no explicit curve flag, not liquidity-sweep).
  let curveDiemLegDiem: bigint | undefined;
  let curveWstDiemLegInDiem: bigint | undefined;
  let curveImbalanceRatio: number | undefined;
  if (seedCurve) {
    const { curvePool, inferenceVault } = config.contracts;
    if (curvePool === null || inferenceVault === null) {
      throw new CliError(
        SEED_BLOCKED,
        "curvePool and inferenceVault must be configured to seed Curve depth from chain",
      );
    }
    // §2 address validation parity with the Part-A reads (irm/morpho): nonzero + has-code, so a
    // codeless/misconfigured curve address fails closed with a clear message rather than relying
    // on the raw read to revert (and against a non-viem client that might not guard zero data).
    await assertContractHasCode(client, "curvePool", curvePool);
    await assertContractHasCode(client, "inferenceVault", inferenceVault);

    let diemLegDiem: bigint;
    let wstDiemLegRaw: bigint;
    try {
      diemLegDiem = toBigInt(
        await client.readContract({
          address: curvePool,
          abi: curvePoolAbi,
          functionName: "balances",
          args: [CURVE_POOL_DIEM_INDEX],
          blockNumber,
        }),
      );
      wstDiemLegRaw = toBigInt(
        await client.readContract({
          address: curvePool,
          abi: curvePoolAbi,
          functionName: "balances",
          args: [CURVE_POOL_WSTDIEM_INDEX],
          blockNumber,
        }),
      );
    } catch (error) {
      throw new CliError(SEED_BLOCKED, `Curve balances read reverted: ${message(error)}`);
    }

    let wstDiemLegInDiem: bigint;
    try {
      wstDiemLegInDiem = toBigInt(
        await client.readContract({
          address: inferenceVault,
          abi: inferenceVaultAbi,
          functionName: "convertToAssets",
          args: [wstDiemLegRaw],
          blockNumber,
        }),
      );
    } catch (error) {
      throw new CliError(
        SEED_BLOCKED,
        `InferenceVault.convertToAssets (wstDIEM leg) reverted: ${message(error)}`,
      );
    }

    // Both legs zero → empty pool → fail-closed (SPEC003 acceptance 12).
    if (diemLegDiem === 0n && wstDiemLegInDiem === 0n) {
      throw new CliError(
        SEED_BLOCKED,
        "Curve pool has zero DIEM and wstDIEM depth; cannot seed an empty pool",
      );
    }

    curveDiemLegDiem = diemLegDiem;
    curveWstDiemLegInDiem = wstDiemLegInDiem;
    curveImbalanceRatio = computeCurveImbalanceRatio(diemLegDiem, wstDiemLegInDiem);
    if (curveImbalanceRatio > CURVE_IMBALANCE_AUTHORITATIVE_THRESHOLD) {
      authoritative = false;
      warnings.push(
        `curve legs imbalanced ${formatImbalanceRatio(curveImbalanceRatio)}:1 — verdict is not authoritative`,
      );
    }
  }

  return {
    seeds: {
      rateAtTargetApyBps,
      morphoSupplyDiem: market.totalSupplyAssets,
      morphoExistingBorrowDiem: market.totalBorrowAssets,
      curveDiemLegDiem,
      curveWstDiemLegInDiem,
    },
    provenance: {
      blockNumber,
      chainId,
      rateAtTargetSource,
      curveDiemLegDiem,
      curveWstDiemLegDiem: curveWstDiemLegInDiem,
      curveImbalanceRatio,
      seededFields: {
        rateAtTargetApyBps: "chain",
        morphoSupplyDiem: "chain",
        morphoExistingBorrowDiem: "chain",
      },
      authoritative,
      warnings,
    },
  };
}

/**
 * `max(legA, legB) / min(legA, legB)`, always ≥ 1. Defined = 1 when BOTH legs are 0 (defensive
 * against a `0/0 → NaN` that would suppress the warning on the most-drained pool; the both-zero
 * case already fails closed upstream). One leg zero + the other nonzero → `+Infinity` (an extreme
 * imbalance that trips the authoritative demotion).
 */
function computeCurveImbalanceRatio(diemLegDiem: bigint, wstDiemLegInDiem: bigint): number {
  if (diemLegDiem === 0n && wstDiemLegInDiem === 0n) {
    return 1;
  }
  const high = diemLegDiem > wstDiemLegInDiem ? diemLegDiem : wstDiemLegInDiem;
  const low = diemLegDiem > wstDiemLegInDiem ? wstDiemLegInDiem : diemLegDiem;
  if (low === 0n) {
    return Number.POSITIVE_INFINITY;
  }
  return Number((high * 10_000n) / low) / 10_000;
}

function formatImbalanceRatio(ratio: number): string {
  return Number.isFinite(ratio) ? ratio.toFixed(2) : "∞";
}

/**
 * Load a chain-measured vault APY from the 7-day SQLite window (SPEC003 §4.3), mirroring the
 * assembly in `status.ts`. vaultApy is block-pinning EXEMPT (§2): the current vault assets are a
 * plain latest read, so NO `blockNumber` is passed to `collectVaultMetrics`. A `collectVaultMetrics`
 * readiness/failure only means `validity.vault` is false → the current sample is not appended; it
 * never hard-fails the seed.
 *
 * Fails SAFE: on a short OR low-density window it returns `not-seeded` (never a 0 seed, never a
 * throw) so `--from-chain` stays usable on a fresh checkout. On success the returned bps value is
 * `Math.round(baseApy × 10_000)` — the ×10000 is MANDATORY because `computeBaseApy` returns a
 * FRACTION; omitting it seeds a value 10,000× too small (blocks every scenario; acceptance 10).
 */
export async function loadVaultApyWindow(input: {
  config: AppConfig;
  client: FromChainSeedClient;
  store: VaultApyWindowStore;
  nowSeconds: number;
}): Promise<VaultApyWindowResult> {
  const { config, client, store, nowSeconds } = input;

  // Latest (block-pinning EXEMPT) read of the vault's current assets + DIEM-asset validity. A
  // live-read revert / RPC error must NOT hard-fail the command (§4.3): fall back to the DB-only
  // window (no current sample) so a rich DB can still measure-7d and a thin one demotes — never
  // an uncaught throw. Mirrors status.ts, which wraps the identical collectVaultMetrics call.
  let vaultSnapshot;
  try {
    const vault = await collectVaultMetrics(config, client, makeEmptySnapshot(nowSeconds));
    vaultSnapshot = vault.snapshot;
  } catch {
    vaultSnapshot = makeEmptySnapshot(nowSeconds);
  }

  const windowStart = nowSeconds - YIELD_WINDOW_SECONDS;
  const vaultAssetSamples = store.listVaultAssetSamplesForWindow(windowStart);
  if (vaultSnapshot.validity.vault) {
    vaultAssetSamples.push({
      timestamp: nowSeconds,
      totalAssetsDiem: vaultSnapshot.vaultTotalAssetsDiem,
    });
  }
  const creditSamples = store.listCreditSamplesSince(windowStart);

  const result = applyYieldWindowMetrics({
    config,
    snapshot: vaultSnapshot,
    creditSamples,
    vaultAssetSamples,
    nowSeconds,
  });
  const sampleCount = vaultAssetSamples.length;

  if (result.snapshot.validity.yieldWindow !== true) {
    return {
      source: "not-seeded",
      sampleCount,
      reason:
        result.readiness[0] ??
        "insufficient 7-day vault asset history for base APY evidence",
    };
  }
  if (sampleCount < MIN_VAULT_APY_WINDOW_SAMPLES) {
    return {
      source: "not-seeded",
      sampleCount,
      reason: `insufficient sample density (${sampleCount}/${MIN_VAULT_APY_WINDOW_SAMPLES})`,
    };
  }

  // computeBaseApy returns a FRACTION (src/metrics/math.ts:41). The ×10000 is the acceptance-10
  // guard: without it a measured 5% window seeds 5 bps (10,000× too small) and blocks everything.
  const vaultApyBps = Math.round(result.snapshot.baseApy * 10_000);
  return { source: "measured-7d", vaultApyBps, sampleCount };
}

/**
 * Static (non-network) `--from-chain` conflict guards (SPEC003 §3.3/§5). The flat
 * borrow-rate model doesn't consume the seeded adaptive rate, and `--preset current-zero`
 * forces curve depth/Morpho supply to 0 — both conflict with seeding a chain value into the
 * same dims. Deliberately does NOT block `--preset liquidity-sweep`: a chain-seeded dim just
 * collapses that preset's sweep on that dim while the other dims keep sweeping.
 *
 * Purely synchronous and side-effect free so callers (the CLI) can run it BEFORE
 * constructing any RPC client — a static conflict never touches the network.
 */
export function assertFromChainCompatibleOptions(options: LoopSizingGridOptions): void {
  if ((options.borrowRateModel ?? "adaptive-curve") === "flat") {
    throw new CliError(
      "INVALID_INPUT",
      "--from-chain seeds the adaptive rate; pass --borrow-apy-bps for the flat model",
    );
  }
  if (options.preset === "current-zero") {
    throw new CliError(
      "INVALID_INPUT",
      "--from-chain and --preset current-zero set conflicting sources for curve depth and Morpho supply",
    );
  }
}

/**
 * End-to-end `loop sizing --from-chain` report: validate the conflicting-source guards,
 * seed the three safe inputs, apply `explicit flag > chain seed > default` precedence, size
 * the grid, and attach `seedProvenance` + `authoritative` to the report (SPEC003 §5/§6).
 */
export async function buildFromChainSizingReport(input: {
  config: AppConfig;
  client: FromChainSeedClient;
  options: LoopSizingGridOptions;
  explicitFlags: FromChainExplicitFlags;
  planningBlock?: bigint;
  // Part B-2 (SPEC003 §4.3): the SQLite window seam for vault-APY seeding. When ABSENT, the report
  // is byte-identical to Part B-1 (no vault seeding, `vaultApySource` undefined) — every existing
  // Part-A/B-1 caller/test passes no store. The real `Storage` satisfies it structurally.
  store?: VaultApyWindowStore;
}): Promise<LoopSizingReport> {
  const { config, client, options, explicitFlags, planningBlock, store } = input;

  // Defense-in-depth for direct API/test callers; the CLI already runs this before
  // constructing the client.
  assertFromChainCompatibleOptions(options);

  // Curve-seed precedence (SPEC003 §5): an explicit curve flag wins over the chain seed, and
  // `--preset liquidity-sweep` still SWEEPS curve depth. Only otherwise do we chain-seed the two
  // legs (and inject a single live get_dy exit slippage) — mixing a hypothetical/swept leg grid
  // with one real get_dy quote would be internally inconsistent.
  const anyExplicitCurveFlag = Boolean(
    explicitFlags.curveDepthDiem || explicitFlags.curveDiemLeg || explicitFlags.curveWstdiemLeg,
  );
  const curveSweptByPreset = options.preset === "liquidity-sweep";
  const seedCurve = !anyExplicitCurveFlag && !curveSweptByPreset;

  const { seeds, provenance } = await seedFromChain({ config, client, planningBlock, seedCurve });

  const gridOptions: LoopSizingGridOptions = { ...options };
  const seededFields: SeedProvenance["seededFields"] = { ...provenance.seededFields };

  if (explicitFlags.rateAtTargetApyBps) {
    seededFields.rateAtTargetApyBps = "flag";
  } else {
    gridOptions.rateAtTargetApyBps = String(seeds.rateAtTargetApyBps);
  }

  if (explicitFlags.morphoSupplyDiem) {
    seededFields.morphoSupplyDiem = "flag";
  } else {
    gridOptions.morphoSupplyDiem = seedAmountToGridValue(seeds.morphoSupplyDiem);
  }

  if (explicitFlags.morphoExistingBorrowDiem) {
    seededFields.morphoExistingBorrowDiem = "flag";
  } else {
    gridOptions.morphoExistingBorrowDiem = seedAmountToGridValue(seeds.morphoExistingBorrowDiem);
  }

  if (
    seedCurve &&
    seeds.curveDiemLegDiem !== undefined &&
    seeds.curveWstDiemLegInDiem !== undefined
  ) {
    // Seed the two legs as single points (leg mode); drop any curve total so the leg/total
    // mutual-exclusivity guard in `resolveCurveLegPairs` never trips.
    delete gridOptions.curveDepthDiem;
    gridOptions.curveDiemLeg = seedAmountToGridValue(seeds.curveDiemLegDiem);
    gridOptions.curveWstdiemLeg = seedAmountToGridValue(seeds.curveWstDiemLegInDiem);
    seededFields.curveDepthDiem = "chain";
  } else if (anyExplicitCurveFlag) {
    seededFields.curveDepthDiem = "flag";
  }

  // Part B-2 vault-APY seeding (SPEC003 §4.3/§5/§6). Precedence: an explicit `--vault-apy-bps`
  // flag wins over the chain seed (and — being un-measured — still demotes, §6). The DB-window seed
  // runs only when a `store` is supplied; with NO store AND no explicit flag the report is
  // byte-identical to B-1 (`vaultApySource` stays undefined). Never seeds 0 and never hard-fails on
  // a short/low-density window (§4.3): it demotes and lets SPEC002's default/grid stand. vaultApy is
  // block-pinning EXEMPT (§2).
  let vaultApySource: SeedProvenance["vaultApySource"];
  let vaultAuthoritative = true;
  const vaultWarnings: string[] = [];
  if (explicitFlags.vaultApyBps) {
    // The operator's explicit flag wins (§5): do NOT consult the adapter or overwrite the value.
    // But an un-measured (operator-supplied) APY is not chain-authoritative — §6 literally demotes
    // on `vaultApySource ≠ "measured-7d"`. JUDGMENT CALL: the conservative, §6-literal reading is
    // to demote; the alternative reading (an explicit operator flag stays authoritative) is noted
    // in the Part B-2 report. Chosen: demote.
    seededFields.vaultApyBps = "flag";
    vaultApySource = "not-seeded";
    vaultAuthoritative = false;
    vaultWarnings.push(
      "vault APY is operator-supplied (--vault-apy-bps), not chain-measured — verdict is not authoritative",
    );
  } else if (store !== undefined) {
    // §4.3 hard guarantee: a vault-subsystem failure (RPC read revert, DB error) must NOT abort the
    // whole command — the rate/Morpho/curve seeds already succeeded. `loadVaultApyWindow` handles a
    // live-read failure internally (DB-only fallback); this outer catch is the belt against ANY
    // other throw, demoting the verdict rather than emitting no report at all.
    try {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const vaultApy = await loadVaultApyWindow({ config, client, store, nowSeconds });
      if (vaultApy.source === "measured-7d") {
        gridOptions.vaultApyBps = String(vaultApy.vaultApyBps);
        seededFields.vaultApyBps = "chain";
        vaultApySource = "measured-7d";
      } else {
        // Short / low-density window: leave vaultApyBps to the normal SPEC002 path (explicit flag,
        // else default/grid) — never seed 0, never throw. Demote the verdict and continue sizing.
        seededFields.vaultApyBps = "default";
        vaultApySource = "not-seeded";
        vaultAuthoritative = false;
        vaultWarnings.push(
          `vault APY not seeded (${vaultApy.reason}) — verdict is not authoritative`,
        );
      }
    } catch (error) {
      seededFields.vaultApyBps = "default";
      vaultApySource = "not-seeded";
      vaultAuthoritative = false;
      vaultWarnings.push(
        `vault APY not seeded (${message(error)}) — verdict is not authoritative`,
      );
    }
  }

  let scenarios;
  try {
    scenarios = buildLoopSizingScenarios(config, gridOptions);
  } catch (error) {
    throw new CliError("INVALID_INPUT", message(error));
  }

  // Compose the vault demotion with Part A/B-1 (never lose a signal: `&&` keeps a prior false).
  let authoritative = provenance.authoritative && vaultAuthoritative;
  const warnings = [...provenance.warnings, ...vaultWarnings];

  // Inject the live, direction-correct get_dy exit slippage per scenario (SPEC003 §4.2), pinned
  // to the same block as every other seed read. Memoized by position size — a grid sweeping
  // initial×leverage has few distinct sizes, so each distinct size reads once.
  if (seedCurve && seeds.curveDiemLegDiem !== undefined) {
    const injectionBySize = new Map<
      string,
      { exitSlippageBps?: number; readiness?: string }
    >();
    let getDyDemoted = false;
    for (const scenario of scenarios) {
      const positionCollateralDiem = positionCollateralForScenario(scenario);
      // Key on BOTH inputs to `quoteCurveExitRoute`. `maxSlippageBps` is single-valued across the
      // grid today (`sizingScenarios.ts` reads `[0]`) and `priceImpactBps` is slippage-independent,
      // so this is defensive — but it keeps the cache correct if slippage ever becomes a swept dim.
      const key = `${positionCollateralDiem.toString()}:${scenario.maxSlippageBps}`;
      let injection = injectionBySize.get(key);
      if (injection === undefined) {
        injection = await computeExitSlippageInjection({
          config,
          client,
          positionCollateralDiem,
          slippageBps: scenario.maxSlippageBps,
          blockNumber: provenance.blockNumber,
        });
        injectionBySize.set(key, injection);
      }
      if (injection.exitSlippageBps !== undefined) {
        scenario.externalExitSlippageBps = injection.exitSlippageBps;
      } else if (!getDyDemoted) {
        // get_dy unavailable (readiness, e.g. pool returned 0) demotes the verdict but does NOT
        // hard-fail — the engine falls back to the leg-aware estimate on the seeded legs (§6).
        authoritative = false;
        getDyDemoted = true;
        warnings.push(
          `get_dy exit quote unavailable (${injection.readiness ?? "no quote produced"}) — verdict is not authoritative`,
        );
      }
    }
  }

  const report = buildLoopSizingReport(scenarios);
  return {
    ...report,
    seedProvenance: { ...provenance, seededFields, authoritative, warnings, vaultApySource },
    authoritative,
  };
}

/**
 * Resolve the live get_dy exit-slippage bps for one position size (SPEC003 §4.2). Reads
 * `convertToShares(positionCollateralDiem)` — the exit sells wstDIEM shares, not the DIEM
 * notional — then reuses `quoteCurveExitRoute` (`priceImpactBps`) at the pinned block. A
 * convertToShares or quote REVERT fails closed; a `readiness`-only result (no quote) does not
 * inject and returns the reason so the caller can demote the verdict.
 */
async function computeExitSlippageInjection(input: {
  config: AppConfig;
  client: FromChainSeedClient;
  positionCollateralDiem: bigint;
  slippageBps: number;
  blockNumber: bigint;
}): Promise<{ exitSlippageBps?: number; readiness?: string }> {
  const { config, client, positionCollateralDiem, slippageBps, blockNumber } = input;
  const inferenceVault = config.contracts.inferenceVault;
  if (inferenceVault === null) {
    throw new CliError(
      SEED_BLOCKED,
      "inferenceVault must be configured to quote get_dy exit slippage",
    );
  }

  let wstDiemIn: bigint;
  try {
    wstDiemIn = toBigInt(
      await client.readContract({
        address: inferenceVault,
        abi: inferenceVaultAbi,
        functionName: "convertToShares",
        args: [positionCollateralDiem],
        blockNumber,
      }),
    );
  } catch (error) {
    throw new CliError(SEED_BLOCKED, `InferenceVault.convertToShares reverted: ${message(error)}`);
  }

  let quote;
  try {
    quote = await quoteCurveExitRoute({ config, client, wstDiemIn, slippageBps, blockNumber });
  } catch (error) {
    throw new CliError(SEED_BLOCKED, `Curve get_dy exit quote reverted: ${message(error)}`);
  }

  if (quote.quote !== undefined) {
    // Clamp into the rev-2 validator's [0, 10000] window; a >10000 impact means block anyway.
    const clamped = Math.min(Math.max(Math.round(quote.quote.priceImpactBps), 0), 10_000);
    return { exitSlippageBps: clamped };
  }
  return { readiness: quote.readiness.join("; ") || undefined };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
