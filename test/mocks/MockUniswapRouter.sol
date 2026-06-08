// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../../src/FlashLoanArbitrage.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockUniswapRouter is ISwapRouter {
    uint256 public multiplier = 110;

    function setMultiplier(uint256 _multiplier) external {
        multiplier = _multiplier;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable override returns (uint256 amountOut) {
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);

        amountOut = (params.amountIn * multiplier) / 100;
        require(amountOut >= params.amountOutMinimum, "Too little received");

        IERC20(params.tokenOut).transfer(params.recipient, amountOut);
    }
}
