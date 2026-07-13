# SPEC005 — Live liquidation readout (resolves SPEC001 OQ#9)

**Status: REVIEWED + LOCKED (2026-07-12).** Two-agent pre-code gate (technical critic + product analyst, both REVISE)
→ fixes folded → focused confirmation pass (2 further Majors: div-by-zero exception-path masking, underwater gate
contradiction) → fixed → LOCKED. Ready for implementation.

> Surface a **live** margin-to-liquidation on the `monitor` dashboard, and — the load-bearing half — turn a
> position approaching liquidation into a `monitor` CRITICAL so the SPEC004 keeper pages on position danger, not
> only on infrastructure failures. Decision-support only: the tool holds no position and takes no protective action
> (SPEC001 A3 / OQ#6 monitor-and-rehearse).

## 1. Problem & scope

The dashboards show health factor nowhere useful and margin-to-liquidation nowhere at all:

- **`monitor`** is the only command that reads the live Morpho position (collateral + debt, `readiness.ts`), but it
  reads **no LLTV and no oracle price**, so it cannot compute a live HF or liquidation distance. Its Owner row shows
  collateral / debt / authorized — never how close the position is to being liquidated.
- **`status` / `watch`** carry a `MetricSnapshot.healthFactor` field, but the status/watch path never populates it
  (`collectVaultMetrics` sets only `validity.vault`; `validity.position` stays the `math.ts` default `false` and
  `status.ts` sets `liveAssessed` from `validity.vault` only), so it is **always the `Infinity` default** and the
  table prints `HF Infinity` — a *false safety signal* on a position it never read.
- The only margin-to-liquidation in the codebase is `sizing.ts`'s `structuralMarginToLiquidationBps` (SPEC002
  rev-3 E2), which is **entry-time structural** (from target leverage + config LLTV, static-NAV, collateral-decline
  axis) — explicitly not a live signal.

**The safety consequence (ties to SPEC004).** `monitor`'s `critical (30)` exit code today is reachable only via
infrastructure alerts (`live_rpc_unavailable`, `curve_liquidity_empty`, `vault_not_ready`, executor mismatches).
**No command emits a CRITICAL when the owner's own position drifts toward liquidation** (HF < 1.40). A keeper
gating on `monitor` (per SPEC004 §7) is paged when the RPC is down but **not** when the position it is supposed to
protect is about to be liquidated. That is the gap this spec closes.

**Assumed keeper gate.** SPEC004 §2 offers `-ge 30` (page hard) and `-ge 20` (default page). This spec's alerts are
designed so **both** gates page correctly on position danger: real liquidation danger and deterministic oracle/market
faults reach **30**; a genuinely un-assessable tick reaches **20**. No design here relies on the keeper choosing one
over the other, and (per §3/§4) no CRITICAL is ever silently masked below 30.

**Scope.** Add a live liquidation readout — **health factor, debt-growth headroom, and liquidation price** — to the
`monitor` command only (behind an `includeLiquidation` flag; §7), plus live position-health and oracle/market-fault
alerts that feed the SPEC004 exit code. Fix the misleading `status`/`watch` `HF Infinity` display. `status`/`watch`
do **not** gain the position reads — they remain vault-liveness snapshots per the SPEC004 §1 danger-detection
asymmetry (`monitor` is the danger command). `loop readiness` is **not** affected (the flag is off for it; §7/§8).

**Out of scope.** No new price feed beyond the Morpho market oracle Morpho itself liquidates against; no automated
deleverage/protection (A3 stands); no change to the offline `sizing` structural margin; no time-to-liquidation
runway estimate (deferred, OQ-D).

## 2. The readout — numbers, formula, scale

Add a `liquidation` readout to the `monitor` live read, gated on **`borrowShares > 0`** (there is debt — something
to be liquidated), **not** the stricter `hasExitPosition` (which additionally requires `collateral > 0` and would
exclude the underwater case below). Evaluate the branches in this order — **fault detection first, so the price
formula is never reached on a fault** (§4):

