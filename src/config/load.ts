import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DEFAULT_CONFIG } from "./defaults.js";
import type { AppConfig } from "../types/domain.js";
import { ALLOWED_UNISWAP_V3_FEE_TIERS } from "../loop/uniswapV3FlashFee.js";

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

const configSchema = z
  .object({
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
      agentTgeRegistry: nullableAddressSchema,
      curvePool: nullableAddressSchema,
      morphoOracle: nullableAddressSchema,
      loopExecutor: nullableAddressSchema,
      autoDeleverageExecutor: nullableAddressSchema,
      usdc: nullableAddressSchema,
      venueAdapters: z
        .array(
          z.object({
            address: addressSchema,
            name: z.string().min(1).optional(),
          }),
        )
        .optional()
        .transform((value) => value ?? []),
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
      healthFactorWarn: z.number().min(1.6),
      healthFactorCritical: z.number().min(1.4),
      minPostLoopHealthFactor: z.number().min(1.7),
      spreadWarnNetApy35: z.number().min(0.08),
      spreadCriticalNetApy35: z.number().min(0.08),
      curveDepthWarn: z.number().positive().max(0.2),
      curveDepthCritical: z.number().positive().max(0.2),
      harvestSilenceWarnDays: z.number().positive(),
      harvestSilenceCriticalDays: z.number().positive(),
      oracleDeviationCritical: z.number().positive().max(0.01),
      borrowSpikeBaseApyRatio: z.number().positive(),
      riskFreeRate: z.number().nonnegative(),
      basisDiscountWarnBps: z.number().int().min(1),
      basisDiscountCriticalBps: z.number().int().min(1),
      inferenceReconcileToleranceBps: z.number().int().min(0).max(10_000),
    }),
    basis: z.object({
      // Quoted decimal string only (e.g. "0.97"); null = no configured market price.
      marketPriceDiemPerWstDiem: z
        .union([z.string().regex(/^[0-9]+(\.[0-9]+)?$/), z.null()])
        .optional()
        .transform((value) => value ?? null),
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
    flashLoan: z.object({
      provider: z.enum(["uniswap-v3", "unconfigured"]),
      factory: nullableAddressSchema,
      pool: nullableAddressSchema,
      loanToken: nullableAddressSchema,
      pairToken: nullableAddressSchema,
      feeTier: z.number().int().positive().nullable(),
    }),
    storage: z.object({
      sqlitePath: z.string().min(1),
    }),
    execution: z.object({
      defaultSlippageBps: z.number().int().min(0).max(300),
      maxSlippageBps: z.number().int().min(0).max(300),
      maxCurvePriceImpactBps: z.number().int().min(0).max(100),
      exitRepayBufferBps: z.number().int().min(1).max(10_000),
      maxBaseApyStalenessBlocks: z.number().int().min(0),
      transactionDeadlineSeconds: z.number().int().positive(),
    }),
  })
  .superRefine((config, ctx) => {
    if (config.execution.defaultSlippageBps > config.execution.maxSlippageBps) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["execution", "defaultSlippageBps"],
        message: "defaultSlippageBps must be less than or equal to maxSlippageBps",
      });
    }
    if (config.thresholds.healthFactorCritical > config.thresholds.healthFactorWarn) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["thresholds", "healthFactorCritical"],
        message: "healthFactorCritical must be less than or equal to healthFactorWarn",
      });
    }
    if (config.thresholds.curveDepthWarn > config.thresholds.curveDepthCritical) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["thresholds", "curveDepthWarn"],
        message: "curveDepthWarn must be less than or equal to curveDepthCritical",
      });
    }
    if (config.thresholds.spreadCriticalNetApy35 > config.thresholds.spreadWarnNetApy35) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["thresholds", "spreadCriticalNetApy35"],
        message: "spreadCriticalNetApy35 must be less than or equal to spreadWarnNetApy35",
      });
    }
    // SPEC007: larger discount bps = more severe → critical ≥ warn
    if (config.thresholds.basisDiscountCriticalBps < config.thresholds.basisDiscountWarnBps) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["thresholds", "basisDiscountCriticalBps"],
        message: "basisDiscountCriticalBps must be greater than or equal to basisDiscountWarnBps",
      });
    }
    if (config.flashLoan.provider === "uniswap-v3") {
      for (const key of ["factory", "pool", "loanToken", "pairToken", "feeTier"] as const) {
        if (config.flashLoan[key] === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["flashLoan", key],
            message: `${key} is required when flashLoan.provider is uniswap-v3`,
          });
        }
      }
      if (config.flashLoan.loanToken !== null && config.flashLoan.loanToken.toLowerCase() !== config.contracts.diem.toLowerCase()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["flashLoan", "loanToken"],
          message: "flashLoan.loanToken must match contracts.diem",
        });
      }
      if (
        config.flashLoan.loanToken !== null &&
        config.flashLoan.pairToken !== null &&
        config.flashLoan.loanToken.toLowerCase() === config.flashLoan.pairToken.toLowerCase()
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["flashLoan", "pairToken"],
          message: "flashLoan.pairToken must differ from loanToken",
        });
      }
      if (config.flashLoan.feeTier !== null && !ALLOWED_UNISWAP_V3_FEE_TIERS.has(config.flashLoan.feeTier)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["flashLoan", "feeTier"],
          message: "flashLoan.feeTier must be a supported Uniswap V3 tier",
        });
      }
    }
  });

export interface LoadConfigOptions {
  configPath?: string;
  overrides?: Partial<AppConfig>;
}

export function interpolateEnv(input: string): string | null {
  const missing = new Set<string>();
  const interpolated = input.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
    const value = process.env[name];
    if (value === undefined) {
      missing.add(name);
      return "";
    }
    return value;
  });
  if (interpolated.trim() === "") {
    return null;
  }
  if (missing.size > 0) {
    throw new Error(`Unresolved env var(s) in config value: ${Array.from(missing).join(", ")}`);
  }
  return interpolated;
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
