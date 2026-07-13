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

## Phase 4 — SPEC002 rev-3 (§11 actionability & honesty refinements) — SHIPPED (2026-07-12); §11 RETIRED

Promotes the **remaining §11 backlog** (rev-2 took slippage/gas/MEV) into the contract as the `## rev-3` section
of `SPEC002.md`. Six items: **E1** shortfall outputs (distance-to-clear, incl. a slippage-clearing depth lever for
the *primary* curve gate), **E2** `structuralMarginToLiquidationBps`, **E3** stressed-rate netAPY, **E4** per-leg
curve depth backstop, **E5** `viable`→`candidate` rename, **E6** default-rate reconciliation (keep conservative 400).

**Two-agent review gate — run before code (both ACCEPT-WITH-RESERVATIONS; fixes folded in, spec LOCKED).** The
reviewers **converged** on the load-bearing correction: **E4 is dominated by the exit-slippage sub-condition under
all valid offline configs** (slippage blocks at ≤2.96% position/leg vs E4's ≥30% share-cap; ~10× earlier), so E4 is
a **dormant backstop** (like `unwind_not_covered`), *not* the "safety win" the draft claimed — and its rationale
mis-stated the formula (it splits the aggregate requirement 50/50, not a per-leg trade cap). Reframed: E4 keeps the
gate (provably tighten-only + balanced-preserving) but only the **entry leg** earns a verdict change (there is no
entry-slippage gate). Other folded fixes: E1 gained the missing **slippage-clearing depth** field (the primary gate
had no unlock number); E2 renamed to encode its **entry-time-structural** nature (+ SPEC001 OQ#9 coordination) so it
isn't misread as a live signal; E3 re-tagged **verdict-affecting** and its warning **proximity-gated** to
`postDrawUtilizationBps > 7000` (the 4×-of-400 stress would otherwise fire across the grid → alarm fatigue); E5's
atomic set extended to SPEC003 §6's integrator-note prose + a table gloss; plus a §7.1–7.3 stale-name reconciliation.

**Staging — four waves (not one unit):** W1 additive (E1/E2/E6 + §7 reconcile) → W2 E3 (proximity-gated) → W3 E4
(backstop) → W4 E5 (breaking rename, atomic). Each wave = executor → adversarial approval gate → merge behind green
gates, per the standing rule.

**ALL FOUR WAVES SHIPPED 2026-07-12 — §11 fully retired.** Each ran spec-contract → executor (opus) → adversarial
approval pass → fixes → merge behind green gates:
- **W1 (fc9dc66)** — E1 shortfalls (incl. the primary-gate `curveDiemLegSlippageShortfallDiem` unlock), E2
  `structuralMarginToLiquidationBps`, E6 docs, §7.1-7.3 reconcile. Additive, zero verdict change. Approval APPROVE;
  the one Medium (untested depth-share positive case) closed pre-commit.
- **W2 (326afe6)** — E3 stressed-rate netAPY, proximity-gated (`STRESSED_UTIL_BAND_BPS = 7000`) so the 4×-of-400
  stress doesn't blanket the grid with warnings. No fixture flipped (all low-util). Approval APPROVE; a flat-mode
  direction caveat folded into the spec.
- **W3 (ba9d1db)** — E4 per-leg curve backstop. Provably tighten-only + balanced-preserving (floor/ceil algebra);
  reframed honestly as a dormant-offline backstop whose only value is the entry leg. Zero fixtures flipped. Approval APPROVE.
- **W4 (88a22f1)** — E5 `viable`→`candidate` breaking rename, atomic across enum/summary/`loopStatusToken`/SPEC003 §6
  prose/docs/tests; SPEC003 demotion preserved (test-locked both branches); zero machine-contract residual. Approval APPROVE.

Full suite 213 pass / 1 pre-existing `cli-live` fail throughout. **The spec-first pipeline has now shipped SPEC003
(A + B-1 + B-2), SPEC002 rev-2, and SPEC002 rev-3 (4 waves) — every unit spec → review → executor → approval → merge.**

## Phase 5 — SPEC004 (scheduler exit-code contract, resolves SPEC001 OQ#7) — SHIPPED (2026-07-12, 0de89ed)

`SPEC004.md` gives the live-monitoring commands (`status`, `watch --once`, `monitor`) a severity-ordered process
exit code so a cron/systemd keeper can gate on `$?` — today a CRITICAL alert exits `0`. Ladder:
`0` nominal · `10` warn · `20` indeterminate · `30` critical · `1` tool-error.

**Two-agent review gate — run before code (both REVISE → fixes folded in, spec LOCKED).** The **technical**
critic found a **Critical (C1):** `rpcFreshness` is a block-header flag set *before* the vault/position reads, so a
partial degradation (block served, `eth_call`s failing) would render a **false `nominal (0)`** on the exact
deployment command — fixed by classifying `indeterminate` on a real **position-assessed** signal (`liveAssessed`,
set only after the position reads complete), not block freshness. It also caught that the draft's "readiness
blockers already surface as CRITICAL alerts" note was false (three bring-up states are WARN) and that the
non-`--json` path returns a *string* so the classifier must live *inside each action*. The **product** analyst
argued the ladder should not let transient RPC blips out-page confirmed danger. Both dissolved cleanly: **critical
is the top rung (30), indeterminate below it (20)**; classification is a **read-completed gate then `max(alert
level)`** with **no separate blocker→critical rule** (so `executor_missing` stays WARN, not a critical over-alarm
— resolving M1/M3 and the setup-blocker over-alarm at once); `all-clear`→`nominal` with an explicit "not a safety
assertion" note; plus a runbook gating recipe (`node dist/…`, not `npm run`), the `tool-error`-is-un-gateable +
dead-man's-switch hazards, and the breaking-change consumer list (CI, Fly healthcheck). Open questions recorded
(setup-blocker distinct code; canonical scheduled command; missing-config vs runtime-unreachable).

**IMPLEMENTED + SHIPPED (0de89ed).** `src/cli/exitCode.ts` (`classifyMonitoringOutcome` read-completed gate +
`isMonitorAssessed`), the `liveAssessed` C1 fix in `status.ts`, the classifier wired inside each of
status/watch/monitor (human-string path also sets the code; `tool-error(1)` never overwritten), JSON
`outcome`/`exitCode`, the runbook recipe in `monitoring.md`, and `test/cli-exit-code.test.ts` (19 tests).
**Approval gate found two more real defects, both fixed + re-approved:** a **HIGH** — `status`/`watch --once`
read only block+vault (never position/curve/morpho/oracle), so `evaluateAlerts` cannot raise a danger CRITICAL on
their snapshot; they reach only `{0,10,20}` and my locked §9 overclaimed `{0,10,20,30}`. Reconciled: they are
**vault-liveness snapshots**, danger-gate `-ge 30` on **`monitor`** only (resolves OQ-b; §1/§9 + `monitoring.md`
callout). And a **MEDIUM** — `liveAssessed` was set on any non-throwing `collectVaultMetrics` return, including the
`asset()!=DIEM` early-return that doesn't complete the read → false `nominal(0)`; fixed by keying `liveAssessed`
off `validity.vault` (read-completed). typecheck/lint/build clean; **232/233** (1 pre-existing unrelated
`cli-live` fail). SPEC001 OQ#7 CLOSED.

## Phase 6 — SPEC005 (live liquidation readout, resolves SPEC001 OQ#9) — SHIPPED (2026-07-12, bd4d831)

`SPEC005.md` adds a **live** liquidation readout to `monitor` (health factor, `debtGrowthHeadroomBps`, gated
liquidation price) and — the load-bearing half — makes a position approaching liquidation a `monitor` CRITICAL, so
the SPEC004 keeper pages on position danger, not only infrastructure faults. Today no command emits a CRITICAL when
the owner's own position drifts toward liquidation (status/watch print a false `HF Infinity`; monitor reads
collateral+debt but no LLTV/oracle). Reuses the dead `computeHealthFactor` (first prod caller); reads live LLTV +
the market's own oracle via `idToMarketParams`; oracle scale 1e36 confirmed against `computeOracleDeviation`.

**Two-agent pre-code gate (technical critic + product analyst, both REVISE → folded → LOCKED), then a focused
confirmation pass (2 more Majors → fixed).** The gate's value showed again — both agents **independently converged**
on an exit-code masking flaw (critic M1 / analyst OQ-A): the draft folded a readout failure into `isMonitorAssessed`,
which short-circuits `!assessed→20` before the CRITICAL check and would mask a co-fired unrelated CRITICAL down to 20.
Resolved by treating a deterministic oracle/market fault (`price==0`/`lltv==0`/underwater — Morpho values collateral
at ~0, i.e. liquidatable) as a **CRITICAL alert** that reaches 30 via the normal path, no fold. The analyst also
caught that reusing `healthFactorCritical=1.40`/`Warn=1.60` would perpetually CRITICAL a high-leverage position;
reconciled by tying the thresholds to the tool's own `minPostLoopHealthFactor=1.7` operating point (entry HF≥1.7 →
1.40/1.60 signal drift, not steady-state) + a resting-HF-no-alarm test; and a margin-axis contradiction (lead with
`debtGrowthHeadroomBps=HF−1`, the debt-accrual axis, not the collateral-decline `(HF−1)/HF`). The confirmation pass
then caught a **div-by-zero exception-path** that re-opened the masking regression (`lltvWad===0` in the liq-price
denominator throws → `rpc-read` catch → 20) and an **underwater gate contradiction** (readout gated on
`hasExitPosition` excluded the `collateral==0` underwater case it claimed to page) — both fixed (fault-detection
before the price formula; gate on `borrowShares>0`; underwater sourced from pre-existing `owner` fields).

