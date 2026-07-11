# `wstdiem-loop-manager` Technical Specification (rev-2)

> **Status — 2026-07-11.** This describes the **shipping tool**: an **offline-first, exit-only,
> broadcast-disabled** operator CLI for monitoring wstDIEM loop positions and running conservative,
> evidence-gated simulations ("rehearsals") of the exit path. **It executes no state-changing action
> — monitor-and-rehearse only** (§5). Broadcast is fail-closed at two independent layers and stays
> disabled pending a production executor audit. Behaviour that
> is specified but **not** in the current tool — the multi-action executor (`open`/`rebalance`),
> broadcast enablement, the auto-deleverager, a persistent watch daemon/TUI, and hardware-wallet
> signing — lives in **Appendix A (Deferred)**, not the main body.
>
> rev-2 reconciles the original spec against the as-built CLI; see
> [`docs/spec/SPEC001-reconciliation.md`](docs/spec/SPEC001-reconciliation.md) for the clause-by-clause drift ledger.

Source revision: the on-chain wstDIEM/DIEM v6 redeploy on Base (live 2026-06-10; addresses in §7).
Upstream contract anchors are the Liquid-Protocol vault sources; the tool consumes them read-only.

Important source-derived constraints:

- `InferenceVault` does not expose `totalShares()`. Use ERC-20 `totalSupply()` as total shares.
- `InferenceVault.creditDIEM(uint256)` emits no custom event. The tool infers credits from
  `FeeRouter` harvest events, vault DIEM balance / `totalAssets()` deltas, and ERC-20 `Transfer`
  logs into the vault.
- Vault-specific deployed addresses are config-required (pinned in §7).

## 1. Data Sources

### Contract Interfaces

The tool reads the interfaces it actually consumes. ABIs live in `src/abi/`.

```ts
type Address = `0x${string}`;
type Hex = `0x${string}`;
type Uint256 = bigint;
type Int128 = bigint;
type Bytes32 = Hex;

interface InferenceVaultContract {
  asset(): Promise<Address>;
  totalAssets(): Promise<Uint256>;
  totalSupply(): Promise<Uint256>;
  convertToAssets(shares: Uint256): Promise<Uint256>;
}

// FeeRouter is observed ONLY via its harvest events (see Event Schemas). The tool
// makes no FeeRouter function calls today — its ABI (`src/abi/feeRouter.ts`) contains
// only the three harvest event definitions.

interface Erc20Contract {
  balanceOf(owner: Address): Promise<Uint256>; // DIEM / wstDIEM balances (`src/abi/erc20.ts`)
}

interface CurvePoolContract {
  balances(i: Uint256): Promise<Uint256>;
  get_dy(i: Int128, j: Int128, dx: Uint256): Promise<Uint256>;
}

interface MorphoMarketParams { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: Uint256; }
interface MorphoMarket { totalSupplyAssets: Uint256; totalSupplyShares: Uint256; totalBorrowAssets: Uint256; totalBorrowShares: Uint256; lastUpdate: Uint256; fee: Uint256; }
interface MorphoPosition { supplyShares: Uint256; borrowShares: Uint256; collateral: Uint256; }

interface MorphoBlueContract {
  idToMarketParams(id: Bytes32): Promise<MorphoMarketParams>;
  market(id: Bytes32): Promise<MorphoMarket>;
  position(id: Bytes32, user: Address): Promise<MorphoPosition>;
  isAuthorized(authorizer: Address, authorized: Address): Promise<boolean>;
  setAuthorization(authorized: Address, newIsAuthorized: boolean): ContractWrite<void>;
}

interface MorphoIrmContract { borrowRateView(params: MorphoMarketParams, market: MorphoMarket): Promise<Uint256>; }
interface WstDIEMMorphoOracleContract { price(): Promise<Uint256>; }
```

The exit executor read-surface is specified in §5. The `AgentTGERegistry`, `SurplusStakingWrapper`,
and `WstDIEMHook` interfaces from the original draft are **not consumed** by this tool and are out
of scope; the vault's yield accrual is observed via credit/harvest inference, not those contracts.

### Event Schemas

Consumed logs only (`src/metrics/backfill.ts`):

```ts
interface Erc20TransferEvent { from: Address; to: Address; value: Uint256; blockNumber: bigint; logIndex: number; transactionHash: Hex; }
interface FeeRouterWETHHarvestedEvent { wethIn: Uint256; wstDIEMOut: Uint256; blockNumber: bigint; logIndex: number; transactionHash: Hex; }
interface FeeRouterWstDIEMHarvestedEvent { amount: Uint256; blockNumber: bigint; logIndex: number; transactionHash: Hex; }
interface FeeRouterVVVHarvestedEvent { vvvIn: Uint256; diemCredited: Uint256; blockNumber: bigint; logIndex: number; transactionHash: Hex; }
interface CurveTokenExchangeEvent { buyer: Address; sold_id: bigint; tokens_sold: Uint256; bought_id: bigint; tokens_bought: Uint256; blockNumber: bigint; logIndex: number; transactionHash: Hex; }
```

