import { parseDecimalToUnits, WAD } from "../metrics/math.js";
import type { AppConfig } from "../types/domain.js";
import { defaultSizingValues, type LoopSizingScenario } from "./sizing.js";

const DEFAULT_INITIAL_DIEM = "100";
const DEFAULT_TARGET_LEVERAGE = "1.5,2,3";
const DEFAULT_CURVE_DEPTH_DIEM = "0,100,1000,10000";
const DEFAULT_MORPHO_SUPPLY_DIEM = "0,100,1000,10000";
const DEFAULT_VAULT_APY_BPS = "1500";
const DEFAULT_BORROW_APY_BPS = "800";

export interface LoopSizingGridOptions {
  initialDiem?: string;
  initialWstDiem?: string;
  wstDiemNav?: string;
  targetLeverage?: string;
  curveDepthDiem?: string;
  morphoSupplyDiem?: string;
  morphoExistingBorrowDiem?: string;
  vaultApyBps?: string;
  borrowApyBps?: string;
  curveFeeBps?: string;
  slippageBps?: string;
  flashFeeBps?: string;
  maxCurvePositionShareBps?: string;
  maxMorphoUtilizationBps?: string;
  minHealthFactor?: string;
  minNetApyBps?: string;
  holdingDays?: string;
  preset?: string;
}

function splitGrid(value: string, name: string): string[] {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new Error(`${name} must include at least one value`);
  }
  return entries;
}

