# SPEC011 — `diem yield`: DIEM-holder route comparison

**Status: REVIEWED + FOLDED (critic REVISE + analyst AWR, 2026-08-18).** Unparked 2026-08-18: measured-anchor post has led
(`@_aug11_` 2026-08-18), SPEC008 rev-2 prints realized windows, SPEC003 rev-4 fail-closes Morpho
leftover. Two-agent gate on the 2026-07-16 draft was **both REVISE**; this document **is** the
rev-2 fold. Do not implement until this revision is LOCKED.

Author: 2026-07-16. Rev-2: 2026-08-18.

> **One-line:** a read-only, decision-support comparison of four DIEM-holder routes. It **does not**
> find the “best” yield. It prints each route with a tier tag. The vault number is **REALIZED NAV
> growth** (SPEC008 rev-2), never a forward yield promise.

**Canonical terms (2026-08-22).** [docs/deployment/resource-ladder.md](docs/deployment/resource-ladder.md).
Venice credit is `$1/day per DIEM` only if spent; `$0` token yield if unused. wstDIEM is rebase-free
(NAV / `convertToAssets`). Loop spread is modeled/realized NAV minus Morpho borrow and execution costs —
not a coupon. This command does not broadcast or protect a position.

## 0. Rev-2 fold (must remain true in the body)

| # | Finding | Fold |
|---|---|---|
| 1 | No `depositFeeBps` getter (only `yieldFeeBps`) | **Drop** all “net of depositFeeBps” claims. No live entry-fee read. Optional footnote: one-time entry cost is **not** a getter and is **not** subtracted from the annualized figure. |
| 2 | One-time fee ≠ annual % | No subtraction. No amortization in this command (sizing.ts already has that; do not reuse here as a “net yield”). |
| 3 | Don’t headline NAV velocity as “yield” | Headline = SPEC008 **realized** window (`windowKind === "realized"`). Label **REALIZED NAV growth**, `notAYieldPromise`. Default `--window-hours 552` (23d). 72h demand-proxy is **not** this command’s headline. |
| 4 | Loop book leftover / Curve unread | Loop row is **not currently enterable** when `seedFromChain` throws `FROM_CHAIN_SEED_BLOCKED` (SPEC003 rev-4). Print live supply/borrow/block from `CliError.data`. **No** 1.5× net APY. **No** “opens when the book fills” / “will open.” |
| 5 | Marketed numbers amplify | Marketed **footer** only when vault row is `ok`. Locked line, **no Δ**, no `deltaVsLow`/`deltaVsHigh`. Never a 5th route row. Live claim is **7-12% APR** (`@_proxystudio` 2026-08-18). Historical 21%/56% off unless `historicalMarketed: true`. |
| 6 | Advice-shaped | Kill “opportunity finder”, “best”, “recommended”, “winner”, “leads with the contrast.” Neutral row order. Ban-list AC. |
| 7 | Credit one-poled | Both poles on the same line: credit is real **if spent**; **$0 token yield** if not. Routes are complementary by holder type. Do not knock Venice. |
| 8 | Sequencing | Measured post leads — **done**. This command follows. |

Also folded from 2026-08-18 reality: Surplus (`@AskSurplus`) is a **third party**, not Liquid;
compounding is the **keeper**, not an agent (AUTONOMOPOLY still dark). Do not claim either.

## 1. Problem & scope

A DIEM holder can:

1. Hold idle — 0 token yield.
2. Stake on Venice for API credit — **$1/day per DIEM** (STATED utility; token has no
   `rewardRate` / `stakingApr` / `creditPerDiemPerDay` view — all revert, 2026-07-16 probe).
3. Deposit DIEM into the wstDIEM vault — NAV ratchets when the keeper credits harvested
   Surplus proceeds. The tool **measures** that ratchet (SPEC008).
4. Loop wstDIEM on Morpho — **not currently enterable** on the live leftover 86% book
   (SPEC003 rev-4, verified 2026-08-18: 0.00052 / 0.00052 DIEM).

