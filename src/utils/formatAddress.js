/**
 * Format a blockchain address for display
 * 
 * Truncates a long address to show first and last characters
 * Example: 0x1234...5678
 * 
 * @param {string} address - The full blockchain address
 * @param {number} startChars - Number of characters to show at the start (default: 6)
 * @param {number} endChars - Number of characters to show at the end (default: 4)
 * @returns {string} Formatted address
 */
export function formatAddress(address, startChars = 6, endChars = 4) {
  if (!address) return '';
  if (address.length <= startChars + endChars) return address;
  
  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
}

/**
 * Format a blockchain transaction hash for display
 * 
 * @param {string} hash - The transaction hash
 * @param {number} startChars - Number of characters to show at the start (default: 8)
 * @param {number} endChars - Number of characters to show at the end (default: 6)
 * @returns {string} Formatted hash
 */
export function formatHash(hash, startChars = 8, endChars = 6) {
  return formatAddress(hash, startChars, endChars);
}

/**
 * Format a balance value with proper decimal places
 * 
 * @param {string|number} balance - The balance value
 * @param {number} decimals - Number of decimal places (default: 4)
 * @returns {string} Formatted balance
 */
export function formatBalance(balance, decimals = 4) {
  if (!balance) return '0';
  const num = typeof balance === 'string' ? parseFloat(balance) : balance;
  return num.toFixed(decimals);
}

/**
 * Get chain name from chain ID
 * 
 * @param {number} chainId - The chain ID
 * @returns {string} Chain name
 */
export function getChainName(chainId) {
  const chains = {
    1: 'Ethereum',
    5: 'Goerli',
    11155111: 'Sepolia',
    137: 'Polygon',
    80002: 'Polygon Amoy',
  };
  
  return chains[chainId] || 'Unknown Network';
}



