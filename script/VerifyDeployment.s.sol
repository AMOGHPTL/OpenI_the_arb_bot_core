// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

import "forge-std/Script.sol";

contract VerifyDeployment is Script {
    function run() external view {
        string memory root = vm.projectRoot();
        string memory deploymentsDir = string.concat(root, "/deployments");
        
        string[] memory networks = new string[](3);
        networks[0] = "base";
        networks[1] = "ethereum";
        networks[2] = "arbitrum";
        
        console.log(" Deployment Status:");
        console.log("...");
        
        for (uint i = 0; i < networks.length; i++) {
            string memory deploymentFile = string.concat(deploymentsDir, "/", networks[i], ".json");
            
            if (vm.exists(deploymentFile)) {
                string memory content = vm.readFile(deploymentFile);
                console.log("ok", networks[i], "deployed");
            } else {
                console.log("no", networks[i], "not deployed yet");
            }
        }
        
        console.log("...");
    }
}