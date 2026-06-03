// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

import "forge-std/Script.sol";
import "../src/FlashLoanArbitrage.sol";

contract DeployFlashLoanArbLocal is Script {
    // Mock Morpho address for local testing (you can deploy a mock)
    address constant MOCK_MORPHO = 0x5FbDB2315678afecb367f032d93F642f64180aa3;

    function run() external {
        vm.startBroadcast();

        FlashLoanArbitrage arbitrage = new FlashLoanArbitrage(MOCK_MORPHO);

        console.log("FlashLoanArbitrage deployed locally to:", address(arbitrage));

        vm.stopBroadcast();
    }
}
