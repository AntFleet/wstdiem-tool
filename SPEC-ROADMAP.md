# wstdiem-loop-manager — Spec-First Roadmap

**Status:** active · **Opened:** 2026-07-11 · **Repo:** `AntFleet/wstdiem-tool`

This roadmap re-establishes a **spec → implementation → verification** discipline for the
operator CLI. It is grounded in a read-only build audit (2026-07-11) of the as-built tree.

## Context (why a refresh, not a rewrite)

The tool is healthy underneath: `typecheck` / `lint` / `build` are clean and **124/125 tests
pass** (the one failure is a non-hermetic `.env` artifact in a local checkout, not a defect).
Broadcast is fail-closed at two independent layers.

The problem is **spec drift**, not code quality. Exactly one document governs the CLI today —
`SPEC001.md` — and it has drifted both ways:

- **Built but unspecified:** `loop sizing` (the entire offline economic engine + adaptive-curve
  borrow model — absent from SPEC001), `loop simulate --live`, the `monitor` command, RPC
  failover logic, the SQLite `alert_state` table.
- **Specified but never built:** persistent `watch` daemon/TUI, `loop history --since`,
  `alerts test --channels`, WebSocket `eth_subscribe` listeners.
- **Protocol-era leftovers** carried over from the pre-split monorepo (SPEC005, PHASE-*,
  INTERFACE-APPENDIX-A, THREAT-MODEL, BUNDLER3-SPIKE, STEP-*, `contracts/`, `foundry.toml`)
  describe the on-chain protocol that now lives in `AntFleet/wstdiem`, not this CLI.

So this is a **spec refresh + retro-spec**, with a clean-up pass to make "the specs" unambiguous.

## Locked decisions (2026-07-11)

| # | Decision | Resolution | Spec impact |
|---|---|---|---|
| D1 | Executor scope (open/rebalance are dead-gated; executor is exit-only) | **Exit-only is current.** open/rebalance move to a "Deferred — conditional on a multi-action executor" appendix; code kept but marked non-current. | SPEC001 rev-2 §5 becomes exit-only; multi-action → appendix |
| D2 | Persistent `watch` daemon/TUI (specified, never built) | **Drop from current spec.** Standardize on `watch --once` + external scheduler (cron/systemd). Daemon retained only as a deferred note. | SPEC001 rev-2 §4 rewritten around `--once` |
| D3 | Broadcast enablement (hard-disabled, gated on executor audit) | **Keep fail-closed.** Document the closed gate only; author the enablement spec as a future SPEC once the executor audit clears. | SPEC001 rev-2 documents the gate; enablement deferred |

## Spec inventory

**Governs the tool (keep, maintain):**
- `SPEC001.md` — canonical CLI technical spec → **needs rev-2** (Phase 1).
- `docs/deployment/*.md` — current, code-synced operational runbooks (audit-gate, live-readiness,
  loop-executor, loop-sizing). Keep; fold their normative bits into the specs.
- `README.md` — accurate one-paragraph purpose. Keep.

**Protocol-era leftovers (Phase 0 — remove after verifying mirrored in `AntFleet/wstdiem`):**
`SPEC005.md`, `PHASE-A-INTERFACE-SHAPES.md`, `INTERFACE-APPENDIX-A.md`, `BUNDLER3-SPIKE.md`,
`PHASE-B-GUIDANCE.md`, `PHASE-B-PR5-LOCKS.md`, `THREAT-MODEL.md`, `contracts/`, `foundry.toml`
(+ any Foundry config / `test/foundry`). These are Solidity-side and duplicated in the protocol repo.

**Product/process artifacts (Phase 0 — separate disposition, do NOT auto-delete):**
`SPEC002.md`–`SPEC004.md` (product / token / points specs), `DESIGN.md` + `docs/design/*`
(Phase-D web-app design), `PHASE-B-PR{1,2}-PROMPT.md`, `STEP-*.md`, `docs/research/*`, `audit/*`.
Decide per-file: archive vs relocate vs keep-as-reference.

## Phase 0 — Baseline / declutter (prereq)

Goal: make "the specs" mean the tool's specs, nothing else.

1. For each protocol-era leftover, **verify it exists in `AntFleet/wstdiem`** before removing it
   here (verify-before-delete; do not trust the "mirrored" claim blindly).
2. Remove the verified leftovers + `contracts/` + Foundry config from the tool repo.
3. Triage the product/process artifacts (archive vs keep) — a separate, non-destructive pass.
4. Commit as a clearly-scoped hygiene change.

**Deliverable:** a docs surface where `SPEC001.md` + `docs/` are visibly the only governing specs.

## Phase 1 — SPEC001 rev-2 (reconcile with as-built)

Goal: make SPEC001 **true** to the current CLI; mark intended-but-unbuilt explicitly.

1. Clause-by-clause reconciliation table: each SPEC001 clause tagged
   *built-as-spec / built-differently / spec-not-built / built-not-spec*.
2. Fold in currently-undocumented surfaces: `monitor`, `loop simulate --live`, the `alert_state`
   table, and the real RPC failover/health-check semantics (§9 detail).
3. Apply decisions: §5 → exit-only (D1); §4 → `--once` + scheduler (D2); document the broadcast
   gate as closed (D3).
4. Remove the never-built specified items (persistent daemon, `--since`, `--channels`) or mark
   them "deferred" per D2.

**Deliverable:** `SPEC001.md` rev-2 + a reconciliation appendix (the drift ledger).

## Phase 2 — SPEC002 (Loop Sizing Engine) — retro-spec

> Numbering freed once the old product SPEC002–004 are relocated in Phase 0.

Goal: spec the largest, most financially-sensitive unspecified surface.

Contents: input/grid semantics; the full gate model (curve depth, Morpho supply, entry/exit
slippage, health factor, net-APY, unwind coverage); flat vs adaptive-curve borrow models (with
the Morpho AdaptiveCurveIrm fidelity claims); the blocker taxonomy; the JSON output contract; and
an explicit **assumptions & limitations** section (linear slippage, instantaneous rate, no
rate-at-target drift). This spec becomes the contract that the planned `loop sizing --from-chain`
live-seed — and any future model change — must conform to.

**Deliverable:** `SPEC002.md` (Loop Sizing Engine) + tests traced to its clauses.

## Phase 3 — Forward specs (spec-first from here on)

- **First application of the discipline:** spec the `loop sizing --from-chain` live-seed *before*
  implementing it (seed `rateAtTarget`, Morpho supply/borrow, curve depth, and empirical vault
  APY from the readers that already exist).
- **Standing rule:** every new surface gets a spec section first → executor implements → verifier
  gate → merge. Every spec clause traces to at least one test.

## Traceability & verification

- Maintain a lightweight **spec-clause ↔ test** map (a table appended to each spec).
- Run a scaled-down audit-cycle gate on each spec change before it's treated as locked.
