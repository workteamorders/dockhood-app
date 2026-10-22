// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {FeeSplitter} from "../src/FeeSplitter.sol";

contract MockFeeToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract MockFeeEscrow {
    using SafeERC20 for IERC20;

    mapping(address => uint256) public nativeCredit;
    mapping(address => mapping(address => uint256)) public tokenCredit;

    function credit(address recipient) external payable {
        nativeCredit[recipient] += msg.value;
    }

    function creditToken(address recipient, address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        tokenCredit[recipient][token] += amount;
    }

    function claim() external {
        uint256 amount = nativeCredit[msg.sender];
        require(amount > 0, "no credit");
        nativeCredit[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "transfer failed");
    }

    function claimToken(address token) external {
        uint256 amount = tokenCredit[msg.sender][token];
        require(amount > 0, "no credit");
        tokenCredit[msg.sender][token] = 0;
        IERC20(token).safeTransfer(msg.sender, amount);
    }
}

contract FeeSplitterEscrowTest is Test {
    FeeSplitter splitter;
    MockFeeEscrow escrow;
    MockFeeToken token;
    address owner = makeAddr("owner");
    address payable operator = payable(makeAddr("operator"));
    address payable pool = payable(makeAddr("pool"));
    address recipient = makeAddr("recipient");

    function setUp() public {
        splitter = new FeeSplitter(owner, operator, pool);
        escrow = new MockFeeEscrow();
        token = new MockFeeToken();
    }

    function test_claimsNativeCreditAsSplitterThenDistributes30PercentToPool() public {
        vm.deal(address(this), 1 ether);
        escrow.credit{value: 1 ether}(address(splitter));

        vm.prank(owner);
        vm.expectRevert(bytes("no credit"));
        escrow.claim();

        vm.prank(owner);
        splitter.claimEscrow(address(escrow), address(0));
        assertEq(escrow.nativeCredit(address(splitter)), 0);
        assertEq(address(escrow).balance, 0);
        assertEq(address(splitter).balance, 1 ether);
        assertEq(pool.balance, 0);
        assertEq(operator.balance, 0);

        splitter.distributeFee();
        assertEq(pool.balance, 0.3 ether);
        assertEq(operator.balance, 0.7 ether);
        assertEq(address(splitter).balance, 0);
    }

    function test_claimsTokenCreditWithoutAutomaticDistributionAndRecoversIt() public {
        token.mint(address(this), 100 ether);
        token.approve(address(escrow), 100 ether);
        escrow.creditToken(address(splitter), address(token), 100 ether);

        vm.prank(owner);
        vm.expectRevert(bytes("no credit"));
        escrow.claimToken(address(token));

        vm.prank(owner);
        splitter.claimEscrow(address(escrow), address(token));
        assertEq(escrow.tokenCredit(address(splitter), address(token)), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.balanceOf(address(splitter)), 100 ether);
        assertEq(token.balanceOf(pool), 0);
        assertEq(token.balanceOf(operator), 0);
        vm.expectRevert(FeeSplitter.NothingToDistribute.selector);
        splitter.distributeFee();

        vm.prank(owner);
        splitter.recoverToken(address(token), recipient, 40 ether);
        assertEq(token.balanceOf(recipient), 40 ether);
        assertEq(token.balanceOf(address(splitter)), 60 ether);
    }

    function test_recoversVestedTokensDeliveredDirectlyWithoutMovingNativeBalance() public {
        token.mint(address(splitter), 10 ether);
        vm.deal(address(splitter), 1 ether);
        vm.prank(owner);
        splitter.recoverToken(address(token), recipient, 10 ether);
        assertEq(token.balanceOf(recipient), 10 ether);
        assertEq(token.balanceOf(address(splitter)), 0);
        assertEq(address(splitter).balance, 1 ether);
    }

    function test_onlyOwnerCanClaimOrRecover() public {
        bytes memory unauthorized = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this));
        vm.expectRevert(unauthorized);
        splitter.claimEscrow(address(escrow), address(0));
        vm.expectRevert(unauthorized);
        splitter.claimEscrow(address(escrow), address(token));
        vm.expectRevert(unauthorized);
        splitter.recoverToken(address(token), recipient, 1);
    }

    function test_rejectsZeroEscrowTokenAndRecoveryRecipient() public {
        vm.startPrank(owner);
        vm.expectRevert(FeeSplitter.ZeroAddress.selector);
        splitter.claimEscrow(address(0), address(0));
        vm.expectRevert(FeeSplitter.ZeroAddress.selector);
        splitter.claimEscrow(address(0), address(token));
        vm.expectRevert(FeeSplitter.ZeroAddress.selector);
        splitter.recoverToken(address(0), recipient, 1);
        vm.expectRevert(FeeSplitter.ZeroAddress.selector);
        splitter.recoverToken(address(token), address(0), 1);
        vm.stopPrank();
    }

    function test_propagatesEscrowClaimFailures() public {
        vm.startPrank(owner);
        vm.expectRevert(bytes("no credit"));
        splitter.claimEscrow(address(escrow), address(0));
        vm.expectRevert(bytes("no credit"));
        splitter.claimEscrow(address(escrow), address(token));
        vm.stopPrank();
    }

    function test_recoveryRejectsFalseReturningToken() public {
        token.mint(address(splitter), 10 ether);
        vm.mockCall(address(token), abi.encodeCall(IERC20.transfer, (recipient, 10 ether)), abi.encode(false));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(token)));
        splitter.recoverToken(address(token), recipient, 10 ether);
        assertEq(token.balanceOf(address(splitter)), 10 ether);
        assertEq(token.balanceOf(recipient), 0);
    }
}
