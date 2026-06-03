// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

struct MorphoMarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

struct LoopExitParams {
    address owner;
    MorphoMarketParams marketParams;
    uint256 repayAmountDiem;
    uint256 maxWstDiemToSell;
    uint256 minDiemOut;
    bool force;
    uint256 deadline;
}

struct LoopResult {
    uint256 collateralWstDiem;
    uint256 borrowedDiem;
    uint256 healthFactorWad;
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ICurvePool {
    function exchange(int128 i, int128 j, uint256 dx, uint256 minDy) external returns (uint256);
}

interface IMorpho {
    function isAuthorized(address authorizer, address authorized) external view returns (bool);
    function position(bytes32 id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);
    function repay(
        MorphoMarketParams calldata marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes calldata data
    ) external returns (uint256 assetsRepaid, uint256 sharesRepaid);
    function withdrawCollateral(
        MorphoMarketParams calldata marketParams,
        uint256 assets,
        address onBehalf,
        address receiver
    ) external;
}

interface IUniswapV3Pool {
    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external;
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

/// @notice Minimal Uniswap V3 flash-exit executor harness for SPEC001.
/// @dev Exit is owner-initiated, callback context is armed only inside exit(), and constructor config is fail-closed.
contract LoopExecutor {
    error CallbackNotArmed();
    error DeadlineExpired();
    error FeeMismatch();
    error InvalidCallbackSender();
    error InvalidContext();
    error InvalidFlashConfig();
    error InvalidMinDiemOut();
    error InvalidProtocolConfig();
    error NonceAlreadyUsed();
    error ReentrantCallback();
    error TransferFailed();
    error ExecutorNotAuthorized();
    error UnauthorizedCaller();

    struct FlashConfig {
        address factory;
        address pool;
        address loanToken;
        address pairToken;
        uint24 feeTier;
    }

    struct ProtocolConfig {
        address morpho;
        address curvePool;
        address wstDiem;
    }

    struct ExitFlashContext {
        address owner;
        address loanToken;
        address pairToken;
        address pool;
        uint24 feeTier;
        uint256 repayAmountDiem;
        uint256 maxWstDiemToSell;
        uint256 minDiemOut;
        bool force;
        uint256 deadline;
        uint256 nonce;
        MorphoMarketParams marketParams;
    }

    event ExitFlashCallbackValidated(
        address indexed owner,
        address indexed pool,
        uint256 repayAmountDiem,
        uint256 flashFee,
        uint256 totalFlashRepaymentDiem,
        uint256 nonce
    );

    event LoopExitExecuted(
        address indexed owner,
        uint256 repayAmountDiem,
        uint256 flashFee,
        uint256 totalFlashRepaymentDiem,
        uint256 wstDiemSold,
        uint256 diemReceived,
        uint256 diemDustRefunded,
        uint256 wstDiemDustRefunded
    );

    FlashConfig public flashConfig;
    ProtocolConfig public protocolConfig;

    bytes32 private armedCallbackHash;
    bool private inFlashCallback;
    uint256 private nextNonce = 1;
    LoopResult private callbackResult;
    mapping(uint256 nonce => bool used) public usedNonce;

    constructor(FlashConfig memory flashConfig_, ProtocolConfig memory protocolConfig_) {
        flashConfig = flashConfig_;
        protocolConfig = protocolConfig_;
        _validateDeploymentConfig();
    }

    function canonicalFlashPool() external view returns (address) {
        return _canonicalFlashPool();
    }

    function expectedFlashFee(uint256 amount) external view returns (uint256) {
        return _expectedFlashFee(amount);
    }

    function loanTokenIsToken0() external view returns (bool) {
        return _loanTokenIsToken0();
    }

    function exit(LoopExitParams calldata params) external returns (LoopResult memory result) {
        if (inFlashCallback) revert ReentrantCallback();
        _validateExitParams(params);
        if (
            IERC20(flashConfig.loanToken).balanceOf(address(this)) != 0
                || IERC20(protocolConfig.wstDiem).balanceOf(address(this)) != 0
        ) {
            revert InvalidContext();
        }

        uint256 nonce = nextNonce++;
        ExitFlashContext memory context = ExitFlashContext({
            owner: params.owner,
            loanToken: flashConfig.loanToken,
            pairToken: flashConfig.pairToken,
            pool: flashConfig.pool,
            feeTier: flashConfig.feeTier,
            repayAmountDiem: params.repayAmountDiem,
            maxWstDiemToSell: params.maxWstDiemToSell,
            minDiemOut: params.minDiemOut,
            force: params.force,
            deadline: params.deadline,
            nonce: nonce,
            marketParams: params.marketParams
        });
        _armExitFlashCallback(context);

        (uint256 amount0, uint256 amount1) =
            _loanTokenIsToken0() ? (params.repayAmountDiem, uint256(0)) : (uint256(0), params.repayAmountDiem);
        IUniswapV3Pool(flashConfig.pool).flash(address(this), amount0, amount1, abi.encode(context));

        result = callbackResult;
        delete callbackResult;
    }

    function _armExitFlashCallback(ExitFlashContext memory context) private {
        _validateStaticContext(context);
        if (block.timestamp > context.deadline) revert DeadlineExpired();
        if (usedNonce[context.nonce]) revert NonceAlreadyUsed();
        armedCallbackHash = keccak256(abi.encode(context));
    }

    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
        if (inFlashCallback) revert ReentrantCallback();
        if (msg.sender != _canonicalFlashPool()) revert InvalidCallbackSender();
        if (armedCallbackHash == bytes32(0)) revert CallbackNotArmed();
        if (keccak256(data) != armedCallbackHash) {
            ExitFlashContext memory suppliedContext = abi.decode(data, (ExitFlashContext));
            if (usedNonce[suppliedContext.nonce]) revert NonceAlreadyUsed();
            revert CallbackNotArmed();
        }

        inFlashCallback = true;
        ExitFlashContext memory context = abi.decode(data, (ExitFlashContext));
        _validateStaticContext(context);
        if (block.timestamp > context.deadline) revert DeadlineExpired();
        if (usedNonce[context.nonce]) revert NonceAlreadyUsed();

        uint256 flashFee = _loanTokenIsToken0() ? fee0 : fee1;
        uint256 otherFee = _loanTokenIsToken0() ? fee1 : fee0;
        if (flashFee != _expectedFlashFee(context.repayAmountDiem)) revert FeeMismatch();
        if (otherFee != 0) revert FeeMismatch();

        uint256 totalRepayment = context.repayAmountDiem + flashFee;
        if (context.minDiemOut < totalRepayment) revert InvalidMinDiemOut();

        uint256 assetsRepaid = _repayBorrowSharesAndWithdraw(context);

        _approveExact(protocolConfig.wstDiem, protocolConfig.curvePool, context.maxWstDiemToSell);
        uint256 diemBeforeCurve = IERC20(flashConfig.loanToken).balanceOf(address(this));
        ICurvePool(protocolConfig.curvePool).exchange(1, 0, context.maxWstDiemToSell, context.minDiemOut);
        uint256 diemAfterCurve = IERC20(flashConfig.loanToken).balanceOf(address(this));
        if (diemAfterCurve < diemBeforeCurve + context.minDiemOut) revert InvalidMinDiemOut();
        uint256 measuredDiemReceived = diemAfterCurve - diemBeforeCurve;
        if (diemAfterCurve < totalRepayment) revert InvalidMinDiemOut();

        _safeTransfer(flashConfig.loanToken, msg.sender, totalRepayment);
        uint256 diemDust = IERC20(flashConfig.loanToken).balanceOf(address(this));
        uint256 wstDiemDust = IERC20(protocolConfig.wstDiem).balanceOf(address(this));
        if (diemDust > 0) _safeTransfer(flashConfig.loanToken, context.owner, diemDust);
        if (wstDiemDust > 0) _safeTransfer(protocolConfig.wstDiem, context.owner, wstDiemDust);

        usedNonce[context.nonce] = true;
        armedCallbackHash = bytes32(0);
        callbackResult = LoopResult({collateralWstDiem: 0, borrowedDiem: 0, healthFactorWad: 0});
        emit ExitFlashCallbackValidated(
            context.owner, context.pool, context.repayAmountDiem, flashFee, totalRepayment, context.nonce
        );
        emit LoopExitExecuted(
            context.owner,
            assetsRepaid,
            flashFee,
            totalRepayment,
            context.maxWstDiemToSell,
            measuredDiemReceived,
            diemDust,
            wstDiemDust
        );
        inFlashCallback = false;
    }