1. **`borrowShares === 0`** → no debt → readout `null`, no alert (nothing to liquidate).
2. **Fault** — `collateral === 0` (underwater/bad-debt), `lltvWad === 0`, or `oraclePrice1e36 === 0` → Morpho values
   the collateral at ~0 → `position_liquidation_fault` **CRITICAL** (§3b). Readout struct is populated with
   `healthFactor: 0`, `debtGrowthHeadroomBps: -10000` (fully underwater sentinel), and
   `liquidationPriceDiemPerWstDiem: null` / `oraclePriceDiemPerWstDiem` = the raw price (or `null` if price was the
   fault) — the price formula is **not** computed on this branch (avoids the `lltvWad`/`collateral` division-by-zero
   that would otherwise throw into the `rpc-read` catch and mask the CRITICAL as a 20).
3. **Normal** — `borrowShares > 0 && collateral > 0 && lltvWad > 0 && oraclePrice1e36 > 0` → the full readout below.

The underwater fault (case 2, `collateral === 0`) is sourced from `owner.collateralWstDiem`/`owner.borrowShares`
(already read unconditionally), so it fires even though the `includeLiquidation`-gated LLTV/oracle reads (§7) may not
have produced usable values.

| Output | Meaning | Formula |
|---|---|---|
| `healthFactor` | live HF (liquidatable at `< 1.0`) — the primary number | reuse `computeHealthFactor(collateralValueDiem, borrowedDiem, lltvWad)` |
| `debtGrowthHeadroomBps` | **primary margin**: how far debt may grow before HF reaches 1.0, as a fraction of current debt — the debt-accrual axis (§6) | `round((HF − 1) × 10000)` (may be **negative** when HF < 1, i.e. underwater) |
| `liquidationPriceDiemPerWstDiem` | **secondary, gated**: the oracle price (DIEM per 1 wstDIEM, WAD-normalized) at which HF = 1.0 — the collateral-decline / fault axis | `borrowedDiem × WAD² / (lltvWad × collateral)`; **`null` when `lltvWad === 0` or `collateral === 0`** (both would throw `bigint / 0n` — computed only on the §2 normal branch) |
| `oraclePriceDiemPerWstDiem` | current oracle price, WAD-normalized, for comparison | `oraclePrice1e36 / WAD` |
| `lltvBps` | the live LLTV used | `idToMarketParams.lltv` → bps |

**Two axes, one identity — reconciled with E2.** `debtGrowthHeadroomBps = HF − 1` (debt may grow this % before
liquidation) is the *debt-accrual* axis. The offline E2 `structuralMarginToLiquidationBps = (HF−1)/HF` is the
*collateral-decline* axis (the % NAV/oracle drop absorbed before HF=1). They are **different numbers on different
axes** and must not be conflated: at HF 1.29, debt-growth headroom = **2900 bps**, collateral-decline margin = 2248
bps. This spec leads with the debt-growth axis (the primary live risk); the collateral-decline axis is expressed
only via `liquidationPriceDiemPerWstDiem` (with the §6 fault caveat), not as a second bps number, to avoid the E2
naming collision.

**Inputs & scale (confirmed against the codebase):**
- `collateral` = `position.collateral` (wstDIEM, 1e18).
- `borrowedDiem` = the existing live-derived debt (`computeBorrowedDiem`, DIEM 1e18).
- `lltvWad` = `idToMarketParams(marketId).lltv` (WAD). **Read live**, not the config constant — the readout must
  reflect the market Morpho actually liquidates against. (`config.morpho.lltvWad` remains the preflight equality
  check only.)
- `oraclePrice1e36` = `oracle.price()` where `oracle` = `idToMarketParams(marketId).oracle` (the **market's own**
  oracle, which may differ from `config.contracts.morphoOracle`; this divergence is intentional — Morpho liquidates
  against the market oracle — and must not be "fixed" to the config oracle). **1e36-scaled** DIEM per 1e18 wstDIEM —
  confirmed by `computeOracleDeviation` (`onchainOraclePrice` vs `convertToAssets(1e18) × WAD`).
