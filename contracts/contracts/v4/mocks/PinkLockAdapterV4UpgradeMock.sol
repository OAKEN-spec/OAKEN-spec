// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import { PinkLockAdapterV4 } from "../PinkLockAdapterV4.sol";

/**
 * Upgrade-test implementation for the adapter. It keeps the v4 storage layout
 * (vault in slot 0, the two indexes, the guard) and appends one field, so a
 * proxy upgrade must leave the vault address and the per-token/per-owner
 * indexes intact.
 */
contract PinkLockAdapterV4UpgradeMock is PinkLockAdapterV4 {
    uint256 public probe;

    function setProbe(uint256 value) external {
        probe = value;
    }

    function version() external pure override returns (string memory) {
        return "v4.1-mock";
    }
}
