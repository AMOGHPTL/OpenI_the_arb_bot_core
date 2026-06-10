// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FlashLoanArbitrage.sol";
import "./mocks/MockERC20.sol";
import "./mocks/MockMorpho.sol";
import "./mocks/MockUniswapRouter.sol";
import "./mocks/MockSushiRouter.sol";

// ---------------------------------------------------------------------------
// Handler — the fuzzer calls functions on this contract in random order.
// It owns the arb contract so it can legitimately call owner-only functions,
// and also simulates adversarial callers.
// ---------------------------------------------------------------------------
contract Handler is Test {
    FlashLoanArbitrage public immutable arb;
    MockERC20          public immutable usdc;
    MockERC20          public immutable weth;
    MockMorpho         public immutable morpho;
    MockUniswapRouter  public immutable uni;
    MockSushiRouter    public immutable sushi;

    // Ghost variables — track aggregate state for conservation invariants
    uint256 public ghost_totalProfit;    // USDC earned by arb via profitable trades
    uint256 public ghost_totalOutflow;   // USDC that left the arb contract (withdraw + rescue)
    bool    public ghost_accessViolated; // true if any non-owner call succeeded

    constructor() {
        usdc   = new MockERC20("USDC", "USDC", 6);
        weth   = new MockERC20("WETH", "WETH", 18);
        morpho = new MockMorpho();
        uni    = new MockUniswapRouter();
        sushi  = new MockSushiRouter();

        // Handler deploys arb — so handler IS the owner
        arb = new FlashLoanArbitrage(address(morpho), address(uni), address(sushi));

        // Seed liquidity pools
        usdc.mint(address(morpho), 10_000_000e6);
        usdc.mint(address(uni),     1_000_000e6);
        weth.mint(address(uni),     1_000_000 ether);
        usdc.mint(address(sushi),   1_000_000e6);
        weth.mint(address(sushi),   1_000_000 ether);
    }

    // -----------------------------------------------------------------------
    // Owner actions
    // -----------------------------------------------------------------------

    /// Randomise exchange rates (1–300 % output per unit in).
    /// Rates below 100 produce unprofitable trades; above 100 produce profit.
    function setRates(uint256 uniRate, uint256 sushiRate) external {
        uni.setMultiplier(bound(uniRate,   1, 300));
        sushi.setMultiplier(bound(sushiRate, 1, 300));
    }

    /// Attempt a flash-loan arb. Catches all reverts so the fuzzer keeps running.
    function doFlashLoan(uint256 amount, uint8 direction) public {
        amount    = bound(amount,    1e6, 1_000e6);
        direction = uint8(bound(direction, 0, 1));

        uint256 balBefore = usdc.balanceOf(address(arb));

        try arb.initiateFlashLoan(
            address(usdc), amount, address(weth), 3000,
            0, direction, 1, 1,
            block.timestamp + 1 hours
        ) {
            uint256 balAfter = usdc.balanceOf(address(arb));
            // Only count genuine profit (balance increase)
            if (balAfter > balBefore) ghost_totalProfit += balAfter - balBefore;
        } catch {}
    }

    /// Owner withdraws all profit.
    function doWithdraw() external {
        uint256 bal = usdc.balanceOf(address(arb));
        if (bal == 0) return;
        arb.withdrawProfit(address(usdc));
        ghost_totalOutflow += bal;
    }

    /// Owner rescues a partial amount.
    function doRescue(uint256 amount) external {
        uint256 bal = usdc.balanceOf(address(arb));
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        arb.rescueTokens(address(usdc), amount);
        ghost_totalOutflow += amount;
    }

    /// Owner revokes an approval then the next trade re-approves via the
    /// cached-approval path — exercises the approve/revoke cycle.
    function doRevokeAndRetrade(bool revokeUsdc, bool revokeUni) external {
        address token   = revokeUsdc ? address(usdc) : address(weth);
        address spender = revokeUni  ? address(uni)   : address(sushi);
        arb.revokeApproval(token, spender);

        // Immediately follow up with a trade so the approval is lazily re-granted
        doFlashLoan(100e6, 0);
    }

    // -----------------------------------------------------------------------
    // Adversarial actions — must NEVER succeed
    // -----------------------------------------------------------------------

    /// Arbitrary address tries every owner-only entry point.
    function trySteal(address attacker) external {
        if (
            attacker == address(0)    ||
            attacker == address(arb)  ||
            attacker == address(this) // handler is owner
        ) return;

        uint256 bal = usdc.balanceOf(address(arb));

        vm.startPrank(attacker);

        try arb.withdrawProfit(address(usdc))
            { ghost_accessViolated = true; } catch {}

        if (bal > 0) {
            try arb.rescueTokens(address(usdc), bal)
                { ghost_accessViolated = true; } catch {}
        }

        try arb.initiateFlashLoan(
            address(usdc), 1e6, address(weth), 3000,
            0, 0, 1, 1, block.timestamp + 1 hours
        )   { ghost_accessViolated = true; } catch {}

        try arb.revokeApproval(address(usdc), address(uni))
            { ghost_accessViolated = true; } catch {}

        vm.stopPrank();
    }

    /// Arbitrary address tries to trigger the flash-loan callback directly
    /// (re-entrancy / OnlyMorpho bypass attempt).
    function tryCallbackDirect(address attacker, uint256 amount) external {
        if (attacker == address(morpho)) return; // morpho is allowed
        amount = bound(amount, 1, 1_000e6);

        vm.prank(attacker);
        try arb.onMorphoFlashLoan(amount, bytes(""))
            { ghost_accessViolated = true; } catch {}
    }
}

