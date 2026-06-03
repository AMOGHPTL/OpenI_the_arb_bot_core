// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import "../src/FlashLoanArbitrage.sol";

contract FlashLoanArbTest is Test {
    FlashLoanArbitrage public arbitrage;
    address public constant MORPHO = 0xbbbBBBBBbB9cC5e90E3B3Af64bdaf62C37Eefffa;
    address public constant USER = address(0x123);

    // Token addresses (Base chain)
    address public constant WETH = 0x4200000000000000000000000000000000000006;
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function setUp() public {
        vm.createSelectFork("base");
        arbitrage = new FlashLoanArbitrage(MORPHO);
    }

    function test_Deployment() public view {
        assertTrue(address(arbitrage) != address(0));
    }

    function test_FlashLoanInitiation() public {
        // This would require mainnet fork testing
        // Test your flash loan logic here
    }

    function test_WithdrawProfit() public {
        // Test profit withdrawal
        vm.prank(arbitrage.owner());
        // arbitrage.withdrawProfit(WETH);
    }
}
