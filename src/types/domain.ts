export type Address = `0x${string}`;
export type Hex = `0x${string}`;
export type Severity = "INFO" | "WARN" | "CRITICAL";

export interface ContractsConfig {
  diem: Address;
  weth: Address;
  vvv: Address;
  vvvStaking: Address;
  morphoBlue: Address;
  adaptiveCurveIrm: Address;
  curveFactory: Address;
  uniswapV4PoolManager: Address;
  inferenceVault: Address | null;
  feeRouter: Address | null;
  agentTgeRegistry: Address | null;
  curvePool: Address | null;
  morphoOracle: Address | null;
  loopExecutor: Address | null;
  autoDeleverageExecutor: Address | null;
}

export interface FlashLoanConfig {
  provider: "uniswap-v3" | "unconfigured";
  factory: Address | null;
  pool: Address | null;
  loanToken: Address | null;
  pairToken: Address | null;
  feeTier: number | null;
}

export interface ThresholdConfig {
  healthFactorWarn: number;
  healthFactorCritical: number;
  minPostLoopHealthFactor: number;
  spreadWarnNetApy35: number;
  spreadCriticalNetApy35: number;
  curveDepthWarn: number;
  curveDepthCritical: number;
  harvestSilenceWarnDays: number;
  harvestSilenceCriticalDays: number;
  oracleDeviationCritical: number;
  borrowSpikeBaseApyRatio: number;
  riskFreeRate: number;
}

export interface AppConfig {
  chainId: number;
  rpc: {
    primaryUrl: string | null;
    fallbackUrls: string[];
    timeoutMs: number;
  };
  contracts: ContractsConfig;
  morpho: {
    marketId: Hex | null;
    lltvWad: string;
  };
  wallet: {
    privateKeyEnv: string;
    hardware: {
      enabled: boolean;
      derivationPath: string;
    };
  };
  position: {
    owner: Address | null;
  };
  thresholds: ThresholdConfig;
  alerts: {
    webhookUrls: string[];
    telegram: {
      botTokenEnv: string;
      chatId: string | null;
    };
  };
  automation: {
    provider: "gelato" | "chainlink";
    gelatoTaskId: string | null;
    chainlinkUpkeepId: string | null;
  };
  flashLoan: FlashLoanConfig;
  storage: {
    sqlitePath: string;
  };
  execution: {
    defaultSlippageBps: number;
    maxSlippageBps: number;
    maxCurvePriceImpactBps: number;
    exitRepayBufferBps: number;
    maxBaseApyStalenessBlocks: number;
    transactionDeadlineSeconds: number;
  };
}

export interface MorphoMarket {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
}

export interface MorphoPosition {
  supplyShares: bigint;
  borrowShares: bigint;
  collateral: bigint;
}

export interface MetricSnapshot {
  timestamp: number;
  blockNumber: bigint;
  validity: {
    vault: boolean;
    yieldWindow: boolean;
    morphoMarket: boolean;
    position: boolean;
    curve: boolean;
    oracle: boolean;
    harvestHistory: boolean;
    rpcFreshness: boolean;
  };
  nav: bigint;
  navDisplay: string;
  navSource: "empty" | "onchain";
  vaultTotalAssetsDiem: bigint;
  baseApy: number;
  borrowRate: number;
  utilization: number;
  netApy35: number;
  spreadScore: number;
  healthFactor: number;
  leverage: number;
  curveTvlDiem: bigint;
  oracleDeviation: number;
  positionSizeVsCurveDepth: number;
  lastHarvestAt: number | null;
  latestBlockAgeSeconds: number;
}

export interface StoredCreditEvent {
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  timestamp: number;
  source: string;
  amountDiem: bigint;
}

export interface StoredHarvestEvent {
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  timestamp: number;
  eventName: string;
  tokenIn?: string;
  amountIn?: bigint;
  amountOut?: bigint;
}

export interface StoredCurveSwap {
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  timestamp: number;
  soldId: number;
  boughtId: number;
  tokensSold: bigint;
  tokensBought: bigint;
  volumeDiem: bigint;
}

export interface StoredPositionSnapshot {
  timestamp: number;
  blockNumber: bigint;
  owner: Address;
  collateralWstDiem: bigint;
  borrowedDiem: bigint;
  leverage: number;
  healthFactor: number;
}

export interface AlertEvaluation {
  alertKey: string;
  level: Severity;
  message: string;
  suggestedAction: string;
  cooldownSeconds: number;
  metrics: Record<string, unknown>;
}

export interface CliJsonOutput<T> {
  ok: boolean;
  command: string;
  chainId: number;
  blockNumber?: string;
  data?: T;
  error?: {
    code: string;
    message: string;
    cause?: string;
  };
}
