// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import { LockVaultV2 } from "../v2/LockVaultV2.sol";

/**
 * A token whose `transferFrom` re-enters `createLock` once.
 *
 * The Foundry PoC (`test/foundry/ReentrancyPoC.t.sol`) proves the v1 bug and
 * the v2 fix without Hardhat. This mock exists so the **Hardhat** suite (and
 * therefore the coverage report) also executes the v2 guard's revert branch,
 * instead of the production path showing 0% coverage.
 *
 * Not deployed anywhere. Test-only.
 */
contract MockReentrantToken {
    string public name = "Reentrant";
    string public symbol = "RE";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    LockVaultV2 public vault;
    bool public armed;
    bool private inHook;
    uint256 public reenterAmount;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function arm(LockVaultV2 v, uint256 amount) external {
        vault = v;
        reenterAmount = amount;
        armed = true;
        allowance[address(this)][address(v)] = type(uint256).max;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;

        if (armed && !inHook) {
            armed = false;
            inHook = true;
            vault.createLock(LockVaultV2.CreateParams({
                token: address(this),
                amount: reenterAmount,
                beneficiary: address(this),
                agent: address(0),
                startTime: 1,
                cliffTime: 1,
                endTime: 1,
                initialUnlockBps: 0,
                steps: 0,
                revocable: false,
                transferable: true,
                label: bytes32("inner")
            }));
            inHook = false;
        }
        return true;
    }
}
