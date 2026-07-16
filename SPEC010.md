# SPEC010 (core) — Unlevered owner readout + position-safety exit-code model on `monitor`

**Status: LOCKED (2026-07-16).** Split from rev-3 (both gate agents verified the core C1/M1/M3 as CLOSED / "lock-ready");
confirmation pass returned NEEDS-MINOR-FIX with three named gaps (blind-path `owner_position_missing` null-deref;
shared-renderer ownership of the owner row; `evaluateReadinessAlerts` owner-configured input) — all folded. This is the
SAFETY core; the dashboard clean-screenshot layer is parked in `SPEC010-B.md`. **Ready for implementation.** Author:
2026-07-16.

> **Split rationale:** 3 gate cycles closed the exit-code/leverage core; the remaining REVISE items all lived in the
> rev-3 dashboard reframe (§4.G) — cosmetic polish for a clean Post-2 screenshot, which the CLI strip already provides.
> This spec ships the safety win (`monitor` stops false-CRITICAL-ing *and* false-safe-ing, and reads unlevered
> holders). `SPEC010-B.md` holds the header/Checks/Blockers/neutral-copy work (not blocking).
> **Folded from the rev-3 gate:** M2 (`executor_read_reverted` ⊕ `executor_config_mismatch` exclusion), Major-4
> (blind case fired a false `owner_missing` for a *configured* owner), Medium-1 (blind flag keyed on
> `configured && undeterminable`, not a render token), Medium-3 (nullable owner fields for partial reads), Medium-4
> (byte-unchanged wording), Medium-5 (OQ-G deleted, §4.F wording fixed).

## 1. Problem & scope
`monitor` reports `Owner: unavailable` for an unlevered wstDIEM holder, and — once the underlying read no longer
throws — would fire a **false CRITICAL** on a position with zero liquidation risk. Root causes: (1) `contracts.loopExecutor`
points at the V6 Router (no flash getters → the probe reverts) and is a *required* deployment key; (2) `monitor`
conflates **position safety** with **leveraged-exit readiness** in its CRITICAL/exit-`30` gate.

**In scope (core):**
- **A. Config/deployment:** `loopExecutor` → `null` (examples + `DEFAULT_CONFIG`); make it **optional**.
- **B. Alert severity reclassification** (tri-state leverage): leveraged-exit alerts are CRITICAL only when the owner
  is levered. **Severity only — alert *copy* is unchanged here** (SPEC010-B rewords it).
- **C. Unlevered owner readout:** wallet holding via `convertToAssets(balanceOf)`, labelled a non-executable vault-NAV
  valuation.
- **D. Read robustness:** revert-vs-transport discrimination (empirically specified) → transport still `20`.
- **F. Alert correctness:** `executor_read_reverted` (WARN, mutually exclusive with `executor_config_mismatch`);
  `owner_unreadable` for a configured-but-unreadable owner (fixes the false `owner_missing`).

**Explicitly OUT (→ `SPEC010-B.md`):** the two-axis `Overall` header, the `Checks` row reframe, blocker
recategorization, and neutral alert *copy* rewrites. The dashboard header/Checks/Blockers rows are untouched by this
spec — a base holder's **exit code** is correct here; the **screenshot** polish is B (CLI strip covers Post 2 meanwhile).
Also out: deploying/auditing a real LoopExecutor; enabling broadcast; Track-B; SPEC005 levered-HF (unchanged).

## 2. Root cause & mechanics (verified in code + on-chain, 2026-07-16)
- **Coupling / throw:** one `try` (`readiness.ts:299`) wraps all live reads; the executor `Promise.all`
  (`readiness.ts:491`, incl. `canonicalFlashPool`) rejects on the Router's unknown-selector revert → `try` throws →
  `rpc-read:fail` (`readiness.ts:~741`).
- **Exit-code model:** exit = **alert level + `assessed` gate** (`exitCode.ts`): `!assessed → 20`; else CRITICAL →
  `30`; WARN → `10`; none → `0`. `isMonitorAssessed` false when `rpc-read` failed. Today's live case is `20` (throw);
  stopping the throw makes it `assessed:true`, exposing the CRITICALs.