    function _validateExitParams(LoopExitParams calldata params) private view {
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (msg.sender != params.owner) revert UnauthorizedCaller();
        if (params.owner == address(0) || params.repayAmountDiem == 0 || params.maxWstDiemToSell == 0) {
            revert InvalidContext();
        }
        if (
            params.marketParams.loanToken != flashConfig.loanToken
                || params.marketParams.collateralToken != protocolConfig.wstDiem
        ) {
            revert InvalidContext();
        }
        if (params.minDiemOut < params.repayAmountDiem + _expectedFlashFee(params.repayAmountDiem)) {
            revert InvalidMinDiemOut();
        }
    }

    function _repayBorrowSharesAndWithdraw(ExitFlashContext memory context) private returns (uint256 assetsRepaid) {
        if (!IMorpho(protocolConfig.morpho).isAuthorized(context.owner, address(this))) {
            revert ExecutorNotAuthorized();
        }

        bytes32 marketId = keccak256(abi.encode(context.marketParams));
        (, uint128 borrowShares,) = IMorpho(protocolConfig.morpho).position(marketId, context.owner);
        _approveExact(flashConfig.loanToken, protocolConfig.morpho, context.repayAmountDiem);
        (assetsRepaid,) = IMorpho(protocolConfig.morpho).repay(context.marketParams, 0, borrowShares, context.owner, "");
        IMorpho(protocolConfig.morpho)
            .withdrawCollateral(context.marketParams, context.maxWstDiemToSell, context.owner, address(this));
    }