function parseAmountGrid(value: string, name: string): bigint[] {
  return splitGrid(value, name).map((entry) => {
    try {
      return parseDecimalToUnits(entry);
    } catch (error) {
      throw new Error(
        `${name} contains invalid amount ${entry}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

function parseNonNegativeIntegerGrid(value: string, name: string): number[] {
  return splitGrid(value, name).map((entry) => {
    if (!/^[0-9]+$/.test(entry)) {
      throw new Error(`${name} values must be non-negative integers`);
    }
    const parsed = Number(entry);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`${name} value exceeds safe integer range`);
    }
    return parsed;
  });
}

function parsePositiveInteger(value: string, name: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} exceeds safe integer range`);
  }
  return parsed;
}

export function parseDecimalToBps(value: string, name: string): number {
  if (!/^[0-9]+(\.[0-9]+)?$/.test(value)) {
    throw new Error(`${name} must be a decimal number`);
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > 4) {
    throw new Error(`${name} supports at most four decimal places`);
  }
  const parsed = Number(BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, "0") || "0"));
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} exceeds safe integer range`);
  }
  return parsed;
}

function parseLeverageGrid(value: string, name: string): number[] {
  return splitGrid(value, name).map((entry) => {
    const parsed = parseDecimalToBps(entry, name);
    if (parsed <= 10_000) {
      throw new Error(`${name} values must be greater than 1`);
    }
    return parsed;
  });
}

function parseSingleDecimalToUnits(value: string, name: string): bigint {
  const values = parseAmountGrid(value, name);
  if (values.length !== 1) {
    throw new Error(`${name} must contain exactly one value`);
  }
  return values[0];
}

function initialCollateralValues(options: LoopSizingGridOptions): bigint[] {
  if (options.initialDiem !== undefined && options.initialWstDiem !== undefined) {
    throw new Error("--initial-diem and --initial-wstdiem are mutually exclusive");
  }
  if (options.initialWstDiem === undefined) {
    return parseAmountGrid(options.initialDiem ?? DEFAULT_INITIAL_DIEM, "--initial-diem");
  }
  const nav = parseSingleDecimalToUnits(options.wstDiemNav ?? "1", "--wstdiem-nav");
  return parseAmountGrid(options.initialWstDiem, "--initial-wstdiem").map(
    (wstDiem) => (wstDiem * nav) / WAD,
  );
}

function applyPreset(options: LoopSizingGridOptions): LoopSizingGridOptions {
  if (options.preset === undefined || options.preset === "baseline") {
    return options;
  }
  if (options.preset === "current-zero") {
    return {
      ...options,
      curveDepthDiem: options.curveDepthDiem ?? "0",
      morphoSupplyDiem: options.morphoSupplyDiem ?? "0",
    };
  }
  if (options.preset === "liquidity-sweep") {
    return {
      ...options,
      curveDepthDiem: options.curveDepthDiem ?? "0,100,1000,10000,100000",
      morphoSupplyDiem: options.morphoSupplyDiem ?? "0,100,1000,10000,100000",
      targetLeverage: options.targetLeverage ?? DEFAULT_TARGET_LEVERAGE,
    };
  }
  throw new Error("--preset must be baseline, current-zero, or liquidity-sweep");
}

export function buildLoopSizingScenarios(
  config: AppConfig,
  rawOptions: LoopSizingGridOptions = {},
): LoopSizingScenario[] {
  const options = applyPreset(rawOptions);
  const defaults = defaultSizingValues(config);
  const initialCollateralDiem = initialCollateralValues(options);
  const targetLeverageBps = parseLeverageGrid(
    options.targetLeverage ?? DEFAULT_TARGET_LEVERAGE,
    "--target-leverage",
  );
  const curveDepthDiem = parseAmountGrid(
    options.curveDepthDiem ?? DEFAULT_CURVE_DEPTH_DIEM,
    "--curve-depth-diem",
  );
  const morphoSupplyDiem = parseAmountGrid(
    options.morphoSupplyDiem ?? DEFAULT_MORPHO_SUPPLY_DIEM,
    "--morpho-supply-diem",
  );
  const vaultApyBps = parseNonNegativeIntegerGrid(
    options.vaultApyBps ?? DEFAULT_VAULT_APY_BPS,
    "--vault-apy-bps",
  );
  const borrowApyBps = parseNonNegativeIntegerGrid(
    options.borrowApyBps ?? DEFAULT_BORROW_APY_BPS,
    "--borrow-apy-bps",
  );
  const morphoExistingBorrowDiem =
    options.morphoExistingBorrowDiem === undefined
      ? defaults.morphoExistingBorrowDiem
      : parseSingleDecimalToUnits(
          options.morphoExistingBorrowDiem,
          "--morpho-existing-borrow-diem",
        );
  const curveFeeBps =
    options.curveFeeBps === undefined
      ? defaults.curveFeeBps
      : parseNonNegativeIntegerGrid(options.curveFeeBps, "--curve-fee-bps")[0];
  const maxSlippageBps =
    options.slippageBps === undefined
      ? defaults.maxSlippageBps
      : parseNonNegativeIntegerGrid(options.slippageBps, "--slippage-bps")[0];
  const flashFeeBps =
    options.flashFeeBps === undefined
      ? defaults.flashFeeBps
      : parseNonNegativeIntegerGrid(options.flashFeeBps, "--flash-fee-bps")[0];
  const maxCurvePositionShareBps =
    options.maxCurvePositionShareBps === undefined
      ? defaults.maxCurvePositionShareBps
      : parsePositiveInteger(options.maxCurvePositionShareBps, "--max-curve-position-share-bps");
  const maxMorphoUtilizationBps =
    options.maxMorphoUtilizationBps === undefined
      ? defaults.maxMorphoUtilizationBps
      : parsePositiveInteger(options.maxMorphoUtilizationBps, "--max-morpho-utilization-bps");
  const minHealthFactorBps =
    options.minHealthFactor === undefined
      ? defaults.minHealthFactorBps
      : parseDecimalToBps(options.minHealthFactor, "--min-health-factor");
  const minNetApyBps =
    options.minNetApyBps === undefined
      ? defaults.minNetApyBps
      : parseNonNegativeIntegerGrid(options.minNetApyBps, "--min-net-apy-bps")[0];
  const holdingPeriodDays =
    options.holdingDays === undefined
      ? defaults.holdingPeriodDays
      : parsePositiveInteger(options.holdingDays, "--holding-days");

  const scenarios: LoopSizingScenario[] = [];
  for (const initial of initialCollateralDiem) {
    for (const leverage of targetLeverageBps) {
      for (const curveDepth of curveDepthDiem) {
        for (const morphoSupply of morphoSupplyDiem) {
          for (const vaultApy of vaultApyBps) {
            for (const borrowApy of borrowApyBps) {
              const id = `scenario-${String(scenarios.length + 1).padStart(4, "0")}`;
              scenarios.push({
                ...defaults,
                id,
                initialCollateralDiem: initial,
                targetLeverageBps: leverage,
                curveDepthDiem: curveDepth,
                morphoSupplyDiem: morphoSupply,
                morphoExistingBorrowDiem,
                vaultApyBps: vaultApy,
                borrowApyBps: borrowApy,
                curveFeeBps,
                maxSlippageBps,
                flashFeeBps,
                maxCurvePositionShareBps,
                maxMorphoUtilizationBps,
                minHealthFactorBps,
                minNetApyBps,
                holdingPeriodDays,
              });
            }
          }
        }
      }
    }
  }
  return scenarios;
}
