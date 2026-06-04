// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

import "forge-std/Script.sol";
import {FlashLoanArbitrage} from "../src/FlashLoanArbitrage.sol";

contract DeployFlashLoanArb is Script {

    // -------------------------------------------------------------------------
    // Morpho Blue — same address on all supported chains
    // -------------------------------------------------------------------------
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

    // -------------------------------------------------------------------------
    // Uniswap V3 SwapRouter
    // -------------------------------------------------------------------------
    address constant UNISWAP_BASE     = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant UNISWAP_ETH      = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address constant UNISWAP_ARBITRUM = 0xE592427A0AEce92De3Edee1F18E0157C05861564;

    // -------------------------------------------------------------------------
    // Second DEX (UniV2-compatible)
    // NOTE: SushiSwap V2 is NOT deployed on Base.
    //   Base      → Aerodrome  (UniV2-compatible)
    //   Ethereum  → SushiSwap V2
    //   Arbitrum  → SushiSwap V2
    // -------------------------------------------------------------------------
    address constant DEX2_BASE     = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43; // Aerodrome
    address constant DEX2_ETH      = 0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F; // SushiSwap V2
    address constant DEX2_ARBITRUM = 0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506; // SushiSwap V2 Arbitrum

    function run() external {
        string memory network = vm.envOr("NETWORK", string("base"));

        address uniswapRouter;
        address dex2Router;

        if (keccak256(bytes(network)) == keccak256(bytes("base"))) {
            uniswapRouter = UNISWAP_BASE;
            dex2Router    = DEX2_BASE;
        } else if (keccak256(bytes(network)) == keccak256(bytes("ethereum"))) {
            uniswapRouter = UNISWAP_ETH;
            dex2Router    = DEX2_ETH;
        } else if (keccak256(bytes(network)) == keccak256(bytes("arbitrum"))) {
            uniswapRouter = UNISWAP_ARBITRUM;
            dex2Router    = DEX2_ARBITRUM;
        } else {
            revert("Unsupported network");
        }

        vm.startBroadcast();

        FlashLoanArbitrage arbitrage = new FlashLoanArbitrage(
            MORPHO,
            uniswapRouter,
            dex2Router
        );

        console.log("FlashLoanArbitrage deployed to:", address(arbitrage));
        console.log("  Network:        ", network);
        console.log("  Morpho:         ", MORPHO);
        console.log("  Uniswap router: ", uniswapRouter);
        console.log("  DEX2 router:    ", dex2Router);
        console.log("  Deployer:       ", msg.sender);

        vm.stopBroadcast();

        _saveDeploymentInfo(network, address(arbitrage), uniswapRouter, dex2Router);
    }

    // -------------------------------------------------------------------------
    // Save deployment JSON to deployments/<network>.json
    // -------------------------------------------------------------------------
    function _saveDeploymentInfo(
        string memory network,
        address contractAddr,
        address uniswapRouter,
        address dex2Router
    ) internal {
        string memory root           = vm.projectRoot();
        string memory deploymentsDir = string.concat(root, "/deployments");

        if (!vm.isDir(deploymentsDir)) {
            vm.createDir(deploymentsDir, true);
        }

        string memory deploymentFile = string.concat(deploymentsDir, "/", network, ".json");

        string memory json = string.concat(
            "{\n",
            '  "network": "',         network,                        '",\n',
            '  "contractAddress": "', vm.toString(contractAddr),      '",\n',
            '  "morphoAddress": "',   vm.toString(MORPHO),            '",\n',
            '  "uniswapRouter": "',   vm.toString(uniswapRouter),     '",\n',
            '  "dex2Router": "',      vm.toString(dex2Router),        '",\n',
            '  "deployer": "',        vm.toString(msg.sender),        '",\n',
            '  "timestamp": "',       vm.toString(block.timestamp),   '",\n',
            '  "chainId": "',         vm.toString(block.chainid),     '"\n',
            "}"
        );

        vm.writeFile(deploymentFile, json);
        console.log("Deployment info saved to:", deploymentFile);
    }
}
