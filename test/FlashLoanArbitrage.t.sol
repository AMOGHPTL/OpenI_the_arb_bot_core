// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";

import "../src/FlashLoanArbitrage.sol";

import "./mocks/MockERC20.sol";
import "./mocks/MockMorpho.sol";
import "./mocks/MockUniswapRouter.sol";
import "./mocks/MockSushiRouter.sol";

contract FlashLoanArbitrageTest is Test {
    FlashLoanArbitrage arbitrage;

    MockERC20 usdc;
    MockERC20 weth;

    MockMorpho morpho;
    MockUniswapRouter uni;
    MockSushiRouter sushi;

    address owner;
    address user = address(0x123);

    function setUp() public {
        owner = address(this);

        usdc = new MockERC20("USD Coin", "USDC", 6);

        weth = new MockERC20("Wrapped Ether", "WETH", 18);

        morpho = new MockMorpho();
        uni = new MockUniswapRouter();
        sushi = new MockSushiRouter();

        arbitrage = new FlashLoanArbitrage(address(morpho), address(uni), address(sushi));

        usdc.mint(address(morpho), 1_000_000e6);

        usdc.mint(address(sushi), 1_000_000e6);
        weth.mint(address(sushi), 1_000_000 ether);

        usdc.mint(address(uni), 1_000_000e6);
        weth.mint(address(uni), 1_000_000 ether);
    }

    function testDeployment() public view {
        assertEq(address(arbitrage.MORPHO()), address(morpho));

        assertEq(address(arbitrage.UNISWAP_ROUTER()), address(uni));

        assertEq(address(arbitrage.SUSHI_ROUTER()), address(sushi));
    }

    function testOwner() public view {
        assertEq(arbitrage.owner(), owner);
    }

    function testGetBalance() public view {
        assertEq(arbitrage.getBalance(address(usdc)), 0);
    }

    function testWithdrawProfit() public {
        usdc.mint(address(arbitrage), 1000e6);

        arbitrage.withdrawProfit(address(usdc));

        assertEq(usdc.balanceOf(owner), 1000e6);
    }

    function testRescueTokens() public {
        usdc.mint(address(arbitrage), 500e6);

        arbitrage.rescueTokens(address(usdc), 200e6);

        assertEq(usdc.balanceOf(owner), 200e6);
    }

    function testInitiateFlashLoanRevertsZeroAmount() public {
        vm.expectRevert(FlashLoanArbitrage.ZeroAmount.selector);

        arbitrage.initiateFlashLoan(address(usdc), 0, address(weth), 3000, 0, 0, 1, 1, block.timestamp + 1 hours);
    }

    function testInitiateFlashLoanRevertsSameToken() public {
        vm.expectRevert(FlashLoanArbitrage.SameToken.selector);

        arbitrage.initiateFlashLoan(address(usdc), 100e6, address(usdc), 3000, 0, 0, 1, 1, block.timestamp + 1 hours);
    }

    function testOnlyOwnerWithdraw() public {
        vm.prank(user);

        vm.expectRevert();

        arbitrage.withdrawProfit(address(usdc));
    }

    function testOnlyMorphoCanCallback() public {
        bytes memory data;

        vm.prank(user);

        vm.expectRevert(FlashLoanArbitrage.OnlyMorpho.selector);

        arbitrage.onMorphoFlashLoan(1e6, data);
    }

    function testSuccessfulArbitrage() public {
        uni.setMultiplier(110);
        sushi.setMultiplier(110);

        arbitrage.initiateFlashLoan(address(usdc), 1000e6, address(weth), 3000, 1, 0, 1, 1, block.timestamp + 1 hours);

        assertGt(usdc.balanceOf(address(arbitrage)), 0);
    }

    function testSlippageProtectionRevertsOnFirstSwap() public {
        uni.setMultiplier(90);

        vm.expectRevert(bytes("Too little received"));

        arbitrage.initiateFlashLoan(
            address(usdc), 1000e6, address(weth), 3000, 1, 0, 1001e6, 1, block.timestamp + 1 hours
        );
    }

    function testProtectedFlashLoanRevertsHighGasPrice() public {
        vm.txGasPrice(101 gwei);

        vm.expectRevert(FlashLoanArbitrage.GasPriceTooHigh.selector);

        arbitrage.initiateProtectedFlashLoan(
            address(usdc), 1000e6, address(weth), 3000, 1, 0, 1, 1, block.timestamp + 1 hours, 0, 100 gwei, 0
        );
    }

    function testProtectedFlashLoanRevertsExpiredBlockWindow() public {
        vm.roll(10);

        vm.expectRevert(FlashLoanArbitrage.BlockWindowExpired.selector);

        arbitrage.initiateProtectedFlashLoan(
            address(usdc), 1000e6, address(weth), 3000, 1, 0, 1, 1, block.timestamp + 1 hours, 0, 0, 9
        );
    }

    function testExistingBalanceDoesNotMaskBadTrade() public {
        usdc.mint(address(arbitrage), 1000e6);
        uni.setMultiplier(100);
        sushi.setMultiplier(100);

        vm.expectRevert(FlashLoanArbitrage.ProfitTooLow.selector);

        arbitrage.initiateFlashLoan(address(usdc), 1000e6, address(weth), 3000, 1, 0, 1, 1, block.timestamp + 1 hours);
    }
}