**IMPLEMENTED + SHIPPED (bd4d831).** `buildLiquidationReadout` (fault-first branch order), the `liquidation`
readout struct + `monitor --json` (`data.readiness.liquidation`, bigints as strings), the two alerts
(`position_health_factor` + `position_liquidation_fault`), the `includeLiquidation`-gated block-pinned reads,
`loop readiness` strict-evidence isolation (structural, zero new checks), the `status`/`watch` `HF Infinity`→`n/a`
honesty fix, and `test/liquidation-readout.test.ts` (14 tests). `exitCode.ts` unchanged — faults reach 30 via the
normal alert path, never masking a co-fired CRITICAL. **Approval gate: APPROVE, 0 blocking, every load-bearing
property confirmed HIGH** (masking closed on all paths, math exact/unbiased, boundaries untouched); its one
non-blocking coverage nicety (normal `0<HF<1` ≠ fault sentinel) folded in as AC2b pre-merge. typecheck/lint/build
clean; **248/248** green (the long-standing `cli-live` red was also root-caused + fixed in fb1ac1a — non-hermetic
test + an empty-`BASE_RPC_URL` fail-closed bug). SPEC001 OQ#9 CLOSED. Pipeline now 10 spec-first units.

## Phase 7 — SPEC006 (capacity + live brief) — SHIPPED (2026-07-13)

