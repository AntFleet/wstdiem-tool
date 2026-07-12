# SPEC004 — Scheduler exit-code contract

> **Forward spec** resolving **SPEC001 Open Question #7**. Defines the process exit-code contract for the
> live-monitoring commands so an external scheduler (`watch --once` + cron/systemd — decision D2) can gate on
> outcome **severity** via `$?`. Spec-first: the acceptance criteria are the tests to write. **Revised after a
> two-agent review gate (technical + product, both REVISE → this pass):** the ladder is re-ordered so confirmed
> danger — not a transient RPC blip — is the loudest signal, and the `indeterminate` trigger is fixed so a
> *partial* chain read (block header served, position reads failed) can never render a false `all-clear`.

## 1. Problem & scope

The deployment model is `watch --once` + an external scheduler (D2) — no persistent daemon. But every command
exits `0` on success regardless of what it found: `runAction` (`src/cli/index.ts:107-127`) sets
`process.exitCode = 1` **only when the action throws**. So **a CRITICAL alert exits `0`, and a scheduler cannot
gate on severity** (OQ#7). This spec assigns a severity-ordered exit code to the three **live-monitoring
commands**: `status`, `watch --once`, `monitor`.

**Out of scope.** `loop sizing` / `loop simulate` (offline/advisory) keep `0` on success / `1` on error — they
assess no live position state. `loop readiness --strict-evidence` already exits non-zero on an evidence-check
failure; this spec does not change it (a later revision may align it — noted, not specified).

**The exit code is a *notification for an out-of-band response*, not a tool action.** Per SPEC001 §5 (OQ#6,
resolved: monitor-and-rehearse only) the tool holds no position open and takes **no** state-changing action on
any outcome. `20`/`30` mean *a human/scheduler must act out-of-band now* — never *the tool acted*.

## 2. Outcome classes → exit codes

A severity-ordered ladder so a scheduler gates with `[ $? -ge N ]`:

| Code | Class | Meaning |
|---|---|---|
| `0` | `nominal` | live position assessed; **no** WARN/CRITICAL alert. **NOT a safety guarantee** — it means no *configured* alert threshold was breached this tick; the tool holds no position and provides no automated liquidation protection (SPEC001 A3). A slow drift below threshold still exits `0`. |
| `1` | `tool-error` | the tool failed to run: invalid input, usage error, `NOT_IMPLEMENTED`, or an uncaught internal error (**existing behavior — unchanged**). |
| `10` | `warn` | live position assessed; worst finding is a WARN-level alert (incl. a stale-but-readable RPC block, SPEC001 §3's `rpc_stale` WARN). |
| `20` | `indeterminate` | the tool **could not assess** the live position this tick (RPC unreachable, wrong chain, no RPC configured, or a *partial* read where the position/market reads did not complete). **Stateless / per-tick** — see §6. |
| `30` | `critical` | live position assessed **and** a CRITICAL-level alert fired — a **confirmed** danger requiring out-of-band action now. Requires a completed read. |

**Ordering rationale (why `critical` is the top rung, not `indeterminate`).** The tool cannot act; the operator's
response to a *confirmed* critical (act out-of-band **now**) is more urgent and more actionable than to a blip
(retry / wait for the next tick), and on a cron cadence transient RPC blips are common while confirmed criticals
are rare — so ranking "blind" above "confirmed danger" would make the loudest page the noisiest signal and dull
response to the real thing. A keeper gets a clean two-tier gate: **`-ge 30`** = confirmed danger, page hard;
**`-ge 20`** = danger-or-blind, default page; **`-ge 10`** = anything to review. Codes are gapped (avoid the
shell-reserved range 126–165) and leave room for future tiers.

## 3. Classification (a read-completed gate, then alert severity)

Classification is a short-circuit ladder, evaluated in this order — **it is a gate, not a numeric max**, because
alerts derived from a read that did not complete are not trustworthy:

```text
1. the action threw                          → tool-error (1)   [set by runAction's catch]
2. the live position assessment DID NOT COMPLETE → indeterminate (20)
3. any alert level === "CRITICAL"            → critical (30)
4. any alert level === "WARN"                → warn (10)
5. otherwise                                 → nominal (0)
```

**"live position assessment did not complete" (the C1 fix — do NOT reuse `rpcFreshness` alone).**
`snapshot.validity.rpcFreshness` means only "a block header was read on the right chain" (`status.ts:47`) — it is
set **before and independent of** the vault/position `eth_call`s in `collectVaultMetrics` (which have no internal
try/catch, `collector.ts:128-151`). A partial degradation (block served, contract reads rate-limited/reverting)
is caught at `status.ts:56` with `rpcFreshness` still `true` and every position-gating validity flag `false`, so
`evaluateAlerts` returns `[]` — which under a naive `rpcFreshness`-only rule would be a **false `nominal`**. The
contract therefore requires a **position-assessed signal**:

- **`status` / `watch --once`:** add `snapshot.validity.liveAssessed`, set `true` **only after the position/market
  reads required to evaluate the CRITICAL alerts fully succeed** (i.e. after `collectVaultMetrics` completes
  without throwing, on the right chain). `indeterminate (20)` ⇔ `!liveAssessed`. This subsumes: no RPC configured,
  RPC/transport unreachable, chainId mismatch (`rpcFreshness=false`), **and** a partial read (block OK, contract
  reads failed) — all of which must be `20`, never `0`. A stale-but-fully-read block (`liveAssessed=true`,
  `latestBlockAgeSeconds > window`) is **not** indeterminate — it is a `warn` via `rpc_stale` (SPEC001 §3),
  consistent with SPEC001's alert table.
- **`monitor`:** the read did not complete ⇔ `readiness.blockNumber === undefined` **or** the `rpc-client` /
  `rpc-read` check failed (`readiness.ts:177,629`).

**Alert severity is the sole source of position-danger classification (steps 3–4) — there is NO separate
"readiness blocker forces critical" rule.** `evaluateReadinessAlerts` already assigns the intended level to each
readiness condition, and those levels are authoritative: `live_rpc_unavailable` → CRITICAL, but `executor_missing`
/ `owner_missing` / `owner_position_missing` → **WARN** (`monitor/readinessAlerts.ts`). So a not-yet-authorized
executor during bring-up classifies `warn (10)`, not a critical over-alarm — and it does not mask a real
`critical` behind the same code. (This resolves the review's M1/M3 and the J3 over-alarm: `readiness.blockers[]`
is **not** consulted for the exit code.) The intentionally-closed **audit gate is never an alert** and never
affects the code; the executor must confirm the audit-gate blocker string
`"broadcast disabled pending production executor audit/review"` (`index.ts:46`, check key `audit-gate`,
`readiness.ts:633-640`) carries no alert and is excluded.

## 4. Integration point (single source of truth for `process.exitCode`)

Classification MUST run **inside each monitoring action, on the fully-built structured result, before the
`--json`/string return branch** — NOT in `runAction` on `data` (the non-`--json` path returns a rendered
**string**, `index.ts:150-153,216-220`, from which the outcome cannot be derived → the human-readable path would
silently exit `0`). Each action:
1. builds the structured result,
2. computes `classifyMonitoringOutcome(result) → { outcome, exitCode }`,
3. sets `process.exitCode = exitCode` (this is the last step and cannot throw, so `runAction`'s `catch → 1`
   can never be overridden, and `nominal (0)` can never overwrite a `tool-error`),
4. attaches `outcome` + `exitCode` to the structured result (for `--json`, §5),
5. returns the string or the structured result as before.

## 5. `--json` envelope

The exit code is set **regardless of `--json`** (the primary machine signal). The monitoring commands' JSON `data`
additionally carries `outcome: "nominal" | "warn" | "indeterminate" | "critical"` and `exitCode: number`, so a
`jq` consumer needn't re-derive the class. **`$?`, `data.exitCode`, and `data.outcome` MUST always agree.** A
`tool-error` still emits the existing `{ ok: false, error }` envelope with exit `1`; `outcome` is a
monitoring-result field, absent on the error envelope. (A `nominal`/`warn`/`critical` run is `ok: true` with a
possibly-non-zero exit — that is the intended shape.)

## 6. Statelessness & the operator's responsibility (honesty)

- **`indeterminate` is per-tick and stateless.** `watch --once` has no daemon and no cross-tick memory, so the
  tool **cannot** distinguish a transient RPC blip from a sustained outage — that is the **scheduler's** job
  (count consecutive `20`s; systemd `OnFailure`/`StartLimitBurst`; a wrapper counter). The spec does not claim
  single-tick blindness is an emergency; it reports "could not assess this tick."
- **Flapping is the scheduler's job too.** SPEC001's alert dedup/cooldown governs alert *delivery*, not the exit
  code, so a scheduler gating on `$?` sees every flapping tick (WARN→nominal→WARN); hysteresis/debounce is the
  operator's responsibility.
- **`nominal (0)` is not a safety assertion** (§2) — do not let a green tick imply the position is safe.

## 7. Scheduler integration (the runbook MUST carry this)

`docs/deployment/monitoring.md` must (a) switch the scheduled invocation from `npm run monitor:live` to
**`node dist/cli/index.js …` directly** — `npm run` wraps any non-zero exit in an alarming `npm ERR!` stack and
can mangle the propagated code, so a routine `warn` looks like a crash — and (b) carry the canonical gating recipe:

```sh
node dist/cli/index.js monitor; rc=$?
case $rc in
  30) page "wstDIEM CRITICAL — act out-of-band now" ;;      # confirmed danger
  20) count_and_escalate "indeterminate (blind this tick)" ;; # page on N consecutive
  10) log "warn — review" ;;
  1)  page "wstDIEM monitor FAILED TO RUN — fix the invocation" ;;  # do NOT let it go silent
  0)  : ;;  # no configured alert breached this tick (NOT a safety guarantee)
esac
```

Two non-obvious hazards the runbook MUST name:
- **`tool-error (1)` is not `-ge`-gateable** — it sits below `warn (10)`, so a persistently broken invocation
  (config typo / missing env after a deploy) exits `1` every tick and is missed by `-ge 20`/`-ge 10` → **silent
  monitoring death**. Gate it explicitly (`rc -eq 1`) and/or route it to the scheduler's own failure handling.
- **No exit code covers "the tick never ran"** (host down / cron disabled). Pair the schedule with a
  **dead-man's-switch / heartbeat** (a missed-run alarm) — `$?` cannot tell you the job didn't fire.
- **Do not gate with shell truthiness** (`if monitor; then …`) — it collapses `1/10/20/30` into one
  indistinguishable "failure." Use `$?` and `-ge`.

## 8. Interactions & backward-compat

- **Breaking change (intentional).** Success is no longer always `0`. Re-baseline the internal consumers that
  assume exit `0` on a warn/critical/indeterminate run: **CI smoke tests** that run `status`/`watch`/`monitor`
  and assert `0`; the **Fly.io deployment healthcheck** (a `0`-expecting healthcheck flaps on every warn tick —
  point it at a `-eq 1`/heartbeat check, not the monitoring exit); `npm run` **wrappers** (§7); and **doc
  examples** implying "exit 0 = success." (The SDK reads contracts directly, not via the CLI — confirm, don't
  assume.) Pre-production, no external consumers — the break is acceptable.
- **`--alert` orthogonal.** Alert *delivery* (`monitor --alert`) is independent of the exit code.
- **`watch` without `--once`** still throws `NOT_IMPLEMENTED` → `1`, unchanged.

## 9. Per-command reachability & open questions

Reachable codes: **`status` / `watch --once`: {0, 10, 20, 30}** (position alerts + the `liveAssessed` gate);
**`monitor`: {0, 10, 20, 30}** (readiness-alert levels + the `blockNumber`/`rpc-*` gate — `warn` reachable via
`executor_missing` etc.). All three carry `1` on a thrown error.

Recorded open questions (do not block this spec; revisit if the deployment matures):
- **[OQ-a] Setup-blockers vs live danger.** Bring-up conditions (`executor_missing`, `owner_missing`,
  `owner_position_missing`) currently classify `warn (10)` via their alert level. If a keeper needs to distinguish
  "not yet operational" from "position in danger," add a distinct code or require `monitor` to be scheduled only
  after readiness passes. (v1: they are `warn`, honest and non-masking.)
- **[OQ-b] Canonical scheduled command.** D2 says `watch --once`; the runbook shows `monitor`; `status` and
  `watch --once` return the identical `StatusResult` and classify identically. Name the one the gating recipe
  attaches to and reconcile D2 ↔ the runbook.
- **[OQ-c] Missing-config vs runtime-unreachable.** Both currently → `indeterminate (20)` (the position is
  un-assessed either way; a persistent `20` after deploy signals "fix me"). Revisit if operators want
  missing-config to be `1`.

## 10. Acceptance criteria (tests when built)

1. **nominal:** `liveAssessed` true, no WARN/CRITICAL alert → exit `0` / `outcome: "nominal"`.
2. **warn:** a WARN alert, no CRITICAL, read completed → exit `10` / `"warn"` (assert on status/watch **and**
   monitor's `executor_missing` WARN — proving the no-blocker-rule fix).
3. **critical:** a CRITICAL alert, read completed → exit `30` / `"critical"`; WARN+CRITICAL mix → `30`.
4. **C1 regression — partial read is NOT a false `nominal`:** block-header read succeeds but the position/market
   reads fail (mock `collectVaultMetrics` throwing) → `liveAssessed` false → exit `20` / `"indeterminate"`,
   **not** `0`. Plus: no-RPC / wrong-chain / `blockNumber===undefined` (monitor) → `20`.
5. **read-gate precedence:** a `monitor` run with `blockNumber===undefined` **and** a `live_rpc_unavailable`
   CRITICAL alert → `20` (indeterminate), **not** `30` — the read-completed gate short-circuits before alert
   severity (a critical requires a completed read).
6. **tool-error unchanged:** invalid-input / `NOT_IMPLEMENTED` throw → exit `1`, not overridden by the ladder.
7. **--json parity:** `--json` and non-`--json` set the same exit code; `data.outcome`/`data.exitCode` equal `$?`
   on both paths (the non-JSON string path must still set the code — the M2 regression).
8. **audit gate excluded:** `monitor` whose only blocker is the closed audit gate (no live-state alert) → `0`.
9. **offline unaffected:** `loop sizing` keeps `0`/`1` (no severity ladder).

## 11. Traceability

Each §10 criterion maps to a test in a new `test/cli-exit-code.test.ts` (compiled-CLI via `execFile`, asserting
real `process` exit codes) plus unit tests on `classifyMonitoringOutcome`. The runbook recipe (§7) ships in
`docs/deployment/monitoring.md`. Resolves SPEC001 OQ#7.
