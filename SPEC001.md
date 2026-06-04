# `wstdiem-loop-manager` Technical Specification

Source revision: `liquid-protocol-v0` main at [`85fb0705f93b41e40f88b39a374da720ec2458d9`](https://github.com/Liquid-Protocol-Ops/liquid-protocol-v0/commit/85fb0705f93b41e40f88b39a374da720ec2458d9).

Source anchors used:

- [`InferenceVault.sol`](https://github.com/Liquid-Protocol-Ops/liquid-protocol-v0/blob/85fb0705f93b41e40f88b39a374da720ec2458d9/src/vault/InferenceVault.sol)
- [`FeeRouter.sol`](https://github.com/Liquid-Protocol-Ops/liquid-protocol-v0/blob/85fb0705f93b41e40f88b39a374da720ec2458d9/src/vault/FeeRouter.sol)
- [`AgentTGERegistry.sol`](https://github.com/Liquid-Protocol-Ops/liquid-protocol-v0/blob/85fb0705f93b41e40f88b39a374da720ec2458d9/src/vault/AgentTGERegistry.sol)
- [`SurplusStakingWrapper.sol`](https://github.com/Liquid-Protocol-Ops/liquid-protocol-v0/blob/85fb0705f93b41e40f88b39a374da720ec2458d9/src/vault/SurplusStakingWrapper.sol)
- [`WstDIEMHook.sol`](https://github.com/Liquid-Protocol-Ops/liquid-protocol-v0/blob/85fb0705f93b41e40f88b39a374da720ec2458d9/src/vault/WstDIEMHook.sol)
- [`DeployAll.s.sol`](https://github.com/Liquid-Protocol-Ops/liquid-protocol-v0/blob/85fb0705f93b41e40f88b39a374da720ec2458d9/script/vault/DeployAll.s.sol)
- [`DeployCurvePool.s.sol`](https://github.com/Liquid-Protocol-Ops/liquid-protocol-v0/blob/85fb0705f93b41e40f88b39a374da720ec2458d9/script/vault/DeployCurvePool.s.sol)
- [`DeployMorphoMarket.s.sol`](https://github.com/Liquid-Protocol-Ops/liquid-protocol-v0/blob/85fb0705f93b41e40f88b39a374da720ec2458d9/script/vault/DeployMorphoMarket.s.sol)
- [`CurvePool.t.sol`](https://github.com/Liquid-Protocol-Ops/liquid-protocol-v0/blob/85fb0705f93b41e40f88b39a374da720ec2458d9/test/vault/CurvePool.t.sol)
- [Morpho contract docs](https://docs.morpho.org/get-started/resources/contracts/morpho)
- [Morpho IRM docs](https://docs.morpho.org/get-started/resources/contracts/irm/)
- [Morpho address docs](https://docs.morpho.org/get-started/resources/addresses/)

Important source-derived constraints:

- `InferenceVault` does not expose `totalShares()`. Use ERC-20 `totalSupply()` as total shares.
- `InferenceVault.creditDIEM(uint256)` emits no custom event. The tool must infer credits from `FeeRouter.VVVHarvested`, vault DIEM balance/`totalAssets()` deltas, and ERC-20 `Transfer` logs into the vault.
- The repo contains vault deploy scripts, but the checked top-level Base `broadcast/` artifacts are for core Liquid Protocol deployments, not a committed `DeployAll.s.sol/8453/run-latest.json`. Vault-specific deployed addresses must therefore be config-required until that artifact exists.

## 1. Data Sources

### Contract Interfaces

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
  balanceOf(owner: Address): Promise<Uint256>;
  convertToAssets(shares: Uint256): Promise<Uint256>;
  convertToShares(assets: Uint256): Promise<Uint256>;
  previewDeposit(assets: Uint256): Promise<Uint256>;
  deposit(assets: Uint256, receiver: Address): ContractWrite<Uint256>;
  creditDIEM(amount: Uint256): ContractWrite<void>;
  currentDepositFeeBps(): Promise<Uint256>;
  vaultOwnedShares(): Promise<Uint256>;
  feeRouter(): Promise<Address>;
  treasury(): Promise<Address>;
  withdrawalsEnabled(): Promise<boolean>;
  maxWithdraw(owner: Address): Promise<Uint256>;
  maxRedeem(owner: Address): Promise<Uint256>;
}

interface FeeRouterContract {
  receiveWETH(amount: Uint256): ContractWrite<void>;
  receivewstDIEM(amount: Uint256): ContractWrite<void>;
  receiveVVV(amount: Uint256): ContractWrite<void>;
  harvest(): ContractWrite<void>;
  harvestVVV(): ContractWrite<void>;
  pendingWETH(): Promise<Uint256>;
  pendingVVV(): Promise<Uint256>;
  maxSlippageBps(): Promise<Uint256>;
  vvvBatchThreshold(): Promise<Uint256>;
  curvePool(): Promise<Address>;
  v4Pool(): Promise<Address>;
}

interface AgentTGERegistryContract {
  register(agent: Address, tier: AgentTier): ContractWrite<void>;
  terminate(): ContractWrite<void>;
  markDormant(agent: Address): ContractWrite<void>;
  recordFeeReceipt(agent: Address): ContractWrite<void>;
  getCommitment(agent: Address): Promise<AgentCommitment>;
  isEligible(agent: Address): Promise<boolean>;
}

type AgentTier = 0 | 1 | 2;
type AgentTierName = "Bronze" | "Silver" | "Gold";

const AGENT_TIER_TO_ABI: Record<AgentTierName, AgentTier> = {
  Bronze: 0,
  Silver: 1,
  Gold: 2,
};

interface AgentCommitment {
  agent: Address;
  dailyAllocationUSD: Uint256;
  tier: AgentTier;
  lastFeeReceiptAt: Uint256;
  active: boolean;
}

interface SurplusStakingWrapperContract {
  stakeForUser(user: Address, diemAmount: Uint256): ContractWrite<Uint256>;
  unstakeForUser(user: Address, wstDIEMAmount: Uint256): ContractWrite<void>;
  getBalance(user: Address): Promise<Uint256>;
  getYield(user: Address): Promise<Uint256>;
}

interface WstDIEMHookContract {
  vault(): Promise<Address>;
  FEE_NORMAL(): Promise<number>;
  FEE_HIGH(): Promise<number>;
  getHookPermissions(): Promise<HookPermissions>;
}

interface HookPermissions {
  beforeInitialize: boolean;
  afterInitialize: boolean;
  beforeAddLiquidity: boolean;
  afterAddLiquidity: boolean;
  beforeRemoveLiquidity: boolean;
  afterRemoveLiquidity: boolean;
  beforeSwap: boolean;
  afterSwap: boolean;
  beforeDonate: boolean;
  afterDonate: boolean;
  beforeSwapReturnDelta: boolean;
  afterSwapReturnDelta: boolean;
  afterAddLiquidityReturnDelta: boolean;
  afterRemoveLiquidityReturnDelta: boolean;
}

interface CurvePoolContract {
  exchange(i: Int128, j: Int128, dx: Uint256, min_dy: Uint256): ContractWrite<Uint256>;
  add_liquidity(amounts: readonly Uint256[], min_mint_amount: Uint256): ContractWrite<Uint256>;
  get_virtual_price(): Promise<Uint256>;
  balances(i: Uint256): Promise<Uint256>;
  balanceOf(owner: Address): Promise<Uint256>;
  totalSupply(): Promise<Uint256>;
}

interface MorphoMarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: Uint256;
}

interface MorphoMarket {
  totalSupplyAssets: Uint256;
  totalSupplyShares: Uint256;
  totalBorrowAssets: Uint256;
  totalBorrowShares: Uint256;
  lastUpdate: Uint256;
  fee: Uint256;
}

interface MorphoPosition {
  supplyShares: Uint256;
  borrowShares: Uint256;
  collateral: Uint256;
}

interface MorphoBlueContract {
  idToMarketParams(id: Bytes32): Promise<MorphoMarketParams>;
  market(id: Bytes32): Promise<MorphoMarket>;
  position(id: Bytes32, user: Address): Promise<MorphoPosition>;
  isAuthorized(authorizer: Address, authorized: Address): Promise<boolean>;
  setAuthorization(authorized: Address, newIsAuthorized: boolean): ContractWrite<void>;
  supplyCollateral(params: MorphoMarketParams, assets: Uint256, onBehalf: Address, data: Hex): ContractWrite<void>;
  borrow(params: MorphoMarketParams, assets: Uint256, shares: Uint256, onBehalf: Address, receiver: Address): ContractWrite<[Uint256, Uint256]>;
  repay(params: MorphoMarketParams, assets: Uint256, shares: Uint256, onBehalf: Address, data: Hex): ContractWrite<[Uint256, Uint256]>;
  withdrawCollateral(params: MorphoMarketParams, assets: Uint256, onBehalf: Address, receiver: Address): ContractWrite<void>;
}

interface MorphoIrmContract {
  borrowRateView(params: MorphoMarketParams, market: MorphoMarket): Promise<Uint256>;
}

interface WstDIEMMorphoOracleContract {
  price(): Promise<Uint256>;
}
```

### Event Schemas

```ts
interface Erc4626DepositEvent {
  sender: Address;
  owner: Address;
  assets: Uint256;
  shares: Uint256;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

interface Erc20TransferEvent {
  from: Address;
  to: Address;
  value: Uint256;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

interface FeeRouterWETHHarvestedEvent {
  wethIn: Uint256;
  wstDIEMOut: Uint256;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

interface FeeRouterWstDIEMHarvestedEvent {
  amount: Uint256;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

interface FeeRouterVVVHarvestedEvent {
  vvvIn: Uint256;
  diemCredited: Uint256;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

interface SurplusStakedEvent {
  user: Address;
  diemIn: Uint256;
  wstDIEMOut: Uint256;
  ref: Bytes32;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

interface SurplusUnstakedEvent {
  user: Address;
  wstDIEMIn: Uint256;
  diemOut: Uint256;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

interface CurveTokenExchangeEvent {
  buyer: Address;
  sold_id: bigint;
  tokens_sold: Uint256;
  bought_id: bigint;
  tokens_bought: Uint256;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}
```

### Reads And Polling

| Source | Read | Poll | Purpose |
|---|---:|---:|---|
| RPC chain | `eth_chainId`, latest block | 15s | Connectivity and stale RPC detection |
| `InferenceVault` | `asset()` | startup | Validate DIEM address |
| `InferenceVault` | `totalAssets()`, `totalSupply()` | 30s | NAV, APY denominator |
| `InferenceVault` | `convertToAssets(1e18)` | 30s | NAV-per-share and Morpho oracle comparison |
| `InferenceVault` | `vaultOwnedShares()`, `currentDepositFeeBps()`, `withdrawalsEnabled()` | 5m | Operator context |
| DIEM ERC-20 | `balanceOf(vault)` | 30s | Cross-check `totalAssets()` |
| wstDIEM ERC-20 | `balanceOf(operator)` | 30s in watch | Wallet exposure |
| `FeeRouter` | `pendingWETH()`, `pendingVVV()`, `maxSlippageBps()`, `vvvBatchThreshold()` | 60s | Fee backlog and harvest readiness |
| `FeeRouter` logs | `WETHHarvested`, `WstDIEMHarvested`, `VVVHarvested` | subscribe + backfill | Harvest cadence, credit inference |
| Vault DIEM `Transfer` logs | `Transfer(from=FeeRouter,to=Vault)` | subscribe + backfill | Infer `creditDIEM` amount/timestamp |
| Morpho Blue | `idToMarketParams(marketId)` | startup + 1h | Validate market config |
| Morpho Blue | `market(marketId)` | 30s | Utilization, borrow rate inputs |
| Morpho Blue | `position(marketId, user)` | 30s | Collateral, borrow shares, HF |
| Morpho Blue | `isAuthorized(owner, loopExecutor)` | startup + before tx simulation | Verify executor can borrow/withdraw on owner's behalf |
| Morpho IRM | `borrowRateView(params, market)` | 30s | Borrow APY |
| Morpho oracle | `price()` | 30s | NAV deviation |
| Curve pool | `balances(0)`, `balances(1)`, `get_virtual_price()`, `totalSupply()` | 30s | Pool TVL/depth |
| Curve LP token | `balanceOf(operator)` | 60s | User LP exposure |
| Curve logs | `TokenExchange` | subscribe + backfill | Rolling 24h volume |
| Public logs | all watched logs | restart backfill from last saved block | Resume safety |

Derived metrics:

```text
totalShares = InferenceVault.totalSupply()
wstDIEM_NAV = InferenceVault.totalAssets() / totalShares
curvePoolTVL_DIEM = balances(0) + InferenceVault.convertToAssets(balances(1))
lastCreditDIEM = latest inferred DIEM inflow from FeeRouter.VVVHarvested or DIEM Transfer(FeeRouter -> Vault)
lastHarvestAt = latest block timestamp among WETHHarvested, WstDIEMHarvested, VVVHarvested
curve24hVolume_DIEM = sum(TokenExchange volume normalized into DIEM value over trailing 24h)
borrowedDIEM = market.totalBorrowShares == 0 ? 0 : position.borrowShares * market.totalBorrowAssets / market.totalBorrowShares
suppliedCollateralWstDIEM = position.collateral
suppliedCollateralDIEM = InferenceVault.convertToAssets(position.collateral)
positionNotionalDIEM = suppliedCollateralDIEM
```

## 2. Computed Metrics

```text
wstDIEM_NAV = totalAssets / totalShares
```

If `totalShares == 0`, display NAV as `1.0` for operator readability but mark source state as empty.

```text
rollingCreditDIEM_7d = sum(inferred creditDIEM amounts over trailing 7 days)

averageVaultAssets_7d = time-weighted average totalAssets over trailing 7 days

baseAPY = (rollingCreditDIEM_7d / averageVaultAssets_7d) * (365 / 7)
```

If `averageVaultAssets_7d == 0`, display `baseAPY` as `0` and mark the APY window as insufficient.

```text
utilization = market.totalBorrowAssets / market.totalSupplyAssets
borrowRatePerSecond = irm.borrowRateView(marketParams, market)
borrowRate = exp(borrowRatePerSecond * 31_536_000) - 1
```

If `market.totalSupplyAssets == 0`, display utilization as `0` and mark the market as empty. Use the raw Morpho `market(marketId)` values for IRM input and only use accrued helper values for display when explicitly labeled.

```text
netAPY(leverage) = leverage * baseAPY - (leverage - 1) * borrowRate
```

```text
riskFreeRate = 0.05
spreadScore = netAPY - 1.5 * riskFreeRate
```

```text
collateralValueDIEM = convertToAssets(position.collateral)
borrowedDIEM = market.totalBorrowShares == 0 ? 0 : position.borrowShares * market.totalBorrowAssets / market.totalBorrowShares
healthFactor = (collateralValueDIEM * liquidationLTV) / borrowedDIEM
```

If `borrowedDIEM == 0`, `healthFactor = Infinity`.

```text
positionNotionalDIEM = collateralValueDIEM
positionSizeVsCurveDepth = positionNotionalDIEM / curvePoolTVL_DIEM
positionSizeVsCurveDepthPercent = positionSizeVsCurveDepth * 100
```

For projected opens, `projectedPositionNotionalDIEM = initialDIEM * targetLeverage`. If `curvePoolTVL_DIEM == 0`, block loop opens and display Curve depth as unavailable.

Morpho oracle deviation:

```text
computedOraclePrice = convertToAssets(1e18) * 1e18
oracleDeviation = abs(onchainOracle.price() - computedOraclePrice) / computedOraclePrice
```

## 3. Alert System

| Alert | Level | Condition | Message | Suggested action | Cooldown |
|---|---|---|---|---|---:|
| Health factor warn | WARN | `healthFactor < 1.6` | `HF below 1.60: position nearing liquidation buffer.` | Rebalance down to HF >= 1.7 or add collateral. | 15m |
| Health factor critical | CRITICAL | `healthFactor < 1.4` | `HF below 1.40: immediate deleveraging required.` | Trigger auto-deleverager or run `loop rebalance --target-leverage`. | 5m |
| Spread compression warn | WARN | `netAPY(3.5) < 0.15` | `3.5x net APY below 15%. Loop carry is compressed.` | Stop adding leverage; consider partial unwind. | 1h |
| Spread compression critical | CRITICAL | `netAPY(3.5) < 0.08` | `3.5x net APY below 8%. Carry no longer compensates risk.` | Deleverage to target HF 1.7. | 15m |
| Curve depth warn | WARN | `positionSizeVsCurveDepth > 0.15` | `Position exceeds 15% of Curve depth.` | Reduce target leverage or split execution. | 30m |
| Curve depth critical | CRITICAL | `positionSizeVsCurveDepth > 0.20` | `Position exceeds 20% of Curve depth.` | Do not open/increase; unwind only with strict simulation. | 10m |
| Harvest silence warn | WARN | `now - lastHarvestAt > 7 days` | `No harvest observed for more than 7 days.` | Check FeeRouter pending balances and keeper health. | 12h |
| Harvest silence critical | CRITICAL | `now - lastHarvestAt > 14 days` | `No harvest observed for more than 14 days.` | Escalate to protocol ops; APY assumptions stale. | 6h |
| Oracle deviation | CRITICAL | `oracleDeviation > 0.01` | `Morpho oracle differs from computed NAV by more than 1%.` | Disable loop txs; verify oracle contract and vault accounting. | 5m |
| Borrow spike | WARN | `borrowRate > 0.7 * baseAPY` | `Borrow rate exceeds 70% of base APY.` | Avoid new leverage; monitor utilization. | 30m |
| RPC stale | WARN | `latestBlockAge > 60s` | `RPC appears stale.` | Fail over to fallback RPC. | 5m |
| Simulation failure | CRITICAL | `eth_call reverted` | `Loop transaction simulation failed; tx will not be broadcast.` | Inspect revert reason and route assumptions. | no cooldown |

Delivery channels:

- Stderr colored output: always enabled, using `chalk`; INFO gray/blue, WARN yellow, CRITICAL red bold.
- Webhook: optional Discord/Slack-compatible JSON POST. Must include `severity`, `alertKey`, `message`, `metrics`, `suggestedAction`, `chainId`, `blockNumber`, `timestamp`.
- Telegram: optional bot token/chat id. Must send the same payload in concise Markdown-safe text.
- Alert deduplication key: `chainId:positionAddress:alertKey:level`.

## 4. Watch Mode (`wstdiem-loop-manager watch`)

Startup sequence:

1. Load `config.yaml`, env vars, and CLI overrides.
2. Verify Base `chainId == 8453`.
3. Verify required addresses are nonzero and contracts have code.
4. Verify `vault.asset() == DIEM`.
5. Verify Morpho `idToMarketParams(marketId)` matches DIEM loan token, wstDIEM collateral, configured oracle, configured IRM, and configured LLTV. The discovered Base DIEM/wstDIEM market uses `lltv == 86e16`.
6. If `loopExecutor` is configured, verify `morpho.isAuthorized(position.owner, loopExecutor) == true`; otherwise print the required authorization setup and mark loop tx commands unavailable.
7. Backfill logs from `state.lastProcessedBlock + 1`.
8. Load current position state and last persisted metrics.
9. Print one startup summary table.

Dashboard rows and columns:

| Row | Columns |
|---|---|
| Chain | chainId, latest block, RPC name, RPC lag, fallback active |
| Vault | totalAssets, totalShares, NAV, depositFeeBps, withdrawalsEnabled |
| Yield | rolling7dCreditDIEM, baseAPY, lastCreditAt, lastHarvestAt |
| FeeRouter | pendingWETH, pendingVVV, vvvBatchThreshold, last WETH harvest, last VVV harvest |
| Morpho market | marketId, LLTV, utilization, totalSupplyAssets, totalBorrowAssets, borrowRate |
| Position | collateral wstDIEM, collateral DIEM value, borrowedDIEM, leverage, healthFactor |
| Curve | DIEM balance, wstDIEM balance, TVL DIEM, virtualPrice, 24h volume |
| Risk | netAPY(3.5x), spreadScore, oracleDeviation, positionSizeVsCurveDepth |
| Automation | Gelato/Chainlink task id, last resolver check, last execution, status |
| Alerts | active count by severity, last alert, next allowed repeat |

Event listeners vs polling:

- Use `eth_subscribe` for `FeeRouter` harvest events, vault DIEM `Transfer` events, Curve `TokenExchange`, and Morpho position-changing logs when the RPC supports WebSocket.
- Always run interval polling for canonical current state because logs can be dropped, reorged, or missed during reconnect.
- On reconnect, backfill from the last finalized processed block with a 20-block reorg safety overlap.
- Expensive historical volume backfills run every 10 minutes in bounded block windows.

SQLite schema:

```sql
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE metric_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  nav TEXT NOT NULL,
  base_apy REAL NOT NULL,
  borrow_rate REAL NOT NULL,
  net_apy_35 REAL NOT NULL,
  spread_score REAL NOT NULL,
  health_factor REAL,
  curve_tvl_diem TEXT NOT NULL,
  oracle_deviation REAL NOT NULL
);

CREATE TABLE credit_events (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  source TEXT NOT NULL,
  amount_diem TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

CREATE TABLE harvest_events (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  token_in TEXT,
  amount_in TEXT,
  amount_out TEXT,
  PRIMARY KEY (tx_hash, log_index)
);

CREATE TABLE curve_swaps (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  sold_id INTEGER NOT NULL,
  bought_id INTEGER NOT NULL,
  tokens_sold TEXT NOT NULL,
  tokens_bought TEXT NOT NULL,
  volume_diem TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

CREATE TABLE position_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  owner TEXT NOT NULL,
  collateral_wstdiem TEXT NOT NULL,
  borrowed_diem TEXT NOT NULL,
  leverage REAL NOT NULL,
  health_factor REAL
);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  alert_key TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  delivered_channels_json TEXT NOT NULL
);

CREATE TABLE tx_history (
  tx_hash TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  params_json TEXT NOT NULL,
  projected_metrics_json TEXT NOT NULL,
  receipt_json TEXT
);
```

Graceful shutdown:

- Stop subscriptions.
- Flush in-memory metric snapshots and pending alert deliveries.
- Persist `lastProcessedBlock`.
- Close SQLite.
- Close webhook/Telegram HTTP clients.
- Exit `0` on SIGINT/SIGTERM after successful flush; exit `130` if interrupted twice.

## 5. Loop Service (`wstdiem-loop-manager loop`)

### `loop open`

Inputs:

| Param | Type | Constraint |
|---|---|---|
| `targetLeverage` | float | `1.5 <= x <= 3.8` |
| `initialDIEM` | decimal token amount | `> 0` |
| `slippageTolerance` | bps | default config, hard max 300 bps |
| `--dry-run` | boolean | simulate only |
| `--from` | address | defaults wallet address |

Pre-flight checks:

```text
projectedHealthFactor > 1.7
curvePoolTVL_DIEM >= 5 * projectedPositionNotionalDIEM
netAPY(targetLeverage) > 0.08
oracleDeviation <= 0.01
rpcChainId == 8453
vault.asset() == DIEM
market.lltv == 0.86e18
morpho.isAuthorized(owner, loopExecutor) == true
simulation succeeds before broadcast
```

If Morpho authorization is missing, the CLI must not simulate or broadcast `open`, `rebalance`, or `exit`. It should print the exact `morpho.setAuthorization(loopExecutor, true)` transaction target/calldata for the owner to submit, or tell the operator to run `loop authorize-executor`.

Flash-loan transaction construction:

The CLI must not try to assemble this as multiple EOA transactions. It must call a deployed `LoopExecutor` contract that owns the flash-loan callback and enforces atomicity.

Current product slice flash-fee boundary:

- `LoopExitParams` intentionally matches the current executor ABI and does not include a separate flash-fee field.
- Flash-loan provider selection is separate from `automation.provider`; `automation.provider` is for Gelato/Chainlink monitoring automation only.
- The selected exit flash provider is Uniswap V3 on Base, using a DIEM loan from the DIEM/WETH 1% pool when live pool DIEM balance can cover the requested repay amount.
- Off-chain exit planning proves protected Curve output covers computed Morpho repay plus configured Uniswap V3 flash fee: `minDiemOut >= repayAmountDiem + flashFee`.
- Fee-inclusive repayment proof is computed from the selected Uniswap V3 pool fee tier once flash-provider config is present; it remains blocked if provider config, same-block liquidity evidence, or deployed executor runtime config is missing, stale, or mismatched.
- Live `simulateContract`/`eth_call` is mandatory for exit because executor-internal flash-fee handling is the only current validation surface.

Required executor interface:

```ts
interface LoopExecutorContract {
  open(params: LoopOpenParams): ContractWrite<LoopResult>;
  rebalance(params: LoopRebalanceParams): ContractWrite<LoopResult>;
  exit(params: LoopExitParams): ContractWrite<LoopResult>;
}

interface LoopOpenParams {
  owner: Address;
  marketParams: MorphoMarketParams;
  initialDiem: Uint256;
  flashDiem: Uint256;
  minWstDiemReceived: Uint256;
  minBorrowedDiem: Uint256;
  maxCurvePriceImpactBps: Uint256;
  deadline: Uint256;
}

interface LoopRebalanceParams {
  owner: Address;
  marketParams: MorphoMarketParams;
  targetLeverageWad: Uint256;
  maxSlippageBps: Uint256;
  deadline: Uint256;
}

interface LoopExitParams {
  owner: Address;
  marketParams: MorphoMarketParams;
  repayAmountDiem: Uint256;
  maxWstDiemToSell: Uint256;
  minDiemOut: Uint256;
  force: boolean;
  deadline: Uint256;
}

interface LoopResult {
  collateralWstDiem: Uint256;
  borrowedDiem: Uint256;
  healthFactorWad: Uint256;
}
```

Atomic open sequence:

1. `LoopExecutor.open(params)` pulls `initialDIEM` from operator by allowance or permit.
2. Executor requests DIEM flash loan from configured provider.
3. Flash callback receives `flashDiem`.
4. Executor approves DIEM to `InferenceVault`.
5. Executor calls `vault.deposit(initialDIEM + flashDiem, executor)` to mint wstDIEM.
6. Executor approves wstDIEM to Morpho.
7. Executor calls `morpho.supplyCollateral(marketParams, wstDIEMAmount, owner, data)`.
8. Executor calls `morpho.borrow(marketParams, flashDiem + flashFee, 0, owner, executor)`. This requires prior `owner -> LoopExecutor` Morpho authorization.
9. Optional Curve step: only if configured route requires converting surplus DIEM into additional wstDIEM collateral; it must not consume DIEM needed to repay the flash loan.
10. Executor repays flash principal plus fee.
11. Executor refunds dust tokens to owner.
12. Executor verifies post-state HF and emits executor event.

Data encoding:

- Use viem ABI encoding for the executor call.
- Nested calls are encoded by the executor, not by the CLI as arbitrary multicall calldata.
- CLI simulation must include the exact `LoopOpenParams` to be broadcast.

Dry-run:

- Run `simulateContract`/`eth_call` for `open`.
- Run `estimateGas`.
- Print projected leverage, HF, borrow rate, net APY, Curve price impact, gas estimate, and max loss from slippage.
- Print flash fee only after the selected provider/fee model or executor simulation result exposes that value; until then, report flash fee as unresolved and rely on live simulation for repayment validation.
- Never broadcast if simulation reverts.

Confirmation prompt:

- Display all projected metrics.
- Require exact `y` or `yes`.
- Any other input aborts without tx.

### `loop rebalance`

Inputs:

| Param | Type |
|---|---|
| `targetLeverage` | float |
| `--slippage-bps` | integer |
| `--dry-run` | boolean |

Behavior:

- If current leverage < target, use add-collateral/open-style path.
- If current leverage > target, partially unwind.
- Same pre-flight, simulation, and confirmation requirements as `open`.
- Require prior `owner -> LoopExecutor` Morpho authorization because rebalance can borrow or withdraw collateral on behalf of `owner`.
- Target post-rebalance HF must be `>= 1.7`.

Partial unwind formula:

```text
targetDebt = collateralValueDIEM * liquidationLTV / targetHealthFactor
repayAmount = max(0, currentDebt - targetDebt)
```

### `loop authorize-executor`

Inputs:

| Param | Type |
|---|---|
| `--owner` | address, defaults wallet address |
| `--dry-run` | boolean |
| `--json` | boolean |

Behavior:

- Read `morpho.isAuthorized(owner, loopExecutor)`.
- If already authorized, exit successfully without broadcasting and report `alreadyAuthorized: true`.
- If not authorized, build `morpho.setAuthorization(loopExecutor, true)` from `owner`.
- Simulate and estimate gas before prompting.
- Require exact `y` or `yes` before broadcasting unless `--dry-run` is set.
- Persist successful authorization tx in `tx_history` with command `loop authorize-executor`.

### `loop exit`

Full atomic unwind sequence:

1. Flash loan DIEM sufficient to repay Morpho debt from the configured Uniswap V3 Base DIEM/WETH 1% pool; the executor must fail closed when live pool DIEM balance cannot cover the requested loan.
2. `morpho.repay(marketParams, repayAmount, 0, owner, data)`.
3. `morpho.withdrawCollateral(marketParams, collateralAmount, owner, executor)`. This requires prior `owner -> LoopExecutor` Morpho authorization.
4. Swap wstDIEM to DIEM through Curve `exchange(1, 0, dx, min_dy)`.
5. Repay flash principal plus fee.
6. Send remaining DIEM/wstDIEM dust to owner.
7. Persist tx history.

Current product slice behavior:

- `loop simulate --action exit --live` builds exact exit params from live Morpho position state and a live Curve quote.
- The CLI computes `repayAmountDiem` from Morpho market totals and the owner's `borrowShares`.
- The CLI sets `maxWstDiemToSell` to the owner's current wstDIEM collateral and `minDiemOut` to the protected Curve quote after configured slippage.
- The implemented off-chain guard rejects an exit plan when `minDiemOut < repayAmountDiem + flashFee`, where `flashFee` is derived from the configured Uniswap V3 pool fee tier and live liquidity evidence is read at the same planning block as the Morpho debt and Curve quote evidence.
- Non-live `loop exit` projection remains blocked from producing unprotected calldata; live simulation remains required before any future broadcast path.

### `loop readiness`

- Reads live Base state for Curve DIEM/wstDIEM liquidity, Morpho market supply/borrow state, optional owner debt/collateral, optional owner authorization, and deployed executor runtime config.
- Verifies a configured executor exposes `canonicalFlashPool()`, `expectedFlashFee(amount)`, `loanTokenIsToken0()`, `flashConfig()`, and `protocolConfig()` values matching the configured Uniswap V3 flash-provider, Morpho, Curve, and wstDIEM surfaces.
- Reports `blocked` when Curve or Morpho are empty, owner is not configured or has no exit-ready position, owner has not authorized the executor, executor config is missing/mismatched, RPC is unavailable, or the audit gate is active.
- Production broadcast remains unavailable even when all live dependency checks pass; readiness must keep reporting `broadcastAvailable: false` and `auditRequired: true` until a production executor audit/review gate is explicitly cleared in a later spec update.

Acceptance criteria for the current product slice:

- `LoopExitParams` stays aligned with the committed ABI: `owner`, `marketParams`, `repayAmountDiem`, `maxWstDiemToSell`, `minDiemOut`, `force`, and `deadline`.
- Live exit planning reads Morpho debt/collateral state, quotes the Curve exit route, and blocks when protected Curve output cannot cover computed Morpho repay.
- Live exit simulation calls `simulateContract`/`eth_call` with the exact executor params and reports blocked/failed/passed status before any broadcast path can exist.
- Tests must assert both `minDiemOut >= repayAmountDiem` and `minDiemOut >= repayAmountDiem + flashFee` when flash-provider config is present; tests must still assert fee-inclusive proof is blocked when provider config is absent.

Selected flash provider for fee-inclusive off-chain proof:

- Provider selection:
  - Use a dedicated `flashLoan` configuration surface separate from `automation.provider`.
  - Recommended provider: Uniswap V3 on Base, configured as `provider: "uniswap-v3"`, `factory: 0x33128a8fC17869897dcE68Ed026d694621f6FDfD`, `pool: 0x80d995189ecc593672aD4703b250a5e82672EB1D`, `loanToken: DIEM`, `pairToken: WETH`, `feeTier: 10000`.
  - Deployed evidence pinned from Base block `46839394`: DIEM token `0xF4d97F2da56e8c3098f3a8D538DB630A2606a024` has 18 decimals; DIEM/WETH 1% pool `0x80d995189ecc593672aD4703b250a5e82672EB1D` held `69.135067981093439788` DIEM. This evidence proves provider viability only up to that pool balance and must be refreshed in live planning.
  - The executor must pin the configured Uniswap V3 pool/factory and accept only the canonical pool callback sender for exit flash-loan repayment. If no provider is configured, the executor must revert and the CLI must report flash-fee proof as unavailable.
- Fee derivation:
  - Canonical executor fee source is the Uniswap V3 callback arguments `fee0` or `fee1` from `uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data)`, matching whichever side is DIEM.
  - Canonical CLI planning fee is the deterministic Uniswap V3 fee-tier formula: `flashFee = ceil(repayAmountDiem * feeTier / 1_000_000)`. For the selected 1% pool, `feeTier = 10000`; DIEM has 18 decimals; all arithmetic is integer wei arithmetic with rounding up.
  - The CLI must reject conflicting configured pool/token/fee evidence and must prove `minDiemOut >= repayAmountDiem + flashFee` only when the provider config and live pool evidence are from the same block as the Curve route quote and Morpho debt read.
- Executor callback validation:
  - The executor constructor must fail closed if the configured Uniswap V3 factory does not resolve `loanToken`/`pairToken`/`feeTier` to the configured flash pool, or if any required protocol address is zero.
  - The executor constructor must reject non-contract addresses for the configured Uniswap V3 factory, flash pool, loan token, pair token, Morpho, Curve pool, and wstDIEM contract.
  - The executor must validate `msg.sender` with the expected Uniswap V3 pool derived from factory, token0, token1, and fee tier; use `CallbackValidation.verifyCallback(factory, poolKey)` or equivalent canonical-pool derivation.
  - The executor must not expose an external callback-arming function; flash callback context must be armed only inside the owner-authorized exit flow.
  - A deployed executor must expose read-only config proof helpers for `canonicalFlashPool()`, `expectedFlashFee(amount)`, `loanTokenIsToken0()`, `flashConfig()`, and `protocolConfig()` so fork tests and CLI readiness checks can verify runtime configuration without relying on deployment notes alone.
  - The current exit executor must require `msg.sender == owner`; any keeper-operated version requires an explicit owner-signed intent or tightly scoped operator authorization before deployment.
  - The executor must validate loan token, loan amount, fee amount, encoded owner/action context, deadline, nonce, non-reentrancy, and Morpho owner authorization before continuing the exit path.
  - The executor must repay flash principal plus fee atomically, refund remaining DIEM/wstDIEM dust to the owner, and revert if Curve output cannot cover `repayAmountDiem + flashFee`.
  - The executor must emit an exit event or expose a simulation-readable result that includes `repayAmountDiem`, `flashFee`, total flash repayment, wstDIEM sold, DIEM received, and dust refunded.
- Simulation evidence:
  - `loop simulate --action exit --live` must include provider identity, provider fee source, fee block number, Morpho debt block number, Curve quote block number, Uniswap V3 pool DIEM balance evidence, exact executor calldata, `simulateContract`/`eth_call` status, and gas estimate.
  - When executor event logs are available from a local/fork simulation harness, the simulator must decode `LoopExitExecuted` and fail closed if emitted `repayAmountDiem`, `flashFee`, or `totalFlashRepaymentDiem` conflict with the off-chain exit proof. Standard `eth_call` may not expose logs; absence of logs is not by itself a failure.
  - Simulation must fail closed when provider config is missing, callback validation cannot be proven by the executor source/ABI, fee evidence is stale relative to the route/debt reads, or `minDiemOut < repayAmountDiem + flashFee`.
  - A passed simulation is required before broadcast and is evidence of executor-internal callback validation; it is not a substitute for the off-chain fee inequality when the fee model is available.
- CLI output:
  - JSON output must expose `repayAmountDiem`, `flashFee`, `flashFeeSource`, `flashLoanProvider`, `totalFlashRepaymentDiem`, `minDiemOut`, `feeInclusiveRepayCovered`, route quote evidence, `liveMorphoDebtBlockNumber`, `liveFlashLoanLiquidity`, decoded `exitExecutionEvidence` when available, live simulation status, and gas estimate.
  - Table output must show the same safety decision in operator-readable form and must print `flashFee: unresolved` only when provider-specific fee derivation is not configured or cannot be proven from same-block evidence.
  - The CLI must never print a concrete flash-fee amount inferred from an unspecified provider or from `automation.provider`.
- Rejected providers:
  - Morpho Blue Base `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`: zero-fee `flashLoan(token, assets, data)` with callback `onMorphoFlashLoan(uint256 assets, bytes data)` is the cleanest primitive, but Base block `46839394` showed zero DIEM balance in Morpho, so it cannot fund DIEM exits until liquidity appears.
  - Balancer V2 Vault Base `0xBA12222222228d8Ba445958a75a0704d566BF2C8`: standard `flashLoan` and `receiveFlashLoan` callback, but Base block `46839394` showed zero DIEM balance in the Vault.
  - Uniswap V4 PoolManager Base `0x498581fF718922c3f8e6A244956aF099B2652b2b`: held `109.981805017303353942` DIEM at Base block `46839394`, but the singleton unlock/delta-settlement flow is materially more complex than V3 flash and is not the first executor target.
  - Aerodrome Base-native: relevant Base venue, but the proven V2 DIEM/USDC pool held only `0.000000026763775930` DIEM at Base block `46839394`; Slipstream flash viability was not proven by official/deployed pool evidence.
  - Aave V3 Base: DIEM reserve configuration returned zero at Base block `46839394`, so DIEM is not a configured flash-loan reserve.
- Fork tests:
  - Provider-specific fork tests must run against Base fork state with the selected Uniswap V3 factory/pool and must cover pool discovery, token-pair membership without assuming DIEM is token0, live DIEM balance cap, callback-sender rejection, wrong-token rejection, stale/deadline rejection, insufficient `minDiemOut` including fee, successful fee-inclusive repayment, owner dust refund, and no retained executor balances.
  - Executor deployment fork tests must deploy the executor locally on a Base fork without broadcasting, using the configured Base Uniswap V3, Morpho, Curve, and wstDIEM addresses, and prove constructor config, canonical flash pool derivation, deterministic fee derivation, token side, and zero retained balances immediately after deployment.
  - Fork tests must assert the off-chain plan's `flashFee` equals the provider/executor fee observed during callback and that `minDiemOut >= repayAmountDiem + flashFee` gates calldata generation.
  - Fork tests must run at pinned block `46839394` and at latest block. Pinned-block tests prove deterministic behavior against known evidence; latest-block tests prove current liquidity and deployment assumptions still hold.

Slippage protection:

```text
curvePriceImpact = 1 - (actualDiemOut / expectedDiemOutAtNAV)
abort unless curvePriceImpact <= maxCurvePriceImpactBps / 10_000
```

Emergency flag:

- `--force` skips the slippage guard only.
- It must not skip oracle deviation, simulation, signer, deadline, or reentrancy safety.
- Prompt must display: `FORCE EXIT CAN REALIZE UNBOUNDED CURVE SLIPPAGE`.

## 6. Auto-Deleverager

Resolver condition:

```text
shouldExecute = healthFactor < 1.4 OR netAPY(currentLeverage) < 0.08
```

Target:

```text
targetHealthFactor = 1.7
```

Repay computation when deleveraging by selling collateral:

```text
C = current collateral value in DIEM
D = current debt in DIEM
L = liquidationLTV
H = targetHealthFactor
phi = simulated net DIEM received per DIEM-value of collateral sold

collateralValueToSell = max(0, (H * D - L * C) / (H * phi - L))
repayAmount = phi * collateralValueToSell
```

Off-chain resolver script responsibilities:

- Read the same config and metrics engine as watch mode.
- Return executable calldata only when resolver condition is true.
- Simulate executor `rebalance` to HF 1.7.
- Refuse execution if oracle deviation exceeds 1%.
- Refuse execution if Curve route cannot repay required debt under configured slippage.

On-chain executor interface:

```ts
interface AutoDeleverageExecutorContract {
  checker(owner: Address, marketId: Bytes32): Promise<[boolean, Hex]>;
  deleverageToHealthFactor(owner: Address, marketParams: MorphoMarketParams, targetHealthFactorWad: Uint256, maxSlippageBps: Uint256): ContractWrite<LoopResult>;
}
```

Watch daemon automation monitoring:

- Store `gelatoTaskId` or Chainlink upkeep id.
- Poll task status every 5 minutes.
- Track last resolver true/false, last execution tx, last revert reason.
- Alert WARN if automation has not checked in for 30 minutes.
- Alert CRITICAL if HF < 1.4 and automation is inactive.

## 7. Configuration

```yaml
chainId: 8453

rpc:
  primaryUrl: ${BASE_RPC_URL}
  fallbackUrls:
    - ${BASE_RPC_URL_FALLBACK_1}
    - ${BASE_RPC_URL_FALLBACK_2}
  timeoutMs: 10000

contracts:
  diem: "0xF4d97F2da56e8c3098f3a8D538DB630A2606a024"
  weth: "0x4200000000000000000000000000000000000006"
  vvv: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf"
  vvvStaking: "0x321b7ff75154472B18EDb199033fF4D116F340Ff"
  morphoBlue: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"
  adaptiveCurveIrm: "0x46415998764C29aB2a25CbeA6254146D50D22687"
  curveFactory: "0xd2002373543Ce3527023C75e7518C274A51ce712"
  uniswapV4PoolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b"

  inferenceVault: "0xb9f23c33FfD2213f31C0cFb6c9e2fDf525a9Dd2D"
  feeRouter: "0x3b8d968DCca09E319fac7Df741804Af5644E3a60"
  agentTgeRegistry: "0x09a4227935FF15b261533238F79935CCcA0e7941"
  curvePool: "0xB9c7F62e4EeC145bFa1C6bBc5fFdFf246181FdA2"
  morphoOracle: "0xBAEC9cccba9884d403dBcee15455e28781f1FD72"
  loopExecutor: "0x6fF481F4B3B0E2ADa548D454F7011D1ed51532B6"
  autoDeleverageExecutor: null

morpho:
  marketId: "0x12fd8d51cd36807382afd6128a32e117955d6d065b27a578687142478e81f894"
  lltvWad: "860000000000000000"

wallet:
  privateKeyEnv: WSTDIEM_OPERATOR_PRIVATE_KEY
  hardware:
    enabled: false
    derivationPath: "m/44'/60'/0'/0/0"

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
  telegram:
    botTokenEnv: WSTDIEM_TELEGRAM_BOT_TOKEN
    chatId: null

automation:
  provider: gelato
  gelatoTaskId: null
  chainlinkUpkeepId: null

storage:
  sqlitePath: "./wstdiem-loop-manager.sqlite"

execution:
  defaultSlippageBps: 50
  maxSlippageBps: 300
  maxCurvePriceImpactBps: 100
  transactionDeadlineSeconds: 300
```

## 8. CLI Interface

| Command | Purpose | Key flags | Output |
|---|---|---|---|
| `watch` | Persistent daemon and TUI | `--config`, `--no-tui`, `--json`, `--once` | Live table, stderr alerts |
| `status` | One-shot snapshot | `--config`, `--json`, `--owner` | Table or JSON |
| `loop open` | Open leveraged position | `--target-leverage`, `--initial-diem`, `--slippage-bps`, `--dry-run`, `--json` | Simulation summary, confirmation, tx hash |
| `loop rebalance` | Move to target leverage | `--target-leverage`, `--slippage-bps`, `--dry-run`, `--json` | Simulation summary, tx hash |
| `loop readiness` | Live exit readiness checklist | `--owner`, `--json` | Curve, Morpho, executor, owner, and audit blockers |
| `loop authorize-executor` | Authorize executor on Morpho | `--owner`, `--dry-run`, `--json` | Authorization status, tx hash |
| `loop exit` | Full unwind | `--slippage-bps`, `--force`, `--dry-run`, `--json` | Exit quote, warning, tx hash |
| `loop simulate` | Dry-run only | `--action open|rebalance|exit`, action flags | JSON or table projection |
| `loop history` | Read SQLite tx/position history | `--limit`, `--since`, `--json` | Table or JSON |
| `alerts test` | Send test alert | `--severity`, `--channels`, `--message` | Delivery report |

JSON output envelope:

```ts
interface CliJsonOutput<T> {
  ok: boolean;
  command: string;
  chainId: number;
  blockNumber?: bigint;
  data?: T;
  error?: {
    code: string;
    message: string;
    cause?: string;
  };
}
```

## 9. Error Handling & Safety

RPC timeout/rate limit:

```text
attemptDelayMs = min(30_000, 500 * 2^attempt) + jitter(0..250)
maxAttempts = 5 for reads
maxAttempts = 1 for tx broadcast
```

Rules:

- On read failure, retry primary, then fail over to fallback RPC.
- On inconsistent RPC results, prefer the RPC with the highest finalized block and matching chain id.
- On tx simulation failure, never broadcast.
- On gas estimation failure, never broadcast unless `--force-gas` is added in a future spec; not part of v1.
- If executor multicall/flash callback reverts mid-sequence, EVM atomicity leaves no partial on-chain state except gas spent. The tool must report the revert reason and persist a failed `tx_history` row only if a tx was actually broadcast.
- If broadcast succeeds but receipt is unavailable, mark status `pending_unknown`, continue polling by hash, and alert WARN after 5 minutes.
- The executor contract must use a reentrancy guard on all public entrypoints and flash-loan callbacks.
- The executor must validate callback sender is the configured flash-loan provider.
- The executor must enforce owner authorization and deadline.
- The executor must refund dust and never retain operator funds after successful execution.

## 10. Tech Stack

| Component | Choice | Justification |
|---|---|---|
| Runtime | Node.js 20+ | Current LTS class, stable WebCrypto/fetch, strong TS ecosystem |
| Language | TypeScript | Safer ABI typing and decimal discipline |
| Chain library | `viem` v2 | Native bigint, strong ABI typing, clean simulation APIs; avoid ethers BigNumber and looser typing |
| CLI | `commander` | Mature subcommand/flag parser |
| Config validation | `zod` | Runtime schema validation for YAML/env |
| YAML | `yaml` | Config parsing |
| TUI | `ink` + React | Testable terminal UI components |
| Tables | `cli-table3` | One-shot status/history tables |
| Colors | `chalk` | Stderr severity coloring |
| SQLite | `better-sqlite3` | Simple embedded persistence, predictable sync writes |
| Logging | `pino` | Structured logs |
| HTTP | `undici` | Webhook/Telegram delivery |
| Tests | `vitest` | Fast TypeScript unit tests |
| Foundry fork tests | `forge test --fork-url $BASE_RPC_URL` | Repo uses Foundry and no Hardhat |
| Formatting/lint | `prettier`, `eslint`, `typescript-eslint` | Standard TS hygiene |
| Hardware wallet | `@ledgerhq/hw-transport-node-hid`, `@ledgerhq/hw-app-eth` | Optional Ledger signing |
| Optional Morpho helpers | `@morpho-org/blue-sdk`, `@morpho-org/blue-sdk-viem` | Cross-check Morpho math; viem remains canonical IO |

Dependency table:

| Package | Role |
|---|---|
| `viem` | RPC, ABI reads/writes, simulation |
| `commander` | CLI commands |
| `zod` | Config and CLI validation |
| `yaml` | `config.yaml` parsing |
| `better-sqlite3` | Local state database |
| `ink` | Watch dashboard |
| `react` | Ink runtime |
| `cli-table3` | Snapshot tables |
| `chalk` | Colored stderr |
| `pino` | Structured logging |
| `undici` | Webhook HTTP |
| `dotenv` | Local env loading |
| `telegraf` | Optional Telegram bot delivery |
| `@ledgerhq/hw-transport-node-hid` | Optional Ledger transport |
| `@ledgerhq/hw-app-eth` | Optional Ledger Ethereum signing |
| `vitest` | Unit tests |
| `typescript` | Compiler |
| `tsx` | Dev runner |
| `eslint` | Lint |
| `prettier` | Format |
| `@types/node` | Node typings |
| `@morpho-org/blue-sdk` | Optional Morpho math verification |
| `@morpho-org/blue-sdk-viem` | Optional Morpho viem integration |

Testing split:

- Unit tests: config parsing, decimal math, APY windows, alert thresholds, SQLite persistence, Morpho share-to-asset math, Curve TVL normalization.
- Integration tests: mocked viem client, websocket reconnect, alert delivery.
- Local Foundry tests: dependency-free Solidity harness for Uniswap V3 exit flash callback validation, including factory-derived canonical pool checks, mocked Morpho repay, mocked collateral withdraw, mocked Curve swap, flash repayment, and owner dust refund. Use:

```text
npm run test:contracts
```

- Foundry fork tests: Base flash-provider evidence, local no-broadcast executor deployment readiness, and env-gated full-unwind readiness checks. Use:

```text
npm run test:contracts:fork
```

- Dry-run deployment script: no-broadcast executor deployment entrypoint for production input validation. Use:

```text
npm run deploy:executor:dry-run
```

- Live owner readiness and required full-unwind fork proof are separate production-gate evidence commands. Use:

```text
npm run readiness:owner
npm run proof:full-unwind
```

`loop readiness` accepts `--owner`, `--loop-executor`, and `--strict-evidence` overrides so a deployed executor candidate can be checked before committing it into operator config. The `readiness:owner` evidence script validates nonzero owner/executor env values, rebuilds `dist`, and exits nonzero unless all live checks pass except the intentionally closed audit gate.

`BaseFlashProviderFork.t.sol` always runs when `BASE_RPC_URL` is set and proves the configured Uniswap V3 DIEM/WETH 1% provider deployment, token pair, fee tier, DIEM decimals, and nonzero DIEM inventory at both pinned and latest Base blocks. `BaseLoopExecutorDeployFork.t.sol` deploys the executor locally on a Base fork without broadcasting and proves the constructor/runtime config against the real provider and protocol addresses. `BaseFullUnwindReadinessFork.t.sol` always proves the known wstDIEM vault, Curve pool, Morpho oracle, and Morpho market deployment wiring when `BASE_RPC_URL` is set. It skips full-unwind readiness until at least one full-unwind env var is provided; once configured, it requires all of:

```text
WSTDIEM_FORK_LOOP_EXECUTOR
WSTDIEM_FORK_OWNER
```

The readiness fork uses the configured wstDIEM vault, Curve pool, Morpho oracle, and market id by default, checks deployed code, vault asset/NAV, Curve balances and exit quote, Morpho market params, owner debt/collateral, and `owner -> loopExecutor` Morpho authorization before any full exit fork should be attempted. Optional `WSTDIEM_FORK_INFERENCE_VAULT`, `WSTDIEM_FORK_CURVE_POOL`, `WSTDIEM_FORK_MORPHO_ORACLE`, and `WSTDIEM_FORK_MARKET_ID` env vars may override the known defaults for alternate deployment checks.

## Open Questions

1. Base mainnet addresses for `InferenceVault`/wstDIEM, `FeeRouter`, `AgentTGERegistry`, Router/`loopExecutor`, Curve DIEM/wstDIEM, Morpho oracle, and Morpho market id are now configured from deployed evidence. The Morpho market id `0x12fd8d51cd36807382afd6128a32e117955d6d065b27a578687142478e81f894` resolves to DIEM loan token, wstDIEM collateral, oracle `0xBAEC9cccba9884d403dBcee15455e28781f1FD72`, adaptive Curve IRM, and `86e16` LLTV. Live reads showed nonzero vault assets/supply but zero Curve DIEM/wstDIEM balances and zero Morpho supply/borrow totals, so full unwind remains blocked on Curve liquidity, Morpho liquidity/position state, and a funded/authorized owner position.
2. Flash-loan provider and fee model are selected: Uniswap V3 Base DIEM/WETH 1% with deterministic fee-tier planning and callback-supplied executor repayment. The repo now includes same-block live pool balance evidence, decoded executor event evidence when simulation returns logs, local callback harness tests, Base provider fork tests, no-broadcast executor deployment fork tests, and a dry-run deployment script/checklist. Remaining work is production executor audit signoff, production broadcast gating, and full unwind proof against live liquidity plus a funded/authorized owner position.
3. The requested open sequence includes `curve.swap`; the source vault already mints wstDIEM through `vault.deposit`. Protocol team must decide whether open should use direct deposit, Curve acquisition of wstDIEM, or a hybrid route.
4. The repo now contains a local Uniswap V3 flash-exit executor harness with mocked unwind tests and Base provider/readiness fork tests, but production mainnet executor hardening, full unwind fork proof, and auto-deleverager contracts still require a separate Solidity spec/audit before mainnet use.
5. The Curve pool `TokenExchange` event signature must be verified against the exact deployed StableSwap NG implementation ABI before coding log decoding.
6. Hardware wallet support scope needs a decision: Ledger only, or also Safe transaction building.
7. Confirm whether `riskFreeRate = 5%` remains static or should be read from an external USDC yield source in later versions.