### Reads

Every command reads current state per-invocation (there is no long-running poller — see §4). The
tool reads: RPC `eth_chainId` + latest block (connectivity / staleness); vault `asset`,
`totalAssets`, `totalSupply`, `convertToAssets(1e18)`; DIEM/wstDIEM ERC-20 `balanceOf`; Morpho
`idToMarketParams`, `market`, `position`, `isAuthorized`, IRM `borrowRateView`; the Morpho oracle
`price()`; and Curve `balances(0)`, `balances(1)`, `get_dy`. `FeeRouter` is not called — its
harvest cadence is inferred from logs. Historical harvest/credit/swap logs are backfilled from the
last saved block with a reorg-safety overlap and persisted to SQLite (§6).

Derived metrics:

```text
totalShares            = InferenceVault.totalSupply()
wstDIEM_NAV            = InferenceVault.totalAssets() / totalShares
curvePoolTVL_DIEM      = balances(0) + InferenceVault.convertToAssets(balances(1))
lastCreditDIEM         = latest inferred DIEM inflow from FeeRouter.VVVHarvested or DIEM Transfer(FeeRouter -> Vault)
lastHarvestAt          = latest block timestamp among WETHHarvested, WstDIEMHarvested, VVVHarvested
curve24hVolume_DIEM    = sum(TokenExchange volume normalized into DIEM over trailing 24h)
borrowedDIEM           = market.totalBorrowShares == 0 ? 0 : position.borrowShares * market.totalBorrowAssets / market.totalBorrowShares
suppliedCollateralDIEM = InferenceVault.convertToAssets(position.collateral)
positionNotionalDIEM   = suppliedCollateralDIEM
```

## 2. Computed Metrics

```text
wstDIEM_NAV = totalAssets / totalShares
```

If `totalShares == 0`, display NAV as `1.0` for operator readability but mark source state as empty.

```text
rollingCreditDIEM_7d  = sum(inferred creditDIEM amounts over trailing 7 days)
averageVaultAssets_7d = time-weighted average totalAssets over trailing 7 days
baseAPY               = (rollingCreditDIEM_7d / averageVaultAssets_7d) * (365 / 7)
```

If `averageVaultAssets_7d == 0`, display `baseAPY` as `0` and mark the APY window as insufficient.

```text
utilization         = market.totalBorrowAssets / market.totalSupplyAssets
borrowRatePerSecond = irm.borrowRateView(marketParams, market)
borrowRate          = exp(borrowRatePerSecond * 31_536_000) - 1
```

If `market.totalSupplyAssets == 0`, display utilization as `0` and mark the market as empty. Use raw
Morpho `market(marketId)` values for IRM input.

```text
netAPY(leverage) = leverage * baseAPY - (leverage - 1) * borrowRate
riskFreeRate     = 0.05
spreadScore      = netAPY - 1.5 * riskFreeRate

collateralValueDIEM = convertToAssets(position.collateral)
healthFactor        = (collateralValueDIEM * liquidationLTV) / borrowedDIEM   // Infinity if borrowedDIEM == 0

positionSizeVsCurveDepth        = positionNotionalDIEM / curvePoolTVL_DIEM
positionSizeVsCurveDepthPercent = positionSizeVsCurveDepth * 100
```

Morpho oracle deviation:

```text
computedOraclePrice = convertToAssets(1e18) * 1e18
oracleDeviation     = abs(onchainOracle.price() - computedOraclePrice) / computedOraclePrice
```

> Note: the offline **loop-sizing** engine models `netAPY` under a utilization-aware Adaptive Curve
> borrow rate rather than a flat `borrowRate`; see §5 and SPEC002 (planned).

## 3. Alert System

This **metric-alert** table is evaluated by `status` and `watch --once` (`src/cli/status.ts` →
`evaluateAlerts`), with cooldown/dedup applied via the `alert_state` table. `monitor` evaluates a
**separate readiness-alert set** (`src/monitor/readinessAlerts.ts` → `evaluateReadinessAlerts`:
`curve_liquidity_empty`, `vault_not_ready`, `morpho_liquidity_empty`, `executor_missing`/
`_no_code`/`_config_mismatch`, `owner_missing`/`_position_missing`, `executor_not_authorized`) and,
with `--alert`, delivers **without** the metric-alert cooldown. There is no daemon continuously
evaluating either set (§4).

