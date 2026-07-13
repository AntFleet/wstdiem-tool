import { createHash } from "node:crypto";
import {
  CAPACITY_DISCLAIMER,
  CAPACITY_KIND,
  CapacitySearchError,
  findLoopCapacity,
  type CapacityInputMode,
  type FindLoopCapacityInput,
  type LoopCapacityResult,
} from "./capacity.js";
import {
  positionCollateralForScenario,
  sizeLoopScenario,
  type LoopSizingResult,
  type LoopSizingScenario,
} from "./sizing.js";

export const BRIEF_DISCLAIMER_SUFFIX =
  " Deltas are vs this tool's last comparable stored brief run on this SQLite file (same input mode and template), not vs a market benchmark.";

export const BRIEF_DISCLAIMER = `${CAPACITY_DISCLAIMER}${BRIEF_DISCLAIMER_SUFFIX}`;

export interface BriefSnapshot {
  timestamp: number;
  blockNumber: string | null;
  chainId: number;
  inputMode: CapacityInputMode;
  templateFingerprint: string;
  persistable: boolean;
  rateAtTargetApyBps: number | null;
  effectiveBorrowApyBpsAtCanonical: Record<string, number>;
  vaultApyBps: number | null;
  vaultApySource: "measured-7d" | "not-seeded" | "flag" | null;
  curveDiemLegDiem: string | null;
  curveWstDiemLegDiem: string | null;
  morphoSupplyDiem: string | null;
  morphoExistingBorrowDiem: string | null;
  morphoRawAvailableDiem: string | null;
  capacities: Array<{
    targetLeverageBps: number;
    capacityEquityDiem: string;
    capacityNotionalDiem: string;
    headroomToBlockEquityDiem: string;
    capacityStatus: string;
    bindingConstraint: string;
  }>;
  netApyAtCanonical: Array<{
    targetLeverageBps: number;
    equityDiem: string;
    netApyBps: number;
    netApyStressedBps: number;
    status: string;
  }>;
  authoritative: boolean;
  warnings: string[];
  decisionSupportOnly: true;
  notADeployRecommendation: true;
  capacityKind: "point-in-time-gate-bound-last-candidate";
  modelCaveats: string[];
  disclaimer: string;
}

export interface BriefDeltas {
  rateAtTargetApyBps: number | null;
  vaultApyBps: number | null;
  morphoRawAvailableDiem: string | null;
  curveDiemLegDiem: string | null;
  perLeverage: Array<{
    targetLeverageBps: number;
    capacityEquityDiem: string | null;
    capacityNotionalDiem: string | null;
    netApyBps: number | null;
    capacityStatusTransition: string | null;
    bindingConstraintTransition: string | null;
  }>;
  incomparable: boolean;
  incomparableReason?: string;
}

export interface LoopBriefResult {
  current: BriefSnapshot;
  previous: BriefSnapshot | null;
  deltas: BriefDeltas | null;
  capacities: LoopCapacityResult[];
  netApyGrid: LoopSizingResult[];
  authoritative: boolean;
  warnings: string[];
  decisionSupportOnly: true;
  notADeployRecommendation: true;
  capacityKind: "point-in-time-gate-bound-last-candidate";
  modelCaveats: string[];
  disclaimer: string;
}

/** Gate/fee knobs that alter sizeLoopScenario (SPEC006 §3.2 fingerprint preimage). */
export interface TemplateFingerprintInput {
  inputMode: CapacityInputMode;
  leverageGridBps: number[];
  canonicalEquityDiem: bigint;
  minHealthFactorBps: number;
  minNetApyBps: number;
  maxSlippageBps: number;
  maxMorphoUtilizationBps: number;
  maxCurvePositionShareBps: number;
  holdingPeriodDays: number;
  gasCostDiem: bigint;
  curveFeeBps: number;
  flashFeeBps: number;
  exitRepayBufferBps: number;
  lltvBps: number;
  borrowRateModel: string;
}

