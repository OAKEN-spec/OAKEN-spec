// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {OakenToken} from "../../OakenToken.sol";
import {OakenTaxToken} from "../OakenTaxToken.sol";

/**
 * @title OakenFlapTokenDeployer
 * @notice Deploys the two token kinds for the Flap-model factory.
 *
 * Split out so the factory's runtime stays under EIP-170: the tax token's
 * creation code alone would push it over. Only the bound factory may call
 * either deploy function; the binding is one-shot.
 */
contract OakenFlapTokenDeployer {
    address public immutable binder;
    address public factory;

    error NotBinder();
    error AlreadyBound();
    error NotFactory();

    constructor(address binder_) {
        if (binder_ == address(0)) revert NotBinder();
        binder = binder_;
    }

    function bindFactory(address factory_) external {
        if (msg.sender != binder) revert NotBinder();
        if (factory != address(0)) revert AlreadyBound();
        if (factory_ == address(0)) revert NotFactory();
        factory = factory_;
    }

    function deployStandard(bytes32 salt, string calldata name, string calldata symbol, uint256 supply, address curve)
        external
        returns (address)
    {
        if (msg.sender != factory) revert NotFactory();
        return address(new OakenToken{salt: salt}(name, symbol, 18, supply, curve));
    }

    function deployTax(bytes32 salt, OakenTaxToken.Init calldata init) external returns (address) {
        if (msg.sender != factory) revert NotFactory();
        return address(new OakenTaxToken{salt: salt}(init));
    }
}
