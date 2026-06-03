// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LoopExecutor, LoopExitParams, MorphoMarketParams} from "../../contracts/LoopExecutor.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
    }

    function prank(address sender) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory entries);
    function warp(uint256 timestamp) external;
}

contract LoopExecutorTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant OWNER = 0x0000000000000000000000000000000000000009;
    address private constant ORACLE = 0x0000000000000000000000000000000000000007;
    address private constant IRM = 0x0000000000000000000000000000000000000008;
    uint24 private constant FEE_TIER = 10_000;
    uint256 private constant REPAY_AMOUNT = 50 ether;
    uint256 private constant FLASH_FEE = 0.5 ether;
    uint256 private constant WST_TO_SELL = 100 ether;
    uint256 private constant DIEM_OUT = 52 ether;

    MockERC20 private diem;
    MockERC20 private weth;
    MockERC20 private wstDiem;
    MockMorpho private morpho;
    MockCurvePool private curvePool;
    MockUniswapV3Factory private factory;
    MockUniswapV3Pool private uniswapPool;
    LoopExecutor private executor;

    function setUp() public {
        diem = new MockERC20();
        weth = new MockERC20();
        wstDiem = new MockERC20();
        morpho = new MockMorpho(diem, wstDiem);
        curvePool = new MockCurvePool(wstDiem, diem);
        factory = new MockUniswapV3Factory();
        uniswapPool = new MockUniswapV3Pool(diem);
        factory.setPool(address(uniswapPool));
        executor = new LoopExecutor(
            LoopExecutor.FlashConfig({
                factory: address(factory),
                pool: address(uniswapPool),
                loanToken: address(diem),
                pairToken: address(weth),
                feeTier: FEE_TIER
            }),
            LoopExecutor.ProtocolConfig({
                morpho: address(morpho), curvePool: address(curvePool), wstDiem: address(wstDiem)
            })
        );
        uniswapPool.setExecutor(executor);
        morpho.seedCollateral(WST_TO_SELL);
        morpho.seedDebt(REPAY_AMOUNT, uint128(REPAY_AMOUNT));
        curvePool.seedDiem(DIEM_OUT);
        uniswapPool.seedDiem(1_000 ether);
    }

    function testExitInitiatesFlashUnwindsAndRepays() public {
        LoopExitParams memory params = _params(REPAY_AMOUNT + FLASH_FEE);

        vm.recordLogs();
        _exitAsOwner(params);
        uint256 emittedDiemReceived = _emittedDiemReceived(vm.getRecordedLogs());

        require(uniswapPool.repaid() == REPAY_AMOUNT + FLASH_FEE, "flash not repaid");
        require(morpho.repaidAssets() == REPAY_AMOUNT, "morpho repay mismatch");
        require(morpho.repaidShares() == REPAY_AMOUNT, "morpho shares repay mismatch");
        require(curvePool.wstDiemSold() == WST_TO_SELL, "wstDIEM sale mismatch");
        require(emittedDiemReceived == DIEM_OUT, "event DIEM received mismatch");
        require(diem.balanceOf(OWNER) == DIEM_OUT - REPAY_AMOUNT - FLASH_FEE, "DIEM dust not refunded");
        require(wstDiem.balanceOf(address(executor)) == 0, "executor retained wstDIEM");
        require(diem.balanceOf(address(executor)) == 0, "executor retained DIEM");
        require(executor.usedNonce(1), "nonce not consumed");
    }

    function testDeploymentConfigProofHelpers() public view {
        require(executor.canonicalFlashPool() == address(uniswapPool), "canonical pool mismatch");
        require(executor.expectedFlashFee(REPAY_AMOUNT) == FLASH_FEE, "expected fee mismatch");
        require(executor.loanTokenIsToken0() == (address(diem) < address(weth)), "token side mismatch");
    }

    function testExitRepaysBorrowSharesAfterInterestAccrues() public {
        uint256 bufferedRepayAmount = 51 ether;
        uint256 accruedDebt = 50.1 ether;
        uint256 flashFee = 0.51 ether;
        morpho.accrueInterest(accruedDebt);

        LoopExitParams memory params = _paramsForRepayAmount(bufferedRepayAmount, bufferedRepayAmount + flashFee);

        _exitAsOwner(params);

        require(uniswapPool.repaid() == bufferedRepayAmount + flashFee, "buffered flash not repaid");
        require(morpho.repaidAssets() == accruedDebt, "accrued Morpho debt not repaid");
        require(morpho.repaidShares() == REPAY_AMOUNT, "borrow shares not fully repaid");
        require(morpho.borrowShares() == 0, "residual borrow shares");
        require(
            diem.balanceOf(OWNER) == DIEM_OUT + bufferedRepayAmount - accruedDebt - bufferedRepayAmount - flashFee,
            "dust mismatch"
        );
    }

    function testUnauthorizedMorphoDelegationRevertsBeforeRepay() public {
        LoopExitParams memory params = _params(REPAY_AMOUNT + FLASH_FEE);
        morpho.setAuthorized(false);

        (bool ok, bytes memory revertData) = _callExitAsOwner(params);

        _assertRevertSelector(ok, revertData, LoopExecutor.ExecutorNotAuthorized.selector);
    }

    function testReentrantCallbackReverts() public {
        LoopExitParams memory params = _params(REPAY_AMOUNT + FLASH_FEE);
        morpho.setReenterCallback(executor);

        (bool ok, bytes memory revertData) = _callExitAsOwner(params);

        _assertRevertSelector(ok, revertData, LoopExecutor.ReentrantCallback.selector);
    }

    function testCallbackDeadlineExpiryReverts() public {
        LoopExitParams memory params = _params(REPAY_AMOUNT + FLASH_FEE);
        params.deadline = block.timestamp + 1;
        uniswapPool.warpBeforeCallback(block.timestamp + 2);

        (bool ok, bytes memory revertData) = _callExitAsOwner(params);

        _assertRevertSelector(ok, revertData, LoopExecutor.DeadlineExpired.selector);
    }

    function testPostCurveUnderDeliveryReverts() public {
        LoopExitParams memory params = _params(REPAY_AMOUNT + FLASH_FEE);
        curvePool.setOutput(REPAY_AMOUNT + FLASH_FEE - 1, false);

        (bool ok, bytes memory revertData) = _callExitAsOwner(params);

        _assertRevertSelector(ok, revertData, LoopExecutor.InvalidMinDiemOut.selector);
    }

    function testConstructorRejectsFactoryPoolMismatch() public {
        factory.setPool(address(new MockUniswapV3Pool(diem)));

        (bool ok, bytes memory revertData) = address(this).call(abi.encodeCall(this.deployExecutorForTest, ()));

        _assertRevertSelector(ok, revertData, LoopExecutor.InvalidFlashConfig.selector);
    }

    function testConstructorRejectsMissingProtocolConfig() public {
        (bool ok, bytes memory revertData) =
            address(this).call(abi.encodeCall(this.deployExecutorWithMissingProtocolForTest, ()));

        _assertRevertSelector(ok, revertData, LoopExecutor.InvalidProtocolConfig.selector);
    }

    function testConstructorRejectsNonContractFlashConfig() public {
        (bool ok, bytes memory revertData) =
            address(this).call(abi.encodeCall(this.deployExecutorWithNonContractFlashConfigForTest, ()));

        _assertRevertSelector(ok, revertData, LoopExecutor.InvalidFlashConfig.selector);
    }

    function testConstructorRejectsNonContractProtocolConfig() public {
        (bool ok, bytes memory revertData) =
            address(this).call(abi.encodeCall(this.deployExecutorWithNonContractProtocolConfigForTest, ()));

        _assertRevertSelector(ok, revertData, LoopExecutor.InvalidProtocolConfig.selector);
    }

    function testWrongCallbackSenderReverts() public {
        LoopExecutor.ExitFlashContext memory context = _context(1, REPAY_AMOUNT + FLASH_FEE);
        bytes memory data = abi.encode(context);

        (bool ok, bytes memory revertData) =
            address(executor).call(abi.encodeCall(executor.uniswapV3FlashCallback, (0, FLASH_FEE, data)));

        _assertRevertSelector(ok, revertData, LoopExecutor.InvalidCallbackSender.selector);
    }

    function testFactoryPoolMismatchRejectsBeforeFlash() public {
        LoopExitParams memory params = _params(REPAY_AMOUNT + FLASH_FEE);
        factory.setPool(address(new MockUniswapV3Pool(diem)));

        (bool ok, bytes memory revertData) = _callExitAsOwner(params);

        _assertRevertSelector(ok, revertData, LoopExecutor.InvalidContext.selector);
    }

    function testWrongLoanTokenContextRevertsBeforeFlash() public {
        LoopExitParams memory params = _params(REPAY_AMOUNT + FLASH_FEE);
        params.marketParams.loanToken = address(weth);

        (bool ok, bytes memory revertData) = _callExitAsOwner(params);

        _assertRevertSelector(ok, revertData, LoopExecutor.InvalidContext.selector);
    }

    function testStaleDeadlineReverts() public {
        LoopExitParams memory params = _params(REPAY_AMOUNT + FLASH_FEE);
        params.deadline = 0;

        (bool ok, bytes memory revertData) = _callExitAsOwner(params);

        _assertRevertSelector(ok, revertData, LoopExecutor.DeadlineExpired.selector);
    }

    function testInsufficientMinDiemOutRevertsBeforeFlash() public {
        LoopExitParams memory params = _params(REPAY_AMOUNT + FLASH_FEE - 1);

        (bool ok, bytes memory revertData) = _callExitAsOwner(params);

        _assertRevertSelector(ok, revertData, LoopExecutor.InvalidMinDiemOut.selector);
    }

    function testCallbackFeeMustMatchUniswapFeeTierFormula() public {
        LoopExitParams memory params = _params(REPAY_AMOUNT + FLASH_FEE);
        _overrideNextFlashFees(FLASH_FEE - 1, 0);

        (bool ok, bytes memory revertData) = _callExitAsOwner(params);

        _assertRevertSelector(ok, revertData, LoopExecutor.FeeMismatch.selector);
    }

    function testNonZeroOtherTokenFeeReverts() public {
        LoopExitParams memory params = _params(REPAY_AMOUNT + FLASH_FEE);
        _overrideNextFlashFees(FLASH_FEE, 1);

        (bool ok, bytes memory revertData) = _callExitAsOwner(params);

        _assertRevertSelector(ok, revertData, LoopExecutor.FeeMismatch.selector);
    }

    function testOldCallbackCannotReplayAfterExit() public {
        _exitAsOwner(_params(REPAY_AMOUNT + FLASH_FEE));
        LoopExecutor.ExitFlashContext memory context = _context(1, REPAY_AMOUNT + FLASH_FEE);
        bytes memory data = abi.encode(context);

        (bool ok, bytes memory revertData) = uniswapPool.callCallback(0, FLASH_FEE, data);

        _assertRevertSelector(ok, revertData, LoopExecutor.CallbackNotArmed.selector);
    }

    function testStaleNonceCallbackDataRevertsDuringArmedExit() public {
        _exitAsOwner(_params(REPAY_AMOUNT + FLASH_FEE));
        uniswapPool.overrideNextCallbackData(abi.encode(_context(1, REPAY_AMOUNT + FLASH_FEE)));

        (bool ok, bytes memory revertData) = _callExitAsOwner(_params(REPAY_AMOUNT + FLASH_FEE));

        _assertRevertSelector(ok, revertData, LoopExecutor.NonceAlreadyUsed.selector);
    }

    function testOnlyOwnerCanInitiateExit() public {
        LoopExitParams memory params = _params(REPAY_AMOUNT + FLASH_FEE);

        (bool ok, bytes memory revertData) = address(executor).call(abi.encodeCall(executor.exit, (params)));

        _assertRevertSelector(ok, revertData, LoopExecutor.UnauthorizedCaller.selector);
    }

    function testPreExistingExecutorBalancesBlockExit() public {
        LoopExitParams memory params = _params(REPAY_AMOUNT + FLASH_FEE);
        diem.mint(address(executor), 1);

        (bool ok, bytes memory revertData) = _callExitAsOwner(params);

        _assertRevertSelector(ok, revertData, LoopExecutor.InvalidContext.selector);
    }

    function testOptionalReturnTokensCanExit() public {
        MockERC20NoReturn noReturnDiem = new MockERC20NoReturn();
        MockERC20NoReturn noReturnWstDiem = new MockERC20NoReturn();
        MockMorphoNoReturn noReturnMorpho = new MockMorphoNoReturn(noReturnDiem, noReturnWstDiem);
        MockCurvePoolNoReturn noReturnCurvePool = new MockCurvePoolNoReturn(noReturnWstDiem, noReturnDiem);
        MockUniswapV3Factory noReturnFactory = new MockUniswapV3Factory();
        MockUniswapV3PoolNoReturn noReturnUniswapPool = new MockUniswapV3PoolNoReturn(noReturnDiem);
        noReturnFactory.setPool(address(noReturnUniswapPool));
        LoopExecutor noReturnExecutor = new LoopExecutor(
            LoopExecutor.FlashConfig({
                factory: address(noReturnFactory),
                pool: address(noReturnUniswapPool),
                loanToken: address(noReturnDiem),
                pairToken: address(weth),
                feeTier: FEE_TIER
            }),
            LoopExecutor.ProtocolConfig({
                morpho: address(noReturnMorpho),
                curvePool: address(noReturnCurvePool),
                wstDiem: address(noReturnWstDiem)
            })
        );
        noReturnUniswapPool.setExecutor(noReturnExecutor);
        noReturnMorpho.seedCollateral(WST_TO_SELL);
        noReturnMorpho.seedDebt(REPAY_AMOUNT, uint128(REPAY_AMOUNT));
        noReturnCurvePool.seedDiem(DIEM_OUT);
        noReturnUniswapPool.seedDiem(1_000 ether);

        vm.prank(OWNER);
        noReturnExecutor.exit(
            LoopExitParams({
                owner: OWNER,
                marketParams: MorphoMarketParams({
                    loanToken: address(noReturnDiem),
                    collateralToken: address(noReturnWstDiem),
                    oracle: ORACLE,
                    irm: IRM,
                    lltv: 860000000000000000
                }),
                repayAmountDiem: REPAY_AMOUNT,
                maxWstDiemToSell: WST_TO_SELL,
                minDiemOut: REPAY_AMOUNT + FLASH_FEE,
                force: false,
                deadline: block.timestamp + 1 days
            })
        );

        require(noReturnUniswapPool.repaid() == REPAY_AMOUNT + FLASH_FEE, "optional-return flash not repaid");
        require(noReturnDiem.balanceOf(OWNER) == DIEM_OUT - REPAY_AMOUNT - FLASH_FEE, "optional-return dust mismatch");
    }

    function _params(uint256 minDiemOut) private view returns (LoopExitParams memory) {
        return _paramsForRepayAmount(REPAY_AMOUNT, minDiemOut);
    }

    function _paramsForRepayAmount(uint256 repayAmount, uint256 minDiemOut)
        private
        view
        returns (LoopExitParams memory)
    {
        return LoopExitParams({
            owner: OWNER,
            marketParams: _marketParams(),
            repayAmountDiem: repayAmount,
            maxWstDiemToSell: WST_TO_SELL,
            minDiemOut: minDiemOut,
            force: false,
            deadline: block.timestamp + 1 days
        });
    }

    function _context(uint256 nonce, uint256 minDiemOut) private view returns (LoopExecutor.ExitFlashContext memory) {
        return LoopExecutor.ExitFlashContext({
            owner: OWNER,
            loanToken: address(diem),
            pairToken: address(weth),
            pool: address(uniswapPool),
            feeTier: FEE_TIER,
            repayAmountDiem: REPAY_AMOUNT,
            maxWstDiemToSell: WST_TO_SELL,
            minDiemOut: minDiemOut,
            force: false,
            deadline: block.timestamp + 1 days,
            nonce: nonce,
            marketParams: _marketParams()
        });
    }

    function _marketParams() private view returns (MorphoMarketParams memory) {
        return MorphoMarketParams({
            loanToken: address(diem),
            collateralToken: address(wstDiem),
            oracle: ORACLE,
            irm: IRM,
            lltv: 860000000000000000
        });
    }

    function _overrideNextFlashFees(uint256 loanTokenFee, uint256 otherTokenFee) private {
        if (executor.loanTokenIsToken0()) {
            uniswapPool.overrideNextFees(loanTokenFee, otherTokenFee);
        } else {
            uniswapPool.overrideNextFees(otherTokenFee, loanTokenFee);
        }
    }

    function _exitAsOwner(LoopExitParams memory params) private {
        vm.prank(OWNER);
        executor.exit(params);
    }

    function _callExitAsOwner(LoopExitParams memory params) private returns (bool, bytes memory) {
        vm.prank(OWNER);
        return address(executor).call(abi.encodeCall(executor.exit, (params)));
    }

    function _emittedDiemReceived(Vm.Log[] memory entries) private pure returns (uint256) {
        bytes32 eventHash =
            keccak256("LoopExitExecuted(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256)");
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].topics.length > 0 && entries[i].topics[0] == eventHash) {
                (,,, uint256 wstDiemSold, uint256 diemReceived,,) =
                    abi.decode(entries[i].data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256));
                require(wstDiemSold == WST_TO_SELL, "event wstDIEM sold mismatch");
                return diemReceived;
            }
        }
        revert("LoopExitExecuted not emitted");
    }

    function _assertRevertSelector(bool ok, bytes memory revertData, bytes4 selector) private pure {
        require(!ok, "call unexpectedly succeeded");
        require(revertData.length >= 4, "missing revert selector");
        bytes4 actual;
        assembly {
            actual := mload(add(revertData, 32))
        }
        require(actual == selector, "unexpected revert selector");
    }

    function deployExecutorForTest() external returns (LoopExecutor) {
        return _deployExecutor(
            LoopExecutor.FlashConfig({
                factory: address(factory),
                pool: address(uniswapPool),
                loanToken: address(diem),
                pairToken: address(weth),
                feeTier: FEE_TIER
            }),
            LoopExecutor.ProtocolConfig({
                morpho: address(morpho), curvePool: address(curvePool), wstDiem: address(wstDiem)
            })
        );
    }

    function deployExecutorWithMissingProtocolForTest() external returns (LoopExecutor) {
        return _deployExecutor(
            LoopExecutor.FlashConfig({
                factory: address(factory),
                pool: address(uniswapPool),
                loanToken: address(diem),
                pairToken: address(weth),
                feeTier: FEE_TIER
            }),
            LoopExecutor.ProtocolConfig({morpho: address(0), curvePool: address(curvePool), wstDiem: address(wstDiem)})
        );
    }

    function deployExecutorWithNonContractFlashConfigForTest() external returns (LoopExecutor) {
        return _deployExecutor(
            LoopExecutor.FlashConfig({
                factory: address(factory),
                pool: address(uniswapPool),
                loanToken: address(0x1234),
                pairToken: address(weth),
                feeTier: FEE_TIER
            }),
            LoopExecutor.ProtocolConfig({
                morpho: address(morpho), curvePool: address(curvePool), wstDiem: address(wstDiem)
            })
        );
    }

    function deployExecutorWithNonContractProtocolConfigForTest() external returns (LoopExecutor) {
        return _deployExecutor(
            LoopExecutor.FlashConfig({
                factory: address(factory),
                pool: address(uniswapPool),
                loanToken: address(diem),
                pairToken: address(weth),
                feeTier: FEE_TIER
            }),
            LoopExecutor.ProtocolConfig({
                morpho: address(0x5678), curvePool: address(curvePool), wstDiem: address(wstDiem)
            })
        );
    }

    function _deployExecutor(
        LoopExecutor.FlashConfig memory flashConfig,
        LoopExecutor.ProtocolConfig memory protocolConfig
    ) private returns (LoopExecutor) {
        return new LoopExecutor(flashConfig, protocolConfig);
    }
}

