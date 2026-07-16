# SPEC010-B — Base-holder dashboard clean-screenshot polish (`monitor` header / Checks / copy)

**Status: PARKED — not blocking. Do after `SPEC010.md` (core) ships. Needs its own two-agent gate before code.**
Author: 2026-07-16.

> **Why parked:** the sole justification for this layer is a clean Post-2 base-holder `monitor` screenshot — and the
> CLI strip already provides that (Post 1 shipped it). The safety-critical exit-code/owner-readout fix is in
> `SPEC010.md`; this is presentation polish. Splitting it out stopped a 4th/5th gate cycle from grinding on cosmetics
> while the core waited. Pick this up only when there's appetite to make the full `monitor` dashboard screenshot-clean
> for an unlevered holder.

## Depends on
`SPEC010.md` (core) — LOCKED + shipped. B builds on the tri-state `leverage` signal, the additive `--json` fields, and
the corrected exit-code model that A introduces. Do not start B until A is merged.

## Goal
For an **affirmatively unlevered** holder (`leverage === "unlevered"`), the *entire* `monitor` dashboard reads as a
calm, safe, honest position — not just the exit code (A already fixes that). Today three surfaces still headline
"broken/blocked" independent of A: the `Overall` row, the `Checks` row, and the leveraged-exit alerts' CRITICAL-toned
copy.

## Requirements (each carries a gate finding from the rev-3 cycle)

**B1 — Two-axis header (`Major-1`, `Major-2`).** Replace `Overall: ${status}` (`output.ts:100`) — for `monitor` only —
with two lines: `Position: <token>` and `Exit-readiness: <token>`.
- `renderLoopReadinessTable` (`output.ts:93`) is **shared** with the `loop readiness` command (`index.ts:490`). **Fork
  or parametrize** it (`mode: "monitor" | "readiness"`) so `loop readiness` keeps its current `Overall` **header row**
  unchanged. Scope of the fork is the **header only** — the **owner row** (`output.ts:134`) was already changed by the
  core (SPEC010.md §4.E) and intentionally applies to both commands; B1 does not touch the owner row. The two-axis
  header is **monitor-only**; the "byte-unchanged for `loop readiness`" guarantee (AC-2) is scoped to the header row +
  exit code + additive JSON, never the owner row.

**B2 — `Position` token honesty (`§6 contradiction`).** No bare `Position: safe` (implies protection). Use e.g.
`Position: unlevered — no liquidation risk (tool provides no protection)`; `Position: danger` only for a SPEC005
fault; `Position: unknown — owner position unreadable` for the blind case (must read as "can't confirm", not "safe").

**B3 — `Exit-readiness` honest attribution (strongest honesty finding).** Do **not** label the gap as only "by
design" — that hides that **no audited LoopExecutor is deployed**. Use e.g.
`Exit-readiness: not enabled (no audited executor deployed; broadcast disabled by design)`. The `ready` token is
currently unreachable (broadcast permanently disabled) — either drop it or mark it explicit forward-scaffolding.

**B4 — `Checks` row reframe (analyst goal-blocker).** The `Checks` row (`output.ts:153`) still renders bare
`executor-config:fail; curve:…fail` for an unlevered holder — it headlines "broken" on the exact screenshot. Under
`leverage === "unlevered"`, render leveraged-exit checks as context (`n/a-for-unlevered` / `context`), not bare `fail`.

**B5 — Blocker recategorization, ADDITIVE-ONLY (`Major-3`).** Partition blockers into {position-safety,
leveraged-exit (context), by-design} for **rendering only**. **Keep `blockers: string[]` and every string byte-stable**
— especially `AUDIT_GATE_BLOCKER = "broadcast disabled pending production executor audit/review"` (`readiness.ts:754`,
`:281`), which `assertStrictLoopReadinessEvidence` (`index.ts:92-124`) compares by exact equality. Carry categorization
as **separate metadata**; do not mutate the array shape or strings (would break the keeper strict-evidence contract +
the `--json` blockers field).

**B6 — Neutral copy for all six downgraded alerts (analyst).** Enumerate the neutral `message`/`suggestedAction` for
each alert downgraded to unlevered-context WARN — `curve_liquidity_empty`, `morpho_liquidity_empty`, `executor_no_code`,
`executor_config_mismatch`, `executor_read_reverted`, `executor_not_authorized`. Today they ship CRITICAL-toned strings
(e.g. `executor_config_mismatch` → "Stop deployment gating and investigate flashConfig()…"). Each becomes neutral
pre-launch language (e.g. "not required for an unlevered holder; needed before leveraging"). Do not leave five
customer-facing strings to the implementer to invent. (A only fixed the *severity*; B fixes the *words*.)

**B7 — Screenshot-width check.** Verify the §4.E owner-row NAV caveat and the two-axis header wrap cleanly in
`cli-table3` at a normal terminal width (the caveat is a long parenthetical; `wordWrap:true` may fragment it). Adjust
layout if it fragments.

## Acceptance criteria (when built)
1. **Header:** unlevered safe holder → `Position: unlevered — no liquidation risk (tool provides no protection)` +
   `Exit-readiness: not enabled (no audited executor deployed; broadcast disabled by design)`; **not** `Overall: blocked`.
2. **`loop readiness` header unchanged:** the `loop readiness` command's **header row** (`Overall`) is byte-unchanged
   by B1 (its owner row was already updated by the core, SPEC010.md §4.E).
3. **Checks row:** unlevered path → the `Checks` row does not headline bare `fail` tokens for leveraged-exit checks.
4. **Blockers additive:** `blockers: string[]` strings (incl. `AUDIT_GATE_BLOCKER`) byte-stable; `loop readiness
   --strict-evidence` unaffected; categorization present only as separate metadata.
5. **Per-alert neutral copy:** each of the six downgraded alerts asserts its specific neutral string present and the
   CRITICAL-toned string absent.
6. **`Position` honesty:** the unlevered header contains the no-protection qualifier and never a bare "safe".
7. **Aggregate calm:** the live-state screenshot (`loopExecutor:null` + drained Curve + Morpho) reads calm in
   aggregate, not just per-line.

## Open questions
- **[OQ-F]** Exact `Position: unknown` wording so it can't be misread as safe (proposed in B2; confirm in gate).
- **[B-OQ]** Does the levered owner's mixed-severity screenshot (WARN `executor_read_reverted` next to CRITICAL
  `curve_liquidity_empty`) read coherently, or does the executor row need a distinct visual tier?

## Traceability
- Findings from the SPEC010 rev-3 gate (both agents): Major-1/2/3/4 + the analyst's Checks-row + neutral-copy +
  Position/Exit-readiness honesty items. Surfaces: `output.ts:93/100/153/154`, `index.ts:302/490/92-124`,
  `readiness.ts:754/757/281`, `readinessAlerts.ts` (the six alert copy strings).
- **No code until B passes its own gate and is LOCKED, and A is shipped.**
