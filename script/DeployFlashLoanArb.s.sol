// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

import "forge-std/Script.sol";
import "../src/FlashLoanArbitrage.sol";

contract DeployFlashLoanArb is Script {
    // Morpho Blue addresses by chain
    address constant MORPHO_BASE = 0xbbbBBBBBbB9cC5e90E3B3Af64bdaf62C37Eefffa;
    address constant MORPHO_ETH = 0xbbbBBBBBbB9cC5e90E3B3Af64bdaf62C37Eefffa;
    address constant MORPHO_ARBITRUM = 0xbbbBBBBBbB9cC5e90E3B3Af64bdaf62C37Eefffa;

    function run() external {
        // Get network from environment or default to base
        string memory network = vm.envOr("NETWORK", string("base"));

        address morpho;
        if (keccak256(bytes(network)) == keccak256(bytes("base"))) {
            morpho = MORPHO_BASE;
        } else if (keccak256(bytes(network)) == keccak256(bytes("ethereum"))) {
            morpho = MORPHO_ETH;
        } else {
            revert("Unsupported network");
        }

        // Use the encrypted keystore - this will prompt for password
        string memory walletName = "mywallet";
        uint256 deployerPrivateKey = vm.parseWallet(walletName);

        vm.startBroadcast(deployerPrivateKey);

        FlashLoanArbitrage arbitrage = new FlashLoanArbitrage(morpho);

        console.log(" FlashLoanArbitrage deployed to:", address(arbitrage));
        console.log("   Network:", network);
        console.log("   Morpho:", morpho);
        console.log("   Deployer:", vm.addr(deployerPrivateKey));

        vm.stopBroadcast();
    }

    function saveDeploymentInfo(string memory network, address contractAddr, address morpho) internal {
        string memory root = vm.projectRoot();
        string memory deploymentsDir = string.concat(root, "/deployments");

        // Create deployments directory if it doesn't exist
        if (!vm.isDir(deploymentsDir)) {
            vm.createDir(deploymentsDir);
        }

        string memory deploymentFile = string.concat(deploymentsDir, "/", network, ".json");

        // Create deployment JSON
        string memory json = string.concat(
            "{\n",
            '  "network": "',
            network,
            '",\n',
            '  "contractAddress": "',
            vm.toString(contractAddr),
            '",\n',
            '  "morphoAddress": "',
            vm.toString(morpho),
            '",\n',
            '  "deployer": "',
            vm.toString(vm.addr(vm.envUint("PRIVATE_KEY"))),
            '",\n',
            '  "timestamp": "',
            vm.toString(block.timestamp),
            '",\n',
            '  "chainId": "',
            vm.toString(block.chainid),
            '"\n',
            "}"
        );

        vm.writeFile(deploymentFile, json);
        console.log("Deployment info saved to:", deploymentFile);
    }
}
