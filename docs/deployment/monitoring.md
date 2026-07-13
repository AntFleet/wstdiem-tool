# Operator Monitoring

> **Start here for the full operator on-ramp:** [operator-runbook.md](./operator-runbook.md)
> (sizing → monitor exit codes → liquidation → exit rehearsal → intelligence commands).

Use the monitor command for a one-shot live dashboard of wstDIEM vault supply/assets, Curve liquidity, Morpho liquidity, deployed executor status, owner position, Morpho authorization, and live liquidation readout (SPEC005).

```sh
export BASE_RPC_URL="https://mainnet.base.org"
npm run build
node dist/cli/index.js monitor
```

> Invoke `node dist/cli/index.js monitor` directly from a scheduler — **not** `npm run monitor:live`.
> `npm run` wraps any non-zero exit in an alarming `npm ERR!` stack and can mangle the propagated
> code, so a routine `warn` looks like a crash.

## Scheduler exit-code contract (SPEC004)

`status`, `watch --once`, and `monitor` set a severity-ordered process exit code so a cron/systemd
keeper can gate on `$?`:

| Code | Class | Meaning |
|---|---|---|
| `0` | `nominal` | live position assessed; no WARN/CRITICAL alert. **NOT a safety guarantee** — only that no configured alert threshold was breached this tick; the tool holds no position and provides no automated liquidation protection. |
| `1` | `tool-error` | the tool failed to run (invalid input, usage error, `NOT_IMPLEMENTED`, uncaught error). |
| `10` | `warn` | assessed; worst finding is a WARN-level alert. |
| `20` | `indeterminate` | the tool **could not assess** the live position this tick (RPC unreachable, wrong chain, no RPC configured, or a partial read where the position/market reads did not complete). Stateless / per-tick. |
| `30` | `critical` | assessed **and** a CRITICAL-level alert fired — confirmed danger requiring out-of-band action now. |

The `--json` `data` additionally carries `outcome` and `exitCode`; `$?`, `data.exitCode`, and
`data.outcome` always agree.

> **Gate danger on `monitor` — not `status`/`watch --once`.** `monitor` is the only command that reads the
> position/Curve/Morpho/oracle state a danger `critical (30)` requires. `status` and `watch --once` are
> lightweight **vault-liveness snapshots** (block header + vault NAV only); their reachable codes are
> **`{0, 10, 20}`** — `10` only from a stale-but-readable RPC, `20` when the vault read did not complete — and
> they **never** emit `30`. A `0` from them attests vault-liveness, not position safety. Schedule `monitor` for
> the `-ge 30` gate below; use `status`/`watch --once` only for a liveness/`indeterminate` signal.

Canonical gating recipe:

```sh
node dist/cli/index.js monitor; rc=$?
case $rc in
  30) page "wstDIEM CRITICAL — act out-of-band now" ;;         # confirmed danger
  20) count_and_escalate "indeterminate (blind this tick)" ;;  # page on N consecutive
  10) log "warn — review" ;;
  1)  page "wstDIEM monitor FAILED TO RUN — fix the invocation" ;;  # do NOT let it go silent
  0)  : ;;  # no configured alert breached this tick (NOT a safety guarantee)
esac
```

Two non-obvious hazards to design around:

- **`tool-error (1)` is not `-ge`-gateable.** It sits below `warn (10)`, so a persistently broken
  invocation (config typo / missing env after a deploy) exits `1` every tick and is missed by
  `-ge 20`/`-ge 10` → silent monitoring death. Gate it explicitly (`rc -eq 1`) and/or route it to
  the scheduler's own failure handling. Do **not** gate with shell truthiness (`if monitor; then …`) —
  it collapses `1/10/20/30` into one indistinguishable "failure."
- **No exit code covers "the tick never ran"** (host down / cron disabled). Pair the schedule with a
  **dead-man's-switch / heartbeat** (a missed-run alarm) — `$?` cannot tell you the job didn't fire.

`indeterminate (20)` is per-tick and stateless: `watch --once` has no cross-tick memory, so
distinguishing a transient RPC blip from a sustained outage (and any flap hysteresis) is the
scheduler's job.

Optional owner and executor overrides:

```sh
node dist/cli/index.js monitor \
  --owner "0x..." \
  --loop-executor "0x..."
```

To emit monitor alerts to configured stderr, webhooks, and Telegram:

```sh
node dist/cli/index.js monitor --alert
```

Telegram config is read from `config.yaml`:

```yaml
alerts:
  telegram:
    botTokenEnv: WSTDIEM_TELEGRAM_BOT_TOKEN
    chatId: "123456789"
```

Then set the token in the environment:

```sh
export WSTDIEM_TELEGRAM_BOT_TOKEN="..."
```

The vault row tracks the configured wstDIEM vault:

- vault / wstDIEM: `0xe49FA849cB37b0e7A42B2335e333fb99474167ba`
- asset / DIEM: `0xF4d97F2da56e8c3098f3a8D538DB630A2606a024`
- total wstDIEM supply
- total DIEM assets
- `convertToAssets(1 wstDIEM)` NAV

Monitor alerts intentionally ignore the closed production audit gate. They alert on actionable live-state blockers only: unavailable RPC, missing or unhealthy wstDIEM vault, empty Curve liquidity, empty Morpho supply, missing/no-code/mismatched executor, missing owner position, and missing Morpho executor authorization.

When the monitor flags **empty Curve liquidity**, `loop sizing --from-chain` will fail closed (`FROM_CHAIN_SEED_BLOCKED: Curve pool has zero DIEM and wstDIEM depth`) rather than seed a verdict against an empty pool — this is expected. See [loop-sizing.md](loop-sizing.md#live-seeding---from-chain) for the fail-closed triggers and how to rehearse against a drained pool with explicit Curve legs.
