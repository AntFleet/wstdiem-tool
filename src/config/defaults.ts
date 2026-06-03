import type { AppConfig } from "../types/domain.js";

export const DEFAULT_CONFIG: AppConfig = {
  chainId: 8453,
  rpc: {
    primaryUrl: process.env.BASE_RPC_URL ?? null,
    fallbackUrls: [
      process.env.BASE_RPC_URL_FALLBACK_1,
      process.env.BASE_RPC_URL_FALLBACK_2,
    ].filter((url): url is string => Boolean(url)),
    timeoutMs: 10_000,
  },
  contracts: {
    diem: "0xF4d97F2da56e8c3098f3a8D538DB630A2606a024",
    weth: "0x4200000000000000000000000000000000000006",
    vvv: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf",
    vvvStaking: "0x321b7ff75154472B18EDb199033fF4D116F340Ff",
    morphoBlue: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
    adaptiveCurveIrm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
    curveFactory: "0xd2002373543Ce3527023C75e7518C274A51ce712",
    uniswapV4PoolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
    inferenceVault: "0x4751BA2b09374C1929FC01734a166e3c8cd75810",
    feeRouter: "0x21fe048B10dC9bED2Ee0Ae76724C627CA7F35F61",
    curvePool: "0x39A4b4779C71E1A18d500627639682c9583Ee86f",
    morphoOracle: "0xBAEC9cccba9884d403dBcee15455e28781f1FD72",
    loopExecutor: null,
    autoDeleverageExecutor: null,
  },
  morpho: {
    marketId: "0x12fd8d51cd36807382afd6128a32e117955d6d065b27a578687142478e81f894",
    lltvWad: "860000000000000000",
  },
  wallet: {
    privateKeyEnv: "WSTDIEM_OPERATOR_PRIVATE_KEY",
    hardware: {
      enabled: false,
      derivationPath: "m/44'/60'/0'/0/0",
    },
  },
  position: {
    owner: null,
  },
  thresholds: {
    healthFactorWarn: 1.6,
    healthFactorCritical: 1.4,
    minPostLoopHealthFactor: 1.7,
    spreadWarnNetApy35: 0.15,
    spreadCriticalNetApy35: 0.08,
    curveDepthWarn: 0.15,
    curveDepthCritical: 0.2,
    harvestSilenceWarnDays: 7,
    harvestSilenceCriticalDays: 14,
    oracleDeviationCritical: 0.01,
    borrowSpikeBaseApyRatio: 0.7,
    riskFreeRate: 0.05,
  },
  alerts: {
    webhookUrls: [],
    telegram: {
      botTokenEnv: "WSTDIEM_TELEGRAM_BOT_TOKEN",
      chatId: null,
    },
  },
  automation: {
    provider: "gelato",
    gelatoTaskId: null,
    chainlinkUpkeepId: null,
  },
  flashLoan: {
    provider: "uniswap-v3",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    pool: "0x80d995189ecc593672aD4703b250a5e82672EB1D",
    loanToken: "0xF4d97F2da56e8c3098f3a8D538DB630A2606a024",
    pairToken: "0x4200000000000000000000000000000000000006",
    feeTier: 10_000,
  },
  storage: {
    sqlitePath: "./wstdiem-loop-manager.sqlite",
  },
  execution: {
    defaultSlippageBps: 50,
    maxSlippageBps: 300,
    maxCurvePriceImpactBps: 100,
    exitRepayBufferBps: 200,
    maxBaseApyStalenessBlocks: 7_200,
    transactionDeadlineSeconds: 300,
  },
};
