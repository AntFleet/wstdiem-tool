# SPEC002 — Loop Sizing Engine

> **Status — 2026-07-11.** Committed contract for the **offline** `loop sizing` command
> (`src/loop/sizing.ts`, `src/loop/sizingScenarios.ts`, `src/loop/morphoRate.ts`). It supersedes the
> non-normative runbook `docs/deployment/loop-sizing.md`. Consistent with SPEC001's monitor-and-
> rehearse posture: sizing uses **no RPC, no broadcast, no deploy** — it is advisory decision-support
> for whether a DIEM/wstDIEM loop size is economically viable *before* any (out-of-band) action.

## 1. Purpose & scope

`loop sizing` sweeps a grid of scenarios and, for each, decides **viable / marginal / blocked**
against six independent gates (Curve depth, Morpho supply, slippage, health factor, net APY, unwind
coverage). It is pure integer/bigint arithmetic over caller-supplied assumptions; it reads nothing
from chain. A `viable` verdict is a candidate for deeper fork/live validation — **never** approval to
act. All token amounts are WAD (1e18) bigint; all rates are basis points (bps) unless noted.

## 2. Input model

### 2.1 Scenario (`LoopSizingScenario`)

One priced scenario. Fields and their CLI source:

| Field | Unit | CLI flag (grid dim in **bold**) | Default |
|---|---|---|---|
| `initialCollateralDiem` | WAD DIEM | **`--initial-diem`** (or **`--initial-wstdiem`** × `--wstdiem-nav`) | `100` |
| `targetLeverageBps` | bps (>10000) | **`--target-leverage`** | `1.5,2,3` |
| `curveDepthDiem` | WAD DIEM | **`--curve-depth-diem`** | `0,100,1000,10000` |
| `morphoSupplyDiem` | WAD DIEM | **`--morpho-supply-diem`** | `0,100,1000,10000` |
| `morphoExistingBorrowDiem` | WAD DIEM | `--morpho-existing-borrow-diem` (single) | `0` |
| `vaultApyBps` | bps | **`--vault-apy-bps`** | `1500` |
| `borrowRateModel` | enum | `--borrow-rate-model` (`adaptive-curve`\|`flat`) | `adaptive-curve` |
| `rateAtTargetApyBps` | bps | **`--rate-at-target-apy-bps`** (adaptive-curve grid dim) | `400` |
| `borrowApyBps` | bps | **`--borrow-apy-bps`** (flat grid dim) | `800` |
| `curveFeeBps` | bps | `--curve-fee-bps` (single) | `4` |
| `maxSlippageBps` | bps | `--slippage-bps` (single) | `execution.maxSlippageBps` (300) |
| `flashFeeBps` | bps | `--flash-fee-bps` (single) | `ceil(flashLoan.feeTier/100)` (100) |
| `maxCurvePositionShareBps` | bps | `--max-curve-position-share-bps` (single) | `floor(thresholds.curveDepthWarn·10000)` (1500) |
| `maxMorphoUtilizationBps` | bps | `--max-morpho-utilization-bps` (single) | `8000` |
| `lltvBps` | bps | (config) | `lltvWad → bps` (8600) |
| `minHealthFactorBps` | bps | `--min-health-factor` (single) | `ceil(minPostLoopHealthFactor·10000)` (17000) |
| `minNetApyBps` | bps | `--min-net-apy-bps` (single) | `0` |
| `exitRepayBufferBps` | bps | (config) | `execution.exitRepayBufferBps` (200) |
| `holdingPeriodDays` | days | `--holding-days` (single) | `365` |

### 2.2 Grid expansion (`buildLoopSizingScenarios`)

The scenario list is the Cartesian product of the **six grid dimensions**:
`initialCollateral × targetLeverage × curveDepth × morphoSupply × vaultApy × borrowDimension`.
The **borrow dimension is model-dependent**: `flat` sweeps `--borrow-apy-bps` (rateAtTarget fixed to
its first value); `adaptive-curve` sweeps `--rate-at-target-apy-bps` (borrowApy fixed to its first
value). All other fields are single values applied to every scenario. Scenario ids are
`scenario-NNNN` (1-based, zero-padded to 4). Example: `1×2×3×2×1×1 = 12` scenarios.

### 2.3 Presets (`--preset`)

- `baseline` (default) — no overrides.
- `current-zero` — defaults `curve-depth-diem` and `morpho-supply-diem` to `0` (the current
  drained-market reality) unless the operator overrides them.
