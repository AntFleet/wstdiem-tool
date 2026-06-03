import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DEFAULT_CONFIG } from "./defaults.js";
import type { AppConfig } from "../types/domain.js";

dotenv.config();

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .transform((value) => value as `0x${string}`);

const nullableAddressSchema = z
  .union([addressSchema, z.null()])
  .optional()
  .transform((value) => value ?? null);

const hexSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]+$/)
  .transform((value) => value as `0x${string}`);

const configSchema = z.object({
  chainId: z.number().int().positive(),
  rpc: z.object({
    primaryUrl: z.string().url().nullable(),
    fallbackUrls: z.array(z.string().url()),
    timeoutMs: z.number().int().positive(),
  }),
  contracts: z.object({
    diem: addressSchema,
    weth: addressSchema,
    vvv: addressSchema,
    vvvStaking: addressSchema,
    morphoBlue: addressSchema,
    adaptiveCurveIrm: addressSchema,
    curveFactory: addressSchema,
    uniswapV4PoolManager: addressSchema,
    inferenceVault: nullableAddressSchema,
    feeRouter: nullableAddressSchema,
    curvePool: nullableAddressSchema,
    morphoOracle: nullableAddressSchema,
    loopExecutor: nullableAddressSchema,
    autoDeleverageExecutor: nullableAddressSchema,
  }),
  morpho: z.object({
    marketId: z
      .union([hexSchema, z.null()])
      .optional()
      .transform((value) => value ?? null),
    lltvWad: z.string().regex(/^[0-9]+$/),
  }),
  wallet: z.object({
    privateKeyEnv: z.string().min(1),
    hardware: z.object({
      enabled: z.boolean(),
      derivationPath: z.string().min(1),
    }),
  }),
  position: z.object({
    owner: nullableAddressSchema,
  }),
  thresholds: z.object({
    healthFactorWarn: z.number().positive(),
    healthFactorCritical: z.number().positive(),
    minPostLoopHealthFactor: z.number().positive(),
    spreadWarnNetApy35: z.number(),
    spreadCriticalNetApy35: z.number(),
    curveDepthWarn: z.number().positive(),
    curveDepthCritical: z.number().positive(),
    harvestSilenceWarnDays: z.number().positive(),
    harvestSilenceCriticalDays: z.number().positive(),
    oracleDeviationCritical: z.number().positive(),
    borrowSpikeBaseApyRatio: z.number().positive(),
    riskFreeRate: z.number().nonnegative(),
  }),
  alerts: z.object({
    webhookUrls: z.array(z.string().url()),
    telegram: z.object({
      botTokenEnv: z.string().min(1),
      chatId: z.string().nullable(),
    }),
  }),
  automation: z.object({
    provider: z.enum(["gelato", "chainlink"]),
    gelatoTaskId: z.string().nullable(),
    chainlinkUpkeepId: z.string().nullable(),
  }),
  storage: z.object({
    sqlitePath: z.string().min(1),
  }),
  execution: z.object({
    defaultSlippageBps: z.number().int().min(0),
    maxSlippageBps: z.number().int().min(0),
    maxCurvePriceImpactBps: z.number().int().min(0),
    transactionDeadlineSeconds: z.number().int().positive(),
  }),
});

export interface LoadConfigOptions {
  configPath?: string;
  overrides?: Partial<AppConfig>;
}

export function interpolateEnv(input: string): string | null {
  const interpolated = input.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
    return process.env[name] ?? "";
  });
  return interpolated.trim() === "" ? null : interpolated;
}

function resolveEnvPlaceholders(value: unknown): unknown {
  if (typeof value === "string") {
    return interpolateEnv(value);
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvPlaceholders).filter((entry) => entry !== null);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveEnvPlaceholders(entry)]),
    );
  }
  return value;
}

function deepMerge<T>(base: T, patch: Partial<T>): T {
  const output: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      output[key] &&
      typeof output[key] === "object" &&
      !Array.isArray(output[key])
    ) {
      output[key] = deepMerge(output[key], value as Partial<unknown>);
    } else if (value !== undefined) {
      output[key] = value;
    }
  }
  return output as T;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const configPath = options.configPath ?? "config.yaml";
  const absolute = path.resolve(configPath);
  const fileConfig = fs.existsSync(absolute)
    ? (resolveEnvPlaceholders(parseYaml(fs.readFileSync(absolute, "utf8"))) as Partial<AppConfig>)
    : {};
  const merged = deepMerge(deepMerge(DEFAULT_CONFIG, fileConfig), options.overrides ?? {});
  return configSchema.parse(merged);
}

export function missingDeploymentKeys(config: AppConfig): string[] {
  const required = ["inferenceVault", "feeRouter", "curvePool", "morphoOracle", "loopExecutor"] as const;
  const missing = required.filter((key) => config.contracts[key] === null);
  if (config.morpho.marketId === null) {
    missing.push("marketId" as (typeof required)[number]);
  }
  return missing;
}