| Alert | Level | Condition | Suggested action | Cooldown |
|---|---|---|---|---:|
| Health factor warn | WARN | `healthFactor < 1.6` | Rebalance down / add collateral | 15m |
| Health factor critical | CRITICAL | `healthFactor < 1.4` | Deleverage now | 5m |
| Spread compression warn | WARN | `netAPY(3.5) < 0.15` | Stop adding leverage | 1h |
| Spread compression critical | CRITICAL | `netAPY(3.5) < 0.08` | Deleverage to HF 1.7 | 15m |
| Curve depth warn | WARN | `positionSizeVsCurveDepth > 0.15` | Reduce target leverage / split | 30m |
| Curve depth critical | CRITICAL | `positionSizeVsCurveDepth > 0.20` | Do not open/increase; unwind only with strict sim | 10m |
| Harvest silence warn | WARN | `now - lastHarvestAt > 7 days` | Check FeeRouter/keeper | 12h |
| Harvest silence critical | CRITICAL | `now - lastHarvestAt > 14 days` | Escalate; APY stale | 6h |
| Oracle deviation | CRITICAL | `oracleDeviation > 0.01` | Disable loop txs; verify accounting | 5m |
| Borrow spike | WARN | `borrowRate > 0.7 * baseAPY` | Avoid new leverage | 30m |
| RPC stale | WARN | `latestBlockAge > 60s` | Fail over to fallback RPC | 5m |
| Simulation failure | CRITICAL | `eth_call reverted` | Inspect revert; tx not broadcast | none |

> **Advisory only.** The suggested-action column names the risk response; the tool **executes none
> of them** — it is monitor-and-rehearse (§5). Treat these as signals to act out-of-band. The
> **Simulation failure** row is surfaced as a `CliError` (`LIVE_SIMULATION_FAILED`) on the exit
> path, not delivered through the alert channels below.

Delivery channels (`src/alerts/deliver.ts`):

- **Stderr** (`chalk`): always on. INFO gray/blue, WARN yellow, CRITICAL red bold.
- **Webhook**: optional Discord/Slack-compatible JSON POST via `undici`, including `severity`,
  `alertKey`, `message`, `metrics`, `suggestedAction`, `chainId`, `blockNumber`, `timestamp`.
- **Telegram**: optional bot token/chat id, same payload as concise plain text via raw HTTP
  (`undici`) — there is no `telegraf` dependency, and no `parse_mode`/escaping is applied today.
- Dedup key: `chainId:positionAddress:alertKey:level`, with cooldown state persisted in the
  `alert_state` table (§6).

## 4. Monitoring commands

The tool does **not** run a persistent daemon. Continuous monitoring is achieved by running
`watch --once` (or `monitor`) on an external scheduler (cron / systemd timer / CI). The persistent
daemon + live TUI + `eth_subscribe` design is deferred (Appendix A).

### `status`
One-shot snapshot of vault, position, Morpho market, Curve, and risk metrics. Flags: `--owner`,
`--config`, `--json`. Read-only.

### `watch --once`
Runs exactly one polling iteration — startup validation, a log backfill from
`state.lastProcessedBlock + 1` with a 20-block reorg overlap, one metrics computation, one alert
evaluation, persistence to SQLite — then exits. Flags: `--once` (required; the bare persistent path
is not implemented and errors), `--no-tui`, `--config`, `--json`.

Startup validation (shared by monitoring reads):

1. Load `config.yaml`, env vars, CLI overrides.
2. Verify Base `chainId == 8453`.
3. Verify required addresses are nonzero and have code.
4. Verify `vault.asset() == DIEM`.
5. Verify Morpho `idToMarketParams(marketId)` matches DIEM loan token, wstDIEM collateral,
   configured oracle, IRM, and LLTV (`lltv == 86e16` on the live market).
6. If `loopExecutor` is configured, report `morpho.isAuthorized(owner, loopExecutor)`; if false,
   print the required authorization setup and mark loop tx commands unavailable.

### `monitor`
Operator dashboard aggregating live vault, Curve, Morpho, executor, and owner readiness into one
view, with optional alert delivery. Flags: `--owner`, `--loop-executor`, `--alert` (deliver to
configured stderr/webhook/Telegram channels; default off). Read-only.

Dashboard content (rendered one-shot by `status`/`monitor`, not a live TUI):

| Group | Fields |
|---|---|
| Chain | chainId, latest block, RPC name, RPC lag |
| Vault | totalAssets, totalShares, NAV |
| Yield | rolling7dCreditDIEM, baseAPY, lastCreditAt, lastHarvestAt |
| Morpho market | marketId, LLTV, utilization, totalSupplyAssets, totalBorrowAssets, borrowRate |
| Position | collateral wstDIEM, collateral DIEM value, borrowedDIEM, leverage, healthFactor |
| Curve | DIEM balance, wstDIEM balance, TVL DIEM, 24h volume |
| Risk | netAPY(3.5x), spreadScore, oracleDeviation, positionSizeVsCurveDepth |
| Alerts | active count by severity, last alert, next allowed repeat |

## 5. Loop Service (`wstdiem-loop-manager loop`)

The deployed executor is **exit-only**. The current loop surface is therefore: **`readiness`**,
**`authorize-executor`**, **`exit`/`simulate` (simulation-only)**, and the offline **`sizing`**
engine. `open` and `rebalance` are specified in Appendix A and are dead-gated in code until a
multi-action executor exists. **No command broadcasts** — broadcast is fail-closed pending audit
(§9, Appendix A).

