// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface VmFullUnwind {
    function envOr(string calldata name, string calldata defaultValue) external view returns (string memory);
    function envOr(string calldata name, address defaultValue) external view returns (address);
    function envOr(string calldata name, bytes32 defaultValue) external view returns (bytes32);
    function createSelectFork(string calldata url) external returns (uint256);
}

struct ForkMarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

struct ForkPosition {
    uint256 supplyShares;
    uint128 borrowShares;
    uint128 collateral;
}

interface IInferenceVaultFork {
    function symbol() external view returns (string memory);
    function asset() external view returns (address);
    function totalAssets() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
}

interface IMorphoBlueFork {
    function idToMarketParams(bytes32 id) external view returns (ForkMarketParams memory);
    function position(bytes32 id, address user) external view returns (ForkPosition memory);
    function isAuthorized(address authorizer, address authorized) external view returns (bool);
}

interface IWstDiemMorphoOracleFork {
    function vault() external view returns (address);
    function price() external view returns (uint256);
}

interface ICurvePoolFork {
    function coins(uint256 i) external view returns (address);
    function balances(uint256 i) external view returns (uint256);
    function fee() external view returns (uint256);
    function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256);
}

interface ILoopExecutorFork {
    function canonicalFlashPool() external view returns (address);
    function expectedFlashFee(uint256 amount) external view returns (uint256);
    function loanTokenIsToken0() external view returns (bool);
    function flashConfig()
        external
        view
        returns (address factory, address pool, address loanToken, address pairToken, uint24 feeTier);
    function protocolConfig() external view returns (address morpho, address curvePool, address wstDiem);
}