contract MockUniswapV3Factory {
    address private pool;

    function setPool(address pool_) external {
        pool = pool_;
    }

    function getPool(address, address, uint24) external view returns (address) {
        return pool;
    }
}

contract MockUniswapV3Pool {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MockERC20 private immutable diem;
    LoopExecutor private executor;
    uint256 public repaid;
    bool private hasFeeOverride;
    uint256 private overrideFee0;
    uint256 private overrideFee1;
    uint256 private callbackWarpTimestamp;
    bytes private callbackDataOverride;

    constructor(MockERC20 diem_) {
        diem = diem_;
    }

    function setExecutor(LoopExecutor executor_) external {
        executor = executor_;
    }

    function seedDiem(uint256 amount) external {
        diem.mint(address(this), amount);
    }

    function overrideNextFees(uint256 fee0, uint256 fee1) external {
        hasFeeOverride = true;
        overrideFee0 = fee0;
        overrideFee1 = fee1;
    }

    function warpBeforeCallback(uint256 timestamp) external {
        callbackWarpTimestamp = timestamp;
    }

    function overrideNextCallbackData(bytes calldata data) external {
        callbackDataOverride = data;
    }

    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external {
        uint256 amount = amount0 + amount1;
        uint256 fee0 = amount0 == 0 ? 0 : (amount0 * 10_000 + 999_999) / 1_000_000;
        uint256 fee1 = amount1 == 0 ? 0 : (amount1 * 10_000 + 999_999) / 1_000_000;
        if (hasFeeOverride) {
            fee0 = overrideFee0;
            fee1 = overrideFee1;
            hasFeeOverride = false;
        }
        uint256 balanceBefore = diem.balanceOf(address(this));

        diem.transfer(recipient, amount);
        if (callbackWarpTimestamp != 0) {
            vm.warp(callbackWarpTimestamp);
            callbackWarpTimestamp = 0;
        }
        bytes memory callbackData = data;
        if (callbackDataOverride.length != 0) {
            callbackData = callbackDataOverride;
        }
        delete callbackDataOverride;
        executor.uniswapV3FlashCallback(fee0, fee1, callbackData);

        repaid = diem.balanceOf(address(this)) - balanceBefore + amount;
    }

    function callCallback(uint256 fee0, uint256 fee1, bytes memory data) external returns (bool, bytes memory) {
        return address(executor).call(abi.encodeCall(executor.uniswapV3FlashCallback, (fee0, fee1, data)));
    }
}

