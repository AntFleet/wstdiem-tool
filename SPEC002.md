# SPEC002 — Loop Sizing Engine

> **Status — 2026-07-11.** Committed contract for the **offline** `loop sizing` command
> (`src/loop/sizing.ts`, `src/loop/sizingScenarios.ts`, `src/loop/morphoRate.ts`). It supersedes the
> non-normative runbook `docs/deployment/loop-sizing.md`. Consistent with SPEC001's monitor-and-
> rehearse posture: sizing uses **no RPC, no broadcast, no deploy** — it is advisory decision-support
> for whether a DIEM/wstDIEM loop size is economically sound *before* any (out-of-band) action.

## 1. Purpose & scope

`loop sizing` sweeps a grid of scenarios and, for each, decides **candidate / marginal / blocked**
against **five economic gates** (Curve depth **+ exit slippage**, Morpho supply, health factor, net
APY, unwind coverage) plus a `scenario_invalid` validity gate — six blockers total (§5); there is no
standalone "slippage" blocker (it is folded into the Curve-depth gate). It is pure integer/bigint
arithmetic over caller-supplied assumptions; it reads nothing
from chain. A `candidate` verdict flags a scenario for deeper fork/live validation — **never** approval to
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

**`curveDepthDiem` denomination.** It is the pool's **total two-sided** depth in DIEM-equivalent
(both legs). Slippage (§4) divides the traded notional by this *total* — see §8 for why a single
scalar cannot represent a drained/imbalanced pool and why dividing by total (not the DIEM side an
exit draws from) understates trade-vs-traded-side by ~2×.

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
requiredCurveDiemDepth   = requiredCurveDepthDiem / 2                           (integer div)
requiredCurveWstDiemDepth= requiredCurveDepthDiem − requiredCurveDiemDepth      (remainder; handles odd WAD)
requiredMorphoSupplyDiem = ceilDiv(borrowAmountDiem · BPS, maxMorphoUtilizationBps)
utilizationBorrowLimit   = floor(morphoSupplyDiem · maxMorphoUtilizationBps / BPS)
availableMorphoBorrowDiem= max(0, utilizationBorrowLimit − morphoExistingBorrowDiem)

estimatedEntrySlippageBps= ceil(curveFeeBps + ratioBps(borrowAmountDiem, curveDepthDiem))
estimatedExitSlippageBps = ceil(curveFeeBps + ratioBps(positionCollateralDiem, curveDepthDiem))
   // trade == 0 → curveFeeBps (checked first); else curveDepth == 0 → +Infinity
flashFeeCostDiem         = ceilDiv(borrowAmountDiem · flashFeeBps, BPS)
oneTimeCostDiem          = entrySlippageCostDiem + exitSlippageCostDiem + flashFeeCostDiem
annualizedOneTimeCostBps = ceil(ratioBps(oneTimeCostDiem, initialCollateralDiem) · 365/holdingPeriodDays)

grossVaultApyBps         = round(leverage · vaultApyBps)
postDrawUtilizationWad   = morphoSupplyDiem>0 ? (morphoExistingBorrowDiem+borrowAmountDiem)·WAD/morphoSupplyDiem
                                              : ((morphoExistingBorrowDiem+borrowAmountDiem) > 0 ? WAD : 0)   // uncapped; may exceed 100%
postDrawUtilizationBps   = postDrawUtilizationWad → bps
effectiveBorrowApyBps    = flat ? borrowApyBps : adaptiveBorrowAprBps(min(util,WAD), rateAtTargetApyBps)
borrowAprAtTargetBps        = adaptiveBorrowAprBps(90%, rateAtTargetApyBps)      // reference
borrowAprAtFullUtilizationBps = adaptiveBorrowAprBps(100%, rateAtTargetApyBps)   // reference
borrowCostApyBps         = round((leverage − 1) · effectiveBorrowApyBps)
netApyBps                = grossVaultApyBps − borrowCostApyBps − annualizedOneTimeCostBps

healthFactorBps          = borrow==0 ? null : floor(L · lltvBps / (L − BPS))
unwindDiemOut            = (exitSlip finite && < BPS) ? floor(positionCollateralDiem·(BPS−exitSlip)/BPS) : 0
unwindRepayRequiredDiem  = ceilDiv(borrowAmountDiem · (BPS + exitRepayBufferBps + flashFeeBps), BPS)
```

Slippage cost uses the estimated bps applied to the traded notional (entry on `borrowAmountDiem`,
exit on `positionCollateralDiem`); if slippage is non-finite the cost is capped at the position
notional. `ratioBps(n, d) = Number(n · 1_000_000 / d) / 100` — i.e. `n/d` in bps to 2-decimal
precision as a JS number (then `ceil`'d where used in slippage and annualized cost); `d = 0` →
`+Infinity`. All amounts are WAD bigint until the ratio, which crosses to `number`.

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

`unwind_not_covered` models the on-chain exit rail: protected Curve exit output must cover the borrow
plus the exit buffer and flash fee. **Gate interaction (important):** under the default
`maxSlippageBps = 300`, gate 1's exit-slippage sub-condition blocks at exit trade > ~2.96% of depth,
while `unwind_not_covered` only binds at far higher slippage (~31% at 3×, ~7% at 10×). So under
defaults the **exit-slippage sub-condition of gate 1 — not unwind coverage — is the primary safety
constraint**, and `unwind_not_covered` is a backstop that activates only when `--slippage-bps` is
relaxed well above 300. The primary constraint is fed the model's softest number (§8, Curve depth).

Two `scenario_invalid` sub-conditions (`maxCurvePositionShareBps ≤ 0`, `maxMorphoUtilizationBps ≤ 0`)
are **API-only edge cases**: the code pushes the blocker but then throws in `ceilDiv` (denominator
≤ 0) rather than returning a blocked result. Unreachable from the CLI (both flags parse ≥ 1).

## 6. Status classification

```text
status = blockers.length > 0 ? "blocked"
       : isMarginal          ? "marginal"
       : "candidate"
