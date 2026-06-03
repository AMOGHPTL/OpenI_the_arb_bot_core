// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {FlashLoanArbitrage} from "../src/FlashLoanArbitrage.sol";
import {IMorpho} from "../src/interfaces/IMorpho.sol";

// Mainnet addresses
address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
address constant MORPHO_BLUE = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
address constant WHALE_USDC = 0x47C10B3A4d61D85233c7b8Da0c4EB9e049e247B5;

contract FlashLoanSwapTest is Test {
    FlashLoanArbitrage public flashArbitrage;
    IERC20 public usdc = IERC20(USDC);
    IERC20 public weth = IERC20(WETH);

    uint256 constant BORROW_AMOUNT = 10000 * 1e6; // 10,000 USDC (6 decimals)
    uint256 constant MIN_PROFIT = 1 * 1e6; // At least 1 USDC profit

    function setUp() public {
        // Fork Ethereum mainnet
        string memory MAINNET_RPC_URL = vm.envString("MAINNET_RPC_URL");
        vm.createSelectFork(MAINNET_RPC_URL);

        // Deploy flash loan contract
        flashArbitrage = new FlashLoanArbitrage(IMorpho(MORPHO_BLUE));

        // Fund the flash contract with ETH for gas
        vm.deal(address(flashArbitrage), 1 ether);
    }

    function test_FlashLoanSwapSuccess() public {
        // Get starting USDC balance of the flash contract
        uint256 startingUsdcBalance = usdc.balanceOf(address(flashArbitrage));

        // Execute the flash loan
        flashArbitrage.flashLoan(
            USDC,
            BORROW_AMOUNT,
            WETH,
            3000,
            MIN_PROFIT
        );

        // Check that the flash contract made a profit
        uint256 endingUsdcBalance = usdc.balanceOf(address(flashArbitrage));
        assertGe(endingUsdcBalance, startingUsdcBalance + MIN_PROFIT);

        // Log the profit - FIXED: separate log statements
        uint256 profit = endingUsdcBalance - startingUsdcBalance;
        console.log("Profit earned:");
        console.log(profit / 1e6);
        console.log("USDC");
    }

    function test_FlashLoanWithDifferentPool() public {
        uint24 fee_500 = 500;

        flashArbitrage.flashLoan(
            USDC, 
            BORROW_AMOUNT, 
            WETH, 
            fee_500, 
            MIN_PROFIT
        );

        uint256 endingBalance = usdc.balanceOf(address(flashArbitrage));
        uint256 profit = endingBalance;
        console.log("Profit with 0.05% pool:");
        console.log(profit / 1e6);
        console.log("USDC");
        assertGe(profit, MIN_PROFIT);
    }

    function test_FlashLoanRevertsIfNoProfit() public {
        uint256 impossibleProfit = 1000000 * 1e6;

        vm.expectRevert("Profit below minimum");
        flashArbitrage.flashLoan(
            USDC, 
            BORROW_AMOUNT, 
            WETH, 
            3000, 
            impossibleProfit
        );
    }

    function test_FlashLoanArbitrage() public {
        uint256 borrowAmount = 1000 * 1e6;
        
        uint256 startingBalance = usdc.balanceOf(address(flashArbitrage));
        
        flashArbitrage.flashLoan(
            USDC,
            borrowAmount,
            WETH,
            3000,
            0
        );
        
        uint256 endingBalance = usdc.balanceOf(address(flashArbitrage));
        uint256 profit = endingBalance - startingBalance;
        
        // FIXED: separate log statements
        console.log("Arbitrage result with");
        console.log(borrowAmount / 1e6);
        console.log("USDC");
        console.log("Profit:");
        console.log(profit / 1e6);
        console.log("USDC");
    }

    function test_FundContractWithUSDC() public {
        vm.startPrank(WHALE_USDC);
        usdc.transfer(address(flashArbitrage), 10000 * 1e6);
        vm.stopPrank();
        
        uint256 balance = usdc.balanceOf(address(flashArbitrage));
        console.log("USDC balance after funding:");
        console.log(balance / 1e6);
        assertEq(balance, 10000 * 1e6);
    }
}