// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import { LockVaultV4 } from "../LockVaultV4.sol";

/**
 * Upgrade-test implementation. It inherits the v4 storage layout, adds one
 * field at the end, and reports a different version. If the proxy upgrade is
 * correct, existing locks and `nextLockId` survive this upgrade unchanged.
 */
contract LockVaultV4UpgradeMock is LockVaultV4 {
    uint256 public probe;

    function setProbe(uint256 value) external {
        probe = value;
    }

    function version() external pure override returns (string memory) {
        return "v4.1-mock";
    }
}
