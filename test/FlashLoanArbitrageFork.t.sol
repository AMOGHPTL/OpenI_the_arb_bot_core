// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";

import "../src/FlashLoanArbitrage.sol";

import "./mocks/MockUniswapRouter.sol";
import "./mocks/MockSushiRouter.sol";

contract FlashLoanArbitrageForkTest is Test {
    address internal constant BASE_MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant BASE_WETH = 0x4200000000000000000000000000000000000006;

    FlashLoanArbitrage internal arbitrage;
    MockUniswapRouter internal uni;
    MockSushiRouter internal sushi;

    function setUp() public {
        string memory rpcUrl = vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org"));
        vm.createSelectFork(rpcUrl);

        uni = new MockUniswapRouter();
        sushi = new MockSushiRouter();
        arbitrage = new FlashLoanArbitrage(BASE_MORPHO, address(uni), address(sushi));

        deal(BASE_USDC, BASE_MORPHO, 1_000_000e6);
        deal(BASE_USDC, address(uni), 1_000_000e6);
        deal(BASE_WETH, address(uni), 1_000_000 ether);
        deal(BASE_USDC, address(sushi), 1_000_000e6);
        deal(BASE_WETH, address(sushi), 1_000_000 ether);
    }

    function testForkRealMorphoCallbackAndRepayment() public {
        uint256 loanAmount = 1_000e6;
        uint256 morphoBalanceBefore = IERC20(BASE_USDC).balanceOf(BASE_MORPHO);

        uni.setMultiplier(110);
        sushi.setMultiplier(110);

        arbitrage.initiateFlashLoan(
            BASE_USDC,
            loanAmount,
            BASE_WETH,
            3000,
            1,
            0,
            1,
            1,
            block.timestamp + 1 hours
        );

        assertEq(IERC20(BASE_USDC).balanceOf(BASE_MORPHO), morphoBalanceBefore);
        assertGt(IERC20(BASE_USDC).balanceOf(address(arbitrage)), 0);
    }
}