- `liquidity-sweep` — defaults the depth/supply grids to `0,100,1000,10000,100000` and leverage to
  `1.5,2,3`.

### 2.4 Parsing rules

- Amount grids parse decimals to WAD via `parseDecimalToUnits`; comma-separated; ≥1 entry required.
- `--target-leverage` values must be `> 1` (bps `> 10000`), ≤4 decimal places.
- bps/integer grids must be non-negative integers within safe-integer range.
- `--initial-diem` and `--initial-wstdiem` are mutually exclusive; `--wstdiem-nav` must be a single
  value and only applies with `--initial-wstdiem` (`initial = wstDiem·nav/WAD`).
- `--borrow-rate-model` must be `flat` or `adaptive-curve`.

## 3. Borrow-rate models

### 3.1 `flat`
`effectiveBorrowApyBps = borrowApyBps` verbatim. Legacy; treats borrow cost as a constant
independent of the loop's own draw. Sweep `--borrow-apy-bps` in this mode.

### 3.2 `adaptive-curve` (default) — Morpho AdaptiveCurveIrm

A faithful offline model of Morpho Blue's AdaptiveCurveIrm (`src/loop/morphoRate.ts`), matching
`borrowRateView` at a given `(utilization, rateAtTarget)`. The instantaneous rate is
`curve(utilization) × rateAtTarget`, with the piecewise-linear multiplier pinned at:

| utilization | multiplier |
|---|---|
| 0% | 0.25× |
| 90% (`TARGET_UTILIZATION`) | 1× |
| 100% (`CURVE_STEEPNESS`) | 4× |

