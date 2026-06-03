// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface Vm {
    function envOr(string calldata name, string calldata defaultValue) external view returns (string memory);
    function createSelectFork(string calldata url, uint256 blockNumber) external returns (uint256);
    function createSelectFork(string calldata url) external returns (uint256);
}

interface IERC20Metadata {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IUniswapV3PoolInfo {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

contract BaseFlashProviderForkTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address private constant POOL = 0x80d995189ecc593672aD4703b250a5e82672EB1D;
    address private constant DIEM = 0xF4d97F2da56e8c3098f3a8D538DB630A2606a024;
    address private constant WETH = 0x4200000000000000000000000000000000000006;
    uint24 private constant FEE_TIER = 10_000;
    uint256 private constant PINNED_BLOCK = 46_839_394;

    function testPinnedBlockUniswapV3DiemWethProviderEvidence() public {
        string memory rpc = _baseRpcUrl();
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc, PINNED_BLOCK);

        _assertPoolIdentity();
        require(IERC20Metadata(DIEM).decimals() == 18, "DIEM decimals changed");
        require(IERC20Metadata(DIEM).balanceOf(POOL) >= 69 ether, "pinned pool DIEM below expected evidence");
    }

    function testLatestBlockUniswapV3DiemWethProviderStillHasInventory() public {
        string memory rpc = _baseRpcUrl();
        if (bytes(rpc).length == 0) return;

        vm.createSelectFork(rpc);

        _assertPoolIdentity();
        require(IERC20Metadata(DIEM).balanceOf(POOL) > 0, "latest pool DIEM inventory is zero");
    }

    function _assertPoolIdentity() private view {
        require(IUniswapV3Factory(FACTORY).getPool(DIEM, WETH, FEE_TIER) == POOL, "factory pool mismatch");
        require(IUniswapV3PoolInfo(POOL).fee() == FEE_TIER, "pool fee mismatch");
        address token0 = IUniswapV3PoolInfo(POOL).token0();
        address token1 = IUniswapV3PoolInfo(POOL).token1();
        require((token0 == DIEM && token1 == WETH) || (token0 == WETH && token1 == DIEM), "pool token pair mismatch");
    }

    function _baseRpcUrl() private view returns (string memory) {
        return vm.envOr("BASE_RPC_URL", string(""));
    }
}
