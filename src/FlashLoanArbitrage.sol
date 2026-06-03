// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// Morpho Flash Loan Interfaces
interface IMorpho {
    function flashLoan(address loanToken, uint256 loanAmount, bytes calldata data) external;
}

interface IMorphoFlashLoanCallback {
    function onMorphoFlashLoan(uint256 amount, uint256 fee, bytes calldata data) external;
}

// Uniswap V3 Router
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

// SushiSwap Router
interface ISushiSwapRouter {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

contract FlashLoanArbitrage is IMorphoFlashLoanCallback, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // State variables
    IMorpho public immutable MORPHO;
    ISwapRouter public immutable UNISWAP_ROUTER;
    ISushiSwapRouter public immutable SUSHI_ROUTER;

    // Protocol addresses (adjust for Base/Ethereum)
    address public constant UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address public constant SUSHI_ROUTER_ADDRESS = 0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F;

    // Events
    event ArbitrageExecuted(address indexed asset, uint256 profit, uint256 timestamp);
    event ArbitrageFailed(string reason, uint256 timestamp);
    event ProfitWithdrawn(address indexed token, uint256 amount);
    event TokensRescued(address indexed token, uint256 amount);
    event FlashLoanInitiated(address indexed token, uint256 amount);

    // Struct for arbitrage parameters
    struct ArbitrageData {
        address tokenBorrowed;
        address tokenIntermediate;
        uint24 uniswapFee;
        uint256 minProfit;
        uint8 direction;
        uint256 minAmountOutFirst;
        uint256 minAmountOutSecond;
    }

    constructor(address _morpho) Ownable(msg.sender) {
        require(_morpho != address(0), "Invalid Morpho address");
        MORPHO = IMorpho(_morpho);
        UNISWAP_ROUTER = ISwapRouter(UNISWAP_V3_ROUTER);
        SUSHI_ROUTER = ISushiSwapRouter(SUSHI_ROUTER_ADDRESS);
    }

    function initiateFlashLoan(
        address token,
        uint256 amount,
        address intermediateToken,
        uint24 fee,
        uint256 minProfit,
        uint8 direction,
        uint256 minAmountOutFirst,
        uint256 minAmountOutSecond
    ) external onlyOwner nonReentrant {
        require(amount > 0, "Amount must be > 0");
        require(token != address(0), "Invalid token");
        require(intermediateToken != address(0), "Invalid intermediate token");

        bytes memory data = abi.encode(
            ArbitrageData({
                tokenBorrowed: token,
                tokenIntermediate: intermediateToken,
                uniswapFee: fee,
                minProfit: minProfit,
                direction: direction,
                minAmountOutFirst: minAmountOutFirst,
                minAmountOutSecond: minAmountOutSecond
            })
        );

        emit FlashLoanInitiated(token, amount);
        MORPHO.flashLoan(token, amount, data);
    }

    function onMorphoFlashLoan(uint256 amount, uint256 fee, bytes calldata data) external override nonReentrant {
        require(msg.sender == address(MORPHO), "Only Morpho can callback");

        ArbitrageData memory arbData = abi.decode(data, (ArbitrageData));

        IERC20 tokenBorrowed = IERC20(arbData.tokenBorrowed);

        uint256 startingBalance = tokenBorrowed.balanceOf(address(this));

        uint256 finalBalance;

        if (arbData.direction == 0) {
            finalBalance = _executeUniToSushi(amount, arbData);
        } else {
            finalBalance = _executeSushiToUni(amount, arbData);
        }

        uint256 totalRepayment = amount + fee;
        require(finalBalance >= totalRepayment, "Insufficient funds for repayment");

        uint256 profit = finalBalance - totalRepayment;
        require(profit >= arbData.minProfit, "Profit below minimum threshold");

        // Use approve directly (safeApprove is deprecated, use approve with reset)
        tokenBorrowed.approve(address(MORPHO), totalRepayment);

        emit ArbitrageExecuted(arbData.tokenBorrowed, profit, block.timestamp);
    }

    function _executeUniToSushi(uint256 amount, ArbitrageData memory arbData) internal returns (uint256 finalBalance) {
        uint256 intermediateAmount = _swapOnUniswap(
            arbData.tokenBorrowed, arbData.tokenIntermediate, arbData.uniswapFee, amount, arbData.minAmountOutFirst
        );

        require(intermediateAmount > 0, "Uniswap swap failed");

        uint256 finalAmount = _swapOnSushiswap(
            arbData.tokenIntermediate, arbData.tokenBorrowed, intermediateAmount, arbData.minAmountOutSecond
        );

        require(finalAmount > 0, "SushiSwap swap failed");

        finalBalance = IERC20(arbData.tokenBorrowed).balanceOf(address(this));
        return finalBalance;
    }

    function _executeSushiToUni(uint256 amount, ArbitrageData memory arbData) internal returns (uint256 finalBalance) {
        uint256 intermediateAmount =
            _swapOnSushiswap(arbData.tokenBorrowed, arbData.tokenIntermediate, amount, arbData.minAmountOutFirst);

        require(intermediateAmount > 0, "SushiSwap swap failed");

        uint256 finalAmount = _swapOnUniswap(
            arbData.tokenIntermediate,
            arbData.tokenBorrowed,
            arbData.uniswapFee,
            intermediateAmount,
            arbData.minAmountOutSecond
        );

        require(finalAmount > 0, "Uniswap swap failed");

        finalBalance = IERC20(arbData.tokenBorrowed).balanceOf(address(this));
        return finalBalance;
    }

    function _swapOnUniswap(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minAmountOut)
        internal
        returns (uint256 amountOut)
    {
        IERC20 tokenInContract = IERC20(tokenIn);

        // Approve Uniswap router
        tokenInContract.approve(address(UNISWAP_ROUTER), amountIn);

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: address(this),
            deadline: block.timestamp + 300,
            amountIn: amountIn,
            amountOutMinimum: minAmountOut,
            sqrtPriceLimitX96: 0
        });

        amountOut = UNISWAP_ROUTER.exactInputSingle(params);
    }

    function _swapOnSushiswap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut)
        internal
        returns (uint256 amountOut)
    {
        IERC20 tokenInContract = IERC20(tokenIn);

        // Approve SushiSwap router
        tokenInContract.approve(address(SUSHI_ROUTER), amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256[] memory amounts =
            SUSHI_ROUTER.swapExactTokensForTokens(amountIn, minAmountOut, path, address(this), block.timestamp + 300);

        amountOut = amounts[amounts.length - 1];
    }

    function withdrawProfit(address token) external onlyOwner {
        IERC20 tokenContract = IERC20(token);
        uint256 balance = tokenContract.balanceOf(address(this));
        require(balance > 0, "No balance to withdraw");
        tokenContract.safeTransfer(owner(), balance);
        emit ProfitWithdrawn(token, balance);
    }

    function rescueTokens(address token, uint256 amount) external onlyOwner {
        require(token != address(0), "Invalid token");
        require(amount > 0, "Amount must be > 0");
        IERC20(token).safeTransfer(owner(), amount);
        emit TokensRescued(token, amount);
    }

    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
}
