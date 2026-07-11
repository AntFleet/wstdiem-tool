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

**Load-bearing — stays in place (audit misclassified as "leftover"):**
`contracts/LoopExecutor.sol` (the v1 **exit-only executor the CLI operates**),
`script/DeployLoopExecutor.s.sol`, `test/foundry/*`, `foundry.toml` — wired into
`proof:full-unwind`, `test:contracts{,:fork}`, `deploy:executor:dry-run`, `readiness:owner`.
Removing them would break the CLI's proof/readiness/deploy pipeline.

**Pre-split internal docs — purged from public history (see below):**
`SPEC002–005`, `PHASE-A-INTERFACE-SHAPES`, `PHASE-B-{GUIDANCE,PR1-PROMPT,PR2-PROMPT,PR5-LOCKS}`,
`STEP-{5,5B,7}-*`, `INTERFACE-APPENDIX-A`, `BUNDLER3-SPIKE`, `DESIGN`, `THREAT-MODEL`, plus
`audit/`, `docs/design/`, `docs/research/`, `prototypes/`.

## Phase 0 — Baseline / declutter — DONE (2026-07-11)

Goal: make "the specs" mean the tool's specs, nothing else.

**Verification overturned the original "delete because mirrored" premise, then surfaced an
exposure.** Blob-SHA comparison against `AntFleet/wstdiem` found **0 of 24 candidates
content-mirrored and 23 of 24 absent by any name** — the protocol repo carries the *finished*
outputs (`PROTOCOL.md`, `docs/{user,keeper,integrator}/`, `contracts/v2/`) but **none of the
pre-split dev trail**. Two audit misclassifications were corrected: `contracts/`+foundry are
load-bearing (kept); `THREAT-MODEL.md` (1165 lines) is unique security content the protocol repo
lacks. Critically, **both repos are PUBLIC**, and the pre-split internal dev trail (threat model,
audit reports, protocol specs) had been newly pushed to public `wstdiem-tool` earlier this
session — which violates the documented policy that this material stays out of public repos.

Actions taken:
1. **Verified** every candidate against the protocol repo (nothing was mirrored; nothing safe to
   simply delete-as-duplicate).
2. **Kept** `contracts/`, `script/`, `test/foundry/`, `foundry.toml` in place (load-bearing).
3. **Preserved** the internal docs privately at `~/wstdiem-internal-docs/` (off-repo).
4. **Purged** the internal dev trail (44 paths) from **all** `wstdiem-tool` history via
   `git filter-repo` + force-push (`2f180c8` → `54e3176`); verified 0/44 paths remain and the
   tool code/spec/deployment docs are intact.
5. **Aborted** the migration into `AntFleet/wstdiem` — that repo is public and its policy
   excludes this internal material; the pushed branch was deleted before any PR.

**Caveat:** the material was public for part of this session; a history purge reduces but does not
guarantee full un-exposure (GitHub may retain cached/forked copies). Treat the threat model as
having been briefly public.

**Result:** `wstdiem-tool` now contains only the tool (code, `SPEC001.md`, `SPEC-ROADMAP.md`,
`README.md`, `docs/deployment/`, contracts + foundry). Root governing docs: `README.md`,
`SPEC001.md`, `SPEC-ROADMAP.md`.

## Phase 1 — SPEC001 rev-2 (reconcile with as-built) — DONE (2026-07-11)

Goal: make SPEC001 **true** to the current CLI; mark intended-but-unbuilt explicitly.

Delivered:
1. **Drift ledger** — clause-by-clause reconciliation at
   [`docs/spec/SPEC001-reconciliation.md`](docs/spec/SPEC001-reconciliation.md); tags every section
   built-as-spec / built-differently / spec-not-built / built-not-spec with file:line evidence.
2. **`SPEC001.md` rev-2** — retitled offline-first / exit-only / broadcast-disabled; folded in the
   built-but-unspecified `monitor` and `loop sizing` (→ SPEC002) commands, the `alert_state` table,
   and the `flashLoan` config block; rebuilt the §8 CLI table; dropped `ink`/`react`/`telegraf`/
   ledger from §10; and collected the unbuilt future (open/rebalance, broadcast enablement,
   auto-deleverager, daemon/TUI, hardware wallet) into **Appendix A (Deferred)**. 1051 → 610 lines.
3. Decisions applied: D1 exit-only current; D2 `watch --once` + scheduler; D3 broadcast fail-closed.

