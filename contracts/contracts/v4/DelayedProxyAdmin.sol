// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

interface IUpgradeableProxy {
    function upgradeTo(address newImplementation) external;
}

/**
 * @title DelayedProxyAdmin
 * @notice The admin of the v4 proxies. It cannot upgrade instantly: an upgrade
 *         is scheduled, waits `delay` (48 hours at deployment), and can be
 *         cancelled by the owner before it executes.
 *
 * The owner is a 2-of-3 multisig. The delay exists so users can see an upgrade
 * coming and exit if they disagree; it is not a governance vote.
 *
 * Two transactions are required:
 *   1. `scheduleUpgrade(proxy, implementation)` — owner (multisig) call
 *   2. after `eta`: `executeUpgrade(proxy)` — owner (multisig) call
 *
 * `cancelUpgrade` clears a pending upgrade. `setDelay` changes the delay for
 * future schedules only; an already-scheduled upgrade keeps its eta.
 */
contract DelayedProxyAdmin {
    address public owner;
    uint256 public delay;
    bool private _entered;

    struct Pending {
        address implementation;
        uint64 eta;
    }

    mapping(address => Pending) public pending;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event DelayChanged(uint256 previousDelay, uint256 newDelay);
    event UpgradeScheduled(address indexed proxy, address indexed implementation, uint64 eta);
    event UpgradeCancelled(address indexed proxy, address indexed implementation);
    event UpgradeExecuted(address indexed proxy, address indexed implementation);

    error NotOwner();
    error ZeroAddress();
    error NoUpgrade();
    error TooEarly(uint64 eta);
    error ReentrantCall();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_entered) revert ReentrantCall();
        _entered = true;
        _;
        _entered = false;
    }

    constructor(address owner_, uint256 delay_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        delay = delay_;
        emit OwnershipTransferred(address(0), owner_);
        emit DelayChanged(0, delay_);
    }

    function scheduleUpgrade(address proxy, address implementation) external onlyOwner {
        if (proxy == address(0) || implementation == address(0)) revert ZeroAddress();
        uint64 eta = uint64(block.timestamp) + uint64(delay);
        pending[proxy] = Pending({ implementation: implementation, eta: eta });
        emit UpgradeScheduled(proxy, implementation, eta);
    }

    function executeUpgrade(address proxy) external onlyOwner nonReentrant {
        Pending memory p = pending[proxy];
        if (p.implementation == address(0)) revert NoUpgrade();
        if (block.timestamp < p.eta) revert TooEarly(p.eta);
        delete pending[proxy];
        IUpgradeableProxy(proxy).upgradeTo(p.implementation);
        emit UpgradeExecuted(proxy, p.implementation);
    }

    function cancelUpgrade(address proxy) external onlyOwner {
        Pending memory p = pending[proxy];
        if (p.implementation == address(0)) revert NoUpgrade();
        delete pending[proxy];
        emit UpgradeCancelled(proxy, p.implementation);
    }

    function setDelay(uint256 newDelay) external onlyOwner {
        uint256 previous = delay;
        delay = newDelay;
        emit DelayChanged(previous, newDelay);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    function pendingUpgrade(address proxy) external view returns (address implementation, uint64 eta) {
        Pending memory p = pending[proxy];
        return (p.implementation, p.eta);
    }
}