/** Stable JSON (sorted keys) → sha256 hex. */
export function computeTemplateFingerprint(input: TemplateFingerprintInput): string {
  const preimage = {
    borrowRateModel: input.borrowRateModel,
    canonicalEquityDiem: input.canonicalEquityDiem.toString(),
    curveFeeBps: input.curveFeeBps,
    exitRepayBufferBps: input.exitRepayBufferBps,
    flashFeeBps: input.flashFeeBps,
    gasCostDiem: input.gasCostDiem.toString(),
    holdingPeriodDays: input.holdingPeriodDays,
    inputMode: input.inputMode,
    leverageGridBps: [...input.leverageGridBps].sort((a, b) => a - b),
    lltvBps: input.lltvBps,
    maxCurvePositionShareBps: input.maxCurvePositionShareBps,
    maxMorphoUtilizationBps: input.maxMorphoUtilizationBps,
    maxSlippageBps: input.maxSlippageBps,
    minHealthFactorBps: input.minHealthFactorBps,
    minNetApyBps: input.minNetApyBps,
  };
  const json = JSON.stringify(preimage, Object.keys(preimage).sort());
  return createHash("sha256").update(json).digest("hex");
}

export function fingerprintFromTemplate(
  template: LoopSizingScenario,
  inputMode: CapacityInputMode,
  leverageGridBps: number[],
  canonicalEquityDiem: bigint,
): string {
  return computeTemplateFingerprint({
    inputMode,
    leverageGridBps,
    canonicalEquityDiem,
    minHealthFactorBps: template.minHealthFactorBps,
    minNetApyBps: template.minNetApyBps,
    maxSlippageBps: template.maxSlippageBps,
    maxMorphoUtilizationBps: template.maxMorphoUtilizationBps,
    maxCurvePositionShareBps: template.maxCurvePositionShareBps,
    holdingPeriodDays: template.holdingPeriodDays,
    gasCostDiem: template.gasCostDiem,
    curveFeeBps: template.curveFeeBps,
    flashFeeBps: template.flashFeeBps,
    exitRepayBufferBps: template.exitRepayBufferBps,
    lltvBps: template.lltvBps,
    borrowRateModel: template.borrowRateModel,
  });
}

function signedBigIntDelta(current: bigint | null, previous: bigint | null): string | null {
  if (current === null || previous === null) {
    return null;
  }
  return (current - previous).toString();
}

function numDelta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) {
    return null;
  }
  return current - previous;
}

function parseBigIntString(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined) {
    return null;
  }
  return BigInt(value);
}

/**
 * Delta vs previous comparable brief (SPEC006 §3.3).
 * No previous → caller sets deltas null. Same mode+fingerprint → fully populated.
 */