**Review gate — PASSED (2026-07-11).** Two-agent review (adversarial technical + product-design).
All Critical/Major technical findings were verified against code and corrected in rev-2 (§1 ABI
over-listing, §9 fictional backoff, §6/§7 schema/config values, §3/§5/§10 details) — see the
post-review corrections table in the reconciliation doc. Product decision applied: **monitor-and-
rehearse only** — no supported in-tool execution while broadcast is fail-closed (Open Question #6
resolved); remaining product gaps captured as Open Questions #7–9. **rev-2 is locked.**

**Next:** Phase 2 — SPEC002 (Loop Sizing Engine), which rev-2 now formally forward-references.

## Phase 2 — SPEC002 (Loop Sizing Engine) — DONE + LOCKED (2026-07-11)

> Numbering freed once the old product SPEC002–004 were purged in Phase 0.

`SPEC002.md` authored against verified code + the three test files (which pin exact acceptance
values: blocker order, `requiredCurveDepth`/`requiredMorphoSupply`, `healthFactorBps=25800`, the IRM
0.25×/1×/4× pins and 217-bps on-chain reproduction, JSON wei-string serialization). Supersedes the
non-normative `docs/deployment/loop-sizing.md`.

**Review gate passed.** Two-agent review (adversarial technical + product), applied from the start:
- **Technical: ACCEPT-WITH-RESERVATIONS** — 0 Critical, 0 Major, 1 Medium, 5 Low (vs Phase 1's 2
  Critical + 4 Major), validating the author-against-verified-code approach. Fixed all: §7.3
  non-finite→`"Infinity"` string serialization; §4 `postDrawUtilization` operand + `borrowAprAtFull…`
  name + slippage edge-order; §5 the two throw-not-blocked `scenario_invalid` conditions; §1 gate
  enumeration.
- **Product: honesty corrections applied** — §8 reframed so the headline limitation is *single-scalar
  `curveDepthDiem` + pool imbalance* (not textbook convexity), with the denomination defined (§2);
  added the missing caveats (`vaultApyBps` is a leverage-amplified guess; HF is an entry-time
  structural check, not liquidation distance; single-block no-price-path; gas+MEV excluded); §5 now
  states the exit-slippage sub-gate — not `unwind_not_covered` — is the primary safety constraint
  under defaults; §10 flags the `--from-chain` idle-regime inversion as ill-conditioned.
- Code-change recommendations (shortfall outputs, `--gas-cost-diem`, liquidation-distance,
  stressed-rate netAPY, `viable`→`candidate` rename) captured in SPEC002 §11 as future work, not
  spec'd as current.

Goal: spec the largest, most financially-sensitive unspecified surface.

Contents: input/grid semantics; the full gate model (curve depth, Morpho supply, entry/exit
slippage, health factor, net-APY, unwind coverage); flat vs adaptive-curve borrow models (with
the Morpho AdaptiveCurveIrm fidelity claims); the blocker taxonomy; the JSON output contract; and
an explicit **assumptions & limitations** section (linear slippage, instantaneous rate, no
rate-at-target drift). This spec becomes the contract that the planned `loop sizing --from-chain`
live-seed — and any future model change — must conform to.

**Deliverable:** `SPEC002.md` (Loop Sizing Engine) + tests traced to its clauses.

## Phase 3 — Forward specs (spec-first from here on) — IN PROGRESS (2026-07-11)

- **Standing rule:** every new surface gets a spec section first → executor implements → verifier
  gate → merge. Every spec clause traces to at least one test.