`SPEC006.md` adds **`loop capacity`** (max equity at leverage `L` still `status === "candidate"` — last-candidate
gate-bound absorption) and **`loop brief`** (capacity grid + canonical net-APY + Δ vs last comparable SQLite run).
Reuses SPEC002 gates + SPEC003 seeds; no new gate math; advisory exit codes only (SPEC004 untouched).

**Two-agent pre-code gate (technical critic + product analyst, both REVISE → folded) + focused confirmation
(ACCEPT-WITH-RESERVATIONS → M1–M4 folded) → LOCKED.** Load-bearing fixes: full search pseudocode with
`maxProbeEquity` + gas-island bisect; `capacityEdge`/`bindingEdge` split; offline refuse
(`OFFLINE_CAPACITY_REFUSED` unless `--from-chain` / explicit market flags / `--allow-offline-defaults`);
structured honesty fields + last-candidate framing (ban “deploy up to”); brief fingerprint + incomparable
baselines; get_dy block-pin + hard-fail vs soft demote; notional only via `positionCollateralForScenario`;
headroom-to-block secondary metric; `morpho-util-headroom` binding name.

**IMPLEMENTED + SHIPPED.** `src/loop/capacity.ts` + `src/loop/brief.ts` + `brief_runs` storage + CLI/render +
tests (`test/capacity.test.ts`, `test/brief.test.ts`). **Approval gate REQUEST-CHANGES → fixed:** (1) get_dy
budget truncation no longer reclassifies mid with leg-aware (SearchTruncatedSignal freezes proven low);
(2) zero-path any-marginal → `bindingConstraint: "marginal-band"`; plus fingerprint leverage sort, brief
hard-fail → `CapacitySearchError`, structural-HF proximity warning, default leverages **1.5 / 1.5,1.8**
(2× always marginal under min HF 1.7). typecheck/lint/build clean; **280/280** green. `exitCode.ts` untouched.

## Phase 8 — SPEC007 (secondary-market basis: market vs NAV) — SHIPPED (2026-07-13)

`SPEC007.md` adds **`loop basis`**: `(marketPrice − NAV) / NAV` in bps with operator-supplied market-price
seam (CLI/config), live convertToAssets NAV (empty/WAD fail-closed), dual discount framing
(stress/illiquidity + edge), advisory alerts only (exit 0), `authoritative: false` in v1. Morpho oracle
never used as market. Two-agent gate + confirmation residuals folded → LOCKED.