// ---------------------------------------------------------------------------
// Invariant test — properties that must hold after ANY sequence of calls
// ---------------------------------------------------------------------------
contract FlashLoanArbitrageInvariantTest is Test {
    Handler internal h;

    uint256 internal morphoSeedBalance;
    uint256 internal totalUsdcSupply;

    function setUp() public {
        h = new Handler();

        morphoSeedBalance = h.usdc().balanceOf(address(h.morpho()));
        totalUsdcSupply   = h.usdc().totalSupply();

        targetContract(address(h));
    }

    // 1. Ownership can never be hijacked
    function invariant_ownerIsAlwaysHandler() public view {
        assertEq(h.arb().owner(), address(h), "owner changed");
    }

    // 2. No unauthorised address ever succeeded in calling a restricted function
    function invariant_accessControlNeverBroken() public view {
        assertFalse(h.ghost_accessViolated(), "access control violated");
    }

    // 3. Immutable constructor arguments never change
    function invariant_addressesAreImmutable() public view {
        assertEq(address(h.arb().MORPHO()),         address(h.morpho()), "morpho changed");
        assertEq(address(h.arb().UNISWAP_ROUTER()), address(h.uni()),    "uni changed");
        assertEq(address(h.arb().SUSHI_ROUTER()),   address(h.sushi()),  "sushi changed");
    }

    // 4. Morpho is always made whole — every flash loan is repaid in full
    //    or the entire tx reverts, leaving Morpho's balance unchanged.
    function invariant_morphoAlwaysRepaid() public view {
        assertGe(
            h.usdc().balanceOf(address(h.morpho())),
            morphoSeedBalance,
            "morpho lost funds"
        );
    }

    // 5. USDC total supply never changes — no tokens are minted or burned
    //    during swaps (catches any mock or contract that mints/burns unexpectedly)
    function invariant_usdcSupplyConserved() public view {
        assertEq(h.usdc().totalSupply(), totalUsdcSupply, "USDC supply changed");
    }

    // 6. The arb contract's balance is exactly what was earned minus what
    //    was withdrawn/rescued.  Proves profit accounting is leak-free.
    function invariant_arbBalanceAccountedFor() public view {
        uint256 held = h.usdc().balanceOf(address(h.arb()));
        assertEq(
            held,
            h.ghost_totalProfit() - h.ghost_totalOutflow(),
            "arb balance inconsistent with profit accounting"
        );
    }

    // 7. The arb contract never accumulates ETH it wasn't sent
    function invariant_noSpuriousEth() public view {
        assertEq(address(h.arb()).balance, 0, "unexpected ETH in contract");
    }
}
