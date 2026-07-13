# wstDIEM operator runbook

**Audience:** operators and capital partners evaluating or monitoring a DIEM/wstDIEM leveraged loop on Base.  
**Posture:** this CLI is **monitor-and-rehearse only** — decision-support, not automated protection and not investment advice. Broadcast stays **fail-closed** until the [production audit gate](./audit-gate.md) clears. The operator/keeper must **decide and act out-of-band**.

This runbook is the public on-ramp. Deeper detail lives in:

| Topic | Doc |
|---|---|
| Scheduler exit codes + alerts | [monitoring.md](./monitoring.md) |
| Sizing engine + `--from-chain` | [loop-sizing.md](./loop-sizing.md) |
| Live readiness + full-unwind proof | [live-readiness.md](./live-readiness.md) |
| Executor deploy / evidence | [loop-executor.md](./loop-executor.md) |
| Audit gate (closed) | [audit-gate.md](./audit-gate.md) |

---

## 0. Quick map

| Goal | Command | Notes |
|---|---|---|
| Page on position danger | `monitor` | Only command for `$? -ge 30` (SPEC004) |
| Vault liveness tick | `status` / `watch --once` | Never emits `30` |
| Entry sizing grid | `loop sizing` / `loop sizing --from-chain` | Offline or live-seeded; advisory |
| Max equity still “candidate” | `loop capacity` | Last-candidate absorption bound |
| Daily capital brief | `loop brief --from-chain` | Capacity + net APY + Δ vs last run |
| Yield velocity (demand proxy) | `loop demand` | NAV-ratchet only; not AskSurplus — needs sampling series ([monitoring.md](./monitoring.md#sampling-cadence--starting-the-demand-series)) |
| Start / keep demand series | `./scripts/sample-tick.sh` (launchd 6h) | Writes `metric_snapshots` via `watch --once` |
| Market vs NAV basis | `loop basis --market-price …` | Operator-supplied market; dual discount framing |
| Exit rehearsal | `loop simulate --action exit --live` | Dry-run; no broadcast |
| Owner / executor evidence | `loop readiness` | Audit gate still closed |

Always invoke the built binary from schedulers:

```sh
npm run build
node dist/cli/index.js <command>
```

Do **not** wrap scheduled monitors in `npm run …` — non-zero exits get an `npm ERR!` stack and can mangle the code.

```sh
export BASE_RPC_URL="https://…"   # Base mainnet
# optional: --config config.yaml
```

---

## 1. Entry sizing — candidate / marginal / blocked

Use sizing **before** any out-of-band open. It does not use RPC (unless `--from-chain`), does not broadcast, and does not clear the audit gate.

### 1.1 Offline grid

```sh
node dist/cli/index.js loop sizing \
  --initial-diem 100 \
  --target-leverage 1.5,1.8 \
  --curve-depth-diem 0,1000,10000 \
  --morpho-supply-diem 0,1000,10000 \
  --vault-apy-bps 1500 \
  --rate-at-target-apy-bps 400
```

Default borrow model is **adaptive-curve** (utilization-aware). Default `rateAtTarget` **400 bps** is deliberately pessimistic vs live (~200 bps class); pass live or `--from-chain` for realism. See [loop-sizing.md](./loop-sizing.md).

### 1.2 Verdict tokens

| Status | Meaning |
|---|---|
| **`candidate`** | Clears hard gates **and** proximity band. For deeper fork/live validation only — **not** approval to act. |
| **`marginal`** | Near a hard gate (e.g. slippage near cap, HF near min, APY near floor). Treat as “not clean.” |
| **`blocked`** | At least one hard gate failed for those assumptions. |

Hard gates include Curve depth + exit slippage, Morpho util-capped supply, health factor (structural in leverage), net APY, and unwind coverage. Shortfalls in the table explain distance-to-clear.

**Leverage vs default min HF 1.7:** structural HF = `LLTV × L / (L − 1)`. At LLTV 0.86, **2.0×** HF ≈ 1.72 sits in the engine’s proximity band → often **marginal** even with deep liquidity. Prefer **1.5×–1.8×** for “candidate” demos under defaults, or consciously lower `--min-health-factor` knowing monitor WARN/CRITICAL thresholds (1.60 / 1.40).

### 1.3 Live seeding (`--from-chain`)

```sh
node dist/cli/index.js loop sizing --from-chain \
  --initial-diem 100 --target-leverage 1.5,1.8
```

Seeds `rateAtTarget`, Morpho supply/borrow, Curve legs, live `get_dy` exit slippage (when possible), and 7-day vault APY from SQLite. **Upgrades inputs, not the model.**

**Fail-closed (no report):** drained Curve (0/0 legs), RPC down, wrong chain, empty Morpho supply, bad contract code, etc.

**Demotion (report continues, not a hard fail):** short vault APY window, unavailable `get_dy`, operator-typed vault APY. Verdict shows `— unverified seed`; JSON `authoritative: false`. A `candidate` with `authoritative: false` is **not** a verified pass.

**Drained pool rehearsal** (explicit legs skip curve chain-seed; still seeds Morpho/rate):

```sh
node dist/cli/index.js loop sizing --from-chain \
  --curve-diem-leg 5000 --curve-wstdiem-leg 5000 \
  --initial-diem 100 --target-leverage 1.5
```

### 1.4 Capacity (how large still clears gates)

```sh
node dist/cli/index.js loop capacity --from-chain --target-leverage 1.5
# or offline/explicit market inputs / --allow-offline-defaults (non-authoritative)
```

Reports **last-candidate** equity and notional (gate-bound absorption), binding constraint, and secondary headroom-to-hard-block. **Not** a promise that capital can deploy; pool/caps move. Offline fantasy without market inputs is **refused** unless `--allow-offline-defaults`.

```sh
node dist/cli/index.js loop brief --from-chain
```

Capacity grid (default leverages **1.5, 1.8**) + net APY at canonical equity + Δ vs last **comparable** SQLite run. Decision-support cron artifact; not a solicitation.

---

## 2. Monitoring cadence and exit-code gating (SPEC004)

### 2.1 Which command pages danger?

| Command | Role | Reachable `$?` |
|---|---|---|
| **`monitor`** | Live danger dashboard (Curve, Morpho, executor, owner, **liquidation**) | `{0, 10, 20, 30}` |
| **`status` / `watch --once`** | Vault-liveness snapshot only | `{0, 10, 20}` — **never 30** |

Gate **position danger on `monitor`**. A `0` from `status` means vault NAV read completed without configured vault alerts — **not** “position is safe.”

### 2.2 Exit codes

| Code | Class | Meaning |
|---|---|---|
| `0` | nominal | Assessed; no WARN/CRITICAL. **Not a safety guarantee.** |
| `1` | tool-error | Failed to run (bad flags, crash). |
| `10` | warn | Assessed; worst is WARN. |
| `20` | indeterminate | Could not assess this tick (RPC/partial read). Per-tick, no memory. |
| `30` | critical | Assessed **and** CRITICAL — act out-of-band now. |

### 2.3 Canonical scheduler recipe

```sh
node dist/cli/index.js monitor; rc=$?
case $rc in
  30) page "wstDIEM CRITICAL — act out-of-band now" ;;
  20) count_and_escalate "indeterminate (blind this tick)" ;;  # page after N consecutive
  10) log "warn — review" ;;
  1)  page "wstDIEM monitor FAILED TO RUN — fix the invocation" ;;
  0)  : ;;  # no configured alert this tick — NOT a safety guarantee
esac
```

**Hazards:**

- **`1` is not covered by `-ge 10`.** A broken deploy that always exits `1` is silent if you only gate `-ge 20`. Match `1` explicitly and/or use the scheduler’s failure path.
- **No code means “tick never ran.”** Pair with a dead-man’s-switch / heartbeat.
- Do not use `if monitor; then …` — shell truthiness collapses all non-zero codes.

Optional:

```sh
node dist/cli/index.js monitor --owner 0x… --loop-executor 0x… --alert
```

`--alert` delivers configured webhook/Telegram alerts (see [monitoring.md](./monitoring.md)). Audit-gate “broadcast disabled” is **not** an alert.

Suggested cadence: `monitor` every 1–5 minutes for danger; `watch --once` on a longer schedule to **persist** vault samples for demand/APY windows (`status` is in-memory only and does **not** write SQLite).

---

## 3. Live liquidation readout (SPEC005) — when to act

`monitor` (with position debt) shows:

| Field | Meaning |
|---|---|
| **Health factor** | Morpho-style HF; liquidatable below **1.0** |
| **Debt-growth headroom (bps)** | How far debt may grow before HF = 1 (primary live risk axis) |
| **Liquidation price** | Oracle DIEM/wstDIEM at HF = 1 (secondary; detailed/`--json`) |

Default thresholds (config): **WARN HF &lt; 1.60**, **CRITICAL HF &lt; 1.40**. Tool-created loops target **min post-loop HF ≥ 1.7**, so 1.60/1.40 signal **drift**, not resting 2× aggression.

**When to act out-of-band (tool does not deleverage):**

| Signal | Suggested operator response |
|---|---|
| HF CRITICAL / debt-growth headroom collapsing | Reduce leverage or add collateral off-tool; rehearse exit (below) |
| `position_liquidation_fault` CRITICAL | Oracle/LLTV/underwater fault — Morpho may value collateral ~0; investigate immediately |
| Curve empty / Morpho empty CRITICAL | Exit liquidity or borrow market broken — do not size new loops; unwind only with strict simulation |
| `indeterminate` (20) streak | Fix RPC; you are blind |

wstDIEM is **NAV-appreciating**. Liquidation-price “drop” framing is a vault/oracle fault axis more than ordinary market drop — still treat debt accrual as the primary live path.

```sh
node dist/cli/index.js monitor --json | jq '.data.readiness.liquidation, .data.outcome, .data.exitCode'
```

---

## 4. Exit rehearsal — `loop simulate --live`

Broadcast remains disabled. Rehearse exit with simulation + preflight:

```sh
node dist/cli/index.js loop simulate --action exit --live \
  --owner 0x… \
  # optional: --force (skips slippage guard only; simulation still mandatory)
```

Expect preflight checks (Curve, Morpho, flash liquidity, evidence) and a blocked/passed simulation result — **no** production tx. Full owner/executor evidence path: [live-readiness.md](./live-readiness.md) (`readiness:owner`, `proof:full-unwind`).

`loop open` / `rebalance` / `exit` without dry-run stay blocked by the audit gate for production broadcast.

---

## 5. Fail-closed drained-pool behavior

Live state has at times shown **Curve DIEM/wstDIEM balances 0/0** and **tight Morpho borrow headroom**. The tool refuses to pretend otherwise:

| Situation | Behavior |
|---|---|
| `loop sizing --from-chain` with empty pool | **No report** — `FROM_CHAIN_SEED_BLOCKED` |
| `monitor` empty Curve | CRITICAL readiness alert (infrastructure) |
| `loop capacity` on 0/0 legs (explicit offline) | Capacity **0** / blocked, curve binding |
| Rehearse with hypothetical depth | Pass `--curve-diem-leg` / `--curve-wstdiem-leg` (or totals) explicitly |

Do not treat a forced offline `candidate` on invented depth as live capacity.

---

## 6. Intelligence layer (decision-support)

These commands do **not** use the SPEC004 danger ladder (advisory `0`/`1` only).

### 6.1 Demand proxy — NAV-ratchet velocity

```sh
node dist/cli/index.js loop demand              # default 72h window
node dist/cli/index.js loop demand --window-hours 24 --json
```

Short-window **NAV** growth (not totalAssets — deposits do not move NAV). Coincident proxy of inference demand, **not** AskSurplus itself and **not** a yield promise. Flat NAV ≠ “zero demand” (harvest lag). Needs SQLite samples from prior **`watch --once`** runs (`status` / `monitor` do not insert `metric_snapshots`).

### 6.2 Basis — secondary market vs NAV

```sh
node dist/cli/index.js loop basis --market-price 0.97 --json
```

`basis = (market − NAV) / NAV` in bps. Market price is **operator-supplied** in v1 (CLI or config) — not Morpho oracle (oracle tracks NAV). **Discount** = stress/illiquidity **and** possible edge; tool cannot tell which. **Not** a trade recommendation. Optional advisory WARN/CRITICAL on large discounts still exit `0` (jq the JSON if you care).

---

## 7. Recommended operator loop

1. **Seed history:** periodic `watch --once` so vault APY and demand windows fill (only path that persists metric snapshots).
2. **Danger page:** `monitor` on a short cron with the §2.3 recipe + dead-man’s-switch.
3. **Size / capacity:** `loop sizing --from-chain` and `loop capacity --from-chain` before any capital plan; treat only `candidate` + `authoritative: true` as verified under the model.
4. **Brief:** `loop brief --from-chain` for recurring deltas (same template fingerprint).
5. **Before leverage changes out-of-band:** `loop simulate --action exit --live` (and readiness/proof when bringing up an executor).
6. **Never** treat nominal `0` or a sizing `candidate` as automated protection or permission to broadcast.

---

## 8. Honesty reminders

- The tool **holds no position** and **takes no protective action**.
- Broadcast stays disabled pending [audit-gate.md](./audit-gate.md).
- `candidate` / capacity / brief / demand / basis are **decision-support**, not investment advice.
- Gate **confirmed danger** on `monitor` exit **30**, not on vault-only commands.
- Large capital still needs independent diligence, fork proofs, and operational ownership of out-of-band actions.