**Execution status (important) — monitor-and-rehearse only.** Because broadcast is disabled, this
tool performs **no state-changing action** — it monitors, sizes, and *simulates* ("rehearses") the
exit. **There is no supported in-tool execution path while broadcast is fail-closed** (decided
2026-07-11): the operator **cannot act on a critical alert through this tool**. Creating a position
(`open`) is out of band (Appendix A1); there is **no automated liquidation protection** (Appendix A3),
so against the 86% LLTV market the operator must react manually — and any such execution is entirely
out-of-band and unsupported until the executor audit gate clears (Appendix A2). The alert "suggested
actions" in §3 are advisory signals, not in-tool commands.

### `loop sizing` (offline)
A pure offline economic simulator that sweeps a grid of leverage × Curve depth × Morpho supply ×
vault APY and prices each scenario through curve-liquidity, Morpho-supply, entry/exit slippage,
health-factor, net-APY, and unwind-coverage gates. It models borrow cost with a faithful Morpho
Adaptive Curve IRM (flat model also available). No chain reads. Its full input/gate/output contract
is **to be specified in SPEC002 (Loop Sizing Engine) — planned, not yet authored**; until then
`loop sizing` has **no committed spec contract** (the closest reference is the non-normative
`docs/deployment/loop-sizing.md` runbook). Key flags: `--preset`, `--initial-diem`/`--initial-wstdiem`, `--target-leverage`,
`--curve-depth-diem`, `--morpho-supply-diem`, `--borrow-rate-model`, `--rate-at-target-apy-bps`,
`--vault-apy-bps`, `--json`.

### `loop authorize-executor`
Inputs: `--owner` (defaults to `config.position.owner`; with the default `null` the command errors
`AUTHORIZATION_UNAVAILABLE`), `--live`, `--json`. `--dry-run` is accepted but currently a no-op —
the command never broadcasts, so it always behaves as a dry run.

- Read `morpho.isAuthorized(owner, loopExecutor)`.
- If already authorized, report `alreadyAuthorized: true` without building a tx.
- If not, build the `morpho.setAuthorization(loopExecutor, true)` transaction from `owner`; with
  `--live`, read current authorization and simulate. Broadcast remains disabled (§9).

### `loop exit` / `loop simulate --action exit --live`
Exit is validated by **live simulation only**; it never broadcasts. `loop simulate --action exit
--live` builds exact exit params from live Morpho position state and a live Curve quote:

- Compute `repayAmountDiem` from Morpho market totals and the owner's `borrowShares`.
- Set `maxWstDiemToSell` to the owner's current wstDIEM collateral and `minDiemOut` to the protected
  Curve quote after configured slippage.
- The implemented off-chain guard rejects an exit plan when `minDiemOut < repayAmountDiem + flashFee`,
  where `flashFee` is derived from the configured Uniswap V3 pool fee tier and live liquidity
  evidence is read at the **same planning block** as the Morpho debt and Curve quote.
- Non-live `loop exit` never produces unprotected calldata; live simulation is required before any
  future broadcast path.

Required exit executor ABI (committed):

```ts
interface LoopExitParams {
  owner: Address;
  marketParams: MorphoMarketParams;
  repayAmountDiem: Uint256;
  maxWstDiemToSell: Uint256;
  minDiemOut: Uint256;
  force: boolean;
  deadline: Uint256;
}
```

Target atomic unwind (executed inside the executor, not assembled by the CLI): flash-loan DIEM
sufficient to repay Morpho debt from the configured Uniswap V3 pool (fail closed if live pool DIEM
cannot cover it) → `morpho.repay` → `morpho.withdrawCollateral` → Curve `exchange(1,0,dx,min_dy)` →
repay flash principal + fee → refund dust to owner.

**Emergency flag** — `--force` skips the slippage guard **only**. It must not skip oracle deviation,
simulation, signer, deadline, or reentrancy safety. Prompt displays:
`FORCE EXIT CAN REALIZE UNBOUNDED CURVE SLIPPAGE`.

### `loop readiness`
- Reads live Base state for Curve DIEM/wstDIEM liquidity, Morpho market supply/borrow, optional
  owner debt/collateral, optional owner authorization, and deployed executor runtime config.
- Verifies a configured executor exposes `canonicalFlashPool()`, `expectedFlashFee(amount)`,
  `loanTokenIsToken0()`, `flashConfig()`, and `protocolConfig()` matching the configured Uniswap V3
  flash-provider, Morpho, Curve, and wstDIEM surfaces.
- Reports `blocked` when Curve/Morpho are empty, the owner is unconfigured or has no exit-ready
  position, the owner has not authorized the executor, executor config is missing/mismatched, RPC is
  unavailable, or the audit gate is active.
- Production broadcast remains unavailable even when all live checks pass: readiness must keep
  reporting `broadcastAvailable: false` and `auditRequired: true` until a production executor
  audit/review gate is explicitly cleared in a later spec update.
