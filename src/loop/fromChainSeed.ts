import { morphoIrmAbi } from "../abi/morphoIrm.js";
import { formatWad } from "../metrics/math.js";
import type { Address, AppConfig, Hex } from "../types/domain.js";
import { CliError } from "../cli/errors.js";
import {
  MORPHO_INITIAL_RATE_AT_TARGET_APR_BPS,
  MORPHO_MAX_RATE_AT_TARGET_APR_BPS,
  MORPHO_MIN_RATE_AT_TARGET_APR_BPS,
  perSecWadToAprBps,
} from "./morphoRate.js";
import { readMorphoMarket, type LoopPreflightClient } from "./preflight.js";
import {
  buildLoopSizingReport,
  type LoopSizingReport,
  type SeedProvenance,
} from "./sizing.js";
import { buildLoopSizingScenarios, type LoopSizingGridOptions } from "./sizingScenarios.js";

/** Structured fail-closed error code for every `--from-chain` seed failure. */
const SEED_BLOCKED = "FROM_CHAIN_SEED_BLOCKED";

const ZERO_ADDRESS = `0x${"0".repeat(40)}` as Address;

/**
 * A read client for the on-chain seed reads. It reuses the injectable-client shape from
 * `preflight.ts` (so tests mock it) and adds `getBlockNumber` for resolving the `latest`
 * pinned block. The production `createViemLoopSimulationClient` satisfies this.
 */
export interface FromChainSeedClient extends LoopPreflightClient {
  getBlockNumber(): Promise<bigint>;
}

/** The three Part-A safe seeds populated onto a `LoopSizingScenario`. */
export interface FromChainSeeds {
  rateAtTargetApyBps: number;
  morphoSupplyDiem: bigint;
  morphoExistingBorrowDiem: bigint;
}

export interface FromChainSeedResult {
  seeds: FromChainSeeds;
  provenance: SeedProvenance;
}

/** Which sizing dims the operator supplied explicitly (a flag wins over a chain seed). */
export interface FromChainExplicitFlags {
  rateAtTargetApyBps: boolean;
  morphoSupplyDiem: boolean;
  morphoExistingBorrowDiem: boolean;
}

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
}): Promise<FromChainSeedResult> {
  const { config, client, planningBlock } = input;

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

  return {
    seeds: {
      rateAtTargetApyBps,
      morphoSupplyDiem: market.totalSupplyAssets,
      morphoExistingBorrowDiem: market.totalBorrowAssets,
    },
    provenance: {
      blockNumber,
      chainId,
      rateAtTargetSource,
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
}): Promise<LoopSizingReport> {
  const { config, client, options, explicitFlags, planningBlock } = input;

  // Defense-in-depth for direct API/test callers; the CLI already runs this before
  // constructing the client.
  assertFromChainCompatibleOptions(options);

  const { seeds, provenance } = await seedFromChain({ config, client, planningBlock });

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

  let scenarios;
  try {
    scenarios = buildLoopSizingScenarios(config, gridOptions);
  } catch (error) {
    throw new CliError("INVALID_INPUT", message(error));
  }

  const report = buildLoopSizingReport(scenarios);
  return {
    ...report,
    seedProvenance: { ...provenance, seededFields },
    authoritative: provenance.authoritative,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