contract MockMorpho {
    MockERC20 private immutable diem;
    MockERC20 private immutable wstDiem;
    uint256 public repaidAssets;
    uint256 public repaidShares;
    uint128 public borrowShares;
    uint256 private borrowAssets;
    bool private authorized = true;
    LoopExecutor private reenterExecutor;

    constructor(MockERC20 diem_, MockERC20 wstDiem_) {
        diem = diem_;
        wstDiem = wstDiem_;
    }

    function seedCollateral(uint256 amount) external {
        wstDiem.mint(address(this), amount);
    }

    function seedDebt(uint256 assets, uint128 shares) external {
        borrowAssets = assets;
        borrowShares = shares;
    }

    function accrueInterest(uint256 assetsAfterAccrual) external {
        borrowAssets = assetsAfterAccrual;
    }

    function setAuthorized(bool authorized_) external {
        authorized = authorized_;
    }

    function setReenterCallback(LoopExecutor executor_) external {
        reenterExecutor = executor_;
    }

    function isAuthorized(address, address) external view returns (bool) {
        return authorized;
    }

    function position(bytes32, address)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares_, uint128 collateral)
    {
        return (0, borrowShares, uint128(wstDiem.balanceOf(address(this))));
    }

    function repay(MorphoMarketParams calldata, uint256 assets, uint256 shares, address, bytes calldata)
        external
        returns (uint256 assetsRepaid, uint256 sharesRepaid)
    {
        require(assets == 0, "asset repay disabled in mock");
        require(shares == borrowShares, "shares mismatch");
        if (address(reenterExecutor) != address(0)) {
            (bool ok, bytes memory revertData) =
                address(reenterExecutor).call(abi.encodeCall(reenterExecutor.uniswapV3FlashCallback, (0, 0, bytes(""))));
            if (!ok) {
                assembly {
                    revert(add(revertData, 32), mload(revertData))
                }
            }
        }
        diem.transferFrom(msg.sender, address(this), borrowAssets);
        repaidAssets += borrowAssets;
        repaidShares += shares;
        uint256 assetsRepaid_ = borrowAssets;
        borrowAssets = 0;
        borrowShares = 0;
        return (assetsRepaid_, shares);
    }

    function withdrawCollateral(MorphoMarketParams calldata, uint256 assets, address, address receiver) external {
        wstDiem.transfer(receiver, assets);
    }
}