```

`isMarginal` (a scenario that passes every gate but sits near an edge):
- **slippage near cap**: `max(entrySlip, exitSlip) > maxSlippageBps · 0.8`, or
- **HF near floor**: `healthFactorBps < ceil(minHealthFactorBps · 1.1)`, or
- **APY near floor**: `netApyBps < minNetApyBps + 200`.

The band constants (`0.8`, `1.1`, `+200 bps`) are fixed heuristics — not configurable.

## 7. Output contract

### 7.1 Report (`LoopSizingReport`)
`{ assumptions, results[], summary }`.

- `assumptions`: `curveDepthModel: "linear-per-leg-depth-share"`, `morphoLiquidityModel:
  "supply-minus-existing-borrow"`, `apyModel: "simple-annualized"`, `borrowRateModel: "flat" |
  "adaptive-curve-instantaneous"`, `readOnly: true`, `broadcastAvailable: false`, `auditRequired: true`.
- `summary`: `{ total, candidate, marginal, blocked, firstCandidateByLeverage[] }`. `firstCandidateByLeverage`
  selects, per leverage, the non-blocked scenario with the **smallest `requiredCurveDepthDiem`** (tie
  → smallest `requiredMorphoSupplyDiem`), ascending by leverage — the cheapest liquidity that unlocks
  each leverage.

### 7.2 Result (`LoopSizingResult`)
Per scenario: `scenario, status, blockers[], firstBlocker, positionCollateralDiem, borrowAmountDiem,
equityDiem, requiredCurveDepthDiem, requiredCurveDiemDepth, requiredCurveWstDiemDepth,
requiredMorphoSupplyDiem, availableMorphoBorrowDiem, estimatedEntrySlippageBps,
exitSlippageBps, exitSlippageSource, warnings, flashFeeCostDiem, oneTimeCostDiem,
annualizedOneTimeCostBps, grossVaultApyBps, borrowRateModel, postDrawUtilizationBps,
effectiveBorrowApyBps, borrowAprAtTargetBps, borrowAprAtFullUtilizationBps, borrowCostApyBps,
netApyBps, healthFactorBps, unwindDiemOut, unwindRepayRequiredDiem`.

- **rev-2 additions:** `exitSlippageBps` (renamed from `estimatedExitSlippageBps`; holds the leg-aware
  estimate or a live `get_dy` quote), `exitSlippageSource` (`"get_dy" | "estimate"`), `warnings[]`.
- **rev-3 additions (E1/E2, always populated per §7.3):** `curveDiemLegSlippageShortfallDiem`
  (`bigint | number` — a wei amount, or the number `Infinity` when `maxSlippageBps ≤ curveFeeBps`),
  `curveDiemLegShortfallDiem`, `curveWstDiemLegShortfallDiem`, `morphoSupplyShortfallDiem` (bigint wei),
  `exitSlippageExcessBps`, `netApyShortfallBps` (number bps; `exitSlippageExcessBps` may be `"Infinity"`),
  `structuralMarginToLiquidationBps` (`number | null`).

### 7.3 JSON envelope & serialization
`--json` wraps the report in the standard `CliJsonOutput` (`ok`, `command: "loop sizing"`, `chainId`,
`data`). **All bigint token amounts serialize as integer wei strings** (e.g. `100 DIEM →
"100000000000000000000"`). bps/ratios are numbers, **except non-finite bps serialize as the strings
`"Infinity"` / `"-Infinity"`** — `estimatedEntrySlippageBps`/`exitSlippageBps` (and, mirroring the
latter, `exitSlippageExcessBps`) when `curveDepthDiem = 0` (which is the **first default grid value**
and the whole `current-zero` preset, so a default `--json` run emits them), and
`annualizedOneTimeCostBps` when `initialCollateralDiem = 0`. The rev-3 `curveDiemLegSlippageShortfallDiem`
also serializes `"Infinity"` (its number-Infinity sentinel) when `maxSlippageBps ≤ curveFeeBps`.
`healthFactorBps` may be `null`. `chainId` is the configured static value — nothing is read from
chain. **All economic fields are populated even when `status = blocked`** (e.g. `postDrawUtilization
→ WAD` when supply is 0), so a consumer must not treat blocked ⇒ null.

### 7.4 Table (`renderLoopSizingTable`)
Columns: `Scenario | Lev | Equity | Borrow | Curve req/actual | Morpho req/actual | Slip entry/exit |
HF | Util→Borrow APR | Net APY | Status[: firstBlocker]`. Summary rows: **Totals**
(candidate/marginal/blocked of total, with a `candidate = clears all gates` gloss), **First candidate by leverage**, **Borrow model** (adaptive-curve
prints `rateAtTarget @90% util` and `@100% util` reference APRs; flat prints "borrow APY used as
given"), **Read-only** (`broadcast disabled; audit required true`).

## 8. Assumptions & limitations

- **Curve depth is a single scalar and cannot represent a drained/imbalanced pool — the headline
  risk.** `curveDepthDiem` is total two-sided depth; slippage is `fee + ratioBps(trade, total)`
  (§4). On a drained/off-peg wstDIEM/DIEM pool — the market state this tool exists to evaluate — the
  DIEM side an exit draws into is nearly empty, so real slippage is dramatically worse and convex,
  yet the model has no notion of imbalance; dividing the trade by *total* depth also understates
  trade-vs-traded-side by ~2×. A `candidate, exit slip 296 bps` reading can therefore be badly
  optimistic on exactly the pool it is meant to guard against. This matters because the exit-slippage
  sub-condition of gate 1 is the **primary** safety constraint (§5) and it consumes this softest
  input — treat `candidate` on a thin/off-peg pool as unsafe pending a fork `get_dy` proof. (Textbook
  linear-vs-convex StableSwap error is second-order: the slippage cap already blocks trades > ~3% of
  depth.)
- **`vaultApyBps` is an assumed input, not measured — and leverage amplifies it.** `grossVaultApyBps
  = round(leverage · vaultApyBps)`; the largest term in `netApyBps` is a hand-typed number (default
  1500) multiplied by leverage, so a 300 bps guess error becomes ~900 bps at 3×. Vault APY is only
  estimable live after ~2 compound cycles; the borrow side, by contrast, is modeled to wei precision.
- **`healthFactorBps` is an entry-time structural check, not a liquidation measure.** It is a pure
  function of leverage and LLTV (`floor(L·lltvBps/(L−BPS))`) — it never touches a price, so every
  scenario at a given leverage gets the identical HF. It answers "is this leverage below the LLTV
  ceiling, assuming oracle = NAV," not "how far to liquidation." NAV/oracle is assumed static and
  equal to Morpho's oracle; `--wstdiem-nav` is a typed-in value.
- **Single-block snapshot — no price path.** The model prices today's liquidity at t=0;
  `holdingPeriodDays` only annualizes one-time cost. It assumes exit-time depth equals entry and that
  nothing is liquidated in between. "Candidate for 365 days" is not a year of modeled risk.
- **Gas and MEV are excluded** from `oneTimeCostDiem` (entry slip + exit slip + flash fee only).
  Entry/exit are multi-call txns and the Curve leg is MEV-exposed on exactly the thin pool this
  targets; at default ~100-DIEM sizes gas alone can flip `netApyBps` negative while status reads
  `candidate`.
- **Morpho liquidity**: `supply − existing borrow`, capped at `maxMorphoUtilizationBps`.
- **APY**: simple-annualized, not compounded; effective APY is marginally higher.
- **Borrow rate**: **instantaneous** at post-draw utilization for the supplied `rateAtTarget`; does
  **not** model multi-day `rateAtTarget` drift (rises under sustained high utilization, falls when
  idle), so sustained-high-utilization scenarios are **understated** — pass the current on-chain
  `rateAtTarget`.
- Not a substitute for a fork-backed `get_dy` proof or live readiness evidence. `candidate` = a
  candidate for validation, not approval to broadcast (broadcast is disabled — SPEC001 §5, §9).

## 9. Acceptance criteria (test-traced)

- **Blocker ordering** (`test/sizing.test.ts`): zero depth → `curve_liquidity_insufficient` first;
  zero supply → `morpho_supply_insufficient` first; borrow-cost > yield → `net_apy_below_threshold`
  (netApy `< 0`).
- **Formulas**: 100 DIEM @1.5× → `borrowAmountDiem=50`, `requiredCurveDepthDiem=1000`,
  `requiredMorphoSupplyDiem=62.5`, `healthFactorBps=25800`, `status=candidate`.
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

**Caveats for that spec:** (a) the `rateAtTarget` inversion is **ill-conditioned in the current
near-idle regime** — inverting through the 0.25× multiplier zone amplifies a small read error (§3:
an idle read understates the full-pool rate by >8×), so it must be gated/annotated, not trusted
blindly; (b) it reintroduces RPC into an otherwise no-RPC command, so it needs fail-closed /
stale-read discipline; (c) it upgrades *inputs*, not the *model* — the §8 limits (imbalance,
gas/MEV, no price path) are unchanged, so it must **not** be shipped as "now the numbers are real."

## 11. Recommended enhancements (not built — future revision)

These are **not** in the current engine or this contract; they are the review's product recommendations, recorded so the contract does not silently omit them:

- **Shortfall outputs (highest value).** Expose per-scenario `curveDepthShortfallDiem`,
  `morphoSupplyShortfallDiem`, `netApyShortfallBps`, so `firstBlocker` becomes actionable ("blocked
  by how much / what would unblock it"). The data exists — `firstViableByLeverage` (renamed
  `firstCandidateByLeverage` in rev-3 E5) already reasons about the cheapest unlock.
- **Gas + MEV cost.** A `--gas-cost-diem` input folded into `oneTimeCostDiem`, with an MEV caveat
  scaling to pool thinness. At default sizes this flips verdicts (§8).
- **Liquidation-distance output.** Margin-to-liquidation / liquidation price, since `healthFactorBps`
  is a pure leverage/LLTV identity (parallels SPEC001 Open Question #9).
- **Stressed-rate netAPY.** A second net APY at `borrowAprAtFullUtilizationBps` (or a rateAtTarget-
  drift multiplier) to bound the sustained-high-utilization case.
- **Naming (SHIPPED — rev-3 E5).** `viable` is the loudest token in a tool that cannot execute; consider
  `candidate`/`passes-gates`, and reconsider `firstViableByLeverage` (which answers "how big can I
  go") as a recommendation surface. *Resolved: renamed to `candidate` / `firstCandidateByLeverage` in rev-3 E5.*
- Reconcile the default `rateAtTargetApyBps = 400` ("conservative") against the runbook-recommended
  live value (~217 on 2026-07-11).

## rev-2 — model fidelity (Phase 3.5, FORWARD — not yet implemented)

> **Committed forward changes** to the engine, the hard prerequisite for **SPEC003 Part B**. Until
> implemented, §1–§10 describe the shipped behavior. Revised after a two-agent review gate (both
> verdicts REVISE → this pass): the leg-draw direction and the ~2× correction were verified correct
> against Curve `exchange(1,0)` semantics; the fixes below close the denomination, override-scope, and
> spec-consistency gaps. Same spec-first gate applies (review → lock → executor → verify).

### R1 — Leg-aware, direction-correct slippage (fixes §8's headline blind spot at the model layer)

Today (`sizing.ts:248-253`) every trade divides by a single `curveDepthDiem` scalar, which cannot
represent an imbalanced/drained pool, is direction-blind, and divides by *total* depth (understating
trade-vs-traded-side by ~2×, §8). rev-2 models the pool as **two legs** in DIEM-equivalent (WAD bigint):

- `curveDiemLegDiem` — the DIEM side (`balances(0)`).
- `curveWstDiemLegDiem` — the wstDIEM side in DIEM (`convertToAssets(balances(1))`).

Each trade divides by the leg it **draws down** — a Curve `exchange(i,j)` pays OUT coin `j`, depleting
the `j` leg (verified: exit is `exchange(1,0)` → DIEM leg drawn; entry `exchange(0,1)` → wstDIEM leg):

```text
estimatedExitSlippageBps  = curveFeeBps + ratioBps(positionCollateralDiem, curveDiemLegDiem)      // exit sells wstDIEM → draws OUT of the DIEM leg
estimatedEntrySlippageBps = curveFeeBps + ratioBps(borrowAmountDiem,       curveWstDiemLegDiem)   // entry buys wstDIEM → draws OUT of the wstDIEM leg
// a zero DRAWN leg → +Infinity (as rev-1); default grid curveDepth=0 → both legs 0 → both +Infinity
```

Direction-correct: on a DIEM-drained pool the **exit** (÷ small DIEM leg) is correctly costly while the
**entry** (÷ large wstDIEM leg) is correctly cheap — the case rev-1's single scalar and SPEC003's
rejected `2×min` heuristic both got wrong.

**Total depth stays defined.** The engine reconstructs `curveDepthDiem = curveDiemLegDiem +
curveWstDiemLegDiem` for the *depth-based* (not slippage-based) parts of gate 1: the depth-sufficiency
sub-condition `curveDepthDiem < requiredCurveDepthDiem` (`sizing.ts:310`) and the `requiredCurveDepthDiem`
/ `requiredCurveDiemDepth` / `requiredCurveWstDiemDepth` outputs (§4/§7.2) are unchanged and keyed off
this reconstructed total. (A per-leg sufficiency check is a §11 future refinement, not rev-2.)

**Input, precedence & backward-compat.** Add `--curve-diem-leg` / `--curve-wstdiem-leg`
(DIEM-equivalent) grid inputs. Keep `--curve-depth-diem <total>` as a **balanced** convenience:
`curveDiemLegDiem = curveWstDiemLegDiem = total / 2` (odd-WAD remainder to the wstDIEM leg, mirroring
`requiredCurveWstDiemDepth`). `--curve-depth-diem` and the leg flags are **mutually exclusive** (both
supplied → `scenario_invalid`), mirroring the §2.4 `--initial-diem` / `--initial-wstdiem` rule.

**Intended correction (breaking, verdict-affecting).** For the same nominal `--curve-depth-diem`, the
`ratioBps` *term* is ~**2× larger** than rev-1 (it divides by ~half the pool — the traded leg — not the
total; the flat `curveFeeBps` term is unchanged). This *is* the §8 understatement fix, not a
double-count. It flips verdicts: the canonical §9 case (100 DIEM @1.5×, `curveDepthDiem=10000`) is
rev-1 exit slip `4 + ratioBps(150,10000) = 154 bps → viable`, but rev-2 (legs 5000) `4 +
ratioBps(150,5000) = 304 bps > 300 → blocked`. **Resolution: the canonical §9 example re-pins to
`curveDepthDiem = 20000`** (legs 10000 → 154 bps → stays `viable`); the §4 worked reference is
slippage-free and is unaffected. Every rev-1 fixture with a nonzero exit trade re-baselines (§AC).
(Historical: the clean-pass token above reads `viable` — the pre-E5 name; it is `candidate` post-rev-3 E5.)

**Offline is conservative by design.** A purely-offline run (no `get_dy`, R2) may now `blocked` on the
2×-inflated *linear* estimate — intentional: offline slippage is an explicit conservative upper bound,
which `loop sizing --from-chain` refines with a real convex `get_dy` quote (R2). The
`assumptions.curveDepthModel` label bumps `"linear-depth-share"` → `"linear-per-leg-depth-share"` so
consumers detect the change. The §6 marginal band (`slippage > 0.8·maxSlippage`) will classify more
scenarios `marginal` now that slippage ~doubles — expected.

### R2 — Live `get_dy` exit-quote injection (the seam SPEC003 Part B fills)

Add an optional `externalExitSlippageBps?: number` scenario input. **When present it replaces
`estimatedExitSlippageBps` at every consumption site** — gate 1 (`sizing.ts:311`), the exit slippage
cost → `netApy` (`:258-261`), the `unwindDiemOut` → `unwind_not_covered` backstop, gate 5
(`:300-303,327`), and the `isMarginal` band (`:209`) — so the verdict stays internally consistent
(rename the field `estimatedExitSlippageBps` → `exitSlippageBps` since it can now hold a live quote). A
negative or `>10000` injected value is `scenario_invalid` (gate 0).

**Reuse the existing exit rail — do not re-derive.** The live quote is exactly `routeQuote.ts`'s
already-tested `quoteCurveExitRoute` + `priceImpactBps` (`routeQuote.ts:44-50,52-99`), which handles the
denomination correctly. The exit sells the position's **wstDIEM shares**, not a DIEM amount:

```text
wstDiemIn               = convertToShares(positionCollateralDiem)          // wstDIEM to sell (NOT the DIEM notional)
expectedDiemOutAtNav    = convertToAssets(wstDiemIn)   ( ≈ positionCollateralDiem )
quotedDiemOut           = get_dy(WSTDIEM_INDEX=1, DIEM_INDEX=0, wstDiemIn)  // at the pinned block
externalExitSlippageBps = priceImpactBps(expectedDiemOutAtNav, quotedDiemOut)   // (expected − quoted)/expected in bps, clamped ≥ 0
```

`get_dy`'s `dx` is a **wstDIEM** amount (SPEC001 §1); passing the DIEM-denominated `positionCollateralDiem`
would mis-quote by the live NAV factor (NAV ratchets ≥ 1), so the `convertToShares` step is mandatory.
Sharing the one `priceImpactBps` helper between the sizing seam and the live preflight rail guarantees
the offline estimate and the execution rail cannot silently diverge.

Offline runs (no injection) use the R1 leg-aware estimate. Entry keeps the R1 estimate — exit is the
only *gating* slippage (there is no entry-slippage blocker), and on a DIEM-drained pool the entry draws
the fat wstDIEM leg where convexity is smallest. The report records **`exitSlippageSource: "get_dy" |
"estimate"`** (entry is always `"estimate"` — state so, so a `--from-chain` report never implies both
legs are chain-real). `exitSlippageSource` **extends the existing `SeedProvenance`** (`sizing.ts:108-115`,
SPEC003 §6) — no parallel provenance system; a non-`get_dy` exit source or an imbalanced pool is a
soft-seed condition that trips SPEC003 §6's `authoritative: false` verdict demotion.

### R3 — Gas in one-time cost; MEV as a caveat

`oneTimeCostDiem = entrySlippageCost + exitSlippageCost + flashFeeCost + gasCostDiem`, with a new
single-valued `gasCostDiem` (`--gas-cost-diem`, default `0`; not a grid dim). At default ~100-DIEM
sizes gas alone can flip `netApyBps` negative, so it must be a first-class term (`sizing.ts:261`).

**Honest default.** With the default `0`, a run that does not set `--gas-cost-diem` still excludes gas
exactly as rev-1 did — so the §8 caveat is **reworded, not dropped**, and when `gasCostDiem == 0` a
**`gas unmodeled` warning rides the verdict** (parallel to SPEC003 §6's demotion), not just §8 prose.
(We deliberately do not auto-estimate gas — that would import gas-unit/base-fee/ETH-DIEM assumptions the
offline engine has no basis for; the operator supplies a real figure or is warned it's excluded.)

**MEV stays a caveat, not a number** — unbounded and venue/timing-specific. §8 documents it scales with
pool thinness on the Curve leg, and like the imbalance caveat, on a thin/imbalanced pool the MEV caveat
**rides the verdict token** — because `candidate` is most MEV-misleading exactly there.

### §7 field additions
- **Scenario inputs:** `curveDiemLegDiem` / `curveWstDiemLegDiem` (WAD bigint, grid dims), `gasCostDiem`
  (WAD bigint, single), `externalExitSlippageBps?` (number; injected by `--from-chain`, not an offline flag).
- **Result/report:** the two curve legs and `exitSlippageSource` echo into §7.2 (legs as WAD, wei-string
  per §7.3); `assumptions.curveDepthModel` → `"linear-per-leg-depth-share"`.

### §8 / §9 / §11 reconciliation
- §8 Curve bullet → "leg-aware, direction-correct, imbalance-aware; still linear per leg unless a live
  `get_dy` quote is injected (R2); offline is a conservative upper bound."
- §8 → gas is a **first-class input but defaults to 0** (a default run still excludes it, warned on the
  verdict); MEV still excluded numerically (verdict-adjacent caveat).
- **§9 / §4** → the canonical `candidate` example re-pins to `curveDepthDiem = 20000` (R1); the §4 worked
  reference is slippage-free and unchanged.
- §11 → "leg-aware/`get_dy` slippage" and "gas + MEV" are promoted to this committed rev-2; shortfall
  outputs, liquidation-distance, and a per-leg depth-sufficiency check remain §11 future.

### Acceptance criteria (tests when built)
1. Exit slippage divides by the DIEM leg, entry by the wstDIEM leg (the verified direction map).
2. Imbalanced fixture (DIEM leg ≪ wstDIEM leg) → high exit / low entry slippage; mirror pool → reverse.
3. `--curve-depth-diem T` → balanced legs `T/2`; exit `= fee + ratioBps(trade, T/2)`. **Re-baseline every
   rev-1 fixture with a nonzero exit trade** — the `candidate` case (re-pinned to 20000), the grid
   `firstCandidateByLeverage`, and the `isMarginal` band — not only depth cases.
4. `--curve-depth-diem` with either leg flag → `scenario_invalid` (mutual exclusion).
5. `externalExitSlippageBps` replaces the exit value at **all four** sites — assert it moves gate 1,
   `netApy`, the `unwind_not_covered` backstop, AND the marginal classification; a negative/`>10000`
   value → `scenario_invalid`.
6. Seam-vs-rail: `externalExitSlippageBps` via `quoteCurveExitRoute` + `priceImpactBps` equals what
   `routeQuote.ts` produces for the same `wstDiemIn` at the same block (guards denomination + no divergence).
7. `gasCostDiem` folds into `oneTimeCostDiem` → `netApyBps` (large-enough gas flips a marginal `candidate`
   to `net_apy_below_threshold`); `gasCostDiem == 0` emits the `gas unmodeled` warning.
8. Total reconstruction: `curveDepthDiem = diemLeg + wstDiemLeg` feeds gate 1's depth-sufficiency
   sub-condition and the `requiredCurve*` outputs.
9. Zero drawn leg → `+Infinity` slippage (fail-safe, as rev-1; JSON serializes `"Infinity"` per §7.3).
10. Integration: SPEC003 Part B seeds both legs from `balances` + the exit quote from `get_dy`, and its
    soft-seed verdict-demotion (SPEC003 §6) fires on an imbalanced pool or a non-`get_dy` exit source.

## rev-3 — actionability & honesty refinements (FORWARD — not yet implemented)

> **Committed forward changes** promoting the remaining §11 backlog into the contract, now that rev-2
> (slippage + gas) has shipped. Scope: make blocked verdicts *actionable* (shortfalls), make the health
> signal *legible* (liquidation distance), *bound* the sustained-high-utilization case (stressed netAPY),
> add a per-leg curve **backstop** gate, and *stop over-claiming* (rename `viable` → `candidate`; reconcile
> the default rate). §1–§10 + rev-2 describe shipped behavior. Per-item blast radius (set by the two-agent
> review gate, both ACCEPT-WITH-RESERVATIONS): **E1/E2** additive · **E6** docs · **E3** verdict-affecting-lite
> (feeds `isMarginal`, so it re-baselines marginal-band fixtures) · **E4** a dormant backstop under defaults
> (dominated by the slippage sub-condition; verdict-affecting only under relaxed slippage / a tight share cap)
> · **E5** BREAKING rename. Ship in four **waves** (see "Staging"), not one unit. Same spec-first gate applies
> (review → lock → executor → approval gate → merge).

### E1 — Shortfall outputs (highest value; additive, no verdict change)

Every gate today answers only pass/fail. rev-3 adds per-scenario *distance-to-clear* fields, so
`firstBlocker` becomes "blocked by how much / what unblocks it." All are **always populated** (§7.3),
**≥ 0**, and **0 exactly when their sub-condition passes** (so a consumer reads them uniformly). They
are pure derived arithmetic from values the engine already computes:

Notation: `position = positionCollateralDiem`, `BPS = 10000`.

```text
curveDiemLegSlippageShortfallDiem = max(0, position·BPS/(maxSlippageBps − curveFeeBps) − curveDiemLegDiem)  // DIEM depth to bring EXIT slippage under the cap — the PRIMARY curve gate's unlock
curveDiemLegShortfallDiem         = max(0, requiredCurveDiemDepth    − curveDiemLegDiem)      // exit-leg depth-SHARE gap (E4 backstop gate)
curveWstDiemLegShortfallDiem      = max(0, requiredCurveWstDiemDepth − curveWstDiemLegDiem)   // entry-leg depth-SHARE gap (E4 backstop gate)
exitSlippageExcessBps             = max(0, exitSlippageBps − maxSlippageBps)                  // bps over the cap (slippage sub-condition)
morphoSupplyShortfallDiem         = max(0, requiredMorphoSupplyDiem − morphoSupplyDiem)       // supply gap
netApyShortfallBps                = max(0, minNetApyBps − netApyBps)                          // yield gap, bps
```

- **The exit-slippage sub-condition is the *primary* Curve constraint under defaults (§5)** — depth-share (E4)
  is a dormant backstop. So `curveDiemLegSlippageShortfallDiem` is the actionable "how much DIEM depth unblocks
  the exit" number; `exitSlippageExcessBps` reports the bps overage; and the per-leg depth-share shortfalls map
  to E4's backstop gate (meaningful only when it binds). Together they explain both curve sub-conditions —
  earlier this field-set omitted the slippage-side depth lever, leaving the primary gate without a concrete unlock.
- `curveDiemLegSlippageShortfallDiem` is derived from the **linear** exit-slippage model (the same model as the
  offline estimate). When `exitSlippageSource == "get_dy"` the gate uses the live convex quote, so this field is
  an **indicative** linear figure, not the exact unlock — the report must not present it as precise under a live quote.
- **`+Infinity` handling.** If `maxSlippageBps ≤ curveFeeBps` the exit can never clear the cap by adding depth →
  `curveDiemLegSlippageShortfallDiem = +Infinity`. If a drawn leg is 0 (offline), `exitSlippageBps` is `+Infinity`
  so `exitSlippageExcessBps` is `+Infinity` too — both serialize `"Infinity"` (§7.3); do **not** clamp to 0, which
  would read as "slippage is fine" on the most-drained pool. (Under an injected `get_dy` quote `exitSlippageBps`
  is the finite quote regardless of leg size, so `exitSlippageExcessBps` is then finite.)
- On a **balanced** pool each depth-share leg shortfall is `max(0, requiredTotal/2 − total/2)` — i.e. **half the
  *total* shortfall**, not "half the pool."
- **No Morpho borrow-availability shortfall field** — the borrow-availability sub-condition
  (`availableMorphoBorrowDiem < borrowAmountDiem`) is already fully described by the existing
  `availableMorphoBorrowDiem` / `borrowAmountDiem` outputs; adding a third derived field is redundant.

### E2 — Liquidation-distance output (additive; a legibility re-expression, **not** new information)

`healthFactorBps` is a pure entry-time leverage/LLTV identity (§8). rev-3 re-expresses it in the terms
an operator reasons in — *how far can the collateral value fall before liquidation* — without pretending
to add a live price path:

```text
structuralMarginToLiquidationBps = healthFactorBps === null ? null
                                 : max(0, round(10000 × (healthFactorBps − 10000) / healthFactorBps))
