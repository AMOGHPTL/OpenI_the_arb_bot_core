// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IMorpho} from "./interfaces/IMorpho.sol";
import {IMorphoFlashLoanCallback} from "./interfaces/IMorphoCallbacks.sol";

// Matches SwapRouter02 ABI (no deadline field — selector 0x04e45aaf).
// SwapRouter01 has an extra `deadline` field and produces selector 0x414bf389 which
// SwapRouter02 does NOT recognise. Deadline protection is handled in _initiateFlashLoan.
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IUniV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

// Ownable2Step: ownership transfer requires the new owner to accept, preventing
// loss of the contract to a mistyped address.
// ReentrancyGuardTransient: same guarantee as ReentrancyGuard but uses EIP-1153
// transient storage (~4.9k gas cheaper per flash loan; requires Cancun, live on Base).
contract FlashLoanArbitrage is IMorphoFlashLoanCallback, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    IMorpho public immutable MORPHO;
    ISwapRouter public immutable UNISWAP_ROUTER;
    IUniV2Router public immutable SUSHI_ROUTER;

    mapping(address token => mapping(address spender => bool approved)) private s_isMaxApproved;

    event ArbitrageExecuted(address indexed asset, uint256 profit, uint256 timestamp);
    event ProfitWithdrawn(address indexed token, uint256 amount);
    event TokensRescued(address indexed token, uint256 amount);
    event ETHRescued(uint256 amount);
    event ApprovalRevoked(address indexed token, address indexed spender);
    event ApprovalsWarmed(address indexed token);

    struct ArbitrageData {
        address tokenBorrowed;
        address tokenIntermediate;
        uint24 uniswapFee;
        uint256 minProfit;
        uint8 direction;
        uint256 minAmountOutFirst;
        uint256 minAmountOutSecond;
        uint256 deadline;
        uint160 uniswapSqrtPriceLimitX96;
        uint256 maxGasPrice;
        uint256 validUntilBlock;
    }

    error ZeroAmount();
    error ZeroAddress();
    error InvalidMorphoAddress();
    error InvalidUniswapRouter();
    error InvalidSushiRouter();
    error SameToken();
    error InvalidDirection();
    error DeadlineExpired();
    error FlashLoanNotReceived();
    error InsufficientRepayment();
    error ProfitTooLow();
    error OnlyMorpho();
    error NoBalance();
    error EthTransferFailed();
    error GasPriceTooHigh();
    error BlockWindowExpired();

    // Reference addresses (verify before use):
    //
    // Ethereum mainnet
    //   Morpho Blue:   0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
    //   Uniswap V3:    0xE592427A0AEce92De3Edee1F18E0157C05861564  (SwapRouter01 — has deadline)
    //   SushiSwap V2:  0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F
    //
    // Base mainnet
    //   Morpho Blue:   0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
    //   Uniswap V3:    0x2626664c2603336E57B271c5C0b26F421741e481  (SwapRouter02 — no deadline)
    //   Uniswap V2:    0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24  (UniV2-compatible)
    //   NOTE: Aerodrome (0xcF77a3...) uses Route[] struct, NOT address[] — incompatible with IUniV2Router
    //
    // Arbitrum
    //   Morpho Blue:   0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
    //   Uniswap V3:    0xE592427A0AEce92De3Edee1F18E0157C05861564  (SwapRouter01 — has deadline)
    //   SushiSwap V2:  0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506
    constructor(address _morpho, address _uniswapRouter, address _sushiRouter) Ownable(msg.sender) {
        if (_morpho == address(0)) revert InvalidMorphoAddress();
        if (_uniswapRouter == address(0)) revert InvalidUniswapRouter();
        if (_sushiRouter == address(0)) revert InvalidSushiRouter();

        MORPHO = IMorpho(_morpho);
        UNISWAP_ROUTER = ISwapRouter(_uniswapRouter);
        SUSHI_ROUTER = IUniV2Router(_sushiRouter);
    }

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
    ) external onlyOwner {
        _initiateFlashLoan(
            token,
            amount,
            intermediateToken,
            fee,
            minProfit,
            direction,
            minAmountOutFirst,
            minAmountOutSecond,
            deadline,
            0,
            0,
            0
        );
    }

    function initiateProtectedFlashLoan(
        address token,
        uint256 amount,
        address intermediateToken,
        uint24 fee,
        uint256 minProfit,
        uint8 direction,
        uint256 minAmountOutFirst,
        uint256 minAmountOutSecond,
        uint256 deadline,
        uint160 uniswapSqrtPriceLimitX96,
        uint256 maxGasPrice,
        uint256 validUntilBlock
    ) external onlyOwner {
        _initiateFlashLoan(
            token,
            amount,
            intermediateToken,
            fee,
            minProfit,
            direction,
            minAmountOutFirst,
            minAmountOutSecond,
            deadline,
            uniswapSqrtPriceLimitX96,
            maxGasPrice,
            validUntilBlock
        );
    }

    function _initiateFlashLoan(
        address token,
        uint256 amount,
        address intermediateToken,
        uint24 fee,
        uint256 minProfit,
        uint8 direction,
        uint256 minAmountOutFirst,
        uint256 minAmountOutSecond,
        uint256 deadline,
        uint160 uniswapSqrtPriceLimitX96,
        uint256 maxGasPrice,
        uint256 validUntilBlock
    ) internal {
        if (amount == 0) revert ZeroAmount();
        if (token == address(0) || intermediateToken == address(0)) revert ZeroAddress();
        if (intermediateToken == token) revert SameToken();
        if (direction > 1) revert InvalidDirection();
        if (deadline <= block.timestamp) revert DeadlineExpired();
        if (minAmountOutFirst == 0 || minAmountOutSecond == 0) revert ZeroAmount();
        _validateMevGuards(maxGasPrice, validUntilBlock);

        bytes memory data = abi.encode(
            ArbitrageData({
                tokenBorrowed: token,
                tokenIntermediate: intermediateToken,
                uniswapFee: fee,
                minProfit: minProfit,
                direction: direction,
                minAmountOutFirst: minAmountOutFirst,
                minAmountOutSecond: minAmountOutSecond,
                deadline: deadline,
                uniswapSqrtPriceLimitX96: uniswapSqrtPriceLimitX96,
                maxGasPrice: maxGasPrice,
                validUntilBlock: validUntilBlock
            })
        );

        MORPHO.flashLoan(token, amount, data);
    }

    function onMorphoFlashLoan(uint256 amount, bytes calldata data) external override nonReentrant {
        if (msg.sender != address(MORPHO)) revert OnlyMorpho();

        ArbitrageData memory arbData = abi.decode(data, (ArbitrageData));
        _validateMevGuards(arbData.maxGasPrice, arbData.validUntilBlock);

        IERC20 tokenBorrowed = IERC20(arbData.tokenBorrowed);

        uint256 startingBalance = tokenBorrowed.balanceOf(address(this));
        if (startingBalance < amount) revert FlashLoanNotReceived();
        unchecked {
            startingBalance -= amount;
        }

        uint256 finalBalance;
        if (arbData.direction == 0) {
            finalBalance = _executeUniToSushi(amount, arbData);
        } else {
            finalBalance = _executeSushiToUni(amount, arbData);
        }

        uint256 totalRepayment = amount;
        if (finalBalance < startingBalance) revert InsufficientRepayment();
        uint256 tradeBalance;
        unchecked {
            tradeBalance = finalBalance - startingBalance;
        }
        if (tradeBalance < totalRepayment) revert InsufficientRepayment();

        uint256 profit;
        unchecked {
            profit = tradeBalance - totalRepayment;
        }
        if (profit < arbData.minProfit) revert ProfitTooLow();

        _approveMaxIfNeeded(arbData.tokenBorrowed, address(MORPHO));

        emit ArbitrageExecuted(arbData.tokenBorrowed, profit, block.timestamp);
    }

    function _executeUniToSushi(uint256 amount, ArbitrageData memory arbData) internal returns (uint256 finalBalance) {
        uint256 intermediateAmount = _swapOnUniswap(
            arbData.tokenBorrowed,
            arbData.tokenIntermediate,
            arbData.uniswapFee,
            amount,
            arbData.minAmountOutFirst,
            arbData.uniswapSqrtPriceLimitX96
        );

        _swapOnSushiswap(
            arbData.tokenIntermediate,
            arbData.tokenBorrowed,
            intermediateAmount,
            arbData.minAmountOutSecond,
            arbData.deadline
        );

        finalBalance = IERC20(arbData.tokenBorrowed).balanceOf(address(this));
    }

    function _executeSushiToUni(uint256 amount, ArbitrageData memory arbData) internal returns (uint256 finalBalance) {
        uint256 intermediateAmount = _swapOnSushiswap(
            arbData.tokenBorrowed, arbData.tokenIntermediate, amount, arbData.minAmountOutFirst, arbData.deadline
        );

        _swapOnUniswap(
            arbData.tokenIntermediate,
            arbData.tokenBorrowed,
            arbData.uniswapFee,
            intermediateAmount,
            arbData.minAmountOutSecond,
            arbData.uniswapSqrtPriceLimitX96
        );

        finalBalance = IERC20(arbData.tokenBorrowed).balanceOf(address(this));
    }

    function _swapOnUniswap(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minAmountOut,
        uint160 sqrtPriceLimitX96
    ) internal returns (uint256 amountOut) {
        address router = address(UNISWAP_ROUTER);
        _approveMaxIfNeeded(tokenIn, router);

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: address(this),
            amountIn: amountIn,
            amountOutMinimum: minAmountOut,
            sqrtPriceLimitX96: sqrtPriceLimitX96
        });

        amountOut = UNISWAP_ROUTER.exactInputSingle(params);
    }

    function _validateMevGuards(uint256 maxGasPrice, uint256 validUntilBlock) internal view {
        if (maxGasPrice != 0 && tx.gasprice > maxGasPrice) revert GasPriceTooHigh();
        if (validUntilBlock != 0 && block.number > validUntilBlock) revert BlockWindowExpired();
    }

    function _swapOnSushiswap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) internal returns (uint256 amountOut) {
        _approveMaxIfNeeded(tokenIn, address(SUSHI_ROUTER));

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256[] memory amounts =
            SUSHI_ROUTER.swapExactTokensForTokens(amountIn, minAmountOut, path, address(this), deadline);

        amountOut = amounts[1];
    }

    function _approveMaxIfNeeded(address token, address spender) internal {
        if (!s_isMaxApproved[token][spender]) {
            s_isMaxApproved[token][spender] = true;
            IERC20(token).forceApprove(spender, type(uint256).max);
        }
    }

    /// @notice Pre-approves `tokens` for both routers and Morpho so the first
    ///         arbitrage of a pair does not pay ~75k gas of cold approvals
    ///         inside the profit-critical transaction. Call once per token
    ///         after deployment (e.g. warmApprovals([USDC, WETH])).
    function warmApprovals(address[] calldata tokens) external onlyOwner {
        uint256 len = tokens.length;
        for (uint256 i; i < len; ++i) {
            address token = tokens[i];
            if (token == address(0)) revert ZeroAddress();
            _approveMaxIfNeeded(token, address(UNISWAP_ROUTER));
            _approveMaxIfNeeded(token, address(SUSHI_ROUTER));
            _approveMaxIfNeeded(token, address(MORPHO));
            emit ApprovalsWarmed(token);
        }
    }

    function revokeApproval(address token, address spender) external onlyOwner {
        if (token == address(0) || spender == address(0)) revert ZeroAddress();
        s_isMaxApproved[token][spender] = false;
        IERC20(token).forceApprove(spender, 0);
        emit ApprovalRevoked(token, spender);
    }

    function withdrawProfit(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) revert NoBalance();
        IERC20(token).safeTransfer(owner(), balance);
        emit ProfitWithdrawn(token, balance);
    }

    function rescueTokens(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(owner(), amount);
        emit TokensRescued(token, amount);
    }

    function rescueETH() external onlyOwner {
        uint256 bal = address(this).balance;
        if (bal == 0) revert NoBalance();
        (bool ok,) = owner().call{value: bal}("");
        if (!ok) revert EthTransferFailed();
        emit ETHRescued(bal);
    }

    receive() external payable {}

    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }
}