export function computeBriefDeltas(
  current: BriefSnapshot,
  previous: BriefSnapshot,
): BriefDeltas {
  const prevByLev = new Map(
    previous.capacities.map((row) => [row.targetLeverageBps, row] as const),
  );
  const prevNetByLev = new Map(
    previous.netApyAtCanonical.map((row) => [row.targetLeverageBps, row] as const),
  );
  const levSet = new Set<number>([
    ...current.capacities.map((r) => r.targetLeverageBps),
    ...previous.capacities.map((r) => r.targetLeverageBps),
  ]);

  const perLeverage = [...levSet]
    .sort((a, b) => a - b)
    .map((targetLeverageBps) => {
      const curCap = current.capacities.find((r) => r.targetLeverageBps === targetLeverageBps);
      const prevCap = prevByLev.get(targetLeverageBps);
      const curNet = current.netApyAtCanonical.find((r) => r.targetLeverageBps === targetLeverageBps);
      const prevNet = prevNetByLev.get(targetLeverageBps);

      const capacityEquityDiem =
        curCap === undefined || prevCap === undefined
          ? null
          : signedBigIntDelta(BigInt(curCap.capacityEquityDiem), BigInt(prevCap.capacityEquityDiem));
      const capacityNotionalDiem =
        curCap === undefined || prevCap === undefined
          ? null
          : signedBigIntDelta(
              BigInt(curCap.capacityNotionalDiem),
              BigInt(prevCap.capacityNotionalDiem),
            );
      const netApyBps =
        curNet === undefined || prevNet === undefined
          ? null
          : curNet.netApyBps - prevNet.netApyBps;

      const capacityStatusTransition =
        curCap !== undefined &&
        prevCap !== undefined &&
        curCap.capacityStatus !== prevCap.capacityStatus
          ? `${prevCap.capacityStatus} → ${curCap.capacityStatus}`
          : null;
      const bindingConstraintTransition =
        curCap !== undefined &&
        prevCap !== undefined &&
        curCap.bindingConstraint !== prevCap.bindingConstraint
          ? `${prevCap.bindingConstraint} → ${curCap.bindingConstraint}`
          : null;

      return {
        targetLeverageBps,
        capacityEquityDiem,
        capacityNotionalDiem,
        netApyBps,
        capacityStatusTransition,
        bindingConstraintTransition,
      };
    });

  return {
    rateAtTargetApyBps: numDelta(current.rateAtTargetApyBps, previous.rateAtTargetApyBps),
    vaultApyBps: numDelta(current.vaultApyBps, previous.vaultApyBps),
    morphoRawAvailableDiem: signedBigIntDelta(
      parseBigIntString(current.morphoRawAvailableDiem),
      parseBigIntString(previous.morphoRawAvailableDiem),
    ),
    curveDiemLegDiem: signedBigIntDelta(
      parseBigIntString(current.curveDiemLegDiem),
      parseBigIntString(previous.curveDiemLegDiem),
    ),
    perLeverage,
    incomparable: false,
  };
}

export interface BuildBriefInput {
  templatesByLeverage: Map<number, LoopSizingScenario>;
  leverageGridBps: number[];
  canonicalEquityDiem: bigint;
  inputMode: CapacityInputMode;
  chainId: number;
  blockNumber?: bigint | null;
  timestamp?: number;
  vaultApySource?: BriefSnapshot["vaultApySource"];
  capacityOptions?: Omit<FindLoopCapacityInput, "template" | "inputMode">;
  previous?: BriefSnapshot | null;
}

