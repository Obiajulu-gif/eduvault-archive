/**
 * Stellar Account Metadata Fetcher
 * 
 * Fetches on-chain account metadata from Horizon and federation servers.
 * Handles unfunded accounts (404) gracefully without throwing.
 */

import { Horizon, StrKey } from '@stellar/stellar-sdk';

const HORIZON_URL = process.env.NEXT_PUBLIC_HORIZON_URL || 'https://horizon.stellar.org';

export interface StellarAccountMeta {
  publicKey: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  exists: boolean;
  dataEntries: Record<string, string>;
}

/**
 * Validates a Stellar public key using the SDK
 */
export function isValidStellarKey(key: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(key);
  } catch {
    return false;
  }
}

/**
 * Decodes base64 data entries from Horizon account data_attr
 */
function decodeDataEntries(dataAttr: Record<string, string>): Record<string, string> {
  const decoded: Record<string, string> = {};
  for (const [key, value] of Object.entries(dataAttr)) {
    try {
      // Horizon returns base64-encoded values
      decoded[key] = Buffer.from(value, 'base64').toString('utf-8');
    } catch {
      decoded[key] = value; // Fallback to raw value if decoding fails
    }
  }
  return decoded;
}

/**
 * Attempts to fetch federation record for a home domain
 */
async function fetchFederationRecord(
  publicKey: string,
  homeDomain: string
): Promise<{ name: string | null; avatarUrl: string | null }> {
  try {
    // Try federation server from home domain
    const federationUrl = `https://${homeDomain}/.well-known/stellar.toml`;
    const tomlResponse = await fetch(federationUrl, {
      method: 'GET',
      headers: { Accept: 'text/plain' },
    });

    if (!tomlResponse.ok) {
      return { name: null, avatarUrl: null };
    }

    const tomlText = await tomlResponse.text();
    
    // Parse TOML for FEDERATION_SERVER
    const federationMatch = tomlText.match(/FEDERATION_SERVER\s*=\s*"([^"]+)"/);
    if (!federationMatch) {
      return { name: null, avatarUrl: null };
    }

    const federationServer = federationMatch[1];
    
    // Query federation server
    const fedResponse = await fetch(
      `${federationServer}?type=id&q=${encodeURIComponent(publicKey)}`,
      { headers: { Accept: 'application/json' } }
    );

    if (!fedResponse.ok) {
      return { name: null, avatarUrl: null };
    }

    const fedData = await fedResponse.json();
    
    return {
      name: fedData.memo || fedData.name || null,
      avatarUrl: fedData.memo || fedData.avatar || null,
    };
  } catch {
    return { name: null, avatarUrl: null };
  }
}

/**
 * Extracts metadata from account data entries
 */
function extractMetadataFromEntries(
  entries: Record<string, string>
): { displayName: string | null; bio: string | null; avatarUrl: string | null } {
  // Check for eduvault-prefixed keys first (our namespace)
  const displayName = entries['eduvault:name'] || entries['name'] || null;
  const bio = entries['eduvault:bio'] || entries['bio'] || null;
  const avatarUrl = entries['eduvault:avatar'] || entries['avatar'] || null;

  return { displayName, bio, avatarUrl };
}

/**
 * Fetches Stellar account metadata from Horizon
 * 
 * @param publicKey - The Stellar public key (G... address)
 * @returns StellarAccountMeta with on-chain metadata
 */
export async function fetchStellarAccountMeta(
  publicKey: string
): Promise<StellarAccountMeta> {
  // Validate public key format
  if (!isValidStellarKey(publicKey)) {
    return {
      publicKey,
      displayName: null,
      bio: null,
      avatarUrl: null,
      exists: false,
      dataEntries: {},
    };
  }

  const horizon = new Horizon.Server(HORIZON_URL);

  try {
    const account = await horizon.loadAccount(publicKey);

    // Decode all data entries
    const dataEntries = account.data_attr ? decodeDataEntries(account.data_attr) : {};

    // Extract metadata from data entries
    let { displayName, bio, avatarUrl } = extractMetadataFromEntries(dataEntries);

    // If home_domain is set, try federation lookup
    if (account.home_domain && (!displayName || !avatarUrl)) {
      const fedRecord = await fetchFederationRecord(publicKey, account.home_domain);
      displayName = displayName || fedRecord.name;
      avatarUrl = avatarUrl || fedRecord.avatarUrl;
    }

    return {
      publicKey,
      displayName,
      bio,
      avatarUrl,
      exists: true,
      dataEntries,
    };
  } catch (err: any) {
    // Handle unfunded account (404)
    const status = err?.response?.status ?? err?.status;
    const name = err?.name ?? '';
    
    if (status === 404 || name === 'NotFoundError') {
      return {
        publicKey,
        displayName: null,
        bio: null,
        avatarUrl: null,
        exists: false,
        dataEntries: {},
      };
    }

    // Network or other errors - return as unfunded to not block onboarding
    console.error('Error fetching Stellar account metadata:', err);
    return {
      publicKey,
      displayName: null,
      bio: null,
      avatarUrl: null,
      exists: false,
      dataEntries: {},
    };
  }
}
