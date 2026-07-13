/** Venue adapter events + reads (BaseInferenceAdapter and subclasses). SPEC009. */
export const inferenceAdapterEventAbis = [
  {
    type: "event",
    name: "SettlementReceived",
    inputs: [{ name: "amount", type: "uint256", indexed: false }],
  },
  {
    type: "event",
    name: "YieldRouted",
    inputs: [
      { name: "usdc", type: "uint256", indexed: false },
      { name: "diem", type: "uint256", indexed: false },
      { name: "operatorShares", type: "uint256", indexed: false },
    ],
  },
] as const;

export const inferenceAdapterReadAbis = [
  {
    type: "function",
    name: "inferenceName",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "operatorFeeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const inferenceAdapterAbi = [...inferenceAdapterEventAbis, ...inferenceAdapterReadAbis] as const;