Utilization clamps to `[0, 100%]` for the rate. `rateAtTargetApyBps` is the anchor (rate at 90%
util); read it on-chain (≈217 bps on 2026-07-11) or default to Morpho genesis 400 bps (conservative).
bigint math mirrors Solidity `SignedWadMath` (truncation toward zero). APR↔per-second uses simple
(linear) annualization over `31_536_000s` (Morpho's `365 days`).

**On-chain reproduction / invariants** (test-locked): `borrowRateView` at 90% util = `rateAtTarget`;
at 100% util = `4×rateAtTarget`. For `rateAtTarget=217`: `@90%→217`, `@100%→~866`, `@41.7%→~129`;
strictly monotonic in utilization; a near-idle read (`@5%`) understates the full-pool rate by `>8×`.

The engine prices each scenario at its **post-draw utilization** (§4), so a shallow pool that reads
~1% idle is correctly charged ~4× `rateAtTarget` once the loop consumes it — the failure mode a flat
assumption misses.

## 4. Sizing computation (`sizeLoopScenario`)

All divisions are integer; `ceil`/`floor`/`round` are called out because acceptance tests pin exact
values. Let `L = targetLeverageBps`, `BPS = 10000`.

```text
positionCollateralDiem   = ceilDiv(initialCollateralDiem · L, BPS)
borrowAmountDiem         = max(0, positionCollateralDiem − initialCollateralDiem)
equityDiem               = initialCollateralDiem

requiredCurveDepthDiem   = ceilDiv(positionCollateralDiem · BPS, maxCurvePositionShareBps)
requiredCurveDiemDepth   = requiredCurveDepthDiem / 2      (wstDIEM side = remainder)
requiredMorphoSupplyDiem = ceilDiv(borrowAmountDiem · BPS, maxMorphoUtilizationBps)
utilizationBorrowLimit   = floor(morphoSupplyDiem · maxMorphoUtilizationBps / BPS)
availableMorphoBorrowDiem= max(0, utilizationBorrowLimit − morphoExistingBorrowDiem)

estimatedEntrySlippageBps= ceil(curveFeeBps + ratioBps(borrowAmountDiem, curveDepthDiem))
estimatedExitSlippageBps = ceil(curveFeeBps + ratioBps(positionCollateralDiem, curveDepthDiem))
   // curveDepth == 0 → +Infinity; trade == 0 → curveFeeBps
flashFeeCostDiem         = ceilDiv(borrowAmountDiem · flashFeeBps, BPS)
oneTimeCostDiem          = entrySlippageCostDiem + exitSlippageCostDiem + flashFeeCostDiem
annualizedOneTimeCostBps = ceil(ratioBps(oneTimeCostDiem, initialCollateralDiem) · 365/holdingPeriodDays)

grossVaultApyBps         = round(leverage · vaultApyBps)
postDrawUtilizationWad   = morphoSupplyDiem>0 ? (morphoExistingBorrowDiem+borrowAmountDiem)·WAD/morphoSupplyDiem
                                              : (borrow>0 ? WAD : 0)   // uncapped; may exceed 100%
postDrawUtilizationBps   = postDrawUtilizationWad → bps
effectiveBorrowApyBps    = flat ? borrowApyBps : adaptiveBorrowAprBps(min(util,WAD), rateAtTargetApyBps)
borrowAprAtTargetBps     = adaptiveBorrowAprBps(90%, rateAtTargetApyBps)      // reference
borrowAprAtFullUtilBps   = adaptiveBorrowAprBps(100%, rateAtTargetApyBps)     // reference
borrowCostApyBps         = round((leverage − 1) · effectiveBorrowApyBps)
netApyBps                = grossVaultApyBps − borrowCostApyBps − annualizedOneTimeCostBps

healthFactorBps          = borrow==0 ? null : floor(L · lltvBps / (L − BPS))
unwindDiemOut            = (exitSlip finite && < BPS) ? floor(positionCollateralDiem·(BPS−exitSlip)/BPS) : 0
unwindRepayRequiredDiem  = ceilDiv(borrowAmountDiem · (BPS + exitRepayBufferBps + flashFeeBps), BPS)
```

Slippage cost uses the estimated bps applied to the traded notional (entry on `borrowAmountDiem`,
exit on `positionCollateralDiem`); if slippage is non-finite the cost is capped at the position
notional. `ratioBps(n, d) = n/d` expressed in bps with 2-decimal precision.

**Worked reference** (100 DIEM, 1.5×, defaults): `positionCollateral=150`, `borrow=50`,
`requiredCurveDepth=1000` (150/0.15), `requiredMorphoSupply=62.5` (50/0.80), `healthFactorBps=25800`
(`15000·8600/5000`).

## 5. Gates & blockers

Blockers are appended in this fixed order; `firstBlocker` is the first appended (drives triage):

| # | Blocker | Condition |
|---|---|---|
| 0 | `scenario_invalid` | any: `initial ≤ 0`, `L ≤ 10000`, negative depth/supply/existing-borrow, `maxCurvePositionShareBps ≤ 0`, `maxMorphoUtilizationBps ≤ 0 or > 10000`, `lltvBps ≤ 0`, `minHealthFactorBps ≤ 0`, `holdingPeriodDays ≤ 0` |
| 1 | `curve_liquidity_insufficient` | `curveDepthDiem < requiredCurveDepthDiem` **or** `estimatedExitSlippageBps > maxSlippageBps` |
| 2 | `morpho_supply_insufficient` | `morphoSupplyDiem < requiredMorphoSupplyDiem` **or** `availableMorphoBorrowDiem < borrowAmountDiem` |
| 3 | `net_apy_below_threshold` | `netApyBps < minNetApyBps` |
| 4 | `health_factor_below_threshold` | `healthFactorBps ≠ null` **and** `healthFactorBps < minHealthFactorBps` |
| 5 | `unwind_not_covered` | `unwindDiemOut < unwindRepayRequiredDiem` |

`unwind_not_covered` is the safety-critical gate: it fails when protected Curve exit output can't
cover the borrow plus the exit buffer and flash fee — the on-chain exit rail, modeled offline.

## 6. Status classification

```text
status = blockers.length > 0 ? "blocked"
       : isMarginal          ? "marginal"
       : "viable"
```

`isMarginal` (a scenario that passes every gate but sits near an edge):
- **slippage near cap**: `max(entrySlip, exitSlip) > maxSlippageBps · 0.8`, or
- **HF near floor**: `healthFactorBps < ceil(minHealthFactorBps · 1.1)`, or
- **APY near floor**: `netApyBps < minNetApyBps + 200`.

## 7. Output contract

### 7.1 Report (`LoopSizingReport`)
`{ assumptions, results[], summary }`.

- `assumptions`: `curveDepthModel: "linear-depth-share"`, `morphoLiquidityModel:
  "supply-minus-existing-borrow"`, `apyModel: "simple-annualized"`, `borrowRateModel: "flat" |
  "adaptive-curve-instantaneous"`, `readOnly: true`, `broadcastAvailable: false`, `auditRequired: true`.
- `summary`: `{ total, viable, marginal, blocked, firstViableByLeverage[] }`. `firstViableByLeverage`
  selects, per leverage, the non-blocked scenario with the **smallest `requiredCurveDepthDiem`** (tie
  → smallest `requiredMorphoSupplyDiem`), ascending by leverage — the cheapest liquidity that unlocks
  each leverage.

### 7.2 Result (`LoopSizingResult`)
Per scenario: `scenario, status, blockers[], firstBlocker, positionCollateralDiem, borrowAmountDiem,
equityDiem, requiredCurveDepthDiem, requiredCurveDiemDepth, requiredCurveWstDiemDepth,
requiredMorphoSupplyDiem, availableMorphoBorrowDiem, estimatedEntrySlippageBps,
estimatedExitSlippageBps, flashFeeCostDiem, oneTimeCostDiem, annualizedOneTimeCostBps,
grossVaultApyBps, borrowRateModel, postDrawUtilizationBps, effectiveBorrowApyBps,
borrowAprAtTargetBps, borrowAprAtFullUtilizationBps, borrowCostApyBps, netApyBps, healthFactorBps,
unwindDiemOut, unwindRepayRequiredDiem`.

### 7.3 JSON envelope & serialization
`--json` wraps the report in the standard `CliJsonOutput` (`ok`, `command: "loop sizing"`, `chainId`,
`data`). **All bigint token amounts serialize as integer wei strings** (e.g. `100 DIEM →
"100000000000000000000"`); bps/ratios are numbers; `healthFactorBps` may be `null`.

### 7.4 Table (`renderLoopSizingTable`)
Columns: `Scenario | Lev | Equity | Borrow | Curve req/actual | Morpho req/actual | Slip entry/exit |
HF | Util→Borrow APR | Net APY | Status[: firstBlocker]`. Summary rows: **Totals**
(viable/marginal/blocked of total), **First viable by leverage**, **Borrow model** (adaptive-curve
prints `rateAtTarget @90% util` and `@100% util` reference APRs; flat prints "borrow APY used as
given"), **Read-only** (`broadcast disabled; audit required true`).

## 8. Assumptions & limitations

- **Curve**: conservative **linear depth-share** slippage (`fee + trade/depth`), not a StableSwap
  invariant. Understates large-trade exit slippage — a known conservatism gap.
- **Morpho liquidity**: `supply − existing borrow`, capped at `maxMorphoUtilizationBps`.
- **APY**: simple-annualized, not compounded; effective APY is marginally higher.
- **Borrow rate**: **instantaneous** at post-draw utilization for the supplied `rateAtTarget`. It does
  **not** model multi-day `rateAtTarget` drift (rises under sustained high utilization, falls when
  idle), so sustained-high-utilization scenarios are **understated** — pass the current on-chain
  `rateAtTarget` and treat those as optimistic.
- Not a substitute for a fork-backed `get_dy` proof or live readiness evidence. `viable` = candidate
  for validation, not approval to broadcast (broadcast is disabled — SPEC001 §5, §9).

## 9. Acceptance criteria (test-traced)

- **Blocker ordering** (`test/sizing.test.ts`): zero depth → `curve_liquidity_insufficient` first;
  zero supply → `morpho_supply_insufficient` first; borrow-cost > yield → `net_apy_below_threshold`
  (netApy `< 0`).
- **Formulas**: 100 DIEM @1.5× → `borrowAmountDiem=50`, `requiredCurveDepthDiem=1000`,
  `requiredMorphoSupplyDiem=62.5`, `healthFactorBps=25800`, `status=viable`.
- **Adaptive vs flat**: a shallow pool yields strictly higher `postDrawUtilizationBps` /
  `effectiveBorrowApyBps` than a deep one for the same borrow; a loop whose own draw spikes
  utilization (~80%) blocks under adaptive-curve while flat pencils it out positive.
- **IRM** (`test/morpho-rate.test.ts`): multiplier pins 0.25×/1×/4×, clamps >100%, APR↔per-sec
  round-trips, reproduces the 217-bps on-chain reading, monotonic, idle-understates-by-8×.
- **CLI** (`test/cli-sizing.test.ts`): runs with `BASE_RPC_URL` unset (offline), `--json` yields
  `ok:true`, `command:"loop sizing"`, `assumptions.{readOnly:true, broadcastAvailable:false,
  auditRequired:true}`, correct grid count, wei-string amounts.

## 10. Planned extension (not in this contract)

`loop sizing --from-chain` (SPEC001 Phase 3): seed `rateAtTargetApyBps` (inverted from the live
`borrowRateView` ÷ `curveMultiplier(currentUtil)`), `morphoSupplyDiem`, `morphoExistingBorrowDiem`,
`curveDepthDiem`, and the empirical vault APY from the existing readers — turning the simulator from
typed assumptions into "what today's actual pool supports." Must conform to this contract; specified
when built.
