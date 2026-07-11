# SPEC002 — Loop Sizing Engine

> **Status — 2026-07-11.** Committed contract for the **offline** `loop sizing` command
> (`src/loop/sizing.ts`, `src/loop/sizingScenarios.ts`, `src/loop/morphoRate.ts`). It supersedes the
> non-normative runbook `docs/deployment/loop-sizing.md`. Consistent with SPEC001's monitor-and-
> rehearse posture: sizing uses **no RPC, no broadcast, no deploy** — it is advisory decision-support
> for whether a DIEM/wstDIEM loop size is economically viable *before* any (out-of-band) action.

## 1. Purpose & scope

`loop sizing` sweeps a grid of scenarios and, for each, decides **viable / marginal / blocked**
against **five economic gates** (Curve depth **+ exit slippage**, Morpho supply, health factor, net
APY, unwind coverage) plus a `scenario_invalid` validity gate — six blockers total (§5); there is no
standalone "slippage" blocker (it is folded into the Curve-depth gate). It is pure integer/bigint
arithmetic over caller-supplied assumptions; it reads nothing
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
       : "viable"
```

`isMarginal` (a scenario that passes every gate but sits near an edge):
- **slippage near cap**: `max(entrySlip, exitSlip) > maxSlippageBps · 0.8`, or
- **HF near floor**: `healthFactorBps < ceil(minHealthFactorBps · 1.1)`, or
- **APY near floor**: `netApyBps < minNetApyBps + 200`.

The band constants (`0.8`, `1.1`, `+200 bps`) are fixed heuristics — not configurable.

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
"100000000000000000000"`). bps/ratios are numbers, **except non-finite bps serialize as the strings
`"Infinity"` / `"-Infinity"`** — `estimatedEntrySlippageBps`/`estimatedExitSlippageBps` when
`curveDepthDiem = 0` (which is the **first default grid value** and the whole `current-zero` preset,
so a default `--json` run emits them), and `annualizedOneTimeCostBps` when `initialCollateralDiem = 0`.
`healthFactorBps` may be `null`. `chainId` is the configured static value — nothing is read from
chain. **All economic fields are populated even when `status = blocked`** (e.g. `postDrawUtilization
→ WAD` when supply is 0), so a consumer must not treat blocked ⇒ null.