- **CRITICAL alerts (enumerated, `readinessAlerts.ts`):** `live_rpc_unavailable` (:44, gated by rpc-fail),
  `vault_not_ready` (:68), `curve_liquidity_empty` (:55), `morpho_liquidity_empty` (:88), `executor_no_code` (:116),
  `executor_config_mismatch` (:125), `executor_not_authorized` (:165), SPEC005 `position_*` (require `borrowShares>0`).
  WARN: `executor_missing` (:107), `owner_position_missing` (:150), `owner_missing` (:140, fires on
  `result.owner === undefined`).
- **Owner read is Morpho-only + gated:** owner branch past a Morpho-market precondition (`readiness.ts:635`); reads
  Morpho `position(marketId, owner)` (`:645`); never `vault.balanceOf(owner)`. Owner fields `collateral`/`borrowShares`
  are non-null `bigint` (`readiness.ts:73-74`).
- **Empirical (viem):** `canonicalFlashPool()` on the Router →
  `ContractFunctionExecutionError → ContractFunctionRevertedError → CallExecutionError → ExecutionRevertedError →
  RpcRequestError`. A pure transport failure would be `HttpRequestError`/`TimeoutError`/socket without
  `ExecutionRevertedError`.
- **Config:** Router hardcoded in `defaults.ts:34`, `config.example.yaml:24`, `config.sampling.example.yaml:24`;
  `loopExecutor` required (`load.ts:279`; `nullableAddressSchema` at `:49` permits null); `config.test.ts:33/46`
  assert the Router value + not-missing. Live Morpho DIEM market ~6 DIEM supply (so `morpho_liquidity_empty` latent).

## 3. Design principle
**Gate CRITICAL/exit-`30` on position safety only, and never resolve "safe" from a position the tool cannot read.**
- **Position safety:** a *levered* owner near/at liquidation → CRITICAL (SPEC005, unchanged); an *affirmatively
  unlevered* owner → zero liquidation risk → never CRITICAL on this axis.
- **Leveraged-exit readiness** (Curve/Morpho depth, executor config/auth, exit-position): infra to unwind a levered
  position. Relevant only when levered.
- **Tri-state leverage:** `levered` (owner read OK, `borrowShares > 0`) / `unlevered` (owner read OK,
  `borrowShares === 0`) / **`unknown`** (no owner configured, OR owner/Morpho read failed/absent). Downgrade the
  leveraged-exit alerts **only** for `unlevered`. `unknown` → **no downgrade**.
- **Blind ⇒ `indeterminate(20)`:** when an owner **is configured** but its leverage is undeterminable (Morpho position
  read failed via revert/shape/`marketId:null`), the position-safety axis is **unassessed** → `20`, regardless of the
  leveraged-exit alerts. Never `10` while the owner's risk is unconfirmed. **This flag keys on
  `owner-configured && leverage-undeterminable`, independent of any render token** (Medium-1).

