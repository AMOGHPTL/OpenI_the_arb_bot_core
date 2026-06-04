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

// UniV2-compatible Router (SushiSwap, Aerodrome, BaseSwap, etc.)
interface IUniV2Router {
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

    // -------------------------------------------------------------------------
    // State variables
    // -------------------------------------------------------------------------

    // All protocol addresses are immutable constructor parameters —
    // chain-agnostic and testable against any fork without code changes.
    IMorpho public immutable MORPHO;
    ISwapRouter public immutable UNISWAP_ROUTER;
    IUniV2Router public immutable SUSHI_ROUTER;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event ArbitrageExecuted(address indexed asset, uint256 profit, uint256 timestamp);
    event ProfitWithdrawn(address indexed token, uint256 amount);
    event TokensRescued(address indexed token, uint256 amount);
    event ETHRescued(uint256 amount);
    event FlashLoanInitiated(address indexed token, uint256 amount);

    // ArbitrageFailed removed — can't reliably emit from internal calls;
    // failed arbs surface as reverted transactions.

    // -------------------------------------------------------------------------
    // Structs
    // -------------------------------------------------------------------------

    struct ArbitrageData {
        address tokenBorrowed;
        address tokenIntermediate;
        uint24 uniswapFee;
        uint256 minProfit;
        uint8 direction;
        uint256 minAmountOutFirst;
        uint256 minAmountOutSecond;
        uint256 deadline;
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    // Reference addresses (verify before use):
    //
    // Ethereum mainnet
    //   Morpho Blue:   0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
    //   Uniswap V3:    0xE592427A0AEce92De3Edee1F18E0157C05861564
    //   SushiSwap V2:  0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F
    //
    // Base mainnet
    //   Morpho Blue:   0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
    //   Uniswap V3:    0x2626664c2603336E57B271c5C0b26F421741e481
    //   SushiSwap V2 is NOT on Base — use a UniV2-compatible alternative:
    //     Aerodrome:   0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43
    //     BaseSwap:    0x327Df1E6de05895d2ab08513aaDD9313Fe505d86

    constructor(address _morpho, address _uniswapRouter, address _sushiRouter) Ownable(msg.sender) {
        require(_morpho != address(0), "Invalid Morpho address");
        require(_uniswapRouter != address(0), "Invalid Uniswap router");
        require(_sushiRouter != address(0), "Invalid Sushi router");

        MORPHO = IMorpho(_morpho);
        UNISWAP_ROUTER = ISwapRouter(_uniswapRouter);
        SUSHI_ROUTER = IUniV2Router(_sushiRouter);
    }

    // -------------------------------------------------------------------------
    // External — owner only
    // -------------------------------------------------------------------------

    /// @notice Initiate a flash-loan arbitrage between Uniswap V3 and a
    ///         UniV2-compatible DEX.
    /// @param token               Token to borrow.
    /// @param amount              Amount to borrow (must be > 0).
    /// @param intermediateToken   Token swapped through (must differ from token).
    /// @param fee                 Uniswap V3 pool fee tier (500, 3000, or 10000).
    /// @param minProfit           Minimum acceptable profit after repayment.
    /// @param direction           0 = Uniswap→Sushi, 1 = Sushi→Uniswap.
    /// @param minAmountOutFirst   Slippage floor for the first swap.
    /// @param minAmountOutSecond  Slippage floor for the second swap.
    /// @param deadline            Unix timestamp after which swaps revert.
    function initiateFlashLoan(
        address token,
        uint256 amount,
        address intermediateToken,
        uint24 fee,
        uint256 minProfit,
        uint8 direction,
        uint256 minAmountOutFirst,
        uint256 minAmountOutSecond,
        uint256 deadline
    ) external onlyOwner nonReentrant {
        require(amount > 0, "Amount must be > 0");
        require(token != address(0), "Invalid token");
        require(intermediateToken != address(0), "Invalid intermediate token");
        require(intermediateToken != token, "Tokens must differ");
        require(direction <= 1, "Direction must be 0 or 1");
        require(deadline > block.timestamp, "Deadline in past");

        // Enforce non-zero slippage guards — callers cannot accidentally
        // disable protection by passing 0.
        require(minAmountOutFirst > 0, "minAmountOutFirst must be > 0");
        require(minAmountOutSecond > 0, "minAmountOutSecond must be > 0");

        bytes memory data = abi.encode(
            ArbitrageData({
                tokenBorrowed: token,
                tokenIntermediate: intermediateToken,
                uniswapFee: fee,
                minProfit: minProfit,
                direction: direction,
                minAmountOutFirst: minAmountOutFirst,
                minAmountOutSecond: minAmountOutSecond,
                deadline: deadline
            })
        );

        emit FlashLoanInitiated(token, amount);
        MORPHO.flashLoan(token, amount, data);
    }

    // -------------------------------------------------------------------------
    // Flash-loan callback
    // -------------------------------------------------------------------------