- `collateralValueDiem` = `collateral × oraclePrice1e36 / 1e36` (DIEM, 1e18) — the price-multiplied collateral value
  `computeHealthFactor` expects (it currently has **no production caller**; this is its first).
- **Loan-token decimals assumption:** the displayed prices assume an 18-decimal loan token (DIEM), so `price1e36` is
  truly 1e36-scale. True for the DIEM/wstDIEM market today. The HF *ratio* is decimal-agnostic (self-consistent)
  regardless; only the displayed price fields carry this assumption — note it so a future non-18-decimal market does
  not silently mis-scale the *display* (HF stays correct).

**Worked acceptance anchor (pin this exact case in a test).** `collateral = 10e18`, `oraclePrice1e36 = 1.05e36`
(NAV 1.05), `borrowedDiem = 7e18`, `lltvWad = 0.86e18`:
- `collateralValueDiem = 10.5e18`; `HF = 10.5 × 0.86 / 7 = 1.29`.
- `debtGrowthHeadroomBps = round((1.29 − 1) × 10000) = 2900`.
- `liquidationPriceDiemPerWstDiem = 7e18 × (1e18)² / (0.86e18 × 10e18) = 0.813953…e18` (≈ 0.814 DIEM/wstDIEM).
- Cross-check identity: price-drop margin `(1.05 − 0.81395)/1.05 = 0.2248` equals `(HF−1)/HF` (the collateral axis /
  E2 value) — asserted with a float **tolerance** (both sides derive from floored bigints; `===` would flake).

## 3. Alerts (the SPEC004 tie-in)

Add to `evaluateReadinessAlerts`, emitted only when `includeLiquidation` and the position warrants it:

**(a) `position_health_factor`** — when `hasExitPosition` and HF computed (finite):
- `HF < thresholds.healthFactorCritical` (default **1.40**) → **CRITICAL** → `monitor` exit **30**.
- else `HF < thresholds.healthFactorWarn` (default **1.60**) → **WARN** → exit **10**.
- else no alert.

**(b) `position_liquidation_fault`** — a deterministic, non-throwing protocol fault where Morpho values the
collateral at ~0 (so its own HF is ~0 and the position is liquidatable): `oraclePrice1e36 === 0`, `lltvWad === 0`,
or the underwater case `collateral === 0 && borrowShares > 0` (§4) → **CRITICAL** → exit **30**. This reaches 30 via
the normal alert path (no `isMonitorAssessed` short-circuit), so it never masks a co-fired unrelated CRITICAL.

Thresholds come from `config.thresholds` (config is authoritative — consistent with the presumption recorded in
SPEC001 OQ#8). Alert messages state HF, `debtGrowthHeadroomBps`, and that there is no automated protection — act
out-of-band now. `position_health_factor` is a per-tick readiness alert (no cooldown, per SPEC001 §3): with
correctly-calibrated thresholds (§3.1) a *sustained* CRITICAL means the operator has drifted into danger and not
acted — continued paging is the intended behavior, not noise.

### 3.1 Threshold calibration — why 1.40/1.60 are right, and when they aren't

The thresholds are **absolute liquidation-proximity lines**, and their usefulness depends on where a healthy
position rests. Resting HF = `LLTV × L / (L − 1)`. The tool's own loop enforces `minPostLoopHealthFactor` (default
**1.7**), which caps leverage at `L ≈ 2.02x` (0.86 × 2.02/1.02 ≈ 1.7). So a **tool-created** position enters at
HF ≥ 1.7 and drifts *down* as borrow interest accrues: `1.7 → 1.60 (WARN) → 1.40 (CRITICAL) → 1.0 (liquidation)`.
The defaults therefore sit **below** resting HF and correctly signal **drift**, not steady state.

- The "3.5x" referenced by the spread alerts is the **APY-model** leverage (`netApy35`), **not** the position's
  operating leverage. Do not conflate them.
