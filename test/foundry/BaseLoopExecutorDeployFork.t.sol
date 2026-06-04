// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LoopExecutor} from "../../contracts/LoopExecutor.sol";

interface VmLoopExecutorDeploy {
    function envOr(string calldata name, string calldata defaultValue) external view returns (string memory);
    function createSelectFork(string calldata url) external returns (uint256);
}

interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
}

contract BaseLoopExecutorDeployForkTest {
    VmLoopExecutorDeploy private constant vm =
        VmLoopExecutorDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant DIEM = 0xF4d97F2da56e8c3098f3a8D538DB630A2606a024;
    address private constant WETH = 0x4200000000000000000000000000000000000006;
    address private constant WSTDIEM = 0x4751BA2b09374C1929FC01734a166e3c8cd75810;
    address private constant MORPHO_BLUE = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address private constant CURVE_POOL = 0x39A4b4779C71E1A18d500627639682c9583Ee86f;
    address private constant UNISWAP_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address private constant UNISWAP_V3_DIEM_WETH_POOL = 0x80d995189ecc593672aD4703b250a5e82672EB1D;
    uint256 private constant BASE_CHAIN_ID = 8453;
    uint24 private constant UNISWAP_V3_FEE_TIER = 10_000;

    function testLatestBlockDeploysExecutorWithVerifiedBaseConfig() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc);
        _assertBaseChain();

        LoopExecutor executor = _deployBaseExecutor();

        require(address(executor).code.length > 0, "executor deploy failed");
        require(executor.canonicalFlashPool() == UNISWAP_V3_DIEM_WETH_POOL, "canonical flash pool mismatch");
        require(executor.expectedFlashFee(50 ether) == 0.5 ether, "flash fee mismatch");
        require(executor.loanTokenIsToken0() == (DIEM < WETH), "loan-token side mismatch");
        require(IERC20Balance(DIEM).balanceOf(address(executor)) == 0, "executor retained DIEM after deploy");
        require(IERC20Balance(WSTDIEM).balanceOf(address(executor)) == 0, "executor retained wstDIEM after deploy");

        (address factory, address pool, address loanToken, address pairToken, uint24 feeTier) = executor.flashConfig();
        require(factory == UNISWAP_V3_FACTORY, "factory mismatch");
        require(pool == UNISWAP_V3_DIEM_WETH_POOL, "pool mismatch");
        require(loanToken == DIEM, "loan token mismatch");
        require(pairToken == WETH, "pair token mismatch");
        require(feeTier == UNISWAP_V3_FEE_TIER, "fee tier mismatch");

        (address morpho, address curvePool, address wstDiem) = executor.protocolConfig();
        require(morpho == MORPHO_BLUE, "morpho mismatch");
        require(curvePool == CURVE_POOL, "curve pool mismatch");
        require(wstDiem == WSTDIEM, "wstDIEM mismatch");
    }

    function testLatestBlockRejectsMismatchedFlashPoolAtDeploy() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc);
        _assertBaseChain();

        try new LoopExecutor(
            LoopExecutor.FlashConfig({
                factory: UNISWAP_V3_FACTORY,
                pool: CURVE_POOL,
                loanToken: DIEM,
                pairToken: WETH,
                feeTier: UNISWAP_V3_FEE_TIER
            }),
            LoopExecutor.ProtocolConfig({morpho: MORPHO_BLUE, curvePool: CURVE_POOL, wstDiem: WSTDIEM})
        ) {
            revert("mismatched pool deploy succeeded");
        } catch (bytes memory reason) {
            _assertRevertSelector(reason, LoopExecutor.InvalidFlashConfig.selector);
        }
    }

    function _deployBaseExecutor() private returns (LoopExecutor) {
        return new LoopExecutor(
            LoopExecutor.FlashConfig({
                factory: UNISWAP_V3_FACTORY,
                pool: UNISWAP_V3_DIEM_WETH_POOL,
                loanToken: DIEM,
                pairToken: WETH,
                feeTier: UNISWAP_V3_FEE_TIER
            }),
            LoopExecutor.ProtocolConfig({morpho: MORPHO_BLUE, curvePool: CURVE_POOL, wstDiem: WSTDIEM})
        );
    }

    function _assertBaseChain() private view {
        require(block.chainid == BASE_CHAIN_ID, "unexpected chain id");
    }

    function _assertRevertSelector(bytes memory revertData, bytes4 selector) private pure {
        require(revertData.length >= 4, "missing revert selector");
        bytes4 actual;
        assembly {
            actual := mload(add(revertData, 32))
        }
        require(actual == selector, "unexpected revert selector");
    }
}
