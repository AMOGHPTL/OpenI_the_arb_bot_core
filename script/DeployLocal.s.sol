// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

import "forge-std/Script.sol";
import {FlashLoanArbitrage} from "../src/FlashLoanArbitrage.sol";

contract DeployFlashLoanArbLocal is Script {
    // -------------------------------------------------------------------------
    // Mock addresses for local Anvil testing.
    // These match Anvil's default deterministic deployment addresses when you
    // deploy three mock contracts in order from the default account.
    //
    // To deploy mocks before running this script:
    //   forge script script/DeployMocks.s.sol --broadcast --rpc-url localhost
    //
    // Or override via env vars:
    //   MOCK_MORPHO / MOCK_UNISWAP / MOCK_SUSHI
    // -------------------------------------------------------------------------
    address constant DEFAULT_MOCK_MORPHO   = 0x5FbDB2315678afecb367f032d93F642f64180aa3;
    address constant DEFAULT_MOCK_UNISWAP  = 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512;
    address constant DEFAULT_MOCK_SUSHI    = 0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0;

    function run() external {
        address mockMorpho  = vm.envOr("MOCK_MORPHO",  DEFAULT_MOCK_MORPHO);
        address mockUniswap = vm.envOr("MOCK_UNISWAP", DEFAULT_MOCK_UNISWAP);
        address mockSushi   = vm.envOr("MOCK_SUSHI",   DEFAULT_MOCK_SUSHI);

        vm.startBroadcast();

        FlashLoanArbitrage arbitrage = new FlashLoanArbitrage(
            mockMorpho,
            mockUniswap,
            mockSushi
        );

        console.log("FlashLoanArbitrage deployed locally to:", address(arbitrage));
        console.log("  Mock Morpho:   ", mockMorpho);
        console.log("  Mock Uniswap:  ", mockUniswap);
        console.log("  Mock Sushi:    ", mockSushi);

        vm.stopBroadcast();
    }
}
