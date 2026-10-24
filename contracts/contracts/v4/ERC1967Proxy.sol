// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/**
 * @title ERC1967Proxy
 * @notice Minimal transparent proxy. The implementation address and the admin
 *         live in the two ERC1967 storage slots, so they can never collide with
 *         the implementation's own storage (which starts at slot 0).
 *
 * ## Rules
 *
 * - Only the admin may call `admin`, `implementation`, `changeAdmin`,
 *   `upgradeTo` or `upgradeToAndCall`.
 * - Everybody else is delegated to the implementation.
 * - The admin is **not** delegated: an admin call that is not one of the five
 *   functions above reverts instead of silently hitting implementation code.
 *   This is the "transparent" half of the pattern.
 *
 * ## Why there is no `receive` in the implementation
 *
 * The vault and the adapter have no ETH-receive path. A plain transfer to the
 * proxy therefore ends in the implementation's fallback, which reverts. The
 * proxy itself can hold ETH only if a future implementation adds a receive.
 *
 * ## Upgrade safety
 *
 * The implementation must keep the ERC1967 slots untouched and must preserve
 * its own storage layout across versions. The v4 files document their layout;
 * the upgrade test deploys a mock that adds a field and checks that existing
 * locks survive.
 */
contract ERC1967Proxy {
    /* keccak256("eip1967.proxy.implementation") - 1 */
    bytes32 private constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    /* keccak256("eip1967.proxy.admin") - 1 */
    bytes32 private constant ADMIN_SLOT =
        0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    event Upgraded(address indexed implementation);
    event AdminChanged(address previousAdmin, address newAdmin);

    error NotAdmin();
    error ZeroAddress();
    error InitializationFailed();

    /**
     * @param admin_          The delayed ProxyAdmin (a contract, not an EOA).
     * @param implementation_ The first implementation.
     * @param data_           Optional initializer calldata, executed in the
     *                        proxy's storage before the proxy is usable.
     */
    constructor(address admin_, address implementation_, bytes memory data_) payable {
        if (admin_ == address(0) || implementation_ == address(0)) revert ZeroAddress();
        _setAdmin(admin_);
        _setImplementation(implementation_);
        if (data_.length != 0) {
            (bool ok,) = implementation_.delegatecall(data_);
            if (!ok) revert InitializationFailed();
        }
    }

    modifier onlyAdmin() {
        if (msg.sender != _getAdmin()) revert NotAdmin();
        _;
    }

    function admin() external onlyAdmin returns (address) {
        return _getAdmin();
    }

    function implementation() external onlyAdmin returns (address) {
        return _getImplementation();
    }

    function changeAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        address previous = _getAdmin();
        _setAdmin(newAdmin);
        emit AdminChanged(previous, newAdmin);
    }

    function upgradeTo(address newImplementation) external onlyAdmin {
        if (newImplementation == address(0)) revert ZeroAddress();
        _setImplementation(newImplementation);
        emit Upgraded(newImplementation);
    }

    function upgradeToAndCall(address newImplementation, bytes calldata data)
        external
        payable
        onlyAdmin
    {
        if (newImplementation == address(0)) revert ZeroAddress();
        _setImplementation(newImplementation);
        (bool ok,) = newImplementation.delegatecall(data);
        if (!ok) revert InitializationFailed();
        emit Upgraded(newImplementation);
    }

    fallback() external payable {
        if (msg.sender == _getAdmin()) revert NotAdmin();
        _delegate(_getImplementation());
    }

    receive() external payable {
        if (msg.sender == _getAdmin()) revert NotAdmin();
        _delegate(_getImplementation());
    }

    function _getAdmin() private view returns (address a) {
        assembly {
            a := sload(ADMIN_SLOT)
        }
    }

    function _setAdmin(address a) private {
        assembly {
            sstore(ADMIN_SLOT, a)
        }
    }

    function _getImplementation() private view returns (address impl) {
        assembly {
            impl := sload(IMPLEMENTATION_SLOT)
        }
    }

    function _setImplementation(address impl) private {
        assembly {
            sstore(IMPLEMENTATION_SLOT, impl)
        }
    }

    function _delegate(address impl) private {
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
