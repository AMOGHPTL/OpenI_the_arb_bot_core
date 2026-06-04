// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../../src/FlashLoanArbitrage.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockMorpho {
    function flashLoan(address loanToken, uint256 loanAmount, bytes calldata data) external {
        IERC20(loanToken).transfer(msg.sender, loanAmount);

        IMorphoFlashLoanCallback(msg.sender).onMorphoFlashLoan(loanAmount, 0, data);
    }
}
