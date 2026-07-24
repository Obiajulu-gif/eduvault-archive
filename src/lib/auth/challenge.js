import { getDb } from '../mongodb.js';
import { NETWORK_PASSPHRASE } from '../config/chain.js';
import { TransactionBuilder, Keypair, StrKey } from '@stellar/stellar-sdk';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function generateNonce() {
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function getDomain() {
  return process.env.AUTH_DOMAIN || process.env.NEXT_PUBLIC_APP_URL || 'localhost';
}

function getWebAuthUri() {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

function extractBaseAccount(source) {
  if (typeof source !== 'string') return source;
  if (source.startsWith('M')) {
    try {
      const decoded = StrKey.decodeMed25519PublicKey(source);
      return StrKey.encodeEd25519PublicKey(decoded.ed25519);
    } catch {
      return source;
    }
  }
  return source;
}

export async function issueChallenge(address, opts = {}) {
  const db = opts.db || await getDb();
  const nonce = generateNonce();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  const domain = getDomain();
  const webAuthUri = getWebAuthUri();

  const message = [
    'EduVault Login',
    `Domain: ${domain}`,
    `URI: ${webAuthUri}`,
    `Network: ${NETWORK_PASSPHRASE}`,
    `Address: ${address.toLowerCase()}`,
    `Nonce: ${nonce}`,
    `IssuedAt: ${now.toISOString()}`,
    `ExpiresAt: ${expiresAt.toISOString()}`,
  ].join('\n');

  const doc = {
    address: address.toLowerCase(),
    nonce,
    message,
    domain,
    webAuthUri,
    networkPassphrase: NETWORK_PASSPHRASE,
    used: false,
    issuedAt: now,
    expiresAt,
    createdAt: now,
  };

  await db.collection('auth_challenges').insertOne(doc);

  return {
    nonce,
    address,
    message,
    domain,
    webAuthUri,
    networkPassphrase: NETWORK_PASSPHRASE,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function verifyChallenge(address, nonce, signedTransactionXdr, opts = {}) {
  const db = opts.db || await getDb();

  const challenge = await db.collection('auth_challenges').findOneAndUpdate(
    {
      address: address.toLowerCase(),
      nonce,
      used: false,
      expiresAt: { $gt: new Date() },
    },
    {
      $set: { used: true, usedAt: new Date() },
    },
    { returnDocument: 'before' }
  );

  if (!challenge) {
    return { valid: false, reason: 'Challenge not found, expired, or already used' };
  }

  try {
    const tx = TransactionBuilder.fromXDR(signedTransactionXdr, NETWORK_PASSPHRASE);

    const rawSource = tx.source;
    const claimedSource = extractBaseAccount(rawSource);

    if (claimedSource.toLowerCase() !== address.toLowerCase()) {
      return { valid: false, reason: 'Transaction source does not match claimed address' };
    }

    if (challenge.networkPassphrase !== NETWORK_PASSPHRASE) {
      return { valid: false, reason: 'Network passphrase mismatch' };
    }

    const memo = tx.memo?.value?.toString() ?? '';
    if (memo !== nonce) {
      return { valid: false, reason: 'Transaction memo does not match challenge nonce' };
    }

    const txHash = tx.hash();
    const signatures = tx.signatures;
    if (!signatures || signatures.length === 0) {
      return { valid: false, reason: 'No signatures provided' };
    }

    const isValidSignature = signatures.some((sig) => {
      try {
        const keypair = Keypair.fromPublicKey(address);
        return keypair.verify(txHash, sig.signature());
      } catch {
        return false;
      }
    });

    if (!isValidSignature) {
      return { valid: false, reason: 'Invalid signature' };
    }

    return { valid: true };
  } catch (err) {
    const msg = err.message || 'Malformed transaction envelope';
    const sanitized = msg.replace(/[A-Za-z0-9+/=]{40,}/g, '<redacted>');
    return { valid: false, reason: `Verification failed: ${sanitized}` };
  }
}

export async function cleanupExpiredChallenges(opts = {}) {
  try {
    const db = opts.db || await getDb();
    await db.collection('auth_challenges').deleteMany({
      expiresAt: { $lt: new Date() },
    });
  } catch {
  }
}

export async function ensureChallengeIndexes(db) {
  try {
    const col = db.collection('auth_challenges');
    await col.createIndex(
      { expiresAt: 1 },
      { name: 'auth_challenges_expires_at_ttl', expireAfterSeconds: 0, background: true }
    );
    await col.createIndex(
      { address: 1, nonce: 1 },
      { name: 'auth_challenges_address_nonce', background: true }
    );
    await col.createIndex(
      { used: 1, expiresAt: 1 },
      { name: 'auth_challenges_used_expires', background: true }
    );
    console.log('Auth challenge indexes ensured successfully.');
  } catch (err) {
    console.error('[Auth Challenge Index Error]:', err);
  }
}
