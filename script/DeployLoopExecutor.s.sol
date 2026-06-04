// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LoopExecutor} from "../contracts/LoopExecutor.sol";

interface VmDeployLoopExecutor {
    function envAddress(string calldata name) external view returns (address);
    function envUint(string calldata name) external view returns (uint256);
}

/// @notice Dry-runable deployment entrypoint for the exit-only LoopExecutor.
/// @dev Run with `forge script ... --fork-url "$BASE_RPC_URL"` first. Do not add
/// `--broadcast` until the production audit gate has been explicitly cleared.
contract DeployLoopExecutor {
    VmDeployLoopExecutor private constant vm =
        VmDeployLoopExecutor(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (LoopExecutor executor) {
        uint256 feeTier = vm.envUint("LOOP_EXECUTOR_UNISWAP_V3_FEE_TIER");
        if (feeTier > type(uint24).max) revert("fee tier exceeds uint24");

        // Safe after the explicit max check above; LoopExecutor stores feeTier as uint24.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint24 checkedFeeTier = uint24(feeTier);

        executor = new LoopExecutor(
            LoopExecutor.FlashConfig({
                factory: vm.envAddress("LOOP_EXECUTOR_UNISWAP_V3_FACTORY"),
                pool: vm.envAddress("LOOP_EXECUTOR_UNISWAP_V3_POOL"),
                loanToken: vm.envAddress("LOOP_EXECUTOR_LOAN_TOKEN"),
                pairToken: vm.envAddress("LOOP_EXECUTOR_PAIR_TOKEN"),
                feeTier: checkedFeeTier
            }),
            LoopExecutor.ProtocolConfig({
                morpho: vm.envAddress("LOOP_EXECUTOR_MORPHO"),
                curvePool: vm.envAddress("LOOP_EXECUTOR_CURVE_POOL"),
                wstDiem: vm.envAddress("LOOP_EXECUTOR_WSTDIEM")
            })
        );
    }
}