### 7.4 Table (`renderLoopSizingTable`)
Columns: `Scenario | Lev | Equity | Borrow | Curve req/actual | Morpho req/actual | Slip entry/exit |
HF | Util→Borrow APR | Net APY | Status[: firstBlocker]`. Summary rows: **Totals**
(viable/marginal/blocked of total), **First viable by leverage**, **Borrow model** (adaptive-curve
prints `rateAtTarget @90% util` and `@100% util` reference APRs; flat prints "borrow APY used as
given"), **Read-only** (`broadcast disabled; audit required true`).

## 8. Assumptions & limitations

- **Curve depth is a single scalar and cannot represent a drained/imbalanced pool — the headline
  risk.** `curveDepthDiem` is total two-sided depth; slippage is `fee + ratioBps(trade, total)`
  (§4). On a drained/off-peg wstDIEM/DIEM pool — the market state this tool exists to evaluate — the
  DIEM side an exit draws into is nearly empty, so real slippage is dramatically worse and convex,
  yet the model has no notion of imbalance; dividing the trade by *total* depth also understates
  trade-vs-traded-side by ~2×. A `viable, exit slip 296 bps` reading can therefore be badly
  optimistic on exactly the pool it is meant to guard against. This matters because the exit-slippage
  sub-condition of gate 1 is the **primary** safety constraint (§5) and it consumes this softest
  input — treat `viable` on a thin/off-peg pool as unsafe pending a fork `get_dy` proof. (Textbook
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
  nothing is liquidated in between. "Viable for 365 days" is not a year of modeled risk.
- **Gas and MEV are excluded** from `oneTimeCostDiem` (entry slip + exit slip + flash fee only).
  Entry/exit are multi-call txns and the Curve leg is MEV-exposed on exactly the thin pool this
  targets; at default ~100-DIEM sizes gas alone can flip `netApyBps` negative while status reads
  `viable`.
- **Morpho liquidity**: `supply − existing borrow`, capped at `maxMorphoUtilizationBps`.
- **APY**: simple-annualized, not compounded; effective APY is marginally higher.
- **Borrow rate**: **instantaneous** at post-draw utilization for the supplied `rateAtTarget`; does
  **not** model multi-day `rateAtTarget` drift (rises under sustained high utilization, falls when
  idle), so sustained-high-utilization scenarios are **understated** — pass the current on-chain
  `rateAtTarget`.
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
  by how much / what would unblock it"). The data exists — `firstViableByLeverage` already reasons
  about the cheapest unlock.
- **Gas + MEV cost.** A `--gas-cost-diem` input folded into `oneTimeCostDiem`, with an MEV caveat
  scaling to pool thinness. At default sizes this flips verdicts (§8).
- **Liquidation-distance output.** Margin-to-liquidation / liquidation price, since `healthFactorBps`
  is a pure leverage/LLTV identity (parallels SPEC001 Open Question #9).
- **Stressed-rate netAPY.** A second net APY at `borrowAprAtFullUtilizationBps` (or a rateAtTarget-
  drift multiplier) to bound the sustained-high-utilization case.
- **Naming.** `viable` is the loudest token in a tool that cannot execute; consider
  `candidate`/`passes-gates`, and reconsider `firstViableByLeverage` (which answers "how big can I
  go") as a recommendation surface.
- Reconcile the default `rateAtTargetApyBps = 400` ("conservative") against the runbook-recommended
  live value (~217 on 2026-07-11).

## rev-2 — model fidelity (Phase 3.5, FORWARD — not yet implemented)

> **Committed forward changes** to the engine, the hard prerequisite for **SPEC003 Part B**. Until
> implemented, §1–§10 describe the shipped behavior; rev-2 promotes three §11 items to committed work
> and revises §4 (slippage/cost) + §8 (assumptions). Same spec-first gate applies (two-agent review →
> lock → executor → verify).

### R1 — Leg-aware, direction-correct slippage (fixes §8's headline blind spot at the model layer)

Today (`sizing.ts:248-253`) every trade divides by a single `curveDepthDiem` scalar, which cannot
represent an imbalanced/drained pool, is direction-blind, and divides by *total* depth (understating
trade-vs-traded-side by ~2×, §8). rev-2 models the pool as **two legs** in DIEM-equivalent:

- `curveDiemLegDiem` — the DIEM side (`balances(0)`).
- `curveWstDiemLegDiem` — the wstDIEM side in DIEM (`convertToAssets(balances(1))`).

Each trade divides by the leg it **draws** (selling into a StableSwap leg depletes it):

```text
estimatedExitSlippageBps  = curveFeeBps + ratioBps(positionCollateralDiem, curveDiemLegDiem)      // exit sells wstDIEM → draws DIEM leg
estimatedEntrySlippageBps = curveFeeBps + ratioBps(borrowAmountDiem,       curveWstDiemLegDiem)   // entry buys wstDIEM → draws wstDIEM leg
// a zero drawn leg → +Infinity (as rev-1)
```

Direction-correct: on a DIEM-drained pool the **exit** (÷ small DIEM leg) is correctly costly while the
**entry** (÷ large wstDIEM leg) is correctly cheap — the case rev-1's single scalar and SPEC003's
rejected `2×min` heuristic both got wrong.

**Input & backward-compat.** Add `--curve-diem-leg` / `--curve-wstdiem-leg` (DIEM-equivalent) grid
inputs; keep `--curve-depth-diem <total>` as a **balanced** convenience: `curveDiemLegDiem =
curveWstDiemLegDiem = total / 2`. **Intended correction (breaking):** for the same nominal
`--curve-depth-diem`, rev-2 exit/entry slippage is ~**2× higher** than rev-1 (it divides by ~half the
pool — the traded leg — not the total). This *is* the §8 ~2× understatement fix, not a regression;
rev-1 acceptance fixtures update to the corrected values. Still a **linear per-leg** estimate — true
convexity comes from a live quote (R2).

### R2 — Live `get_dy` exit-quote injection (the seam SPEC003 Part B fills)

Add an optional `externalExitSlippageBps?: number` scenario input. When present it **overrides** the R1
exit estimate; the exit gate uses it verbatim, and the report records `exitSlippageSource: "get_dy" |
"estimate"`. This is the seam by which `loop sizing --from-chain` (SPEC003 Part B) injects a **real
convex** exit slippage from a live `get_dy(1→0, positionCollateralDiem)` at the pinned block:

```text
externalExitSlippageBps = max(0, round((1 − diemOut / expectedDiemOutAtNav) · 10000))
```

Offline runs (no injection) use the R1 leg-aware estimate. Entry keeps the R1 estimate — the exit gate
is the primary safety constraint (§5); an entry-quote seam is a later option. This is the correct
layer for convexity: a real quote, not an offline heuristic.

### R3 — Gas in one-time cost; MEV as a caveat

`oneTimeCostDiem = entrySlippageCost + exitSlippageCost + flashFeeCost + gasCostDiem`, with a new
`gasCostDiem` (`--gas-cost-diem`, default `0`). At default ~100-DIEM sizes gas alone can flip
`netApyBps` negative, so it must be a first-class term (`sizing.ts:261`). **MEV stays a caveat, not a
number** — unbounded and venue/timing-specific; §8 documents that it scales with pool thinness on the
Curve leg and that a thin-pool `viable` is MEV-exposed regardless of the modeled slippage.

### §8 / §11 reconciliation
- §8 Curve bullet → "leg-aware, direction-correct, imbalance-aware; still linear per leg unless a live
  `get_dy` quote is injected (R2)."
- §8 → gas now **included** (R3); MEV still excluded numerically (caveat, R3).
- §11 → "leg-aware/`get_dy` slippage" and "gas + MEV" are promoted to this committed rev-2; shortfall
  outputs and liquidation-distance remain §11 future.

### Acceptance criteria (tests when built)
1. Exit slippage divides by the DIEM leg, entry by the wstDIEM leg (the direction map).
2. Imbalanced fixture (DIEM leg ≪ wstDIEM leg) → high exit / low entry slippage; mirror pool → reverse.
3. `--curve-depth-diem T` → balanced legs `T/2`; exit `= fee + ratioBps(trade, T/2)` (the corrected ~2× vs rev-1 — rev-1 fixtures updated).
4. `externalExitSlippageBps` overrides the exit estimate; `exitSlippageSource` records `"get_dy"` vs `"estimate"`.
5. `gasCostDiem` folds into `oneTimeCostDiem` → `netApyBps` (a large-enough gas value flips a marginal `viable` to blocked).
6. Zero drawn leg → `+Infinity` slippage (fail-safe, as rev-1; JSON serializes `"Infinity"` per §7.3).
7. Integration: SPEC003 Part B seeds both legs from `balances` + the exit quote from `get_dy`, and its soft-seed verdict-demotion (SPEC003 §6) fires on an imbalanced pool.