**IMPLEMENTED + SHIPPED.** `src/metrics/basis.ts` + config `basis`/`basisDiscount*Bps` + CLI/render +
`test/basis.test.ts` (13). Independent totalAssets/totalSupply/convertToAssets reads; advisory
`basis_discount` alerts; paste dual framing; suite **313/313**.

## Phase 9 — SPEC008 (NAV-ratchet yield velocity / demand proxy) — SHIPPED (2026-07-13)

`SPEC008.md` adds **`loop demand`**: short-window **NAV-only** yield velocity + prior-window acceleration as an
on-chain coincident **demand proxy** (not AskSurplus, not a yield promise). Default window **72h**; invalid
sample filter (empty watch ticks write WAD nav); live tip prefers `convertToAssets`; paste-safe framing;
`windowGrowthBps` non-annualized; no brief attach; no monitor alerts; `exitCode.ts` untouched.

**Two-agent pre-code gate (technical REVISE + product AWR → folded) + confirmation AWR → M1–M5 folded → LOCKED.**

**IMPLEMENTED + SHIPPED.** `src/metrics/demand.ts` + `listNavSamplesForWindow` (SQL valid-anchor filter) +
`loop demand` CLI/render + `test/demand.test.ts` (20). **Approval REQUEST-CHANGES → fixed:** unfiltered
`LIMIT 1` anchor could hide valid history behind a dirty empty tip — SQL + bigint filter now skip
assets=0/nav=0 sentinels. typecheck/lint/build clean; **300/300** green.

## Phase 10 — SPEC009 (attributable inference-demand tracker; SPEC008 refinement) — SHIPPED @36797fa (2026-07-13)

`SPEC009.md` refines SPEC008's NAV-velocity proxy into the **attributable** signal: ingest the on-chain events by
which inference USDC becomes wstDIEM yield — `InferenceVault.DIEMCredited(adapter, amount)` (per-venue, Tier-1) +
the adapters' `SettlementReceived`/`YieldRouted` — and report per-adapter USDC settled + DIEM credited, plus the
honesty headline: **`inferenceSharePct`** (inference-attributable ÷ realized yield), which honestly reports a low
share early (base-staking + protocol-seeded yield dominates while bootstrapping — expected) and grows with adoption.
`loop demand --flows`; read-only, decision-support. Source of truth: `Liquid-Protocol-Ops/liquid-protocol-v0`
`src/vault/`.

**Two-agent pre-code gate (technical critic REVISE + product analyst AWR → folded), then a confirmation pass (M2/M3/
M4/M5 verified CLOSED line-by-line; 3 more surgical Majors → fixed) → LOCKED.** The gate's value showed hard here —
five review rounds before any code caught: a **mechanically wrong reconciliation** (the 5% `yieldFeeBps` is a
treasury share-mint / dilution, NOT a DIEM haircut; `DIEMCredited` emits the gross amount) → corrected to the
asset-side split with a first-order NAV identity on **start-of-window** supply; the **X402 permissionless-settlement**
honesty hole (`recordX402Settlement` is `external`, anyone can push `SettlementReceived`) → three-tier trust labeling;
and a **`S_start` data-plumbing gap** (`totalSupply` is fetched-then-discarded, never persisted) → persist via the
existing `ensureColumn` pattern. Framing softened pre-publish to be bootstrapping-supportive (protocol self-seeding
is normal, not a red flag).

**SHIPPED @36797fa** (spec → executor → adversarial approval gate APPROVE-WITH-NITS → fold → merge). Delivered:
the vault/adapter event decode + storage (`inference_credit`/`inference_settlement`, PK `(tx_hash,log_index)` +
`INSERT OR REPLACE`), the `total_supply_diem` snapshot column persisting **start-of-window** supply, the
feeRouter-decoupled backfill on the shared `lastProcessedBlock` cursor (no 302k lookback), the config venue-adapter
set + `usdc`, and `loop demand --flows` + `test/inference-flows.test.ts`. All 11 §7 criteria + every load-bearing
trap verified in code by the gate; the one folded fix — `yieldFeeBps` now **fails closed** (treasury active + read
throws → headline `n/a`, never a silent over-report of the inference share). Build clean; suite **339/339**
(`loop demand` byte-unchanged without `--flows`). 3 Low nits deferred (X402-label name-heuristic, `0%`-vs-`n/a`
posture, renderer banned-phrase throw) — non-blocking, see the session's gate notes.

Phases 0–10 all SHIPPED. Pipeline = 14 spec-first units.

## Traceability & verification

- Maintain a lightweight **spec-clause ↔ test** map (a table appended to each spec).
- Run a scaled-down audit-cycle gate on each spec change before it's treated as locked.