- A position operated **more aggressively** than `minPostLoopHealthFactor` (resting HF below 1.60 — e.g. an
  externally-opened 3.0x position at HF ≈ 1.29) will fire WARN/CRITICAL **continuously**. That is a *correct*
  reflection of its standing risk (it genuinely lives near liquidation), not a false alarm — but such an operator
  must consciously lower `healthFactorWarn`/`Critical` (they are config-driven) or accept continuous paging. §9 pins
  a test that a resting-HF-1.72 position does **not** alarm.

## 4. Fail-closed — no false `nominal`, no masked CRITICAL

Every "cannot cleanly assess the position" path must fail **safe** (page), and none may silently downgrade an
unrelated CRITICAL. There are exactly three cases, all handled without touching `isMonitorAssessed`:

1. **A read throws** (`idToMarketParams` reverts, `oracle` is a zero/codeless address, RPC error, etc.) — caught by
   the existing outer `try` in `buildLoopReadiness` → `rpc-read` **fail** → `isMonitorAssessed` false → exit **20 /
   indeterminate** (SPEC004, unchanged). The readout is absent for that tick.
2. **A read succeeds with a fault value** (`oraclePrice1e36 === 0`, `lltvWad === 0`, or `collateral === 0 &&
   borrowShares > 0`) — Morpho's own HF is ~0, i.e. the position is liquidatable. Emit the `position_liquidation_fault`
   **CRITICAL** (§3b) → exit **30**. This is *not* "indeterminate": we *can* assess it, and the assessment is
   maximal danger. **Fault detection MUST run before the price formula** (§2 branch order): both `lltvWad === 0` and
   `collateral === 0` sit in `liquidationPriceDiemPerWstDiem`'s **denominator**, and `bigint / 0n` *throws* — if the
   formula were computed on the fault branch it would land in the `rpc-read` catch (case 1) → 20 and **mask this very
   CRITICAL**, the exact regression this design removes. So on the fault branch `liquidationPriceDiemPerWstDiem` is
   `null`, never computed.
3. **No borrow** (`borrowShares === 0`) — nothing to liquidate → readout `null`, no alert, tick classifies on its
   other signals (not forced to indeterminate).

> **Why not fold `liquidation-readout` into `isMonitorAssessed` (rejecting the earlier draft).** Folding would
> short-circuit `!assessed → 20` *before* the CRITICAL check in `classifyMonitoringOutcome`, so an isolated oracle
> fault would mask a co-fired unrelated CRITICAL (e.g. `curve_liquidity_empty`) down to 20 — a paging regression for
> a `-ge 30` keeper. Handling faults as a CRITICAL alert (case 2) reaches 30 through the normal path and preserves
> every co-fired CRITICAL. The throwing case (1) already yields 20 on its own. So there is no residual "non-throwing
> but truly unknown" case that needs the fold. (Resolves the technical M1 / product OQ-A convergence.)

## 5. `status` / `watch` honesty fix (no new reads)

`status`/`watch` do not read the position (SPEC004 boundary) — `validity.position` is always `false` on this path
(`math.ts` default; `status.ts` sets `liveAssessed` from `validity.vault` only). They currently render `HF Infinity`
from the unpopulated default, which reads as "infinitely safe." Change the display: when `validity.position` is
false, render HF as **`n/a (run monitor)`**, not `Infinity`. Display-only; no computation added, no boundary
crossed. (A genuinely debt-free position also shows `n/a` here — the live HF lives on `monitor`.)

## 6. Honesty — what the margin does and does not mean

wstDIEM is a **NAV-appreciating** collateral: `convertToAssets(1e18)` ratchets **up** as yield accrues, so the
oracle price trends up, not down, under normal operation. The readout copy MUST NOT imply market-price-drop risk:

- The primary path to liquidation is **debt accrual** — borrow interest growing `borrowedDiem` while collateral
  value is roughly static — **not** a collateral price crash. `debtGrowthHeadroomBps` (`HF − 1`) is exactly the
  headroom that debt growth consumes: "debt may grow N% before liquidation, at static NAV." (This is the correct
  axis — the earlier draft mislabeled the collateral-decline number as the debt buffer.)
