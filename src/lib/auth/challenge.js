import { getDb } from '@/lib/mongodb';
import { NETWORK_PASSPHRASE } from '@/lib/config/chain';
import { Transaction, xdr, Keypair } from '@stellar/stellar-sdk';
import crypto from 'crypto';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_CLEANUP_INTERVAL_MS = 60 * 1000;

function generateNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function getDomainSeparationString(action, origin, network, contract) {
  return `${action || 'default'}:${origin || 'default'}:${network || 'default'}:${contract || 'default'}`;
}

function getChallengeMessage(nonce, address, domainSeparation) {
  return `EduVault\nAddress: ${address}\nNonce: ${nonce}\nDomain: ${domainSeparation}\nTimestamp: ${Date.now()}`;
}

export async function issueChallenge(address, options = {}) {
  const db = await getDb();
  const nonce = generateNonce();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  const issuedAt = new Date();

  const { action = 'default', origin, network, contract } = options;
  const domainSeparation = getDomainSeparationString(action, origin, network, contract);

  const doc = {
    address: address.toLowerCase(),
    nonce,
    expiresAt,
    issuedAt,
    used: false,
    createdAt: new Date(),
    action,
    origin: origin || null,
    network: network || null,
    contract: contract || null,
    domainSeparation,
  };

  await db.collection('auth_challenges').insertOne(doc);

  return {
    nonce,
    address,
    expiresAt: expiresAt.toISOString(),
    message: getChallengeMessage(nonce, address, domainSeparation),
  };
}

export async function verifyChallenge(address, nonce, signedTransactionXdr, options = {}) {
  const db = await getDb();
  const addressLower = address.toLowerCase();

  const challenge = await db.collection('auth_challenges').findOne({
    address: addressLower,
    nonce,
    used: false,
    expiresAt: { $gt: new Date() },
  });

  if (!challenge) {
    return { valid: false, reason: 'Challenge not found, expired, or already used' };
  }

  const { action = 'default', origin, network, contract } = options;
  const requestedDomain = getDomainSeparationString(action, origin, network, contract);

  if (challenge.domainSeparation !== requestedDomain) {
    await markChallengeUsed(db, challenge._id);
    return { valid: false, reason: 'Challenge domain separation mismatch' };
  }

  try {
    const tx = Transaction.fromXDR(signedTransactionXdr, NETWORK_PASSPHRASE);

    const txSource = tx.source;
    if (txSource !== address) {
      await markChallengeUsed(db, challenge._id);
      return { valid: false, reason: 'Transaction source does not match claimed address' };
    }

    const memo = tx.memo?.value?.toString() ?? '';
    if (memo !== nonce) {
      await markChallengeUsed(db, challenge._id);
      return { valid: false, reason: 'Transaction memo does not match challenge nonce' };
    }

    const txHash = tx.hash().toString('hex');
    const isSigned = tx.signatures.some((sig) => {
      try {
        const keypair = Keypair.fromPublicKey(address);
        return keypair.verify(txHash, sig.signature());
      } catch {
        return false;
      }
    });

    await markChallengeUsed(db, challenge._id);

    if (!isSigned) {
      return { valid: false, reason: 'Invalid signature' };
    }

    return {
      valid: true,
      sessionContext: {
        address: addressLower,
        action: challenge.action,
        origin: challenge.origin,
        network: challenge.network,
        contract: challenge.contract,
      }
    };
  } catch (err) {
    await markChallengeUsed(db, challenge._id).catch(() => {});
    return { valid: false, reason: `Verification failed: ${err.message}` };
  }
}

async function markChallengeUsed(db, id) {
  await db.collection('auth_challenges').updateOne(
    { _id: id },
    { $set: { used: true, usedAt: new Date() } }
  );
}

export async function cleanupExpiredChallenges() {
  try {
    const db = await getDb();
    await db.collection('auth_challenges').deleteMany({
      expiresAt: { $lt: new Date() },
    });
  } catch {
  }
}