- Flags: `--owner`, `--loop-executor`, `--strict-evidence`, `--json`.

Acceptance criteria (current slice):

- `LoopExitParams` stays aligned with the committed ABI.
- Live exit planning reads Morpho debt/collateral, quotes the Curve exit route, and blocks when
  protected Curve output cannot cover the computed Morpho repay.
- Live exit simulation calls `simulateContract`/`eth_call` with the exact executor params and reports
  blocked/failed/passed before any broadcast path can exist.
- Tests assert both `minDiemOut >= repayAmountDiem` and `minDiemOut >= repayAmountDiem + flashFee`
  when flash-provider config is present, and that fee-inclusive proof is blocked when it is absent.

Selected flash provider (fee-inclusive off-chain proof):

- Dedicated `flashLoan` config surface (separate from `automation.provider`). Provider: Uniswap V3 on
  Base — `factory 0x33128a8fC17869897dcE68Ed026d694621f6FDfD`, `pool
  0x80d995189ecc593672aD4703b250a5e82672EB1D`, `loanToken DIEM`, `pairToken WETH`, `feeTier 10000`.
- Canonical CLI planning fee: `flashFee = ceil(repayAmountDiem * feeTier / 1_000_000)` (integer wei,
  round up); canonical executor fee source is the V3 `uniswapV3FlashCallback` `fee0`/`fee1` on the
  DIEM side.
- The executor pins the configured pool/factory, accepts only the canonical pool callback sender,
  fails closed on missing provider config, validates loan token/amount/fee/owner-context/deadline/
  nonce/non-reentrancy/Morpho-authorization, repays principal+fee atomically, refunds dust, and
  reverts if Curve output cannot cover `repayAmountDiem + flashFee`.
- Rejected providers (Base block `46839394` evidence): Morpho Blue (0 DIEM balance), Balancer V2
  Vault (0 DIEM), Uniswap V4 PoolManager (viable balance but singleton unlock flow too complex for
  first target), Aerodrome (negligible DIEM), Aave V3 (DIEM not a configured reserve).

Simulation & CLI output:

- `loop simulate --action exit --live` includes provider identity + fee source, fee/debt/quote block
  numbers, V3 pool DIEM balance evidence, exact executor calldata, `simulateContract`/`eth_call`
  status, and gas estimate. When a fork/local harness returns logs, it decodes `LoopExitExecuted`
  and fails closed if emitted `repayAmountDiem`/`flashFee`/`totalFlashRepaymentDiem` conflict with
  the off-chain proof; plain `eth_call` may expose no logs, and absence of logs is not itself a
  failure.
- JSON exposes `repayAmountDiem`, `flashFee`, `flashFeeSource`, `flashLoanProvider`,
  `totalFlashRepaymentDiem`, `minDiemOut`, `feeInclusiveRepayCovered`, route-quote evidence,
  `liveMorphoDebtBlockNumber`, `liveFlashLoanLiquidity`, decoded `exitExecutionEvidence` when
  available, live simulation status, and gas estimate. Tables show the same decision and print
  `flashFee: unresolved` only when it cannot be proven from same-block evidence. The CLI never prints
  a concrete flash fee inferred from an unspecified provider.

### `loop history`
Reads the SQLite `tx_history` table. Flag: `--limit` (`--since` is not implemented — Appendix A).

## 6. Persistence (SQLite)

`state`/history persists via `better-sqlite3` (`src/storage/sqlite.ts`). Schema — the original eight
tables plus `alert_state` for cooldown/dedup:

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE metric_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, block_number INTEGER NOT NULL, nav TEXT NOT NULL, base_apy REAL NOT NULL, borrow_rate REAL NOT NULL, net_apy_35 REAL NOT NULL, spread_score REAL NOT NULL, health_factor REAL, curve_tvl_diem TEXT NOT NULL, oracle_deviation REAL NOT NULL, vault_total_assets_diem TEXT NOT NULL DEFAULT '0');
CREATE TABLE credit_events (tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number INTEGER NOT NULL, timestamp INTEGER NOT NULL, source TEXT NOT NULL, amount_diem TEXT NOT NULL, PRIMARY KEY (tx_hash, log_index));
CREATE TABLE harvest_events (tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number INTEGER NOT NULL, timestamp INTEGER NOT NULL, event_name TEXT NOT NULL, token_in TEXT, amount_in TEXT, amount_out TEXT, PRIMARY KEY (tx_hash, log_index));
CREATE TABLE curve_swaps (tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number INTEGER NOT NULL, timestamp INTEGER NOT NULL, sold_id INTEGER NOT NULL, bought_id INTEGER NOT NULL, tokens_sold TEXT NOT NULL, tokens_bought TEXT NOT NULL, volume_diem TEXT NOT NULL, PRIMARY KEY (tx_hash, log_index));
CREATE TABLE position_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, block_number INTEGER NOT NULL, owner TEXT NOT NULL, collateral_wstdiem TEXT NOT NULL, borrowed_diem TEXT NOT NULL, leverage REAL NOT NULL, health_factor REAL);
CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, alert_key TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL, metrics_json TEXT NOT NULL, delivered_channels_json TEXT NOT NULL);
CREATE TABLE alert_state (dedupe_key TEXT PRIMARY KEY, last_delivered_at INTEGER NOT NULL);   -- dedupe_key = chainId:positionAddress:alertKey:level
CREATE TABLE tx_history (tx_hash TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, command TEXT NOT NULL, status TEXT NOT NULL, params_json TEXT NOT NULL, projected_metrics_json TEXT NOT NULL, receipt_json TEXT);
```

Each `watch --once` run flushes metric snapshots and pending alert deliveries, persists
`lastProcessedBlock`, and closes SQLite before exit. (A persistent daemon's subscription lifecycle
and SIGINT/SIGTERM handling is deferred — Appendix A.)

## 7. Configuration

```yaml
chainId: 8453