## 4. Required behavior
**4.A Config / deployment.** `contracts.loopExecutor: null` in both example YAMLs + `DEFAULT_CONFIG`; remove
`loopExecutor` from the required set (`load.ts:279`) so a null value does not fail the deployment-config check
(optional, per SPEC009's `venueAdapters`/`usdc` precedent). Update `config.test.ts:33/46` + the ~10
executor-referencing tests (inject an executor only where the executor path is genuinely exercised). Null
`loopExecutor` ⇒ `executor-config` check `fail` ⇒ `executor_missing` WARN; owner-authorization read skipped
(`readiness.ts:717`) ⇒ no `executor_not_authorized`.

**4.B Severity reclassification (tri-state).** When `leverage === "unlevered"`, emit these at **WARN** (never CRITICAL):
`curve_liquidity_empty`, `morpho_liquidity_empty`, `executor_no_code`, `executor_config_mismatch`,
`executor_read_reverted` (already WARN in all states per §4.F — listed for completeness, not a downgrade),
`executor_not_authorized`; and **suppress** `owner_position_missing`. When `"levered"` or
`"unknown"`, all keep current severity. SPEC005 `position_*` unaffected always. **Alert message/suggestedAction text is
unchanged in this spec** (the CRITICAL-toned copy on a now-WARN row is reworded in SPEC010-B; the *severity* — hence the
exit code — is correct here).

**4.C Unlevered owner readout.** Read `vault.balanceOf(owner)` at the pinned `blockNumber`, **independent of
Morpho-market availability**. `walletValueDiem = vault.convertToAssets(walletWstDiem)` (single-rounding, same block).
Add `walletWstDiem`, `walletValueDiem` (bigint).

**4.D Read robustness (discriminator, empirically specified).** Own try/catch around the executor probe and each owner
read (`balanceOf`, Morpho `position`, `isAuthorized`). Classify a caught error:
- **Contract revert** (degrade that line, continue): the error or any `cause` in its chain is
  `ContractFunctionRevertedError` **or** `ExecutionRevertedError` (covers the live no-data unknown-selector revert).
- **Transport / unclassifiable** (re-raise → outer catch → `rpc-read:fail` → `20`, **fail-closed default**):
  `HttpRequestError`, `TimeoutError`, socket, or any error not matching the revert markers. Not by message substring.
  The executor `Promise.all` (5 same-contract reads): a revert-marked rejection degrades the whole executor row; a
  transport rejection re-raises.

**4.E Owner row presentation (`output.ts:134` only — not the header/Checks/Blockers).**
> **Shared-renderer note (Major #2):** `output.ts:134` is inside `renderLoopReadinessTable` (`output.ts:93`), which
> is shared by `monitor` **and** `loop readiness` (`index.ts:490`). This owner-row change therefore applies to **both**
> commands — an accepted improvement (an unlevered wallet holding is correct to show on `loop readiness` too). No
> `mode` fork is needed for the owner row; SPEC010-B's `mode` fork (B1) is scoped to the **header** only. (No existing
> test asserts the rendered owner-row string; `loop readiness --json` keeps existing fields unchanged + additive.)
- **Levered** (`borrowShares > 0`): existing collateral/debt/HF readout **byte-unchanged**, plus a distinct
  `in-wallet: X wstDIEM` line.
- **Unlevered** (`borrowShares === 0`, `walletWstDiem > 0`): `holding X wstDIEM (vault NAV ≈ Y DIEM — accounting value;
  redemption not currently executable, Curve drained; not a market/exit quote); no debt; HF n/a (unlevered)`.
- **No position** (`walletWstDiem === 0`, no Morpho position, reads OK): `no position` — not `unavailable`.
- **Per-read failure:** that line `n/a`. Whole-row `unavailable` only when *all* owner reads fail — and per §3 that is
  `leverage: unknown` with a configured owner ⇒ `indeterminate(20)` (so `unavailable` never coexists with exit `10`).
- NAV unavailable (vault no-code) ⇒ wallet line `n/a`, never `≈ 0 DIEM`.
- **Owner result-type nullability (Medium-3):** to keep `result.owner` defined while the Morpho position is unreadable
  (partial read), `collateral`/`borrowShares`/`borrowedDiem`/`hasExitPosition` become **nullable**; a null
  `borrowShares` ⇒ `leverage: unknown` ⇒ blind ⇒ `20`.

**4.F Alert correctness.**
- **`executor_read_reverted`:** in the §4.D revert path set `executor = {hasCode, verified:false, readReverted:true,
  reason}` and push `executor-config` = `fail`. Add `executor_read_reverted` (WARN) carrying `reason` (e.g.
  `"configured address is not a LoopExecutor (flash getters absent)"`). It **pre-empts** `executor_config_mismatch`:
  insert an `else if (readReverted)` **before** the `!verified` branch (`readinessAlerts.ts:122`) so the two never
  both fire. WARN in all leverage states (config-identity problem, distinct from a real executor's CRITICAL
  `executor_config_mismatch`).
- **`owner_unreadable` (Major-4):** guard `owner_missing` on the **config** (`config.position.owner === null && no
  --owner`), NOT on `result.owner === undefined`. When an owner **is configured** but unreadable, emit a distinct
  `owner_unreadable` WARN ("owner position could not be read") — never the false "Owner is not configured" copy. It
  fires in **both** unreadable shapes: `result.owner === undefined` (all owner reads failed) **and** `result.owner`
  defined with `borrowShares === null` (partial read). (This pairs with the blind ⇒ `20` from §3; the alert is WARN,
  the exit code is driven to `20` by the blind flag.)
  - **`evaluateReadinessAlerts` input (Major-4 gap):** the evaluator (`readinessAlerts.ts:35`) currently receives no
    config, so it cannot distinguish "no owner configured" from "configured but unreadable" (both are
    `leverage: unknown`). It **must gain an `ownerConfigured`/blind input** (the blind flag already computed for
    `exitCode.ts` is the natural carrier) to route `owner_missing` vs `owner_unreadable`.
  - **`owner_position_missing` on the blind path (Major #1 — avoids a null-deref):** when `borrowShares === null`
    (blind/partial read), emit **only** `owner_unreadable`; do **not** evaluate `owner_position_missing`
    (`readinessAlerts.ts:147`), whose metrics `.toString()` the now-nullable `collateralWstDiem`/`borrowedDiem` and
    would throw. (`executor_not_authorized` at `:162` is already safe — it checks `=== false`, and the field is `null`.)

## 5. Exit-code model — corrected & complete
- **Unlevered + healthy vault + null/wrong executor + drained Curve + (empty or funded) Morpho:** all leveraged-exit
  CRITICALs downgraded (§4.B) → worst alert WARN → **exit `10`**. Never `30`/`0`.
- **Owner configured but leverage undeterminable** (Morpho revert/shape/`marketId:null`): position-safety unassessed →
  **`20`** (blind, §3). Never `10`.
- **Transport failure** (§4.D): `rpc-read:fail` → **`20`**.
- **Levered** owner, drained Curve/unverified executor → **`30`**; SPEC005 fault → **`30`**. Unchanged.
- **No owner configured (`unknown`):** no downgrade → current behavior (`curve_liquidity_empty` CRITICAL → `30`),
  keeper not lulled.
- **Unlevered + *unhealthy* vault:** `vault_not_ready` stays CRITICAL → `30` (fail-toward-alarm; not downgraded).

## 6. Fail-closed & honesty
- `balanceOf`/`convertToAssets` revert → wallet line `n/a` (no crash, no fabrication).
- Unlevered = no debt ⇒ HF/liquidation `n/a`; "no debt", never a synthetic "safe" implying protection (A3). (The
  header **`Position:` token wording** is SPEC010-B's concern; this spec's owner *row* already says "no debt / HF n/a".)
- Wallet value is a **vault-NAV accounting valuation, non-executable** (Curve drained; embeds accrued yield) — caveat in
  the rendered row (§4.E). Never a realizable-proceeds/yield claim.
- **Blind ⇒ 20, never 10** — never report "safe" for a position it couldn't read.
- Downgraded leveraged-exit alerts still **render** (WARN) — attribution, not silence.
- **Framing:** wrong-address config + no deployed executor are normal pre-launch — neutral; never imply the protocol is
  broken. (Copy rewording that fully delivers this is in SPEC010-B; severity here is already honest.)

## 7. Integration points
- `src/config/defaults.ts:34`, `config.example.yaml:24`, `config.sampling.example.yaml:24`: `loopExecutor: null`.
- `src/config/load.ts:279`: drop `loopExecutor` from `required`.
- `src/loop/readiness.ts`: tri-state `leverage`; own try/catch (revert-vs-transport, §4.D) around executor + each owner
  read; `balanceOf` decoupled from the Morpho gate; nullable owner fields (§4.E); result-type additions
  (`walletWstDiem`, `walletValueDiem`, `executor.readReverted`, `executor.reason`, `leverage`); the
  `configured && undeterminable` blind flag feeding classification. **Does NOT touch `:754` blockers / `:757` status.**
- `src/monitor/readinessAlerts.ts`: thread `leverage` **and an `ownerConfigured`/blind input** (§4.F Major-4 gap);
  §4.B **severity** reclassification; `executor_read_reverted` (mutually exclusive, §4.F); `owner_unreadable` + guard
  `owner_missing` on config (§4.F); skip `owner_position_missing` when `borrowShares === null` (§4.F Major #1).
  **Message text unchanged.**
- `src/cli/exitCode.ts`: honor the blind flag for a configured-but-unreadable owner.
- `src/cli/output.ts:134` (Owner row **only**): the three owner states + wallet line + NAV caveat + executor `reason`
  in the executor cell. **Does NOT touch `:100` Overall / `:153` Checks / `:154` Blockers (→ SPEC010-B).**
- Tests: `config.test.ts:33/46` + the ~10 executor tests.
- `--json`: **additive** fields (`walletWstDiem`/`walletValueDiem`, executor `readReverted`/`reason`, `leverage`);
  existing fields unchanged; `monitor` without `--owner` + non-reverting executor: existing fields unchanged, new
  fields additive (Medium-4 wording).

## 8. Acceptance criteria (tests, when built)
1. **Unlevered → 10:** unlevered owner + healthy vault + `loopExecutor:null` + drained Curve → exit `10`. Variant with
   the **Router** address → also `10`, and `executor_read_reverted` WARN with its reason renders.
2. **Empty Morpho:** unlevered owner + `morpho.totalSupplyAssets == 0` → exit `10`.
3. **Blind ⇒ 20 (C1 danger):** owner **configured** but Morpho `position` reverts / `marketId:null` / shape-mismatch →
   exit `20`, not `10`; leveraged-exit alerts not downgraded; `owner_unreadable` WARN (not the "not configured" copy).
4. **Transport vs revert:** viem transport error → `rpc-read:fail` → `20`; a no-data contract revert
   (`ExecutionRevertedError` in chain) → degrades that line only, read continues.
5. **Levered unchanged:** levered owner + drained Curve/unverified executor → `30`; SPEC005 fault → `30`; skipped auth
   read on `loopExecutor:null` doesn't mask a fault.
6. **`readReverted` ⊕ `config_mismatch`:** the reverted-executor path fires `executor_read_reverted` and **not**
   `executor_config_mismatch` (no double-emit).
7. **Unlevered wallet readout:** `balanceOf=X`, empty Morpho → `walletWstDiem X`, `walletValueDiem = convertToAssets(X)`,
   "no debt", HF `n/a`, state holding — not `unavailable`; rendered row contains the "redemption not currently
   executable" caveat.
8. **Independent degradation + Morpho-decouple:** `balanceOf>0` + Morpho `position` reverts → wallet line shown,
   position `n/a`, row not `unavailable` (exit `20` per #3). Wallet-only holder on `marketId:null` → wallet line renders.
9. **No-owner preserved:** `monitor` without `--owner` + drained Curve → current behavior (`curve_liquidity_empty`
   CRITICAL → `30`).
10. **Config/deployment:** `loopExecutor:null` parses; deployment-config passes; `missingDeploymentKeys` excludes
    `loopExecutor`.
11. **NAV-unavailable:** vault no-code → wallet line `n/a`, never `≈ 0 DIEM`.
12. **`--json`:** new fields additive; existing fields unchanged for `monitor` without `--owner` + non-reverting executor.

## 9. Open questions
- **[OQ-G — resolved]** `executor_read_reverted` = WARN in all leverage states (config-identity, not a live danger).
- (Position/Exit-readiness header token wording, Checks-row reframe, neutral copy → `SPEC010-B.md`.)

## 10. Traceability & dependencies
- Root cause: `readiness.ts:299/491/635/645/717`; alerts `readinessAlerts.ts:44/55/68/88/107/116/122/125/137/150/165`;
  exit `exitCode.ts`; owner row `output.ts:134`; config `defaults.ts:34`, `load.ts:279/49`, `config.test.ts:33/46`.
- Empirical: viem revert chain (probe 2026-07-16); live Morpho ~6 DIEM (M1 latent).
- Diagnostic: `DIAGNOSTIC-canonicalflashpool-revert.md` (H1 wrong-address; no LoopExecutor deployed).
- Relates to: SPEC004 (exit ladder), SPEC005 (levered HF — unchanged), SPEC009 (optional-key precedent).
- **Follow-up:** `SPEC010-B.md` (dashboard clean-screenshot: two-axis header, Checks reframe, blocker
  recategorization, neutral copy) — depends on this core; not blocking.
- Gate history: rev-1/rev-2/rev-3 REVISE; core (C1/M1/M3) verified CLOSED at rev-3; this spec = the closed core +
  folded core-adjacent fixes (M2, Major-4, Medium-1/3/4/5).
- **No code until a confirmation pass clears and this is LOCKED.**
