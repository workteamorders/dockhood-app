// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IFeeEscrow {
    function claim() external;
    function claimToken(address token) external;
}

/// @title hood.exe fee splitter
/// @notice Splits fee income between the verification pool and the operator. ETH can be sent with distributeFee() or
/// beforehand (e.g. as a coin's creator-fee recipient); each distributeFee() call splits the whole balance.
contract FeeSplitter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Safety cap: never more than half of the fees to the pool.
    uint16 public constant MAX_POOL_BPS = 5_000;

    address payable public operatorWallet;
    address payable public verificationPool;
    /// @notice The pool's share in basis points (3000 = 30%).
    uint16 public poolBps = 3_000;

    event FeeDistributed(uint256 poolAmount, uint256 operatorAmount);
    event PoolBpsSet(uint16 poolBps);
    event OperatorWalletSet(address indexed operatorWallet);
    event VerificationPoolSet(address indexed verificationPool);

    error ZeroAddress();
    error BpsTooHigh();
    error NothingToDistribute();
    error TransferFailed();

    constructor(address owner_, address payable operator_, address payable pool_) Ownable(owner_) {
        if (operator_ == address(0) || pool_ == address(0)) revert ZeroAddress();
        operatorWallet = operator_;
        verificationPool = pool_;
    }

    receive() external payable {}

    /// @notice Claims this splitter's escrow credit; address(0) selects native ETH. Distribution is separate.
    function claimEscrow(address escrow, address token) external onlyOwner nonReentrant {
        if (escrow == address(0)) revert ZeroAddress();
        if (token == address(0)) IFeeEscrow(escrow).claim();
        else IFeeEscrow(escrow).claimToken(token);
    }

    /// @notice Recovers ERC20 fees or vested tokens. No token conversion or ERC20 pool distribution is automated.
    function recoverToken(address token, address recipient, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0) || recipient == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(recipient, amount);
    }

    /// @notice Splits everything this contract holds (including msg.value) between the pool and the operator.
    function distributeFee() external payable nonReentrant {
        uint256 amount = address(this).balance;
        if (amount == 0) revert NothingToDistribute();
        uint256 poolAmount = (amount * poolBps) / 10_000;
        uint256 operatorAmount = amount - poolAmount;
        emit FeeDistributed(poolAmount, operatorAmount);
        (bool a,) = verificationPool.call{value: poolAmount}("");
        (bool b,) = operatorWallet.call{value: operatorAmount}("");
        if (!a || !b) revert TransferFailed();
    }

    function setPoolBps(uint16 newBps) external onlyOwner {
        if (newBps > MAX_POOL_BPS) revert BpsTooHigh();
        poolBps = newBps;
        emit PoolBpsSet(newBps);
    }

    function setOperatorWallet(address payable operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operatorWallet = operator_;
        emit OperatorWalletSet(operator_);
    }

    function setVerificationPool(address payable pool_) external onlyOwner {
        if (pool_ == address(0)) revert ZeroAddress();
        verificationPool = pool_;
        emit VerificationPoolSet(pool_);
    }
}