- `liquidationPriceDiemPerWstDiem` is the collateral-decline / fault axis. It is shown as the oracle level at which
  HF = 1, **with an explicit caveat** that for a NAV-appreciating asset a price *decline* to that level implies a
  vault/oracle fault, not ordinary volatility — keep that caveat load-bearing, not fine print. Per **OQ-B (v1:
  gated)** it is surfaced only in the detailed/`--json` view, not the headline row, so it is not misread as the
  primary risk gauge.
- The readout is **decision-support**, not protection: HF < 1.40 is a signal to act out-of-band; the tool will not
  and cannot deleverage (A3). `nominal (0)` from `monitor` still is not a safety guarantee (SPEC004 §2).

## 7. Integration points

- **Flag-gated reads (monitor only):** extend `buildLoopReadiness` with an `includeLiquidation: boolean` input, set
  `true` only by the `monitor` action (`index.ts` monitor) and left `false`/absent by `loop readiness`
  (`index.ts`). When set and **`borrowShares > 0`** (§2 gate), read `idToMarketParams(marketId)` (live `lltv` +
  `oracle`) and `oracle.price()`, **block-pinned to the same `blockNumber`** as the existing position/market reads
  (no TOCTOU). Export `parseMorphoMarketParams` + its result type from `preflight.ts` (currently module-private) for
  reuse. Reuse `computeHealthFactor` (`math.ts`).
- **The underwater fault (`collateral === 0 && borrowShares > 0`) does NOT depend on these gated reads.** It is
  detected from `owner.collateralWstDiem`/`owner.borrowShares` (read unconditionally, independent of
  `includeLiquidation`), so the `position_liquidation_fault` CRITICAL fires even if the LLTV/oracle reads were never
  usable. Do not source the underwater signal from a `liquidation` struct that the gate could leave null.
- **Readout struct:** add a sibling `liquidation: LiquidationReadout | null` field to `LoopReadinessResult` (not
  nested in `owner`), carrying `healthFactor`, `debtGrowthHeadroomBps`, `liquidationPriceDiemPerWstDiem`,
  `oraclePriceDiemPerWstDiem`, `lltvBps`. Both `evaluateReadinessAlerts` and the renderer read it from there.
- **`--json`:** `monitor --json` `data` carries the `liquidation` object. **bigint fields
  (`liquidationPriceDiemPerWstDiem`, `oraclePriceDiemPerWstDiem`) serialize via `.toString()`** — the existing
  convention (`readinessAlerts.ts`) — so a `jq` consumer gets strings, not numbers.
- **Render:** headline liquidation row in `renderLoopReadinessTable` (HF + `debtGrowthHeadroomBps` %); liquidation
  price + caveat in the detailed view only (OQ-B gating). `null` readout renders `n/a (no borrow)`.
- **Alerts:** `position_health_factor` (§3a) and `position_liquidation_fault` (§3b) in `evaluateReadinessAlerts`.
- **`isMonitorAssessed` / `exitCode.ts`:** **unchanged** (per §4 — no fold).

## 8. Interactions & backward-compat

- **SPEC004:** additive on `monitor`. Reachable codes stay `{0,10,20,30}`, but `30` and `10` become reachable via
  *position* danger (new), and `20` via a *throwing* position read (new). `status`/`watch` stay `{0,10,20}`. No
  CRITICAL is masked below 30 (§4).
- **`loop readiness`:** unaffected — `includeLiquidation` is off, so no new reads, no new `checks` row, and
  `--strict-evidence` (`assertStrictLoopReadinessEvidence`) is not tripped by a new check. (This closes the shared-
  `buildLoopReadiness` break the technical review flagged.)
- **SPEC002 rev-3:** the offline `structuralMarginToLiquidationBps` ((HF−1)/HF, collateral axis) is unchanged and
  stays offline; this spec's live `debtGrowthHeadroomBps` (HF−1) is the debt-axis live counterpart. Deliberately
  distinct names + axes.
- **`--json` consumers:** new `liquidation` object is additive under `data`. No renames.

## 9. Acceptance criteria (tests when built)