contract BaseFullUnwindReadinessForkTest {
    VmFullUnwind private constant vm = VmFullUnwind(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant DIEM = 0xF4d97F2da56e8c3098f3a8D538DB630A2606a024;
    address private constant INFERENCE_VAULT = 0xe49FA849cB37b0e7A42B2335e333fb99474167ba;
    address private constant CURVE_POOL = 0x21c33a1Bb5f6Eb43563e1fB9e7AA1D4E90C1A0CD;
    address private constant MORPHO_BLUE = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address private constant MORPHO_ORACLE = 0xAF29776f93FE0bf21282bF792A52AC212f20F45c;
    address private constant ADAPTIVE_CURVE_IRM = 0x46415998764C29aB2a25CbeA6254146D50D22687;
    address private constant UNISWAP_V3_DIEM_WETH_POOL = 0x80d995189ecc593672aD4703b250a5e82672EB1D;
    address private constant WETH = 0x4200000000000000000000000000000000000006;
    bytes32 private constant MARKET_ID = 0xdd6b9f10bf69445ebba0626ef54042af628cdf65dda98ff68df4d235d4d56c76;
    uint256 private constant LLTV = 860_000_000_000_000_000;
    uint256 private constant BASE_CHAIN_ID = 8453;
    uint24 private constant UNISWAP_V3_FEE_TIER = 10_000;
    address private constant UNISWAP_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;

    struct FullUnwindEnv {
        address inferenceVault;
        address curvePool;
        address morphoOracle;
        address loopExecutor;
        address owner;
        bytes32 marketId;
    }

    function testLatestBlockWstDiemAndCurveDeploymentEvidence() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc);
        _assertBaseChain();

        _assertContract(INFERENCE_VAULT, "missing inferenceVault code");
        _assertContract(CURVE_POOL, "missing curvePool code");
        require(_stringEqual(IInferenceVaultFork(INFERENCE_VAULT).symbol(), "wstDIEM"), "vault symbol mismatch");
        require(IInferenceVaultFork(INFERENCE_VAULT).asset() == DIEM, "vault asset is not DIEM");
        require(IInferenceVaultFork(INFERENCE_VAULT).totalAssets() > 0, "vault totalAssets is zero");
        require(IInferenceVaultFork(INFERENCE_VAULT).totalSupply() > 0, "vault totalSupply is zero");
        require(IInferenceVaultFork(INFERENCE_VAULT).convertToAssets(1 ether) > 0, "vault NAV unavailable");
        require(ICurvePoolFork(CURVE_POOL).coins(0) == DIEM, "curve coin0 is not DIEM");
        require(ICurvePoolFork(CURVE_POOL).coins(1) == INFERENCE_VAULT, "curve coin1 is not wstDIEM");
        require(ICurvePoolFork(CURVE_POOL).fee() > 0, "curve fee unavailable");
        ICurvePoolFork(CURVE_POOL).balances(0);
        ICurvePoolFork(CURVE_POOL).balances(1);
    }

    function testLatestBlockMorphoMarketDeploymentEvidence() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc);
        _assertBaseChain();

        _assertContract(MORPHO_ORACLE, "missing morphoOracle code");
        require(IWstDiemMorphoOracleFork(MORPHO_ORACLE).vault() == INFERENCE_VAULT, "oracle vault mismatch");
        require(IWstDiemMorphoOracleFork(MORPHO_ORACLE).price() > 0, "oracle price unavailable");
        _assertMorphoMarket(MARKET_ID, INFERENCE_VAULT, MORPHO_ORACLE);
    }

    function testLatestBlockFullUnwindReadinessWhenEnvProvided() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;

        FullUnwindEnv memory env = FullUnwindEnv({
            inferenceVault: vm.envOr("WSTDIEM_FORK_INFERENCE_VAULT", INFERENCE_VAULT),
            curvePool: vm.envOr("WSTDIEM_FORK_CURVE_POOL", CURVE_POOL),
            morphoOracle: vm.envOr("WSTDIEM_FORK_MORPHO_ORACLE", MORPHO_ORACLE),
            loopExecutor: vm.envOr("WSTDIEM_FORK_LOOP_EXECUTOR", address(0)),
            owner: vm.envOr("WSTDIEM_FORK_OWNER", address(0)),
            marketId: vm.envOr("WSTDIEM_FORK_MARKET_ID", MARKET_ID)
        });

        if (!_hasAnyFullUnwindEnvRequest()) return;
        _requireCompleteFullUnwindEnv(env);

        vm.createSelectFork(rpc);
        _assertBaseChain();

        _assertContract(env.inferenceVault, "missing inferenceVault code");
        _assertContract(env.curvePool, "missing curvePool code");
        _assertContract(env.morphoOracle, "missing morphoOracle code");
        _assertContract(env.loopExecutor, "missing loopExecutor code");

        require(IInferenceVaultFork(env.inferenceVault).asset() == DIEM, "vault asset is not DIEM");
        require(IInferenceVaultFork(env.inferenceVault).convertToAssets(1 ether) > 0, "vault NAV unavailable");
        require(ICurvePoolFork(env.curvePool).balances(0) > 0, "curve DIEM balance is zero");
        require(ICurvePoolFork(env.curvePool).balances(1) > 0, "curve wstDIEM balance is zero");
        require(ICurvePoolFork(env.curvePool).get_dy(1, 0, 1 ether) > 0, "curve exit quote unavailable");

        _assertLoopExecutor(env.loopExecutor, env.inferenceVault, env.curvePool);
        _assertMorphoMarket(env.marketId, env.inferenceVault, env.morphoOracle);

        ForkPosition memory position = IMorphoBlueFork(MORPHO_BLUE).position(env.marketId, env.owner);
        require(position.borrowShares > 0, "owner has no Morpho debt");
        require(position.collateral > 0, "owner has no Morpho collateral");
        require(IMorphoBlueFork(MORPHO_BLUE).isAuthorized(env.owner, env.loopExecutor), "executor not authorized");
    }

    function _hasAnyFullUnwindEnvRequest() private view returns (bool) {
        return bytes(vm.envOr("WSTDIEM_FORK_INFERENCE_VAULT", string(""))).length > 0
            || bytes(vm.envOr("WSTDIEM_FORK_CURVE_POOL", string(""))).length > 0
            || bytes(vm.envOr("WSTDIEM_FORK_MORPHO_ORACLE", string(""))).length > 0
            || bytes(vm.envOr("WSTDIEM_FORK_LOOP_EXECUTOR", string(""))).length > 0
            || bytes(vm.envOr("WSTDIEM_FORK_OWNER", string(""))).length > 0
            || bytes(vm.envOr("WSTDIEM_FORK_MARKET_ID", string(""))).length > 0;
    }

    function _requireCompleteFullUnwindEnv(FullUnwindEnv memory env) private pure {
        require(env.inferenceVault != address(0), "set WSTDIEM_FORK_INFERENCE_VAULT");
        require(env.curvePool != address(0), "set WSTDIEM_FORK_CURVE_POOL");
        require(env.morphoOracle != address(0), "set WSTDIEM_FORK_MORPHO_ORACLE");
        require(env.loopExecutor != address(0), "set WSTDIEM_FORK_LOOP_EXECUTOR");
        require(env.owner != address(0), "set WSTDIEM_FORK_OWNER");
        require(env.marketId != bytes32(0), "set WSTDIEM_FORK_MARKET_ID");
    }

    function _assertContract(address target, string memory message) private view {
        require(target.code.length > 0, message);
    }

    function _assertMorphoMarket(bytes32 marketId, address inferenceVault, address oracle) private view {
        ForkMarketParams memory params = IMorphoBlueFork(MORPHO_BLUE).idToMarketParams(marketId);
        require(params.loanToken == DIEM, "morpho loan token mismatch");
        require(params.collateralToken == inferenceVault, "morpho collateral token mismatch");
        require(params.oracle == oracle, "morpho oracle mismatch");
        require(params.irm == ADAPTIVE_CURVE_IRM, "morpho irm mismatch");
        require(params.lltv == LLTV, "morpho lltv mismatch");
    }

    function _assertBaseChain() private view {
        require(block.chainid == BASE_CHAIN_ID, "unexpected chain id");
    }

    function _assertLoopExecutor(address loopExecutor, address inferenceVault, address curvePool) private view {
        require(
            ILoopExecutorFork(loopExecutor).canonicalFlashPool() == UNISWAP_V3_DIEM_WETH_POOL,
            "executor flash pool mismatch"
        );
        require(ILoopExecutorFork(loopExecutor).expectedFlashFee(50 ether) == 0.5 ether, "executor flash fee mismatch");
        require(
            ILoopExecutorFork(loopExecutor).loanTokenIsToken0() == (DIEM < WETH), "executor loan token side mismatch"
        );
        (address factory, address pool, address loanToken, address pairToken, uint24 feeTier) =
            ILoopExecutorFork(loopExecutor).flashConfig();
        require(factory == UNISWAP_V3_FACTORY, "executor factory mismatch");
        require(pool == UNISWAP_V3_DIEM_WETH_POOL, "executor pool mismatch");
        require(loanToken == DIEM, "executor loan token mismatch");
        require(pairToken == WETH, "executor pair token mismatch");
        require(feeTier == UNISWAP_V3_FEE_TIER, "executor fee tier mismatch");

        (address morpho, address executorCurvePool, address wstDiem) = ILoopExecutorFork(loopExecutor).protocolConfig();
        require(morpho == MORPHO_BLUE, "executor morpho mismatch");
        require(executorCurvePool == curvePool, "executor curve pool mismatch");
        require(wstDiem == inferenceVault, "executor wstDIEM mismatch");
    }

    function _stringEqual(string memory left, string memory right) private pure returns (bool) {
        return keccak256(bytes(left)) == keccak256(bytes(right));
    }
}
