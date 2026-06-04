// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../../src/FlashLoanArbitrage.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockSushiRouter is IUniV2Router {
    uint256 public multiplier = 110;

    function setMultiplier(uint256 _multiplier) external {
        multiplier = _multiplier;
    }

    function swapExactTokensForTokens(uint256 amountIn, uint256, address[] calldata path, address to, uint256)
        external
        override
        returns (uint256[] memory amounts)
    {
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);

        uint256 amountOut = (amountIn * multiplier) / 100;

        IERC20(path[1]).transfer(to, amountOut);

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }
}