1. **Worked example (§2 anchor):** `HF ≈ 1.29`, `debtGrowthHeadroomBps === 2900`, `liquidationPriceDiemPerWstDiem ≈
   0.81395e18`; the collateral-axis identity `(HF−1)/HF == price-drop margin` holds **within a float tolerance**.
2. **CRITICAL fires + exits 30 (gap-closing):** live HF `1.30` (< 1.40) with a real position →
   `position_health_factor` CRITICAL → `monitor` exit **30**.
3. **WARN fires + exits 10:** HF `1.50` → WARN → exit **10**, not 30.
4. **Healthy resting position does NOT alarm:** HF `1.72` (≈2x at LLTV 0.86, the tool's `minPostLoopHealthFactor`
   operating point) with a position, no other alert → no `position_health_factor` alert → exit **0**. (The §3.1
   calibration guard — the "obvious" steady-state test.)
5. **Debt-free → null, no alert:** `borrowShares 0` → `liquidation` null, no alert, tick not forced indeterminate.
6. **Fault → CRITICAL 30, not masked (M1) — BOTH fault variants, each with a co-fired CRITICAL:**
   6a. `oraclePrice1e36 === 0` (collateral > 0, borrow > 0) → `position_liquidation_fault` CRITICAL → exit **30**;
       with a co-fired independent `curve_liquidity_empty` CRITICAL also present, still **30** (not 20).
   6b. `lltvWad === 0` (the division-by-zero variant) → `position_liquidation_fault` CRITICAL → exit **30**; with a
       co-fired `curve_liquidity_empty` CRITICAL, still **30** — proving the price formula was NOT computed on the
       fault branch (else it throws → `rpc-read` fail → 20, masking the co-fired CRITICAL). This is the AC that locks
       the exception-path regression closed.
7. **Throwing read → 20:** `oracle.price()` throws → `rpc-read` fail → `isMonitorAssessed` false → exit **20 /
   indeterminate** (SPEC004 path, unchanged).
8. **Underwater/bad-debt → CRITICAL 30 (M3):** `collateral === 0 && borrowShares > 0` → `position_liquidation_fault`
   CRITICAL → exit **30**, NOT the `owner_position_missing` WARN(10), and no division-by-zero.
9. **`--json` parity + serialization:** `monitor --json` `data.liquidation` carries all fields; bigint prices are
   **strings**; `data.exitCode === $?`.
10. **`status` honesty:** `status`/`watch` render `HF n/a (run monitor)`, never `Infinity`; **no** `idToMarketParams`/
    `oracle` call on that path.
11. **`loop readiness` untouched:** `loop readiness --strict-evidence` on a position that would trip the new readout
    still passes (no `liquidation-readout` check added to its `checks`); no oracle/lltv read issued on that path.
12. **Block-pinning:** the `idToMarketParams`/`oracle` reads use the same `blockNumber` as the position/market reads.

## 10. Open questions

- **[OQ-A — RESOLVED]** No fold into `isMonitorAssessed`. Faults are CRITICAL alerts (reach 30, no masking); throwing
  reads stay `rpc-read`→20. (§4.)
- **[OQ-B — RESOLVED v1: gated]** `liquidationPriceDiemPerWstDiem` is shown in the detailed/`--json` view only, not
  the headline row, with the §6 fault caveat.
- **[OQ-C — RESOLVED]** Oracle source = the market's own `idToMarketParams.oracle` (what Morpho liquidates against);
  NAV deviation stays a separate preflight concern.
- **[OQ-D — deferred]** Time/debt-to-liquidation runway ("~N days at current borrow APR, static NAV"). Actionable but
  needs an accrual-rate estimate net of vault yield (memory: estimable after 2+ compound cycles); deferred to a
  follow-up so this unit doesn't ship a half-honest runway number.

## 11. Traceability

Each §9 criterion maps to a test (`test/liquidation-readout.test.ts` for the math/alerts; monitor compiled-CLI for
exit codes and `--json`). SPEC001 OQ#9 gains a cross-reference to this spec on lock. Roadmap Phase 6.
