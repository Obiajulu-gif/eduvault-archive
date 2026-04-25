// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

/**
 * @title EduVault
 * @notice NFT contract for educational content marketplace
 * @dev Extends ERC721URIStorage with manual ownership enumeration via _ownedTokens.
 *
 * OWNERSHIP ENUMERATION TRADEOFF:
 * - The _ownedTokens mapping maintains a list of token IDs per owner for efficient
 *   off-chain queries (e.g., "show all materials owned by user X").
 * - Removal from the list uses O(n) linear scan on transfers, which is acceptable
 *   because:
 *   1. Educational material NFTs are rarely transferred after minting
 *   2. Typical user token counts are small (< 100)
 *   3. Gas costs remain reasonable for expected usage patterns
 *   4. No external enumeration standard (like ERC721Enumerable) is required
 * - For high-transfer-volume use cases, consider replacing with ERC721Enumerable
 *   or an off-chain indexer.
 */
contract EduVault is ERC721URIStorage {
    uint256 private _nextTokenId;

    // Mapping from owner to list of owned token IDs
    // INVARIANT: For each address `owner`, _ownedTokens[owner] contains exactly
    // the set of non-burned token IDs where ownerOf(tokenId) == owner.
    mapping(address => uint256[]) private _ownedTokens;

    // Track position of each token in owner's array for O(1) removal
    // INVARIANT: _ownedTokensIndex[tokenId] is the index in _ownedTokens[ownerOf(tokenId)]
    mapping(uint256 => uint256) private _ownedTokensIndex;

    constructor() ERC721("EduVault", "EDV") {}

    /**
     * @notice Mint a new educational material NFT
     * @param uri IPFS or HTTP URI pointing to material metadata
     */
    function mint(string memory uri) external {
        uint256 tokenId = _nextTokenId;
        _nextTokenId += 1;

        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, uri);
    }

    /**
     * @notice Get all token IDs owned by a specific address
     * @param owner Address to query
     * @return Array of token IDs owned by the address
     */
    function tokensOfOwner(address owner) external view returns (uint256[] memory) {
        return _ownedTokens[owner];
    }

    /**
     * @notice Get total number of tokens minted
     * @return Total minted token count
     */
    function totalMinted() external view returns (uint256) {
        return _nextTokenId;
    }

    /**
     * @dev Override to maintain ownership enumeration on transfers.
     * Uses O(1) removal via index tracking instead of O(n) scan.
     *
     * INVARIANTS MAINTAINED:
     * - After transfer, old owner's list no longer contains tokenId
     * - After transfer, new owner's list contains tokenId at correct index
     * - Index mapping is updated to reflect new position
     * - Zero-address transfers (burns) properly clean up ownership list
     */
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = super._update(to, tokenId, auth);

        if (from != address(0)) {
            // Remove token from old owner list using O(1) swap-and-pop
            uint256[] storage fromTokens = _ownedTokens[from];
            uint256 tokenIndex = _ownedTokensIndex[tokenId];
            uint256 lastIndex = fromTokens.length - 1;

            // If the token is not the last one, swap it with the last token
            if (tokenIndex != lastIndex) {
                uint256 lastTokenId = fromTokens[lastIndex];
                fromTokens[tokenIndex] = lastTokenId;
                _ownedTokensIndex[lastTokenId] = tokenIndex; // Update index of moved token
            }

            // Remove the last element and clean up index
            fromTokens.pop();
            delete _ownedTokensIndex[tokenId];
        }

        if (to != address(0)) {
            // Add token to new owner list
            uint256 newIndex = _ownedTokens[to].length;
            _ownedTokens[to].push(tokenId);
            _ownedTokensIndex[tokenId] = newIndex;
        }

        return from;
    }
}