export async function buildLoopBrief(input: BuildBriefInput): Promise<LoopBriefResult> {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const capacities: LoopCapacityResult[] = [];
  const netApyGrid: LoopSizingResult[] = [];
  const warnings: string[] = [];
  let authoritative = input.inputMode !== "offline-defaults";

  const firstTemplate = input.templatesByLeverage.get(input.leverageGridBps[0]);
  if (firstTemplate === undefined) {
    throw new Error("buildLoopBrief requires at least one leverage template");
  }

  const templateFingerprint = fingerprintFromTemplate(
    firstTemplate,
    input.inputMode,
    input.leverageGridBps,
    input.canonicalEquityDiem,
  );

  const persistable = input.inputMode !== "offline-defaults";

  for (const leverageBps of input.leverageGridBps) {
    const template = input.templatesByLeverage.get(leverageBps);
    if (template === undefined) {
      throw new Error(`missing template for leverage ${leverageBps}`);
    }
    const cap = await findLoopCapacity({
      template,
      inputMode: input.inputMode,
      ...input.capacityOptions,
    });
    capacities.push(cap);
    warnings.push(...cap.warnings);
    if (!cap.authoritative) {
      authoritative = false;
    }

    const netScenario: LoopSizingScenario = {
      ...template,
      id: `brief-net-${leverageBps}`,
      initialCollateralDiem: input.canonicalEquityDiem,
      targetLeverageBps: leverageBps,
    };
    if (input.capacityOptions?.quoteExitSlippage !== undefined) {
      const quote = await input.capacityOptions.quoteExitSlippage(
        positionCollateralForScenario(netScenario),
        netScenario.maxSlippageBps,
        input.capacityOptions.blockNumber ?? input.blockNumber ?? 0n,
      );
      if ("bps" in quote) {
        netScenario.externalExitSlippageBps = quote.bps;
      } else if ("demote" in quote) {
        authoritative = false;
        warnings.push(`get_dy exit quote unavailable (${quote.demote}) — net APY non-authoritative`);
      } else if ("hardFail" in quote) {
        throw new CapacitySearchError("FROM_CHAIN_SEED_BLOCKED", quote.hardFail);
      }
    }
    netApyGrid.push(sizeLoopScenario(netScenario));
  }

  const effectiveBorrowApyBpsAtCanonical: Record<string, number> = {};
  for (const row of netApyGrid) {
    effectiveBorrowApyBpsAtCanonical[String(row.scenario.targetLeverageBps)] =
      row.effectiveBorrowApyBps;
  }

  const modelCaveats = capacities[0]?.modelCaveats ?? [
    "single-block-snapshot",
    "no-concurrent-flow",
    "last-candidate-no-operator-buffer",
    "gas-unmodeled-unless-flagged",
    "vault-apy-input",
    "linear-or-get_dy-slippage-model",
    "spec002-section-8",
  ];

  const current: BriefSnapshot = {
    timestamp,
    blockNumber: input.blockNumber === undefined || input.blockNumber === null
      ? null
      : input.blockNumber.toString(),
    chainId: input.chainId,
    inputMode: input.inputMode,
    templateFingerprint,
    persistable,
    rateAtTargetApyBps: firstTemplate.rateAtTargetApyBps,
    effectiveBorrowApyBpsAtCanonical,
    vaultApyBps: firstTemplate.vaultApyBps,
    vaultApySource: input.vaultApySource ?? null,
    curveDiemLegDiem: firstTemplate.curveDiemLegDiem.toString(),
    curveWstDiemLegDiem: firstTemplate.curveWstDiemLegDiem.toString(),
    morphoSupplyDiem: firstTemplate.morphoSupplyDiem.toString(),
    morphoExistingBorrowDiem: firstTemplate.morphoExistingBorrowDiem.toString(),
    morphoRawAvailableDiem: (
      firstTemplate.morphoSupplyDiem > firstTemplate.morphoExistingBorrowDiem
        ? firstTemplate.morphoSupplyDiem - firstTemplate.morphoExistingBorrowDiem
        : 0n
    ).toString(),
    capacities: capacities.map((cap) => ({
      targetLeverageBps: cap.targetLeverageBps,
      capacityEquityDiem: cap.capacityEquityDiem.toString(),
      capacityNotionalDiem: cap.capacityNotionalDiem.toString(),
      headroomToBlockEquityDiem: cap.headroomToBlockEquityDiem.toString(),
      capacityStatus: cap.capacityStatus,
      bindingConstraint: cap.bindingConstraint,
    })),
    netApyAtCanonical: netApyGrid.map((row) => ({
      targetLeverageBps: row.scenario.targetLeverageBps,
      equityDiem: row.equityDiem.toString(),
      netApyBps: row.netApyBps,
      netApyStressedBps: row.netApyStressedBps,
      status: row.status,
    })),
    authoritative,
    warnings: [...new Set(warnings)],
    decisionSupportOnly: true,
    notADeployRecommendation: true,
    capacityKind: CAPACITY_KIND,
    modelCaveats,
    disclaimer: BRIEF_DISCLAIMER,
  };

  const previous = input.previous ?? null;
  const deltas =
    previous === null ? null : computeBriefDeltas(current, previous);

  return {
    current,
    previous,
    deltas,
    capacities,
    netApyGrid,
    authoritative,
    warnings: current.warnings,
    decisionSupportOnly: true,
    notADeployRecommendation: true,
    capacityKind: CAPACITY_KIND,
    modelCaveats,
    disclaimer: BRIEF_DISCLAIMER,
  };
}