```

the fractional decline in collateral value (bps) the position absorbs before `HF` reaches `1.0` (liquidation).
`null` mirrors `healthFactorBps === null` (a debt-free position — the engine yields `null`, **never** `+Infinity`,
so no `+Infinity` branch is needed); `0` when `HF ≤ 1.0`.

- **The name encodes the nature, because names travel into JSON and operator mental models without their caveats.**
  This is an **entry-time structural identity** derived purely from leverage/LLTV — *not* a live liquidation
  distance: it assumes the wstDIEM/DIEM collateral valuation does not move (no oracle/depeg path), and the tool
  has **no automated liquidation protection** (SPEC001 §5), so a misread as a live margin invites exactly the
  false complacency the tool exists to prevent. Hence `structuralMarginToLiquidationBps`, not `marginToLiquidationBps`.
- **Coordinate with SPEC001 Open Question #9** (which proposes a margin-to-liquidation on the *live* `monitor`
  dashboard): the live-dashboard value and this offline-structural value must **not** share an ambiguous token.
- **§8 gains a caveat** that this inherits `healthFactorBps`'s limits verbatim. A concrete `liquidationPriceRatio`
  is deferred (wstDIEM NAV ratchets ≥ 1, so a single "price" is ambiguous).

### E3 — Stressed-rate netAPY (output + **proximity-gated** verdict-ride) **[VERDICT-AFFECTING-lite]**

Bound the sustained-high-utilization case with a second netAPY priced at the 100%-utilization borrow rate:

```text
borrowCostStressedApyBps = round((leverage − 1) × borrowAprAtFullUtilizationBps)   // 4× rateAtTarget cap
netApyStressedBps        = grossVaultApyBps − borrowCostStressedApyBps − annualizedOneTimeCostBps
```

`borrowAprAtFullUtilizationBps` is already computed for both models (`sizing.ts:350`), so this is well-defined
in `flat` mode too (it is not the flat `borrowApyBps`, and rev-3 states so). It is **never a blocker** (that would
over-block on a rate the loop may never sustain). **Flat-mode caveat:** the stress prices at the adaptive
`4×rateAtTarget`, which can be *lower* than a deliberately-high user-supplied `--borrow-apy-bps` — in that case
`netApyStressedBps > netApyBps` (the "stressed" figure is less stressed than the base). This is correct-as-defined
(the stress is the full-util adaptive rate, not a `max()` against the flat assumption); it is only a meaningful
downside bound when the full-util adaptive rate exceeds the operator's flat rate.

**`netApyStressedBps` is always emitted as a number** (informational, unconditional). But the verdict-ride is
**proximity-gated** to avoid alarm fatigue: because the stress prices at `4×rateAtTarget` and the default
`rateAtTarget` is a deliberately-pessimistic 400 (→ 1600 bps stressed borrow, E6), an ungated warning would fire
across most of the grid even in today's ~42%-util regime where full utilization is remote. So the
`net apy negative under sustained max utilization` **warning + `isMarginal` demotion fire only when the loop is
actually near the stress regime**:

```text
stressedNearFail = postDrawUtilizationBps > STRESSED_UTIL_BAND_BPS   // = 7000 (70%), a fixed heuristic (§6), tunable
                   && netApyStressedBps < minNetApyBps
