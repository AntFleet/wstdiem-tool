# SPEC007 — wstDIEM basis: market price vs NAV

**Status: REVIEWED + LOCKED (2026-07-13).** Two-agent pre-code gate (technical critic REVISE + product
analyst ACCEPT-WITH-RESERVATIONS) → fixes folded → focused confirmation ACCEPT-WITH-RESERVATIONS →
residual Majors M1–M3 folded → LOCKED. Ready for implementation.

> **Forward spec** (authored before implementation; acceptance criteria = the tests to write).
> Decision-support only (SPEC001 A3 / OQ#6). Surfaces the secondary-market **premium/discount vs
> intrinsic NAV** — a de-peg / stress signal and a below-NAV edge — **not** free edge and **not**
> investment advice.

## 1. Problem & scope

The founder sells wstDIEM on a secondary marketplace, creating a market price distinct from vault
NAV. Nobody else publishes the **basis** systematically:

```text
basis = (marketPrice − NAV) / NAV
```

- **Discount** (`basis < 0`): market below NAV — **stress/illiquidity first**, possible edge second.
  The tool **cannot tell which**. Never collapse to “buy.”
- **Premium** (`basis > 0`): market above NAV — secondary prints above intrinsic; expanding via
  secondary pays above NAV. Observation only (no “prefer mint” instruction).

**Why not the Morpho oracle.** Morpho’s oracle tracks NAV by design (`computeOracleDeviation`).
Oracle-vs-NAV is ~0 and is **not** an independent secondary market signal. Using the oracle as
`marketPrice` is a **spec defect**.

**Scope (v1).**

| Surface | Job |
|---|---|
| **`loop basis`** | Live NAV from chain; market price via **pluggable operator-supplied seam**; basis bps + gloss + advisory alerts. |
| **Pure math** | `src/metrics/basis.ts` |
| **Config** | `basis.marketPriceDiemPerWstDiem` + discount thresholds |
| **Thresholds** | Config-driven discount WARN/CRITICAL (absolute bps of discount) |

**Out of scope (v1).** Live marketplace/DEX feed; Curve spot as default; Morpho oracle as market;
auto trade; brief attach; `monitor` / `readinessAlerts` / `evaluateAlerts` / `exitCode.ts` wiring.

**Lexicon (normative).**
- Use **"secondary-market basis (market vs NAV)"**, **premium** / **discount**.
- Ban **affirmative claims**: “free money”, “free edge” (as a claim), “risk-free discount”,
  “arbitrage guaranteed”, “oracle price is market”, “deploy into the discount”, “buy now”,
  “buy the discount”.
- Allowed: decision-support phrasing that stress/illiquidity **and** edge are both possible.

## 2. Inputs & scale

### 2.1 NAV resolution (`resolveNavForBasis`) — fail-closed

```text
navConvert = convertToAssets(1e18) if read succeeds else null
navTotalsResult = computeNav(totalAssets, totalSupply)  // may be source "empty" → WAD placeholder

if navConvert !== null && navConvert > 0n
   && totalSupply > 0n && totalAssets > 0n:          // empty vault not a live basis denom
  nav = navConvert
  navSource = "convertToAssets"
  if navTotalsResult.source === "onchain" && navTotalsResult.nav > 0n
     && navTotalsResult.nav !== navConvert:
    warning "nav-source-mismatch"  // warning only; arithmeticComplete still true when math OK
else if navTotalsResult.source === "onchain"
     && navTotalsResult.nav > 0n
     && totalSupply > 0n && totalAssets > 0n:
  nav = navTotalsResult.nav
  navSource = "totalAssets/totalSupply"
else:
  nav unavailable  // NEVER use source==="empty" / makeEmptySnapshot.nav / WAD placeholder alone
```

`navTotals` field on the result always carries the onchain totals NAV string when available (for
cross-check display), or null.

**Do not** trust `MetricSnapshot.nav` alone (`snapshot.nav` is always totals-path and may be empty
placeholder). Keep basis resolution **local** to the basis module; do not change MetricSnapshot
`navSource` enum (`empty`|`onchain`).

### 2.2 Market price seam

```ts
type MarketPriceSourceKind = "cli-flag" | "config" | "unavailable";
// Future only (not v1): "curve-spot" | "marketplace-feed"

interface MarketPriceInput {
  kind: MarketPriceSourceKind;
  marketPriceDiemPerWstDiem?: bigint; // WAD; absent when unavailable
}
```

**Precedence:** `--market-price` → else config non-null → else unavailable.

**Parse:** decimal DIEM per wstDIEM → WAD via `parseDecimalToUnits`. Must be `> 0`. Zero/negative/non-decimal → `INVALID_INPUT`.

**Config (always present on AppConfig):**

```ts
// domain + defaults + zod
basis: {
  marketPriceDiemPerWstDiem: string | null; // quoted decimal string only, e.g. "0.97"
}
thresholds: {
  ...
  basisDiscountWarnBps: number;      // default 100; int >= 1
  basisDiscountCriticalBps: number;  // default 500; int >= warn
}
```

YAML: **quoted** strings for market price (`"0.97"`). Unquoted floats rejected or stringified only
via explicit zod preprocess that preserves decimal text — pin: **z.string().nullable()** matching
`parseDecimalToUnits` when non-null.

Zod: `basisDiscountWarnBps` / `Critical` = `z.number().int().min(1)`;
`superRefine(critical >= warn)`.

### 2.3 Forbidden sources

Morpho oracle, invented mid price, SQLite NAV history as market.

## 3. Formula

```text
if nav <= 0n or market missing → basis unavailable (nulls)
delta = marketPrice - nav
basisFraction = delta >= 0 ? ratio(delta, nav) : -ratio(nav - marketPrice, nav)
basisBps = Math.round(basisFraction * 10_000)
```

Never `ratio(_, 0n)`.

**Anchors:** 0.95/1.00 → −500; 1.05/1.00 → +500; equal → 0 (flat, not n/a).

**Machine gloss enum (JSON only — not paste):**

| Condition | `basisGloss` |
|---|---|
| n/a | `null` |
| `basisBps < 0` | `"discount-stress-and-edge-proxy"` |
| `basisBps > 0` | `"premium-secondary-above-nav"` |
| `0` | `"flat-at-nav"` |

## 4. Alerts (basis command only)

When both market and NAV available:

| Condition | Level |
|---|---|
| `basisBps <= -basisDiscountCriticalBps` | CRITICAL |
| `basisBps <= -basisDiscountWarnBps` (else) | WARN |
| else | none |

Alert only when `basisBps < 0` **and** `basisBps <= -threshold` (flat never alerts).

**Full `AlertEvaluation` pin:**

```ts
{
  alertKey: "basis_discount",
  level: "WARN" | "CRITICAL",
  message:
    "ADVISORY: secondary-market discount {absBps} bps (stress/illiquidity and possible edge; tool cannot tell which). " +
    "market {m} / NAV {n} DIEM per wstDIEM. Source: operator-supplied ({cli-flag|config}) — not a verified live market print. " +
    "Act out-of-band if desired; tool does not trade.",
// Human paste/alert use absBps = Math.abs(basisBps); JSON basisBps stays signed.
  suggestedAction: "Act out-of-band if desired; tool does not trade or expand.",
  cooldownSeconds: 3600,
  metrics: {
    basisBps,
    marketPriceDiemPerWstDiem: string,
    nav: string,
    marketPriceSource: "cli-flag" | "config",
  },
}
```

Implement in `evaluateBasisAlerts` in `src/metrics/basis.ts` — **not** `evaluateAlerts` /
`readinessAlerts` / `exitCode.ts`.

**Exit codes:** `0` success (including n/a and including alerts present); `1` invalid input / tool error.
Not a SPEC004 monitoring command.

## 5. Result shape

```ts
interface LoopBasisResult {
  nav: string | null;
  navSource: "convertToAssets" | "totalAssets/totalSupply" | "unavailable";
  navTotals: string | null;
  marketPriceDiemPerWstDiem: string | null;
  marketPriceSource: MarketPriceSourceKind;
  basisBps: number | null;
  basis: number | null;
  basisGloss: string | null;
  alerts: AlertEvaluation[];
  blockNumber: string | null;
  arithmeticComplete: boolean;  // inputs present + math OK
  authoritative: false;         // always false in v1 (no live market feed)
  decisionSupportOnly: true;
  notATradeRecommendation: true;
  basisKind: "secondary-market-vs-nav";
  modelCaveats: string[];
  disclaimer: string;
  pasteLine: string;
  warnings: string[];
}
```

**`authoritative`:** always `false` in v1. **`arithmeticComplete`:** true when `basisBps !== null`
and navSource is convert or totals (onchain path) and market is cli/config.

**Always-on `modelCaveats`:**
`operator-supplied-market-price`, `secondary-not-morpho-oracle`,
`discount-dual-signal-stress-and-edge`, `nav-point-in-time`, `basis-not-trade-recommendation`,
`thresholds-unvalidated-secondary-spreads`, `no-market-price-timestamp`,
`v1-not-authoritative-market`.

**`disclaimer` (fixed):**

> `"Secondary-market basis (market price vs vault NAV) is decision-support only — not investment advice and not a trade recommendation. A discount can reflect stress/illiquidity or a genuine edge; the tool cannot tell which. Morpho oracle tracks NAV and is not used as market price. v1 market input is operator-supplied and may be stale. The operator must decide and act out-of-band."`

**Paste templates (normative — no banned tokens):**

| State | pasteLine |
|---|---|
| Discount | `Secondary-market basis: {absBps} bps discount (stress/illiquidity and possible edge; tool cannot tell which) · market {m} / NAV {n} DIEM per wstDIEM · source operator-supplied — decision-support only; not a trade recommendation` |
| Premium | `Secondary-market basis: {absBps} bps premium (secondary prints above NAV; not cheap intrinsic) · market {m} / NAV {n} DIEM per wstDIEM · source operator-supplied — decision-support only; not a trade recommendation` |
| Flat | `Secondary-market basis: 0 bps flat at NAV · market {m} / NAV {n} · source operator-supplied — decision-support only; not a trade recommendation` |
| n/a | `Secondary-market basis: n/a · market and/or NAV unavailable — decision-support only; not a trade recommendation` |

## 6. CLI (single contract — no debate)

```text
loop basis
  --market-price <decimal>   # optional if config set; > 0
  --json
```

- **No `--nav` flag in v1.** Unit tests call pure `computeBasis` / `resolveNavForBasis` mocks.
- Live NAV reads are **independent** `readContract`s (not atomic `collectVaultMetrics` alone —
  convert throw must not drop totals). Pattern: attempt totals + convert separately; then pure
  `resolveNavForBasis({ totalAssets, totalSupply, navConvert })`. Optional vault `asset()==DIEM`
  check. Do not change MetricSnapshot semantics.
- No RPC / vault fail / missing vault → `navSource: "unavailable"`, `basisBps: null`, **exit 0**.
- Market present + NAV missing → exit 0, basis n/a (do not invent NAV).
- Invalid market price → `INVALID_INPUT` exit 1.
- Hermetic tests: clear `BASE_RPC_URL` / offline config (HANDOFF dotenv gotcha).
- After NAV reads, set `blockNumber` from client `getBlockNumber()` when available.
- Banner always:  
  `Secondary-market basis (market vs NAV) — decision-support only. Discount can be stress/illiquidity or edge; tool cannot tell which. Morpho oracle is not market price. OPERATOR-SUPPLIED MARKET PRICE in v1 — not a live feed; may be stale.`

**Files to touch:** `src/metrics/basis.ts`, `src/types/domain.ts`, `src/config/defaults.ts`,
`src/config/load.ts`, `src/cli/index.ts`, `src/cli/output.ts`, `test/basis.test.ts`,
`test/config.test.ts` if needed.

**Do not touch:** `exitCode.ts`, `evaluateAlerts.ts`, `readinessAlerts.ts`, monitor classification.

## 7. Fail-closed & honesty

1. No market / no valid NAV → null basis, never 0-as-missing.
2. Empty vault / empty snapshot NAV never used as denominator.
3. Discount dual framing stress-first on all human surfaces.
4. Oracle never market.
5. Operator-supplied + may-be-stale always labeled.
6. `authoritative` always false in v1.
7. Alerts advisory (exit 0); message not a buy signal.

## 8. Acceptance criteria

1. market 0.95 / nav 1.00 → `basisBps === -500`, gloss discount-stress-and-edge-proxy.
2. market 1.05 / nav 1.00 → `+500`, gloss premium-secondary-above-nav.
3. market === nav → `0`, flat (not n/a).
4. No market → `basisBps === null`, no alert.
5. No valid NAV (empty supply/assets) → null basis even if computeNav returns WAD.
6. `basisBps === -500`, critical 500 → CRITICAL; alert/paste human text uses `500 bps discount` (abs).
7. `basisBps === -100`, warn 100, critical 500 → WARN.
7b. nav-source-mismatch → warning present, basis still computed, `arithmeticComplete === true`.
8. `basisBps === -99` → no alert; `basisBps === 0` → no alert.
9. Premium +500 → no alert.
10. JSON: bigint strings; honesty fields; paste templates; `authoritative === false`; caveats present.
11. CLI: no RPC + no market → n/a exit 0; `--market-price 0` → exit 1; hermetic env.
12. CLI flag overrides config when both set.
13. No oracle import/call for market on CLI path.
14. convert preferred; mismatch warning; empty vault unavailable.
15. Ban-list AC on full paste + alerts (claim phrases).
16. Alert message includes operator-supplied + dual framing + act out-of-band.
17. Discount paste contains stress/illiquidity and edge; premium paste not discount-only.
18. Do not modify exitCode / evaluateAlerts / readinessAlerts.
19. zod: critical < warn rejected; warn min 1.
20. Suite green.

## 9. Open questions (resolved)

- **[OQ-A — RESOLVED]** Defaults 100/500 provisional + `thresholds-unvalidated-secondary-spreads`.
- **[OQ-B — RESOLVED]** No monitor fold in v1.
- **[OQ-C — RESOLVED]** No Curve spot default.
- **[OQ-D — RESOLVED]** No offline `--nav` CLI flag.

## 10. Traceability

`test/basis.test.ts`. Roadmap Phase 8.

## 11. Review-gate log

| Pass | Agents | Verdict | Folded |
|---|---|---|---|
| Pre-code #1 | technical critic + product analyst | REVISE + AWR | resolveNav empty/WAD ban; single CLI contract; paste ban-safe + dual/source templates; authoritative always false + arithmeticComplete; full AlertEvaluation; zod/defaults/AppConfig; threshold min1 + equality ACs; always-on caveats; stress-first gloss; no evaluateAlerts/exitCode; OQ lock |
| Confirmation | focused critic | **ACCEPT-WITH-RESERVATIONS** | M1 mismatch warning-only (not arithmeticComplete false); M2 independent readContracts for convert-fail→totals; M3 human absBps vs signed JSON basisBps |
