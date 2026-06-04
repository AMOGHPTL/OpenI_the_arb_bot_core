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

        console.log("=== Deployment Status ===");

        for (uint256 i = 0; i < networks.length; i++) {
            string memory deploymentFile = string.concat(deploymentsDir, "/", networks[i], ".json");

            if (vm.exists(deploymentFile)) {
                string memory content = vm.readFile(deploymentFile);

                // Parse fields from JSON
                address contractAddr = _parseAddress(content, "contractAddress");
                address morphoAddr = _parseAddress(content, "morphoAddress");
                address uniswapRouter = _parseAddress(content, "uniswapRouter");
                address dex2Router = _parseAddress(content, "dex2Router");

                console.log("");
                console.log("[OK]", networks[i]);
                console.log("  Contract: ", contractAddr);
                console.log("  Morpho:   ", morphoAddr);
                console.log("  Uniswap:  ", uniswapRouter);
                console.log("  DEX2:     ", dex2Router);

                // Sanity checks
                require(contractAddr != address(0), "Bad contractAddress in JSON");
                require(morphoAddr != address(0), "Bad morphoAddress in JSON");
                require(uniswapRouter != address(0), "Bad uniswapRouter in JSON");
                require(dex2Router != address(0), "Bad dex2Router in JSON");
            } else {
                console.log("[--]", networks[i], "not deployed yet");
            }
        }

        console.log("");
        console.log("=========================");
    }

    // -------------------------------------------------------------------------
    // Minimal JSON field extractor (no external library needed).
    // Finds the first occurrence of "key": "0x..." and returns the address.
    // -------------------------------------------------------------------------
    function _parseAddress(string memory json, string memory key) internal pure returns (address) {
        // Build search string: "key": "
        string memory search = string.concat('"', key, '": "');
        bytes memory jsonBytes = bytes(json);
        bytes memory searchBytes = bytes(search);

        uint256 start = _indexOf(jsonBytes, searchBytes);
        if (start == type(uint256).max) return address(0);

        // Move past the search string to the start of the value
        start += searchBytes.length;

        // Read 42 chars ("0x" + 40 hex digits)
        bytes memory addrBytes = new bytes(42);
        for (uint256 i = 0; i < 42 && start + i < jsonBytes.length; i++) {
            addrBytes[i] = jsonBytes[start + i];
        }

        return _toAddress(string(addrBytes));
    }

    function _indexOf(bytes memory haystack, bytes memory needle) internal pure returns (uint256) {
        if (needle.length > haystack.length) return type(uint256).max;
        for (uint256 i = 0; i <= haystack.length - needle.length; i++) {
            bool found = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) found = false;
                break;
            }
            if (found) return i;
        }
        return type(uint256).max;
    }

    function _toAddress(string memory s) internal pure returns (address) {
        bytes memory b = bytes(s);
        require(b.length == 42 && b[0] == "0" && b[1] == "x", "Invalid address string");
        uint160 result = 0;
        for (uint256 i = 2; i < 42; i++) {
            result *= 16;
            uint8 c = uint8(b[i]);
            if (c >= 48 && c <= 57) result += c - 48; // 0-9
            else if (c >= 65 && c <= 70) result += c - 55; // A-F
            else if (c >= 97 && c <= 102) result += c - 87; // a-f
            else revert("Invalid hex char");
        }
        return address(result);
    }
}