- **First forward spec — `SPEC003.md` (`loop sizing --from-chain`) — REVIEWED + SPLIT + Part A LOCKED.**
  Seeds live Base reads into the sizing engine (SPEC002). **Spec-before-build paid off twice:** (1)
  verified on-chain the AdaptiveCurveIrm exposes `rateAtTarget(marketId)` **directly** (217 bps on
  2026-07-11), retiring the fragile `borrowRateView ÷ curveMultiplier` inversion; (2) the two-agent
  review gate (adversarial + product) — run before any code — caught two numeric defects (a 10,000×
  vault-APY unit bug, a 10× acceptance-criterion error), a `rateAtTarget==0` clamp fail-*open*, an
  overstated-"reuse"/quorum error, and a flat-model provenance gap. **All fixed in the doc before a
  line was written.**
  - **Verdict: REVISE → SPLIT (both reviewers' recommendation).** The 5 seeds split by risk:
    - **Part A (ship-ready, locked):** `rateAtTargetApyBps` (direct read) + `morphoSupplyDiem` /
      `morphoExistingBorrowDiem` — feed the model's wei-precision terms; pure garbage-in removal.
    - **Part B (was gated on SPEC002 rev-2; now un-gated and further split):** `curveDepthDiem` +
      `vaultApyBps` — the softest, verdict-flipping inputs. **B-1** = curve legs + live `get_dy` exit
      slippage (§4.2); **B-2** = `vaultApyBps` 7-day DB window (§4.3).
  - **Central product-safety rule added:** any degraded/unseeded input sets `authoritative:false` and
    **demotes the verdict token itself**, not just a warnings sidecar.
  - **Part A IMPLEMENTED + SHIPPED (7d74aa4)** — the first code of the spec-first pipeline, end-to-end:
    spec → executor (opus) → code-review approval gate → fixes → verify → merge behind green gates.
    `--from-chain` seeds `rateAtTarget` (direct read; live 217 bps) + Morpho supply/borrow, block-pinned
    and fail-closed; `src/loop/fromChainSeed.ts` + 30 tests; offline output byte-for-byte unchanged. The
    review gate (run before code) + approval pass caught the design and every carried-over bug; the
    inversion fallback was consciously cut (direct-read revert fails closed).
  - **Part B-1 IMPLEMENTED + SHIPPED (5f07111)** — now that SPEC002 rev-2 is live, `--from-chain` seeds
    the two curve legs (`balances(0)` / `convertToAssets(balances(1))`) and injects a direction-correct,
    convex **live `get_dy` exit slippage** into the rev-2 `externalExitSlippageBps` seam, per scenario
    (exit sells wstDIEM shares → `convertToShares(positionCollateral)` → the reused
    `quoteCurveExitRoute` + `priceImpactBps` rail), memoized by size, block-pinned. Fail-closed vs
    demote split: a genuine revert / both-legs-zero / codeless curve address fails closed; a merely
    unavailable `get_dy` or a >2:1 imbalance **demotes** (authoritative:false + estimate fallback).
    `positionCollateralForScenario` is now the shared helper so the live quote is sized identically to
    the gate it feeds. Approval pass APPROVE / 0C / 0H; its Medium/Low items closed pre-commit (curve
    has-code parity, slippage in the memo key, a non-identity-NAV mock that catches a convertToShares-skip
    regression, and a flip test proving the leg-aware estimate would block where the live quote clears).
    Offline output byte-for-byte unchanged; from-chain 41 tests.
  - **Part B-2 IMPLEMENTED + SHIPPED (8bfbd14) — SPEC003 Part B COMPLETE.** `--from-chain` seeds
    `vaultApyBps` from the 7-day SQLite window via a `loadVaultApyWindow` adapter (mirrors `status.ts`:
    `collectVaultMetrics` + `listVaultAssetSamplesForWindow`/`listCreditSamplesSince` + current-sample
    append, aggregated by `applyYieldWindowMetrics`). `vaultApyBps = round(baseApy × 10000)` — the
    ×10000 is mandatory (`computeBaseApy` returns a FRACTION); acceptance-10 test pins a measured 5% →
    exactly 500. **Never seed 0, never hard-fail (§4.3):** insufficient/low-density (< `MIN_VAULT_APY_
    WINDOW_SAMPLES` = 4, OQ2 resolved, tunable) → `not-seeded` + authoritative:false + sizing continues
    on the SPEC002 default. Injectable `store` (real `Storage` in the CLI, a fake in tests); no store +
    no explicit flag → byte-identical to B-1. Explicit `--vault-apy-bps` wins (§5) and, being un-measured,
    demotes (§6-literal). `authoritative` composes as the AND of rate/curve + vault + get_dy demotions.
    Approval pass found **1 HIGH** — `collectVaultMetrics` was called unwrapped, so a vault live-read
    revert would abort the whole `--from-chain` command (violating §4.3's continue-on-vault-failure) — plus
    2 MEDIUM paired tests; **all fixed before commit** (two-layer catch: DB-only fallback inner + demote-
    on-any-throw outer; + regression tests). from-chain 50 tests; full suite 194 pass / 1 pre-existing fail.
  - **SPEC003 fully shipped.** OQ1 (staleness) resolved as no-gate; OQ2 (density floor) resolved as
    `MIN_VAULT_APY_WINDOW_SAMPLES = 4`. Follow-up chip filed: an exact-`windowStart`-boundary sample is
    double-counted by `listVaultAssetSamplesForWindow` (pre-existing storage nit, now interacts with the
    density floor).

### Phase 3.5 — SPEC002 rev-2 (prerequisite for SPEC003 Part B) — IMPLEMENTED + SHIPPED (2026-07-11, ee169d6)

Drafted as the `## rev-2` section in `SPEC002.md`. The design resolves the "get_dy is a chain read but
SPEC002 is offline" tension **two-layered**:
- **R1 — leg-aware offline slippage.** Replace the single `curveDepthDiem` scalar with two legs
  (`curveDiemLegDiem` / `curveWstDiemLegDiem`); each trade divides by the leg it draws (exit → DIEM leg,
  entry → wstDIEM leg). Direction-correct + imbalance-aware, fixing §8's headline blind spot **at the
  model layer** — no full StableSwap needed. `--curve-depth-diem` stays as a balanced convenience;
  the intended ~2× slippage increase is the understatement fix, not a regression.
- **R2 — live `get_dy` injection seam.** Optional `externalExitSlippageBps` overrides the R1 estimate;
  SPEC003 Part B fills it from a real `get_dy(1→0)` convex quote. Convexity lives in the real quote,
  not an offline heuristic.
- **R3 — gas in `oneTimeCostDiem`** (`--gas-cost-diem`); MEV stays a caveat, not a number.

Then SPEC003 Part B seeds both legs from `balances` + the exit quote from `get_dy`, and vaultApyBps
(×10000-corrected), into the fixed model.

**Review gate passed (both agents REVISE → applied).** The verifier confirmed the load-bearing design
— the leg-draw direction is correct (verified vs Curve `exchange(1,0)`) and the ~2× is a genuine fix,
not a double-count. Fixes folded in: (1) the R2 `get_dy` seam was mis-denominated (passed a DIEM amount
into a wstDIEM `dx`) — corrected to quote `convertToShares(positionCollateralDiem)` and to **reuse the
already-tested `quoteCurveExitRoute` + `priceImpactBps`** rail (which also *defines* the previously-undefined
`expectedDiemOutAtNav`); (2) the override now replaces exit slippage at **all four** sites (gate 1, netApy,
the unwind backstop, the marginal band), not just gate 1; (3) total depth reconstructed
(`diemLeg + wstDiemLeg`) for gate-1's depth-sufficiency sub-condition; (4) the ~2× flips the canonical
§9 `viable` example → re-pinned to `curveDepthDiem = 20000`, §9/§4 added to the reconciliation;
(5) gas default 0 kept but honest — a `gas unmodeled` warning rides the verdict, no over-claim of
"included"; (6) new field specs + `curveDepthModel` label bump + leg-flag mutual exclusion. SPEC003 §4.2
aligned to the corrected denomination + rail reuse.

**IMPLEMENTED + SHIPPED (ee169d6).** Engine + CLI carry the two legs, the `externalExitSlippageBps`
seam (replacing exit slippage at all four sites), and `gasCostDiem`; offline JSON/table output otherwise
unchanged and `fromChainSeed` (Part A) flows legs+gas through as ordinary grid dims with no `get_dy`
wiring. A focused approval pass on the plumbing I had not personally exercised (field-rename completeness,
CLI flag↔camelCase field mapping through commander, output rendering, Part A compatibility, no Part B
leakage) returned **APPROVE / 0 blocking**; its three LOW test-hardening items were all closed
before commit: a compiled-CLI case now drives the leg/gas flags end-to-end through commander, a
`--preset current-zero → legs 0/0` mapping test was added, and the leg-flag mutual exclusion was
tightened to also reject a **preset-supplied** curve total (previously it would silently drop the
preset's curve intent). Gates: typecheck + lint clean; new `test/sizing-rev2.test.ts` (rev-2 acceptance
1–9); full suite 174 pass / 1 pre-existing `cli-live` fail (stash-confirmed unrelated on clean tree
7c309d0).

**Next code step: SPEC003 Part B** — now unblocked. Seed both curve legs from Curve `balances` + the
exit quote from `get_dy(1→0)` via the existing `quoteCurveExitRoute` + `priceImpactBps` rail (filling
`externalExitSlippageBps`), plus `vaultApyBps` (×10000-corrected), into the now-implemented rev-2 model.

## Traceability & verification

- Maintain a lightweight **spec-clause ↔ test** map (a table appended to each spec).
- Run a scaled-down audit-cycle gate on each spec change before it's treated as locked.
