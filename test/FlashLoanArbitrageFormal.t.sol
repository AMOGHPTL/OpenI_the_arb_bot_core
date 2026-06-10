// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================================
// Formal verification via Halmos (symbolic execution).
//
// Install:  pip install halmos
// Run:      halmos --match-contract Formal --solver-timeout-assertion 60000
//
// Functions prefixed with `check_` are ignored by `forge test` and are only
// run by Halmos.  Each one is a PROOF: Halmos tries to find ANY assignment of
// symbolic inputs that violates the embedded `assert`.  If it cannot, the
// property is proven for the full input space under the stated preconditions.
// ============================================================================

import "forge-std/Test.sol";
import "../src/FlashLoanArbitrage.sol";
import "./mocks/MockERC20.sol";
import "./mocks/MockMorpho.sol";
import "./mocks/MockUniswapRouter.sol";
import "./mocks/MockSushiRouter.sol";

contract FlashLoanArbitrageFormalTest is Test {
    FlashLoanArbitrage internal arb;
    MockERC20          internal usdc;
    MockERC20          internal weth;
    MockMorpho         internal morpho;
    MockUniswapRouter  internal uni;
    MockSushiRouter    internal sushi;

    address internal owner;

    function setUp() public {
        owner  = address(this);

        usdc   = new MockERC20("USDC", "USDC", 6);
        weth   = new MockERC20("WETH", "WETH", 18);
        morpho = new MockMorpho();
        uni    = new MockUniswapRouter();
        sushi  = new MockSushiRouter();

        arb = new FlashLoanArbitrage(address(morpho), address(uni), address(sushi));

        usdc.mint(address(morpho), 10_000_000e6);
        usdc.mint(address(uni),     1_000_000e6);
        weth.mint(address(uni),     1_000_000 ether);
        usdc.mint(address(sushi),   1_000_000e6);
        weth.mint(address(sushi),   1_000_000 ether);

        // Fix block.timestamp so deadline arithmetic is concrete
        vm.warp(1000);
    }

    // ========================================================================
    // 1. ACCESS CONTROL
    //    Prove: no address other than the owner can ever call restricted fns.
    // ========================================================================

    /// For ALL addresses that are not the owner, withdrawProfit always reverts.
    function check_withdrawProfit_onlyOwner(address attacker) public {
        vm.assume(attacker != owner);
        vm.prank(attacker);
        try arb.withdrawProfit(address(usdc)) {
            assert(false); // reachable iff onlyOwner was bypassed
        } catch {}
    }

    /// For ALL non-owner addresses, rescueTokens always reverts.
    function check_rescueTokens_onlyOwner(address attacker, uint256 amount) public {
        vm.assume(attacker != owner);
        vm.prank(attacker);
        try arb.rescueTokens(address(usdc), amount) {
            assert(false);
        } catch {}
    }

    /// For ALL non-owner addresses, initiateFlashLoan always reverts
    /// (onlyOwner fires before any external call or state mutation).
    function check_initiateFlashLoan_onlyOwner(address attacker) public {
        vm.assume(attacker != owner);
        vm.prank(attacker);
        try arb.initiateFlashLoan(
            address(usdc), 1_000e6, address(weth), 500,
            0, 0, 1, 1, block.timestamp + 1 hours
        ) {
            assert(false);
        } catch {}
    }

    /// For ALL non-owner addresses, revokeApproval always reverts.
    function check_revokeApproval_onlyOwner(address attacker) public {
        vm.assume(attacker != owner);
        vm.prank(attacker);
        try arb.revokeApproval(address(usdc), address(uni)) {
            assert(false);
        } catch {}
    }

    /// For ALL callers that are not Morpho, onMorphoFlashLoan always reverts.
    /// This proves reentrancy from an arbitrary external contract is impossible.
    function check_callback_onlyMorpho(address caller, uint256 amount) public {
        vm.assume(caller != address(morpho));
        vm.prank(caller);
        try arb.onMorphoFlashLoan(amount, bytes("")) {
            assert(false);
        } catch {}
    }

    // ========================================================================
    // 2. INPUT VALIDATION
    //    Prove: the contract always reverts with the correct error for bad inputs.
    // ========================================================================

    /// amount == 0  →  ZeroAmount (checked before any external call)
    function check_zeroAmount_reverts(address token, address intermediate, uint8 direction) public {
        vm.assume(token != address(0));
        vm.assume(intermediate != address(0));
        vm.assume(token != intermediate);
        vm.assume(direction <= 1);

        try arb.initiateFlashLoan(
            token, 0, intermediate, 500,
            0, direction, 1, 1, block.timestamp + 1 hours
        ) {
            assert(false);
        } catch (bytes memory reason) {
            assert(bytes4(reason) == FlashLoanArbitrage.ZeroAmount.selector);
        }
    }

    /// tokenBorrowed == tokenIntermediate  →  SameToken
    function check_sameToken_reverts(address token, uint256 amount) public {
        vm.assume(token != address(0));
        vm.assume(amount > 0);

        try arb.initiateFlashLoan(
            token, amount, token, 500,
            0, 0, 1, 1, block.timestamp + 1 hours
        ) {
            assert(false);
        } catch (bytes memory reason) {
            assert(bytes4(reason) == FlashLoanArbitrage.SameToken.selector);
        }
    }

    /// direction > 1  →  InvalidDirection
    function check_invalidDirection_reverts(uint8 direction, uint256 amount) public {
        vm.assume(direction > 1);
        vm.assume(amount > 0);

        try arb.initiateFlashLoan(
            address(usdc), amount, address(weth), 500,
            0, direction, 1, 1, block.timestamp + 1 hours
        ) {
            assert(false);
        } catch (bytes memory reason) {
            assert(bytes4(reason) == FlashLoanArbitrage.InvalidDirection.selector);
        }
    }

    /// deadline <= block.timestamp  →  DeadlineExpired
    function check_expiredDeadline_reverts(uint256 deadline, uint256 amount) public {
        vm.assume(deadline <= block.timestamp);
        vm.assume(amount > 0);

        try arb.initiateFlashLoan(
            address(usdc), amount, address(weth), 500,
            0, 0, 1, 1, deadline
        ) {
            assert(false);
        } catch (bytes memory reason) {
            assert(bytes4(reason) == FlashLoanArbitrage.DeadlineExpired.selector);
        }
    }

    /// minAmountOutFirst == 0  →  ZeroAmount
    function check_zeroMinAmountFirst_reverts(uint256 amount) public {
        vm.assume(amount > 0);

        try arb.initiateFlashLoan(
            address(usdc), amount, address(weth), 500,
            0, 0,
            0,   // minAmountOutFirst = 0
            1,
            block.timestamp + 1 hours
        ) {
            assert(false);
        } catch (bytes memory reason) {
            assert(bytes4(reason) == FlashLoanArbitrage.ZeroAmount.selector);
        }
    }

    // ========================================================================
    // 3. ARITHMETIC SAFETY
    //    Prove: the two unchecked subtractions in onMorphoFlashLoan cannot
    //    wrap around given their preceding guard checks.
    // ========================================================================

    /// Given the two guards that precede the unchecked blocks, neither
    /// subtraction can underflow.
    ///
    /// This is a standalone pure proof — no external calls, no state.
    function check_uncheckedSub_cannotUnderflow(
        uint256 finalBalance,
        uint256 startingBalance,
        uint256 loanAmount
    ) public pure {
        // ---- mirror the exact guards from onMorphoFlashLoan ----

        // Guard 1: if (finalBalance < startingBalance) revert InsufficientRepayment()
        if (finalBalance < startingBalance) return; // excluded by guard

        uint256 tradeBalance;
        unchecked { tradeBalance = finalBalance - startingBalance; }

        // Prove the subtraction was exact (no wrap)
        assert(tradeBalance == finalBalance - startingBalance);

        // Guard 2: if (tradeBalance < loanAmount) revert InsufficientRepayment()
        if (tradeBalance < loanAmount) return; // excluded by guard

        uint256 profit;
        unchecked { profit = tradeBalance - loanAmount; }

        // Prove the subtraction was exact
        assert(profit == tradeBalance - loanAmount);
        // Prove profit never exceeds tradeBalance (monotonicity)
        assert(profit <= tradeBalance);
    }

    /// The startingBalance correction (subtract the loan from the running balance)
    /// cannot underflow because the FlashLoanNotReceived check is first.
    function check_startingBalanceCorrection_cannotUnderflow(
        uint256 rawBalance,
        uint256 loanAmount
    ) public pure {
        // Guard: if (rawBalance < loanAmount) revert FlashLoanNotReceived()
        if (rawBalance < loanAmount) return;

        uint256 startingBalance;
        unchecked { startingBalance = rawBalance - loanAmount; }

        assert(startingBalance == rawBalance - loanAmount);
        assert(startingBalance <= rawBalance);
    }

    // ========================================================================
    // 4. MEV GUARDS
    //    block.number > validUntilBlock  →  BlockWindowExpired
    //
    //    Note: vm.txGasPrice is NOT supported by Halmos (it is a read-only
    //    opcode that Halmos cannot make symbolic).  The GasPriceTooHigh check
    //    is instead covered by testProtectedFlashLoanRevertsHighGasPrice in
    //    the unit test suite.
    // ========================================================================

    /// block.number > validUntilBlock  →  BlockWindowExpired
    function check_blockWindowGuard(uint256 currentBlock, uint256 validUntilBlock) public {
        vm.assume(validUntilBlock > 0);
        vm.assume(currentBlock > validUntilBlock);
        vm.roll(currentBlock);

        try arb.initiateProtectedFlashLoan(
            address(usdc), 1_000e6, address(weth), 500,
            0, 0, 1, 1,
            block.timestamp + 1 hours,
            0, 0, validUntilBlock
        ) {
            assert(false);
        } catch (bytes memory reason) {
            assert(bytes4(reason) == FlashLoanArbitrage.BlockWindowExpired.selector);
        }
    }

    // ========================================================================
    // 5. CONSTRUCTOR IMMUTABILITY
    //    Prove: the immutable addresses set in the constructor are exactly the
    //    ones passed in — no aliasing, truncation, or silent fallback.
    // ========================================================================

    function check_constructor_setsImmutables(
        address morphoAddr,
        address uniAddr,
        address sushiAddr
    ) public {
        vm.assume(morphoAddr != address(0));
        vm.assume(uniAddr    != address(0));
        vm.assume(sushiAddr  != address(0));

        FlashLoanArbitrage a = new FlashLoanArbitrage(morphoAddr, uniAddr, sushiAddr);

        assert(address(a.MORPHO())         == morphoAddr);
        assert(address(a.UNISWAP_ROUTER()) == uniAddr);
        assert(address(a.SUSHI_ROUTER())   == sushiAddr);
        assert(a.owner()                   == address(this));
    }
}
