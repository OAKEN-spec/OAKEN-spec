// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title CurveDeployer
 * @notice Minimal CREATE2 deployer used to place the graduation adapter at an
 * address whose low bits carry the Uniswap V4 hook permission flags.
 *
 * V4 reads hook permissions from the address, so the adapter must be mined,
 * not deployed with `new`. This helper does nothing else: it takes a salt and
 * init code and returns the address CREATE2 produced.
 */
contract CurveDeployer {
    event Deployed(address indexed addr, bytes32 salt);

    error DeployFailed();

    function predict(bytes32 salt, bytes calldata initCode) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(initCode))))));
    }

    function deploy(bytes32 salt, bytes calldata initCode) external returns (address addr) {
        // Copy to memory so the CREATE2 init-code pointer is unambiguous: for a
        // memory `bytes`, the pointer is the length word and the code starts 32
        // bytes later. (`calldata` offsets differ between compiler versions and
        // are exactly the kind of silent mismatch that changes the address.)
        bytes memory code = initCode;
        assembly {
            addr := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (addr == address(0)) revert DeployFailed();
        emit Deployed(addr, salt);
    }
}