contract MockCurvePool {
    MockERC20 private immutable wstDiem;
    MockERC20 private immutable diem;
    uint256 public wstDiemSold;
    uint256 private outputDiem = 52 ether;
    bool private enforceMinDy = true;

    constructor(MockERC20 wstDiem_, MockERC20 diem_) {
        wstDiem = wstDiem_;
        diem = diem_;
    }

    function seedDiem(uint256 amount) external {
        diem.mint(address(this), amount);
    }

    function setOutput(uint256 outputDiem_, bool enforceMinDy_) external {
        outputDiem = outputDiem_;
        enforceMinDy = enforceMinDy_;
    }

    function exchange(int128, int128, uint256 dx, uint256 minDy) external returns (uint256) {
        if (enforceMinDy) {
            require(minDy <= outputDiem, "minDy too high");
        }
        wstDiem.transferFrom(msg.sender, address(this), dx);
        wstDiemSold += dx;
        diem.transfer(msg.sender, outputDiem);
        return outputDiem;
    }
}

contract MockERC20 {
    mapping(address account => uint256 balance) public balanceOf;
    mapping(address account => mapping(address spender => uint256 amount)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance too low");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance too low");
        require(allowance[from][msg.sender] >= amount, "allowance too low");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockUniswapV3PoolNoReturn {
    MockERC20NoReturn private immutable diem;
    LoopExecutor private executor;
    uint256 public repaid;

    constructor(MockERC20NoReturn diem_) {
        diem = diem_;
    }

    function setExecutor(LoopExecutor executor_) external {
        executor = executor_;
    }

    function seedDiem(uint256 amount) external {
        diem.mint(address(this), amount);
    }

    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external {
        uint256 amount = amount0 + amount1;
        uint256 fee0 = amount0 == 0 ? 0 : (amount0 * 10_000 + 999_999) / 1_000_000;
        uint256 fee1 = amount1 == 0 ? 0 : (amount1 * 10_000 + 999_999) / 1_000_000;
        uint256 balanceBefore = diem.balanceOf(address(this));

        diem.transfer(recipient, amount);
        executor.uniswapV3FlashCallback(fee0, fee1, data);

        repaid = diem.balanceOf(address(this)) - balanceBefore + amount;
    }
}

contract MockMorphoNoReturn {
    MockERC20NoReturn private immutable diem;
    MockERC20NoReturn private immutable wstDiem;
    uint128 private borrowShares;
    uint256 private borrowAssets;

    constructor(MockERC20NoReturn diem_, MockERC20NoReturn wstDiem_) {
        diem = diem_;
        wstDiem = wstDiem_;
    }

    function seedCollateral(uint256 amount) external {
        wstDiem.mint(address(this), amount);
    }

    function seedDebt(uint256 assets, uint128 shares) external {
        borrowAssets = assets;
        borrowShares = shares;
    }

    function isAuthorized(address, address) external pure returns (bool) {
        return true;
    }

    function position(bytes32, address)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares_, uint128 collateral)
    {
        return (0, borrowShares, uint128(wstDiem.balanceOf(address(this))));
    }

    function repay(MorphoMarketParams calldata, uint256 assets, uint256 shares, address, bytes calldata)
        external
        returns (uint256 assetsRepaid, uint256 sharesRepaid)
    {
        require(assets == 0, "asset repay disabled in mock");
        require(shares == borrowShares, "shares mismatch");
        diem.transferFrom(msg.sender, address(this), borrowAssets);
        uint256 assetsRepaid_ = borrowAssets;
        borrowAssets = 0;
        borrowShares = 0;
        return (assetsRepaid_, shares);
    }

    function withdrawCollateral(MorphoMarketParams calldata, uint256 assets, address, address receiver) external {
        wstDiem.transfer(receiver, assets);
    }
}

contract MockCurvePoolNoReturn {
    MockERC20NoReturn private immutable wstDiem;
    MockERC20NoReturn private immutable diem;

    constructor(MockERC20NoReturn wstDiem_, MockERC20NoReturn diem_) {
        wstDiem = wstDiem_;
        diem = diem_;
    }

    function seedDiem(uint256 amount) external {
        diem.mint(address(this), amount);
    }

    function exchange(int128, int128, uint256 dx, uint256 minDy) external returns (uint256) {
        require(minDy <= 52 ether, "minDy too high");
        wstDiem.transferFrom(msg.sender, address(this), dx);
        diem.transfer(msg.sender, 52 ether);
        return 52 ether;
    }
}

contract MockERC20NoReturn {
    mapping(address account => uint256 balance) public balanceOf;
    mapping(address account => mapping(address spender => uint256 amount)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance too low");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "balance too low");
        require(allowance[from][msg.sender] >= amount, "allowance too low");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
