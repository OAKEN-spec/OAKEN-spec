// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title MockPosition
 * @notice Minimal ERC-721 standing in for a Uniswap V3/V4 position manager.
 *
 * Only the surface the escrow touches: `ownerOf`, `transferFrom` with the
 * standard owner-or-approved authorisation, and single-token approvals. Kept
 * small on purpose — the points worth testing are the escrow's behaviour, not
 * this mock's, and a mock that quietly got authorisation wrong would make the
 * escrow's tests pass for the wrong reason.
 *
 * `transferFrom` clears the single-token approval on transfer, as the standard
 * requires, and deliberately leaves `isApprovedForAll` operators alone. That
 * asymmetry is the hazard documented in PositionLock's header, so the mock
 * reproduces it rather than smoothing it over.
 */
contract MockPosition {
    string public name = "Mock Positions NFT";
    string public symbol = "MOCKPOS";
    uint256 public totalSupply;

    mapping(uint256 => address) private _owners;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    function mint(address to, uint256 tokenId) external {
        require(_owners[tokenId] == address(0), "minted");
        _owners[tokenId] = to;
        totalSupply++;
    }

    function ownerOf(uint256 tokenId) external view returns (address owner) {
        owner = _owners[tokenId];
        require(owner != address(0), "nonexistent");
    }

    function approve(address to, uint256 tokenId) external {
        address owner = _owners[tokenId];
        require(msg.sender == owner || _operatorApprovals[owner][msg.sender], "not authorized");
        _tokenApprovals[tokenId] = to;
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(from == _owners[tokenId], "wrong from");
        require(
            msg.sender == from ||
                msg.sender == _tokenApprovals[tokenId] ||
                _operatorApprovals[from][msg.sender],
            "not authorized"
        );
        require(to != address(0), "zero to");

        // The standard clears the single-token approval on any transfer and
        // leaves operator approvals standing.
        delete _tokenApprovals[tokenId];
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    /**
     * Present so the collection behaves like a real one toward the escrow's
     * `transferFrom`-only return path; the escrow never calls it.
     */
    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        transferFrom(from, to, tokenId);
        if (to.code.length != 0) {
            require(
                IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, "") ==
                    0x150b7a02,
                "unsafe recipient"
            );
        }
    }

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
}

interface IERC721Receiver {
    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external returns (bytes4);
}