rpc:
  primaryUrl: ${BASE_RPC_URL}
  fallbackUrls: [ ${BASE_RPC_URL_FALLBACK_1}, ${BASE_RPC_URL_FALLBACK_2} ]
  timeoutMs: 10000

contracts:
  diem: "0xF4d97F2da56e8c3098f3a8D538DB630A2606a024"
  weth: "0x4200000000000000000000000000000000000006"
  vvv: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf"
  vvvStaking: "0x321b7ff75154472B18EDb199033fF4D116F340Ff"
  morphoBlue: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"
  adaptiveCurveIrm: "0x46415998764C29aB2a25CbeA6254146D50D22687"
  curveFactory: "0xd2002373543Ce3527023C75e7518C274A51ce712"
  uniswapV4PoolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b"   # inert; rejected flash provider (§5)
  inferenceVault: "0xe49FA849cB37b0e7A42B2335e333fb99474167ba"
  feeRouter: "0xa13a6e75d696bAceB38236389eeFD6eCa5FD4ED3"
  agentTgeRegistry: "0xb13830e7f72Eef167A7F188285feBa5f7C1198Ef"
  curvePool: "0x21c33a1Bb5f6Eb43563e1fB9e7AA1D4E90C1A0CD"
  morphoOracle: "0xAF29776f93FE0bf21282bF792A52AC212f20F45c"
  loopExecutor: "0x74ad4532133Ba538945a5371D249560E66CC7c71"
  autoDeleverageExecutor: null            # deferred (Appendix A)

morpho:
  marketId: "0xdd6b9f10bf69445ebba0626ef54042af628cdf65dda98ff68df4d235d4d56c76"
  lltvWad: "860000000000000000"

# Flash-loan provider for exit fee-inclusive off-chain proof (separate from automation.provider).
flashLoan:
  provider: "uniswap-v3"                  # or "unconfigured"
  factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD"
  pool: "0x80d995189ecc593672aD4703b250a5e82672EB1D"
  loanToken: "0xF4d97F2da56e8c3098f3a8D538DB630A2606a024"   # DIEM
  pairToken: "0x4200000000000000000000000000000000000006"   # WETH
  feeTier: 10000

wallet:
  privateKeyEnv: WSTDIEM_OPERATOR_PRIVATE_KEY
  hardware: { enabled: false, derivationPath: "m/44'/60'/0'/0/0" }   # hardware signing deferred

position:
  owner: null

thresholds:
  healthFactorWarn: 1.6
  healthFactorCritical: 1.4
  minPostLoopHealthFactor: 1.7
  spreadWarnNetApy35: 0.15
  spreadCriticalNetApy35: 0.08
  curveDepthWarn: 0.15
  curveDepthCritical: 0.20
  harvestSilenceWarnDays: 7
  harvestSilenceCriticalDays: 14
  oracleDeviationCritical: 0.01
  borrowSpikeBaseApyRatio: 0.70
  riskFreeRate: 0.05

alerts:
  webhookUrls: []
  telegram: { botTokenEnv: WSTDIEM_TELEGRAM_BOT_TOKEN, chatId: null }

automation:                               # inert; auto-deleverager deferred (Appendix A)
  provider: gelato
  gelatoTaskId: null
  chainlinkUpkeepId: null

storage:
  sqlitePath: "./wstdiem-loop-manager.sqlite"

execution:
  defaultSlippageBps: 50
  maxSlippageBps: 300
  maxCurvePriceImpactBps: 100
  exitRepayBufferBps: 200
  maxBaseApyStalenessBlocks: 7200
  transactionDeadlineSeconds: 300