**In scope:** top-level `diem yield [--diem <amount>] [--diem-usd <price>] [--window-hours <n>]
[--json]`. Compose existing modules. **Out of scope:** new safety logic, broadcast, a DIEM/USD
oracle, `--flows`, SPEC010-B, deriving `depositFeeBps`, `--since`.

## 2. Tiers (normative)

| Tier | Meaning |
|---|---|
| MEASURED | On-chain arithmetic this tool already computes (NAV, realized window). |
| STATED | Documented protocol constant, not a chain read. |
| MODELED | Sizing engine output **only if** `--from-chain` seed succeeds. |
| UNAVAILABLE | Seed blocked / series not ok. Show the refuse, not a stand-in 0 or marketed %. |
| MARKETED | External claim. Audit line only. Never a row’s primary number. |

## 3. Command

```
diem yield
  --diem <amount>          # default 1; scales $ / wallet notions, not percents
  --diem-usd <price>       # optional; credit %-equivalent only
  --window-hours <n>       # integer 169..840; default 552 (23d). 1..168 → INVALID_INPUT
  --json
```

`--window-hours` **must** be a realized window (`> 168`). This command does not speak demand-proxy.
Reuse `MAX_WINDOW_HOURS = 840`, `MAX_DEMAND_PROXY_WINDOW_HOURS = 168`.

`--from-chain` live tip for demand is **on** (memory-only, same as `loop demand --from-chain`).
Loop seed is `--from-chain` always (no offline fantasy loop APY).

Exit: 0 when the table renders (including UNAVAILABLE loop / n/a vault). 1 on bad flags / RPC
hard-fail that is not the leftover refuse (leftover is a **row**, not a process failure).

### 3.1 Rows (fixed order — not a ranking)

1. **Hold idle** — `0` token yield. No tier theater.
2. **Stake for credit (Venice)** — STATED.  
   Always: `$1/day per DIEM (API credit if spent; $0 token yield if unused)`.  
   With `--diem-usd`: also `upper-bound {365/price}% only if the credit is fully used`.  
   Screenshot-safe: the “if spent / if unused” pair is on the **same line** as the $1/day.
3. **wstDIEM vault (unlevered)** — MEASURED or UNAVAILABLE.  
   Number = `buildLoopDemand` at the realized window + live tip.  
   Print SPEC008 realized paste fields: bps, `(pct)%`, observed hours, configured hours,
   sample count, NAV start→end, `authoritative` (will be false).  
   Live NAV via `convertToAssets(1e18)`.  
   If `current.status !== "ok"`: `n/a (status, samples N)` — never 7–12, never 21, never 0-as-missing.
4. **wstDIEM loop (levered)** — MODELED or UNAVAILABLE.  
   Attempt `seedFromChain` + size 1.5× at `--diem` (single scenario).  
   If `FROM_CHAIN_SEED_BLOCKED` leftover: UNAVAILABLE, locked leftover message (or the
   `morphoDustBlockedMessage` string), `CliError.data` wei + block. **No net APY.**  
   If seed succeeds: MODELED net APY / HF / liq buffer from SPEC002; label `modeled, not a
   deploy recommendation`; do **not** subtract a deposit fee.

Then, **only if** vault row is MEASURED/`ok` — **footer, not a 5th row**:

```
marketed 7-12% APR (external, @_proxystudio 2026-08-18) vs realized {bps} bps ({pct}%) over observed {h}h
```

No `Δ`. No range-edge deltas. `--json.rows.length === 4` always. `audit` is `null` or
`{ tier: "MARKETED", source, claim, line }`. `historicalMarketed` default **false**.

### 3.2 Locked copy

**Banner (exact):**

```
DIEM route comparison. Decision-support only; not advice; not a ranking. Vault figure is REALIZED NAV growth, not a forward yield. Surplus is a third party; compounding is the keeper, not an agent.
```

**Vault cell when ok:** reuse SPEC008 realized `pasteLine` (do not invent a third template).

**Loop leftover cell:** reuse SPEC003 rev-4 `morphoDustBlockedMessage` (do not invent a second
leftover sentence).

