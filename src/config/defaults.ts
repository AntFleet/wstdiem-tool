import "dotenv/config";
import type { AppConfig } from "../types/domain.js";

export const DEFAULT_CONFIG: AppConfig = {
  chainId: 8453,
  rpc: {
    // Normalize empty/whitespace env values to null: `??` only catches null/undefined, so a
    // `BASE_RPC_URL=` with no value (a common .env misconfig) would otherwise become "" — which
    // is NOT `=== null`, bypassing the no-RPC fail-closed guard and silently building a client
    // against viem's default public endpoint for safety-critical reads. Empty = no RPC configured.
    primaryUrl: process.env.BASE_RPC_URL?.trim() || null,
    fallbackUrls: [
      process.env.BASE_RPC_URL_FALLBACK_1,
      process.env.BASE_RPC_URL_FALLBACK_2,
    ]
      .map((url) => url?.trim())
      .filter((url): url is string => Boolean(url)),
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
    inferenceVault: "0xe49FA849cB37b0e7A42B2335e333fb99474167ba",
    feeRouter: "0xa13a6e75d696bAceB38236389eeFD6eCa5FD4ED3",
    agentTgeRegistry: "0xb13830e7f72Eef167A7F188285feBa5f7C1198Ef",
    curvePool: "0x21c33a1Bb5f6Eb43563e1fB9e7AA1D4E90C1A0CD",
    morphoOracle: "0xAF29776f93FE0bf21282bF792A52AC212f20F45c",
    loopExecutor: "0x74ad4532133Ba538945a5371D249560E66CC7c71",
    autoDeleverageExecutor: null,
  },
  morpho: {
    marketId: "0xdd6b9f10bf69445ebba0626ef54042af628cdf65dda98ff68df4d235d4d56c76",
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
    basisDiscountWarnBps: 100,
    basisDiscountCriticalBps: 500,
  },
  basis: {
    marketPriceDiemPerWstDiem: null,
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
