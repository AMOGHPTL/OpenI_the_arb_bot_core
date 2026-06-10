// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FlashLoanArbitrage.sol";

/// @dev Full execution-engine test with real on-chain routers on a Base mainnet fork.
///      Run with: forge test --match-contract RealDex --fork-url $BASE_RPC_URL -vvv
///
///      Both legs use real on-chain routers:
///        Leg 1 (Uniswap V3)  — SwapRouter02 @ 0x2626664c2603336E57B271c5C0b26F421741e481
///        Leg 2 (Uniswap V2)  — UniV2 Router  @ 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24
///
///      Pass/fail semantics:
///        - ProfitTooLow   → correct: arb not present at this block (bot should not fire)
///        - Any other error → BUG in the execution engine
contract FlashLoanArbitrageRealDexTest is Test {
    address internal constant BASE_MORPHO   = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address internal constant BASE_UNI_V3   = 0x2626664c2603336E57B271c5C0b26F421741e481; // SwapRouter02
    address internal constant BASE_UNI_V2   = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24; // UniV2 Router
    address internal constant BASE_USDC     = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant BASE_WETH     = 0x4200000000000000000000000000000000000006;

    // Uniswap V3 QuoterV2 on Base
    address internal constant BASE_QUOTER_V2 = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;

    FlashLoanArbitrage internal arb;

    function setUp() public {
        vm.createSelectFork("base"); // "base" resolves via foundry.toml [rpc_endpoints]

        arb = new FlashLoanArbitrage(BASE_MORPHO, BASE_UNI_V3, BASE_UNI_V2);
        deal(BASE_USDC, BASE_MORPHO, 10_000_000e6);
    }

    /// @dev Direction 0: borrow USDC, swap USDC->WETH on Uni V3, swap WETH->USDC on Uni V2.
    function testRealDexSwapPathUniV3toV2() public {
        _runPath(0, 500);
    }

    /// @dev Direction 1: borrow USDC, swap USDC->WETH on Uni V2, swap WETH->USDC on Uni V3.
    function testRealDexSwapPathUniV2toV3() public {
        _runPath(1, 500);
    }

    /// @dev Shared execution. Passes when:
    ///   - trade is profitable (morpho repaid, profit logged), OR
    ///   - InsufficientRepayment (path runs at net loss — correct contract behaviour), OR
    ///   - ProfitTooLow (profit below minProfit — correct contract behaviour).
    ///   Fails on any other revert, which would mean a broken router ABI or wrong address.
    function _runPath(uint8 direction, uint24 fee) internal {
        uint256 loanAmount = 1_000e6;

        (uint256 minFirst, uint256 minSecond) = _safeMinAmounts(loanAmount, fee, direction);

        uint256 morphoBefore = IERC20(BASE_USDC).balanceOf(BASE_MORPHO);

        try arb.initiateFlashLoan(
            BASE_USDC, loanAmount, BASE_WETH, fee,
            0,           // minProfit = 0 so the call always completes unless there's a net loss
            direction,
            minFirst, minSecond,
            block.timestamp + 1 hours
        ) {
            // Arb was profitable: verify Morpho was fully repaid
            assertEq(IERC20(BASE_USDC).balanceOf(BASE_MORPHO), morphoBefore, "Morpho not repaid");
            console.log("Profitable arb on direction", direction, "- profit (USDC 6dp):", IERC20(BASE_USDC).balanceOf(address(arb)));
        } catch (bytes memory reason) {
            if (reason.length >= 4) {
                // forge-lint: disable-next-line(unsafe-typecast)
                bytes4 sel = bytes4(reason);
                // Both are valid "no arb at this block" outcomes — not bugs.
                // InsufficientRepayment: swap produced net loss (can't repay loan).
                // ProfitTooLow: swap covered loan but missed minProfit threshold.
                bool isNoArb = (
                    sel == FlashLoanArbitrage.InsufficientRepayment.selector ||
                    sel == FlashLoanArbitrage.ProfitTooLow.selector
                );
                assertTrue(isNoArb, string.concat("Unexpected execution revert selector: ", vm.toString(reason)));
                console.log("No arb on direction", direction, "at this block - correct contract behaviour");
            } else {
                // Empty revert or string revert from an external call — indicates a broken router
                assertTrue(false, string.concat("External revert (wrong router ABI or address?): ", vm.toString(reason)));
            }
        }
    }

    /// @dev Creates a price divergence by front-running V2 with a large USDC→WETH swap,
    ///      then verifies the arb contract captures the spread profitably.
    ///
    ///      After the manipulation:
    ///        V2 WETH price  : ~6000+ USDC  (WETH was bought out, now expensive on V2)
    ///        V3 WETH price  : ~1600  USDC  (untouched)
    ///      Direction 0 (buy cheap WETH on V3, sell expensive WETH on V2) is highly profitable.
    function testProfitableArbitrageAfterManipulation() public {
        // ---- 1. Give this test contract USDC to move the V2 price ----
        deal(BASE_USDC, address(this), 500_000e6);
        IERC20(BASE_USDC).approve(BASE_UNI_V2, type(uint256).max);

        // ---- 2. Large USDC→WETH buy on V2: WETH becomes very expensive on V2 ----
        address[] memory path = new address[](2);
        path[0] = BASE_USDC;
        path[1] = BASE_WETH;
        (bool ok,) = BASE_UNI_V2.call(
            abi.encodeWithSignature(
                "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
                500_000e6, 1, path, address(this), block.timestamp + 1 hours
            )
        );
        require(ok, "manipulation swap failed");

        // ---- 3. Quote legs at post-manipulation prices (direction=0: V3->V2) ----
        uint256 loanAmount = 1_000e6; // 1 000 USDC
        (uint256 minFirst, uint256 minSecond) = _safeMinAmounts(loanAmount, 500, 0);

        // ---- 4. Execute the arb ----
        uint256 arbBefore = IERC20(BASE_USDC).balanceOf(address(arb));

        arb.initiateFlashLoan(
            BASE_USDC, loanAmount, BASE_WETH, 500,
            0,          // minProfit = 0
            0,          // direction = 0  (buy WETH on V3, sell on V2)
            minFirst, minSecond,
            block.timestamp + 1 hours
        );

        uint256 profit = IERC20(BASE_USDC).balanceOf(address(arb)) - arbBefore;
        assertGt(profit, 500e6, "expected substantial profit from manipulated spread");
        console.log("Arb profit (USDC 6dp):", profit);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /// @dev Returns safe minAmounts at 90% of live quotes (10% slippage buffer).
    ///      Falls back to 1 wei if either quoter call fails, so execution still proceeds.
    function _safeMinAmounts(uint256 loanAmount, uint24 fee, uint8 direction)
        internal
        returns (uint256 minFirst, uint256 minSecond)
    {
        if (direction == 0) {
            // V3 first leg: USDC -> WETH
            uint256 wethOut  = _quoteV3(BASE_USDC, BASE_WETH, fee, loanAmount);
            // V2 second leg: WETH -> USDC
            uint256 usdcBack = _quoteV2(BASE_WETH, BASE_USDC, wethOut);
            minFirst  = wethOut  > 0 ? (wethOut  * 90) / 100 : 1;
            minSecond = usdcBack > 0 ? (usdcBack * 90) / 100 : 1;
        } else {
            // V2 first leg: USDC -> WETH
            uint256 wethOut  = _quoteV2(BASE_USDC, BASE_WETH, loanAmount);
            // V3 second leg: WETH -> USDC
            uint256 usdcBack = _quoteV3(BASE_WETH, BASE_USDC, fee, wethOut);
            minFirst  = wethOut  > 0 ? (wethOut  * 90) / 100 : 1;
            minSecond = usdcBack > 0 ? (usdcBack * 90) / 100 : 1;
        }
    }

    /// @dev Uniswap V3 QuoterV2 quote. Returns 0 on failure.
    function _quoteV3(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)
        internal
        returns (uint256 amountOut)
    {
        (bool ok, bytes memory data) = BASE_QUOTER_V2.call(
            abi.encodeWithSignature(
                "quoteExactInputSingle((address,address,uint256,uint24,uint160))",
                tokenIn, tokenOut, amountIn, fee, 0
            )
        );
        if (!ok || data.length < 32) return 0;
        (amountOut,,,) = abi.decode(data, (uint256, uint160, uint32, uint256));
    }

    /// @dev Uniswap V2 getAmountsOut quote. Returns 0 on failure.
    function _quoteV2(address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (uint256 amountOut)
    {
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        (bool ok, bytes memory data) = BASE_UNI_V2.staticcall(
            abi.encodeWithSignature("getAmountsOut(uint256,address[])", amountIn, path)
        );
        if (!ok || data.length < 64) return 0;
        uint256[] memory amounts = abi.decode(data, (uint256[]));
        amountOut = amounts[amounts.length - 1];
    }
}