MUST-NOT anywhere in stdout/JSON strings: `best`, `recommended`, `winner`, `opportunity`,
`opens when`, `will open`, `soon`, `agent`, `autonomous`, `deploy up to`, `demand is up`,
`APY you will earn`, presenting 7–12 / 21 / 56 as MEASURED.

### 3.3 Disclaimer

Vault row carries SPEC008 `REALIZED_DISCLAIMER` (verbatim). Command banner is §3.2. Do not
lead with SPEC008 demand-proxy disclaimer.

## 4. Integration (reuse only)

| Signal | Source |
|---|---|
| Realized NAV window | `buildLoopDemand` + `demandLookbackStart` + sqlite `listNavSamplesForWindow` + live tip (`collectVaultMetrics` / `convertToAssets`) — same path as `loop demand --from-chain` |
| Live NAV | `convertToAssets(1e18)` |
| Loop enterability / 1.5× | `seedFromChain` + `buildLoopSizingReport` (one leverage). Catch leftover; do not fail the process |
| Credit $1/day | config constant + citation, not a chain read |
| Marketed claims | config list + citation; default one row (7–12%) |
| Deposit fee | **not read** |

New files: `src/metrics/diemYield.ts` (pure compose), `renderDiemYieldTable` in `output.ts`,
`diem yield` in `src/cli/index.ts`. Config keys under `diemYield:` with defaults in
`src/config/defaults.ts` so missing YAML still runs.

`--json` envelope: `{ banner, windowHours, windowKind, rows[], audit, disclaimer, notAdvice: true }`.
Each row: `{ id, label, tier, primary, extras }`. Bigints as strings.

## 5. Fail-closed

1. Unanchored / not-ok realized window → vault `n/a`, **no** marketed audit line.
2. Leftover Morpho → loop UNAVAILABLE, leftover string, no 1.5× APY.
3. No `--diem-usd` → no credit %.
4. `--window-hours` ≤ 168 or > 840 or non-integer → `INVALID_INPUT`.
5. RPC down (not leftover) → exit 1, no table pretending chain was read.
6. Do not write sqlite. Live tip memory-only.

## 6. Acceptance

1. Four route rows in the fixed order + audit line **only** when vault is ok.
2. Vault ok → realized pasteLine present, `windowKind === "realized"`, `notAYieldPromise`,
   `authoritative === false`; number matches `buildLoopDemand` at the same window.
3. Vault not-ok → `n/a`, no 7–12 / 21 / 56 in that cell; no audit line.
4. Credit line always has both poles; `--diem-usd 1400` → `%` + “only if fully used” same line;
   without flag → no %.
5. Leftover fixture (supply `520023189765570`) → loop UNAVAILABLE, Morpho message, no net APY;
   process exit 0.
6. Healthy Morpho + Curve fixture → loop MODELED 1.5× row has HF + liq; labeled modeled; no
   deposit-fee netting fields.
7. `--window-hours 72` → INVALID_INPUT. Default is 552. 840 accepted.
8. Ban-list on full stdout (superlatives + leftover-predictive + agent + marketed-as-measured).
9. `--diem 10` scales $ notions linearly; percents unchanged.
10. `--json` every row has `tier`; no `depositFeeBps` field.
11. `exitCode.ts` untouched.
12. Help text: hours, `23d=552`, `35d=840`, “not advice”, no “opportunity.”

## 7. Open questions (rev-2 resolutions)

- **[OQ-A — RESOLVED]** Credit %-equivalent only with `--diem-usd`, both poles on the same line.
- **[OQ-B — RESOLVED]** Marketed line is an **audit**, gated on measured-ok. Default claim is
  the live 7–12% APR, not 21/56.
- **[OQ-C — RESOLVED]** Loop is a single 1.5× attempt; leftover → UNAVAILABLE, not a grid.
- **[OQ-D — RESOLVED]** Command name stays `diem yield` (continuity). Description/banner do not
  say “yield finder.” Vault cell does not say “yield.”

## 8. Traceability

- Grounding 2026-07-16: DIEM views revert; NAV 1.0118 then.
- Live 2026-08-18: NAV 1.016016793; realized 552h = 529 bps / 5.29%; 840h = 606 bps / 6.06%;
  Morpho leftover 0.00052/0.00052; founder 7–12% APR tweet.