```

## 8. CLI Interface

| Command | Purpose | Key flags | Output |
|---|---|---|---|
| `status` | One-shot snapshot | `--owner`, `--config`, `--json` | Table or JSON |
| `watch --once` | One monitoring iteration + persist | `--once`, `--no-tui`, `--config`, `--json` | Table, stderr alerts |
| `monitor` | Live operator dashboard | `--owner`, `--loop-executor`, `--alert` | Dashboard, optional alert delivery |
| `loop sizing` | Offline sizing simulator (→ SPEC002, planned) | `--preset`, `--target-leverage`, `--curve-depth-diem`, `--morpho-supply-diem`, `--borrow-rate-model`, `--rate-at-target-apy-bps`, `--vault-apy-bps`, + ~13 more, `--json` | Sizing grid table/JSON |
| `loop readiness` | Live exit-readiness checklist | `--owner`, `--loop-executor`, `--strict-evidence`, `--json` | Curve/Morpho/executor/owner/audit blockers |
| `loop authorize-executor` | Authorize executor on Morpho | `--owner`, `--live`, `--dry-run`, `--json` | Authorization status/calldata |
| `loop simulate` | Dry-run (live-optional) exit projection | `--action exit`, `--live`, `--force`, `--owner`, `--from`, `--json` | JSON/table projection |
| `loop exit` | Exit projection (simulate-only) | `--slippage-bps`, `--force`, `--dry-run`, `--owner`, `--json` | Exit quote + warnings |
| `loop history` | Read SQLite tx history | `--limit` | Table or JSON |
| `alerts test` | Send a test alert | `--severity`, `--message` | Delivery report |

> Deferred commands `loop open` and `loop rebalance` exist in code but are dead-gated and specified
> in Appendix A. `--force-broadcast` does not exist; broadcast is disabled at two layers.

JSON output envelope:

```ts
interface CliJsonOutput<T> {
  ok: boolean;
  command: string;
  chainId: number;
  blockNumber?: bigint;
  data?: T;
  error?: { code: string; message: string; cause?: string };
}
```

## 9. Error Handling & Safety

RPC read failover (`src/contracts/rpc.ts`) — **actual current behavior**:

- Up to `maxAttempts = 5` retries per endpoint, fired **immediately** (there is no backoff, delay,
  or jitter in the current code — `rpc.ts:42-67`), then failover to the configured fallback URLs.
- On inconsistent results, prefer the RPC with the highest finalized block and matching chain id.
- *Jittered exponential backoff and a broadcast retry policy (`maxAttempts = 1`) are **not built** —
  see Appendix A2; RPC failover/health-check logic is also currently under-tested (Phase 3 gap).*
- **Broadcast is disabled.** No command sends a transaction; `assertBroadcastNotAllowed` throws and
  readiness reports `broadcastAvailable: false`, `auditRequired: true`. The broadcast contract
  (never-broadcast-on-revert, `pending_unknown` receipt handling, `--force-gas`) is specified in
  Appendix A for when the audit gate clears.
- On tx simulation failure, never proceed. Simulation is mandatory for the exit path.

Executor safety invariants (enforced by `contracts/LoopExecutor.sol`, fork-tested):

- Reentrancy guard on all public entrypoints and the flash-loan callback.
- Validate the callback sender is the configured canonical Uniswap V3 pool.
- Enforce owner authorization and deadline; require `msg.sender == owner` for the current exit
  executor.
- Refund dust and retain no operator funds after execution; revert if Curve output cannot cover
  `repayAmountDiem + flashFee`.

## 10. Tech Stack

| Component | Choice | In use |
|---|---|---|
| Runtime / Language | Node.js 20+, TypeScript | ✅ |
| Chain library | `viem` v2 | ✅ |
| CLI | `commander` | ✅ |
| Config validation | `zod` + `yaml` | ✅ |
| Tables / Colors | `cli-table3`, `chalk` | ✅ |
| SQLite | `better-sqlite3` | ✅ |
| Logging / HTTP | `pino`, `undici` | ✅ |
| Tests | `vitest`; Foundry `forge` fork tests | ✅ |
| Format/lint | `prettier`, `eslint`, `typescript-eslint` | ✅ |
| ~~TUI `ink` + `react`~~ | — | ✖ deferred (no daemon) |
| ~~Telegram `telegraf`~~ | raw `undici` | ✖ not a dependency |
| Env loading | `dotenv` | ✅ |
| ~~Hardware wallet `@ledgerhq/*`~~ | — | ✖ deferred |
| ~~`@morpho-org/blue-sdk*`~~ | — | ✖ not a dependency (potential future cross-check) |

Testing split:

- **Unit** (`vitest`): config parsing, decimal math, APY windows, alert thresholds, SQLite
  persistence, Morpho share-to-asset math, Curve TVL normalization, sizing engine, Adaptive Curve
  IRM.
- **Foundry local** (`npm run test:contracts`): dependency-free Solidity harness for the Uniswap V3
  exit flash callback — factory-derived canonical pool checks, mocked Morpho repay/withdraw, mocked
  Curve swap, flash repayment, owner dust refund.
- **Foundry fork** (`npm run test:contracts:fork`): Base flash-provider evidence, no-broadcast
  executor deployment readiness, env-gated full-unwind readiness. `BaseFlashProviderFork.t.sol`,
  `BaseLoopExecutorDeployFork.t.sol`, `BaseFullUnwindReadinessFork.t.sol` run at pinned block
  `46839394` and latest.
- **Production-gate evidence**: `npm run deploy:executor:dry-run`, `npm run readiness:owner`,
  `npm run proof:full-unwind`. `loop readiness` accepts `--owner`/`--loop-executor`/
  `--strict-evidence` so a deployed executor candidate can be checked before it enters operator
  config; the evidence scripts exit nonzero unless all live checks pass except the intentionally
  closed audit gate.

---

## Appendix A — Deferred (not in the current tool)

These are specified but **not built**; each needs its own gate before entering the main body.

### A1. Multi-action executor: `loop open` / `loop rebalance`
The deployed executor is exit-only, so `open`/`rebalance` are dead-gated (`src/loop/params.ts`
returns them as unsupported; `src/cli/loop.ts` throws before any broadcast). The original full
specifications — `LoopOpenParams`/`LoopRebalanceParams`, the atomic open sequence (flash → deposit →
supplyCollateral → borrow → repay flash → refund), pre-flight checks (`projectedHF > 1.7`,
`curveTVL >= 5× notional`, `netAPY(target) > 0.08`, `oracleDeviation <= 0.01`), and the partial-unwind
formula `repayAmount = max(0, currentDebt - collateralValueDIEM·L/H)` — are retained here and become
current only when a multi-action executor is deployed and audited.

### A2. Broadcast enablement
All broadcast is fail-closed pending a production executor audit/review. The enablement contract
(retry `maxAttempts = 1` for broadcast; never broadcast on sim/gas failure; `pending_unknown` receipt
handling with WARN after 5 minutes; confirmation prompt requiring exact `y`/`yes`; a future
`--force-gas`) is authored as its own SPEC once the gate clears (roadmap D3).

### A3. Auto-deleverager
`autoDeleverageExecutor` is `null`; there is no resolver, on-chain `AutoDeleverageExecutorContract`,
or daemon automation monitoring. Deferred design: resolver condition
`shouldExecute = HF < 1.4 OR netAPY(currentLeverage) < 0.08`; target HF 1.7; collateral-sell repay
`collateralValueToSell = max(0, (H·D − L·C)/(H·φ − L))`; Gelato/Chainlink task polling with
WARN/CRITICAL on stale automation. Requires both a deployed contract and A4.

### A4. Persistent watch daemon + TUI
The original §4 daemon — `eth_subscribe` WebSocket listeners for FeeRouter/vault/Curve/Morpho logs
with polling fallback, live `ink`+`react` dashboard, reconnect backfill, and SIGINT/SIGTERM graceful
shutdown (exit `0`, or `130` on double-interrupt) — is deferred. Current practice: `watch --once` on
an external scheduler.

### A5. Hardware-wallet signing
Ledger (`@ledgerhq/*`) and/or Safe transaction-building support is deferred; not a dependency today.

## Open Questions

1. Flash-loan provider and fee model are **selected** (Uniswap V3 Base DIEM/WETH 1%, deterministic
   fee-tier planning, callback-supplied executor repayment) with same-block liquidity evidence, fork
   tests, and a dry-run deployment script. Remaining: production executor audit signoff, broadcast
   gating, and full-unwind proof against live liquidity + a funded/authorized owner position.
2. `open` route (direct `vault.deposit` vs Curve acquisition vs hybrid) — a protocol-team decision,
   deferred with A1.
3. Verify the exact deployed Curve StableSwap-NG `TokenExchange` event ABI before finalizing log
   decoding.
4. Hardware-wallet scope (Ledger only vs also Safe) — deferred with A5.
5. Confirm whether `riskFreeRate = 5%` stays static or is later read from an external USDC-yield
   source.
6. **Interim exit execution — RESOLVED 2026-07-11: monitor-and-rehearse only.** While broadcast is
   fail-closed there is **no supported in-tool execution path**; the tool surfaces and simulates
   risk but the operator cannot act on a critical alert through it. Execution is out-of-band and
   unsupported until the executor audit gate clears (Appendix A2). Consequences applied: the §5
   execution-status note and the §3 advisory note. (Accepted trade-off: the monitoring/readiness
   surface is decision-support and rehearsal, not an actionable kill-switch.)
7. **Scheduler exit-code contract.** Under `watch --once` + cron (D2), what exit code should the CLI
   return by outcome class (all-clear / WARN / CRITICAL / RPC-unavailable / readiness-blocked)?
   Today it sets only a generic `1` on internal error, so a CRITICAL alert still exits `0` and a
   scheduler cannot gate on severity via exit status.
8. **Threshold source of truth.** When the §3 alert table values differ from `config.thresholds`
   (§7), which is authoritative? (Presumably config — state it.)
9. **Liquidation readout.** Should the dashboard surface margin-to-liquidation / liquidation price
   (not just HF), given there is no automated liquidation protection?