```

- **`isMarginal` predicate (pinned):** add `stressedNearFail` as a fourth `isMarginal` condition (alongside
  slippage-near-cap / HF-near-floor / APY-near-floor, §6). A scenario that passes all gates but is
  `stressedNearFail` classifies `marginal`, not `candidate`. The predicate is evaluated on the same `baseResult`
  (`netApyStressedBps` is a §7 result field, populated before `isMarginal`).
- **The warning rides `blocked` verdicts too** — like rev-2's `gas unmodeled`, `warnings[]` is independent of
  `status`; a scenario blocked on another gate still surfaces the sustained-utilization warning when
  `stressedNearFail` holds. (`status` is decided by `blockers`; the warning is advisory.)

### E4 — Per-leg curve depth-sufficiency **[BACKSTOP gate — dormant under defaults]**

rev-2's gate 1 depth sub-condition keys off the *reconstructed total* (`curveDepthDiem < requiredCurveDepthDiem`).
rev-3 splits it **per-leg**:

```text
// gate 1 depth sub-condition (replaces the total check; the slippage sub-condition is unchanged)
curveDiemLegDiem < requiredCurveDiemDepth  ||  curveWstDiemLegDiem < requiredCurveWstDiemDepth
```

**What it actually enforces (corrected from the review — do not over-claim).** This is **not** a "position ≤ share
of the drawn leg" cap. `requiredCurveDiemDepth = requiredCurveDepthDiem / 2` (`sizing.ts:278`) — it splits the
*existing aggregate* `requiredCurveDepthDiem` **proportionally** (each leg must hold ≥ its half). That proportional
split — not a per-leg trade cap — is precisely what preserves balanced-pool equivalence. It is a **looser** per-leg
concentration bound than "the exit ≤ maxShare of the DIEM leg."

**Safety & scope (verified by the review).** The change is **tighten-only and balanced-preserving**: `total <
requiredTotal ⇒ at least one leg short` (so every old block still blocks), and `total ≥ requiredTotal ⇒ both legs
pass` under the floor/remainder split — so **balanced fixtures (incl. the canonical §9 case, legs 10000/10000) are
provably unchanged**. Only imbalanced pools with a leg below its half-requirement newly block. Re-baseline only
imbalanced fixtures.

**Where it actually bites (this is a backstop, not a headline tightening):**
- **Exit / DIEM leg — dormant offline.** E4 blocks the DIEM leg at `position/diemLeg > 2·maxCurvePositionShareBps/BPS`
  (≥ 30% at the default share cap 1500). The exit-**slippage** sub-condition (§5) already blocks at
  `position/diemLeg > (maxSlippageBps − curveFeeBps)/BPS` (≤ 2.96% given the zod cap `maxSlippageBps ≤ 300`). Slippage
  therefore fires **~10× earlier for every valid offline config** — the DIEM-leg depth check can only bind when a live
  `get_dy` quote has replaced `exitSlippageBps` (from-chain), or the operator sets `maxCurvePositionShareBps < ~148 bps`
  / `--slippage-bps > ~3000`. Under defaults it changes **zero** verdicts (a dormant backstop, like `unwind_not_covered`, §5).
- **Entry / wstDIEM leg — this is E4's real value.** There is **no entry-slippage blocker** (rev-2 R2; gate 1 checks
  only `exitSlippageBps`). So the entry-leg depth check is the **only** constraint guarding a thin *entry* leg — the
  one place E4 earns a verdict change offline.
- `requiredCurveDepthDiem` (total) stays an output and the `firstCandidateByLeverage` ranking key (E5) — the aggregate
  is still the right *ranking* heuristic even though the *gate* is per-leg.
- **Deferred (out of rev-3 scope, noted):** keying each leg's requirement to its *actual* trade (`positionCollateralDiem`
  for the DIEM leg, `borrowAmountDiem` for the wstDIEM leg) would be a truer "cap for the trade it faces," but it is a
  larger, balanced-pool-affecting change; rev-3 keeps the proportional 50/50 split of the position-based aggregate.

### E5 — Rename `viable` → `candidate` **[BREAKING output rename]**

> **E5 SHIPPED.** The `viable` → `candidate` rename landed atomically across the enum, `summary` fields,
> `loopStatusToken`, the table (with a `candidate = clears all gates` gloss), SPEC003 §6's integrator-note
> prose, the runbook, and all tests — zero residual `"viable"` in code/JSON/tests (AC5). No gate, computation,
> or verdict changed; a scenario that was `viable` is now `candidate` (`marginal`/`blocked` unchanged).

`viable` is the loudest possible token in a tool that **cannot execute** and whose own §1 says a pass is only a
candidate for deeper fork/live validation. rev-3 renames the clean-pass status so the token matches its meaning:

- `LoopSizingStatus`: `"viable" | "marginal" | "blocked"` → **`"candidate" | "marginal" | "blocked"`**.
- `summary.viable` (count) → `summary.candidate`; `summary.firstViableByLeverage` → `summary.firstCandidateByLeverage`.
- Table token `viable` → `candidate`; the "Totals" / "First … by leverage" summary rows and all prose follow.
- **Decision (both reviewers): full enum rename, not display-only.** The JSON status enum changes too — display-only
  would leave the machine contract saying `viable` for no benefit (pre-production, broadcast-disabled, no external
  consumers). `candidate` also *aligns* with SPEC003's existing `candidate — unverified seed`, which is a reason to
  prefer it over alternatives like `passes-gates`.
- **Land atomically — E5 is one change touching ALL of:** (a) the `LoopSizingStatus` enum + status classification
  (`sizing.ts`), (b) `LoopSizingReport.summary` (`viable`→`candidate`, `firstViableByLeverage`→`firstCandidateByLeverage`)
  + `buildLoopSizingReport`, (c) `loopStatusToken` + the two summary render sites (`output.ts`), (d) **SPEC003 §6's
  JSON-integrator-note prose, which literally enumerates `viable`/`marginal`/`blocked`** and instructs AND-combining
  with `authoritative` — update that prose, not just the code, and (e) the three test files
  (`test/sizing.test.ts`, `test/sizing-rev2.test.ts`, `test/from-chain-seed.test.ts`). Splitting E5 across units leaves
  the enum and the demotion signal disagreeing in the interim.
- **Demotion contrast (SPEC003 §6).** Post-rename an authoritative pass reads `candidate`; a degraded seed reads
  `candidate — unverified seed` — **same root token**, so the at-a-glance downgrade is now carried by the
  `— unverified seed` suffix + the `UNVERIFIED SEED` banner + `authoritative:false` (the banner is **load-bearing** —
  keep it). `loopStatusToken` (`output.ts:180`) updates its `result.status === "viable"` check to `"candidate"`.
- **`candidate` vs `marginal` legibility.** Both read as "maybe"; the ladder is `blocked < marginal < candidate`.
  Mitigate in the **table** with a one-word gloss (e.g. `candidate = clears all gates`) or ordering/emphasis — do
  **not** invent a fourth term.

### E6 — Default `rateAtTargetApyBps` reconciliation (documentation; **keep the conservative default**)

The default `rateAtTargetApyBps = 400` (Morpho genesis) is ~2× the live ~217 bps (2026-07-11). rev-3 **keeps 400**
as the default because a *higher* assumed borrow rate is the safe error direction for a sizing tool (it understates
netAPY and blocks more, never less). It is a documentation reconciliation, not a value change:

- The `--rate-at-target-apy-bps` help text and §3.2 state plainly: `400` is the conservative genesis default; pass
  the live value (`--rate-at-target-apy-bps 217`) or `--from-chain` (SPEC003, seeds it directly) for realistic sizing.
- **Decision (both reviewers): keep 400.** A false-negative (block a fine scenario) is far cheaper than a
  false-positive for a tool that must not green-light a bad loop, and the assumed rate is always visible (§7.4 prints
  `rateAtTarget @90% util`; `borrowAprAtTargetBps` is an output). The pessimism compounds through E3's `4×` multiplier
  (→ 1600 bps stressed borrow) — but that is handled by **E3's proximity gate**, not by weakening this default.

### §7 field additions (rev-3)

- **Result (`LoopSizingResult`):** `curveDiemLegSlippageShortfallDiem`, `curveDiemLegShortfallDiem`,
  `curveWstDiemLegShortfallDiem`, `morphoSupplyShortfallDiem` (WAD bigint, wei-string per §7.3 — the two
  slippage/depth DIEM fields may be `"Infinity"`); `exitSlippageExcessBps`, `netApyShortfallBps`, `netApyStressedBps`
  (number bps; `exitSlippageExcessBps` may be `"Infinity"`); `structuralMarginToLiquidationBps` (number | null). All
  always populated (§7.3).
- **Status/summary:** `status` enum value `viable` → `candidate`; `summary.candidate`; `summary.firstCandidateByLeverage`.
- **Table:** add a `Shortfall` / `Margin-to-liq` surfacing for blocked/near-edge rows (exact column layout at the
  executor's discretion, but the `firstBlocker`'s shortfall — the slippage-clearing depth for a slippage block — and
  `structuralMarginToLiquidationBps` must be visible); the status token renders `candidate` with the legibility gloss.

### §7.1–7.3 reconciliation (rev-3 lock retires the pre-rev-2 stale names)

rev-3 is the lock point that retires §11 and adds `"Infinity"` fields keyed to §7.3, so fold in the outstanding
rev-2 doc-drift so the referenced clauses are correct: §7.2 must list `exitSlippageBps` (rev-2 renamed
`estimatedExitSlippageBps`) and add the rev-2 legs + rev-3 fields; §7.3's non-finite-serialization example uses
`exitSlippageBps` (and now also `exitSlippageExcessBps` / `curveDiemLegSlippageShortfallDiem`); §7.1
`assumptions.curveDepthModel` reads `"linear-per-leg-depth-share"` (rev-2), not `"linear-depth-share"`.

### §8 / §11 reconciliation (rev-3)

- §8 HF caveat → gains the `structuralMarginToLiquidationBps` re-expression note (same entry-time-identity limits;
  an entry-time structural identity, not a live liquidation distance — coordinate the name with SPEC001 OQ#9).
- §8 → add the stressed-netAPY bound and the `net apy negative under sustained max utilization` warning.
- §11 → shortfall outputs, liquidation-distance, stressed-rate netAPY, per-leg depth-sufficiency, and the
  `viable`→`candidate` rename are **promoted to this committed rev-3**; the §11 list is now fully retired
  (rev-2 took slippage + gas + MEV-caveat; rev-3 takes the rest).

### Staging (four waves — do not ship as one unit)

1. **Wave 1 — additive, zero verdict change, zero re-baseline:** E1 (shortfalls incl. `curveDiemLegSlippageShortfallDiem`),
   E2 (`structuralMarginToLiquidationBps`), E6 (docs) + the §7.1–7.3 reconciliation. Highest value / lowest risk — ship first.
2. **Wave 2 — verdict-affecting-lite:** E3 (stressed netAPY output + proximity-gated verdict-ride); re-baseline only
   fixtures that cross the marginal band under `stressedNearFail`.
3. **Wave 3 — backstop gate:** E4; re-baseline only imbalanced fixtures (entry-leg cases). Ship knowing it's dormant
   under defaults (documented as a backstop).
4. **Wave 4 — breaking rename:** E5, landed **atomically** with its full SPEC003 §6 coordination (enum + token +
   integrator-note prose + tests).

### Acceptance criteria (tests when built)

1. **Shortfalls are exact and directional.** For a **slippage-blocked** scenario, `curveDiemLegSlippageShortfallDiem`
   added to the DIEM leg brings `exitSlippageBps` to ≤ `maxSlippageBps` (offline/linear); a passing gate → `0`; and it
   is `"Infinity"` when `maxSlippageBps ≤ curveFeeBps`. The per-leg *depth-share* `curve*LegShortfallDiem` clear E4's
   backstop sub-condition; `morphoSupplyShortfallDiem` / `netApyShortfallBps` are `max(0, req − actual)` → `0` when
   passing. `exitSlippageExcessBps` is `> 0` iff `exitSlippageBps > maxSlippageBps`, and `"Infinity"` on a zero drawn
   leg **(offline / no injected quote — finite under a live `get_dy` quote)**.
2. **`structuralMarginToLiquidationBps`** equals `10000 × (HF − 10000)/HF` (rounded) for a finite HF, `null` when HF is
   `null` (debt-free; never `+Infinity`), `0` when `HF ≤ 10000`; a fixture at HF 25800 → 6124 bps (± rounding).
3. **`netApyStressedBps`** uses `borrowAprAtFullUtilizationBps` (4× rateAtTarget), always emitted, ≤ `netApyBps`
   whenever the stressed rate ≥ the effective rate; well-defined in `flat` mode (full-util APR, not `borrowApyBps`).
   The **verdict-ride is proximity-gated**: a scenario with `postDrawUtilizationBps > STRESSED_UTIL_BAND_BPS (7000)`
   whose base passes but `netApyStressedBps < minNetApyBps` → `marginal` + warning; the *same* scenario at low util
   (≤ 7000) stays `candidate` and only carries `netApyStressedBps` as a number (no warning, no demotion).
4. **[E4] Backstop gate.** A **thin-wstDIEM-leg** (entry-leg) imbalanced pool whose total clears the old check blocks
   on `curveDiemLegDiem`/`curveWstDiemLegDiem` per-leg → `curve_liquidity_insufficient` (this is the case E4 uniquely
   catches — no entry-slippage gate exists). A **thin-DIEM-leg** pool at default slippage is attributable to the
   **slippage** sub-condition (assert it blocks there, proving E4's exit-leg half is dominated offline). A balanced
   pool (legs 10000/10000) is provably unchanged vs rev-2.
5. **[E5] Rename (atomic).** `status`/`summary`/table all read `candidate`; **no residual `"viable"` string in code,
   JSON, docs, or SPEC003 §6's integrator-note prose**; SPEC003's chain-seed demotion still degrades the token
   (`candidate — unverified seed` + banner) and its test passes.
6. **[E6]** The default remains `400`; `--rate-at-target-apy-bps 217` and `--from-chain` are documented as the
   realistic path; help text + §3.2 updated.
7. **No-regression:** every rev-1/rev-2 **balanced** fixture keeps its verdict; the only fixture changes are the
   marginal-band `stressedNearFail` cases (E3), imbalanced entry-leg pools (E4), and the `viable`→`candidate` token (E5).