    function _validateStaticContext(ExitFlashContext memory context) private view {
        if (
            context.owner == address(0) || context.loanToken != flashConfig.loanToken
                || context.pairToken != flashConfig.pairToken || context.pool != flashConfig.pool
                || context.pool != _canonicalFlashPool() || context.feeTier != flashConfig.feeTier
                || context.repayAmountDiem == 0 || context.maxWstDiemToSell == 0
                || context.marketParams.loanToken != flashConfig.loanToken
                || context.marketParams.collateralToken != protocolConfig.wstDiem
        ) {
            revert InvalidContext();
        }
    }

    function _validateDeploymentConfig() private view {
        if (
            flashConfig.factory == address(0) || flashConfig.pool == address(0) || flashConfig.loanToken == address(0)
                || flashConfig.pairToken == address(0) || flashConfig.loanToken == flashConfig.pairToken
                || flashConfig.feeTier == 0 || flashConfig.factory.code.length == 0 || flashConfig.pool.code.length == 0
                || flashConfig.loanToken.code.length == 0 || flashConfig.pairToken.code.length == 0
                || flashConfig.pool != _canonicalFlashPool()
        ) {
            revert InvalidFlashConfig();
        }
        if (
            protocolConfig.morpho == address(0) || protocolConfig.curvePool == address(0)
                || protocolConfig.wstDiem == address(0) || protocolConfig.morpho.code.length == 0
                || protocolConfig.curvePool.code.length == 0 || protocolConfig.wstDiem.code.length == 0
        ) {
            revert InvalidProtocolConfig();
        }
    }

    function _approveExact(address token, address spender, uint256 amount) private {
        _safeApprove(token, spender, 0);
        _safeApprove(token, spender, amount);
    }

    function _safeApprove(address token, address spender, uint256 amount) private {
        _callOptionalReturn(token, abi.encodeCall(IERC20.approve, (spender, amount)));
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        _callOptionalReturn(token, abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function _callOptionalReturn(address token, bytes memory data) private {
        (bool success, bytes memory returndata) = token.call(data);
        if (!success || (returndata.length != 0 && !abi.decode(returndata, (bool)))) revert TransferFailed();
    }

    function _expectedFlashFee(uint256 amount) private view returns (uint256) {
        return _ceilDiv(amount * uint256(flashConfig.feeTier), 1_000_000);
    }

    function _loanTokenIsToken0() private view returns (bool) {
        return flashConfig.loanToken < flashConfig.pairToken;
    }

    function _canonicalFlashPool() private view returns (address) {
        return IUniswapV3Factory(flashConfig.factory)
            .getPool(flashConfig.loanToken, flashConfig.pairToken, flashConfig.feeTier);
    }

    function _ceilDiv(uint256 numerator, uint256 denominator) private pure returns (uint256) {
        return numerator == 0 ? 0 : ((numerator - 1) / denominator) + 1;
    }
}
