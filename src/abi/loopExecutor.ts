export const loopExecutorAbi = [
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
  {
    type: "function",
    name: "canonicalFlashPool",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "expectedFlashFee",
    stateMutability: "view",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "loanTokenIsToken0",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "ExitFlashCallbackValidated",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "pool", type: "address", indexed: true },
      { name: "repayAmountDiem", type: "uint256", indexed: false },
      { name: "flashFee", type: "uint256", indexed: false },
      { name: "totalFlashRepaymentDiem", type: "uint256", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LoopExitExecuted",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "repayAmountDiem", type: "uint256", indexed: false },
      { name: "flashFee", type: "uint256", indexed: false },
      { name: "totalFlashRepaymentDiem", type: "uint256", indexed: false },
      { name: "wstDiemSold", type: "uint256", indexed: false },
      { name: "diemReceived", type: "uint256", indexed: false },
      { name: "diemDustRefunded", type: "uint256", indexed: false },
      { name: "wstDiemDustRefunded", type: "uint256", indexed: false },
    ],
  },
] as const;