- Reuses SPEC002 / SPEC003 rev-4 / SPEC007 seam / SPEC008 rev-2.
- SPEC011.md was untracked/PARKED; rev-2 is the document that may land on `main` with the impl.

## 9. Implementation lock (post-gate folds)

### Catch leftover only

Inside the action (so `runAction` does not turn it into a process fail):

```
error instanceof CliError
  && error.code === "FROM_CHAIN_SEED_BLOCKED"
  && error.data is object with dustFloorWei
```

→ loop row UNAVAILABLE, reuse `morphoDustBlockedMessage` + `data` wei/block, **exit 0**.

Every other `FROM_CHAIN_SEED_BLOCKED` (RPC, chainId, no-code, Curve empty, `get_dy`)
**rethrows** → exit 1, no table. Healthy Morpho + empty Curve is **not** a leftover row.

Vault live-tip RPC failure is swallowed like `loop demand --from-chain` (sqlite still
prints). Loop-seed RPC failure is exit 1.

### Loop compose

```
buildFromChainSizingReport({
  options: { initialDiem: String(--diem), targetLeverage: "1.5", vaultApyBps: String(realizedVelocityBps) },
  explicitFlags: all false except vaultApyBps true when we inject realized bps,
  store, client, planningBlock undefined
})
```

`--diem` = `initialDiem`. Default `--diem` 1. AC9 linear-scale applies to Hold / Venice / Vault
$ notions; loop MODELED APY **may** move with size. If vault window is not `ok`, do not inject
1500 bps — loop MODELED is refused (`UNAVAILABLE: no realized window to seed vault APY`) even
if Morpho seeds. If seed succeeds and sizing `blocked`, still print the blocked MODELED row
(HF / blockers), labeled modeled.

Commander: `program.command("diem").command("yield")` — never `.command("diem yield")`.

Parse: `--diem` via existing decimal amount parse; `--diem-usd` via `parseStrictFloat` > 0.

### Config (all three files + example)

```
diemYield:
  creditUsdPerDiemPerDay: 1
  creditCitation: "Venice documented constant; DIEM token views revert (2026-07-16)"
  marketedClaim: "7-12% APR"
  marketedSource: "@_proxystudio 2026-08-18"
  historicalMarketed: false
```

Add to `AppConfig`, `DEFAULT_CONFIG`, `configSchema` (Zod 3 strips unknown keys). Default
run must not print `21` or `56`.

### On-wire JSON

`jsonEnvelope(config, "diem yield", payload)`:

```
payload = {
  banner,                    // §3.2 exact
  windowHours,
  windowKind: "realized",
  rows: [hold, venice, vault, loop],  // length 4
  audit: null | { tier: "MARKETED", source, claim, line },
  disclaimer,                // REALIZED_DISCLAIMER when vault ok, else command banner
  notAdvice: true
}
row = { id, label, tier, primary, extras }
```

`primary` is the screenshot string:
- Venice: full both-poles sentence; with `--diem-usd` also contains `upper-bound` and
  `only if fully used`.
- Vault ok: SPEC008 realized `pasteLine` (contains `REALIZED NAV growth`, bps, `%`, hours).
- Loop leftover: leftover message.

### Extra ACs

13. First human stdout line === §3.2 banner. `--json.data.banner` same.
14. Default run stdout matches `552h` and `23d`. `--window-hours 840` matches `840h` and `35d`.
15. `rows.length === 4`; `audit` null when vault not-ok; when ok, `line` is the locked
    marketed sentence and contains no `delta` / `Δ`.
16. Leftover identified by `dustFloorWei`; Curve-empty fixture (healthy Morpho + 0/0 Curve)
    is **not** swallowed as leftover (process exit 1 or uncaught).
17. No-yaml / default config stdout+JSON have no `21` and no `56`.
18. Help one-liner contains `route comparison`, `not advice`, `23d=552`, `35d=840`; no
    `opportunity`, `best`, `finder`, `7-12`.
19. Do not change `DEFAULT_VELOCITY_WINDOW_HOURS` or `exitCode.ts`.
