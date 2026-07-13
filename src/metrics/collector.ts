import { inferenceVaultAbi } from "../abi/inferenceVault.js";
import type { Address, AppConfig, MetricSnapshot } from "../types/domain.js";
import {
  WAD,
  computeBaseApy,
  computeNav,
  computeNetApy,
  computeSpreadScore,
  formatWad,
  makeEmptySnapshot,
} from "./math.js";

export interface MetricsReadClient {
  readContract(args: {
    address: Address;
    abi: unknown;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

export interface MetricsCollectionResult {
  snapshot: MetricSnapshot;
  readiness: string[];
}

export interface CreditWindowSample {
  timestamp: number;
  amountDiem: bigint;
}

export interface VaultAssetWindowSample {
  timestamp: number;
  totalAssetsDiem: bigint;
}

export const YIELD_WINDOW_SECONDS = 7 * 24 * 60 * 60;

function sumCreditDiem(samples: CreditWindowSample[], windowStart: number, windowEnd: number): bigint {
  return samples.reduce((total, sample) => {
    if (sample.timestamp < windowStart || sample.timestamp > windowEnd) {
      return total;
    }
    return total + sample.amountDiem;
  }, 0n);
}

function timeWeightedAverageVaultAssets(
  samples: VaultAssetWindowSample[],
  windowStart: number,
  windowEnd: number,
): bigint | null {
  const sorted = [...samples].sort((left, right) => left.timestamp - right.timestamp);
  const initial = sorted.filter((sample) => sample.timestamp <= windowStart).at(-1);
  if (initial === undefined || sorted.length < 2) {
    return null;
  }

  let currentAssets = initial.totalAssetsDiem;
  let currentTime = windowStart;
  let weightedAssetsSeconds = 0n;
  for (const sample of sorted) {
    if (sample.timestamp <= windowStart) {
      continue;
    }
    if (sample.timestamp > windowEnd) {
      break;
    }
    if (sample.timestamp > currentTime) {
      weightedAssetsSeconds += currentAssets * BigInt(sample.timestamp - currentTime);
      currentTime = sample.timestamp;
    }
    currentAssets = sample.totalAssetsDiem;
  }
  if (currentTime < windowEnd) {
    weightedAssetsSeconds += currentAssets * BigInt(windowEnd - currentTime);
  }
  return weightedAssetsSeconds / BigInt(windowEnd - windowStart);
}

export function applyYieldWindowMetrics(input: {
  config: AppConfig;
  snapshot: MetricSnapshot;
  creditSamples: CreditWindowSample[];
  vaultAssetSamples: VaultAssetWindowSample[];
  nowSeconds?: number;
}): MetricsCollectionResult {
  const windowEnd = input.nowSeconds ?? input.snapshot.timestamp;
  const windowStart = windowEnd - YIELD_WINDOW_SECONDS;
  const averageVaultAssets = timeWeightedAverageVaultAssets(input.vaultAssetSamples, windowStart, windowEnd);
  if (averageVaultAssets === null || averageVaultAssets === 0n) {
    return {
      snapshot: input.snapshot,
      readiness: ["insufficient 7-day vault asset history for base APY evidence"],
    };
  }

  const rollingCreditDiem = sumCreditDiem(input.creditSamples, windowStart, windowEnd);
  const baseApy = computeBaseApy(rollingCreditDiem, averageVaultAssets);
  const netApy35 = computeNetApy(3.5, baseApy, input.snapshot.borrowRate);
  return {
    snapshot: {
      ...input.snapshot,
      validity: {
        ...input.snapshot.validity,
        yieldWindow: true,
      },
      baseApy,
      netApy35,
      spreadScore: computeSpreadScore(netApy35, input.config.thresholds.riskFreeRate),
    },
    readiness: [],
  };
}

export async function collectVaultMetrics(
  config: AppConfig,
  client: MetricsReadClient,
  baseSnapshot: MetricSnapshot = makeEmptySnapshot(),
): Promise<MetricsCollectionResult> {
  if (config.contracts.inferenceVault === null) {
    return {
      snapshot: baseSnapshot,
      readiness: ["missing inferenceVault; vault metrics unavailable"],
    };
  }

  const asset = (await client.readContract({
    address: config.contracts.inferenceVault,
    abi: inferenceVaultAbi,
    functionName: "asset",
  })) as Address;
  if (asset.toLowerCase() !== config.contracts.diem.toLowerCase()) {
    return {
      snapshot: baseSnapshot,
      readiness: [`vault.asset() ${asset} does not match DIEM ${config.contracts.diem}`],
    };
  }

  const [totalAssets, totalSupply, oneWstDiemAssets] = await Promise.all([
    client.readContract({
      address: config.contracts.inferenceVault,
      abi: inferenceVaultAbi,
      functionName: "totalAssets",
    }),
    client.readContract({
      address: config.contracts.inferenceVault,
      abi: inferenceVaultAbi,
      functionName: "totalSupply",
    }),
    client.readContract({
      address: config.contracts.inferenceVault,
      abi: inferenceVaultAbi,
      functionName: "convertToAssets",
      args: [WAD],
    }),
  ]);

  const nav = computeNav(
    BigInt(totalAssets as bigint | number | string),
    BigInt(totalSupply as bigint | number | string),
  );
  const convertToAssetsNav = BigInt(oneWstDiemAssets as bigint | number | string);
  const readiness =
    convertToAssetsNav > 0n && convertToAssetsNav !== nav.nav
      ? ["vault convertToAssets(1e18) differs from totalAssets/totalSupply NAV"]
      : [];
  return {
    snapshot: {
      ...baseSnapshot,
      validity: {
        ...baseSnapshot.validity,
        vault: true,
      },
      nav: nav.nav,
      navDisplay: formatWad(nav.nav),
      navSource: nav.source,
      vaultTotalAssetsDiem: BigInt(totalAssets as bigint | number | string),
      // SPEC009: persist supply for start-of-window S_start (already fetched for NAV).
      totalSupply: BigInt(totalSupply as bigint | number | string),
    },
    readiness,
  };
}
