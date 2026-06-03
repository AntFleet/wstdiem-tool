export const loopExecutorAbi = [
  {
    type: "function",
    name: "open",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          {
            name: "marketParams",
            type: "tuple",
            components: [
              { name: "loanToken", type: "address" },
              { name: "collateralToken", type: "address" },
              { name: "oracle", type: "address" },
              { name: "irm", type: "address" },
              { name: "lltv", type: "uint256" },
            ],
          },
          { name: "initialDiem", type: "uint256" },
          { name: "flashDiem", type: "uint256" },
          { name: "minWstDiemReceived", type: "uint256" },
          { name: "minBorrowedDiem", type: "uint256" },
          { name: "maxCurvePriceImpactBps", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "collateralWstDiem", type: "uint256" },
          { name: "borrowedDiem", type: "uint256" },
          { name: "healthFactorWad", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "rebalance",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          {
            name: "marketParams",
            type: "tuple",
            components: [
              { name: "loanToken", type: "address" },
              { name: "collateralToken", type: "address" },
              { name: "oracle", type: "address" },
              { name: "irm", type: "address" },
              { name: "lltv", type: "uint256" },
            ],
          },
          { name: "targetLeverageWad", type: "uint256" },
          { name: "maxSlippageBps", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "collateralWstDiem", type: "uint256" },
          { name: "borrowedDiem", type: "uint256" },
          { name: "healthFactorWad", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "exit",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "owner", type: "address" },
          {
            name: "marketParams",
            type: "tuple",
            components: [
              { name: "loanToken", type: "address" },
              { name: "collateralToken", type: "address" },
              { name: "oracle", type: "address" },
              { name: "irm", type: "address" },
              { name: "lltv", type: "uint256" },
            ],
          },
          { name: "repayAmountDiem", type: "uint256" },
          { name: "maxWstDiemToSell", type: "uint256" },
          { name: "minDiemOut", type: "uint256" },
          { name: "force", type: "bool" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "collateralWstDiem", type: "uint256" },
          { name: "borrowedDiem", type: "uint256" },
          { name: "healthFactorWad", type: "uint256" },
        ],
      },
    ],
  },
] as const;