    function onMorphoFlashLoan(uint256 amount, uint256 fee, bytes calldata data) external override nonReentrant {
        require(msg.sender == address(MORPHO), "Only Morpho can callback");

        ArbitrageData memory arbData = abi.decode(data, (ArbitrageData));
        IERC20 tokenBorrowed = IERC20(arbData.tokenBorrowed);

        // Verify borrowed tokens actually arrived before touching them.
        require(tokenBorrowed.balanceOf(address(this)) >= amount, "Flash loan not received");

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

        // forceApprove resets any prior allowance before setting the new one,
        // which handles USDT-style tokens that revert on non-zero→non-zero approve.
        tokenBorrowed.forceApprove(address(MORPHO), totalRepayment);

        emit ArbitrageExecuted(arbData.tokenBorrowed, profit, block.timestamp);
    }

    // -------------------------------------------------------------------------
    // Internal — swap routes
    // -------------------------------------------------------------------------

    function _executeUniToSushi(uint256 amount, ArbitrageData memory arbData) internal returns (uint256 finalBalance) {
        uint256 intermediateAmount = _swapOnUniswap(
            arbData.tokenBorrowed,
            arbData.tokenIntermediate,
            arbData.uniswapFee,
            amount,
            arbData.minAmountOutFirst,
            arbData.deadline
        );
        require(intermediateAmount > 0, "Uniswap swap returned 0");

        uint256 finalAmount = _swapOnSushiswap(
            arbData.tokenIntermediate,
            arbData.tokenBorrowed,
            intermediateAmount,
            arbData.minAmountOutSecond,
            arbData.deadline
        );
        require(finalAmount > 0, "Sushi swap returned 0");

        finalBalance = IERC20(arbData.tokenBorrowed).balanceOf(address(this));
    }

    function _executeSushiToUni(uint256 amount, ArbitrageData memory arbData) internal returns (uint256 finalBalance) {
        uint256 intermediateAmount = _swapOnSushiswap(
            arbData.tokenBorrowed, arbData.tokenIntermediate, amount, arbData.minAmountOutFirst, arbData.deadline
        );
        require(intermediateAmount > 0, "Sushi swap returned 0");

        uint256 finalAmount = _swapOnUniswap(
            arbData.tokenIntermediate,
            arbData.tokenBorrowed,
            arbData.uniswapFee,
            intermediateAmount,
            arbData.minAmountOutSecond,
            arbData.deadline
        );
        require(finalAmount > 0, "Uniswap swap returned 0");

        finalBalance = IERC20(arbData.tokenBorrowed).balanceOf(address(this));
    }

    // -------------------------------------------------------------------------
    // Internal — individual swaps
    // -------------------------------------------------------------------------

    function _swapOnUniswap(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        IERC20(tokenIn).forceApprove(address(UNISWAP_ROUTER), amountIn);

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: address(this),
            deadline: deadline,
            amountIn: amountIn,
            amountOutMinimum: minAmountOut,
            sqrtPriceLimitX96: 0
        });

        amountOut = UNISWAP_ROUTER.exactInputSingle(params);

        // Reset residual allowance — a compromised or upgraded router
        // cannot drain leftover approval after the swap completes.
        IERC20(tokenIn).forceApprove(address(UNISWAP_ROUTER), 0);
    }

    function _swapOnSushiswap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        IERC20(tokenIn).forceApprove(address(SUSHI_ROUTER), amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256[] memory amounts =
            SUSHI_ROUTER.swapExactTokensForTokens(amountIn, minAmountOut, path, address(this), deadline);

        // Reset residual allowance after swap.
        IERC20(tokenIn).forceApprove(address(SUSHI_ROUTER), 0);

        amountOut = amounts[amounts.length - 1];
    }

    // -------------------------------------------------------------------------
    // Owner utilities
    // -------------------------------------------------------------------------

    /// @notice Withdraw the full ERC20 balance held by this contract.
    function withdrawProfit(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "No balance to withdraw");
        IERC20(token).safeTransfer(owner(), balance);
        emit ProfitWithdrawn(token, balance);
    }

    /// @notice Emergency rescue of a specific ERC20 amount.
    function rescueTokens(address token, uint256 amount) external onlyOwner {
        require(token != address(0), "Invalid token");
        require(amount > 0, "Amount must be > 0");
        IERC20(token).safeTransfer(owner(), amount);
        emit TokensRescued(token, amount);
    }

    /// @notice Rescue any ETH that ends up in this contract (e.g. from
    ///         accidental sends or WETH unwraps).
    function rescueETH() external onlyOwner {
        uint256 bal = address(this).balance;
        require(bal > 0, "No ETH to rescue");
        (bool ok,) = owner().call{value: bal}("");
        require(ok, "ETH transfer failed");
        emit ETHRescued(bal);
    }

    /// @notice Allow the contract to receive ETH.
    receive() external payable {}

    /// @notice Read the ERC20 balance held by this contract.
    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
}
