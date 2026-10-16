import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  encryptProtectedContent,
  decryptProtectedContent,
  isProtectedMaterial,
  sanitizeMaterialPublic,
  getMasterKey,
} from '../../src/lib/storage/protectedStorage.js';

test('isProtectedMaterial distinguishes protected materials from free materials', () => {
  assert.equal(isProtectedMaterial({ price: 10 }), true);
  assert.equal(isProtectedMaterial({ price: '15.5' }), true);
  assert.equal(isProtectedMaterial({ isProtected: true, price: 0 }), true);
  assert.equal(isProtectedMaterial({ price: 0, isFree: true }), false);
  assert.equal(isProtectedMaterial({ price: 0 }), false);
});

test('sanitizeMaterialPublic strips raw CIDs and secrets from protected materials while keeping free materials intact', () => {
  const protectedDoc = {
    _id: 'mat-paid-1',
    title: 'Advanced Soroban Engineering',
    price: 25,
    cid: 'QmSuperSecretProtectedCid1234567890abcdef',
    ipfsCid: 'QmSuperSecretProtectedCid1234567890abcdef',
    storageKey: 'key_protected_abc',
    fileUrl: 'https://gateway.pinata.cloud/ipfs/QmSuperSecretProtectedCid1234567890abcdef',
    wrappedKey: 'hex_wrapped_key',
    rating: 4.8,
  };

  const sanitizedProtected = sanitizeMaterialPublic(protectedDoc);

  assert.equal(sanitizedProtected.title, 'Advanced Soroban Engineering');
  assert.equal(sanitizedProtected.isProtected, true);
  assert.equal(sanitizedProtected.requiresEntitlement, true);
  assert.equal(sanitizedProtected.cid, undefined);
  assert.equal(sanitizedProtected.ipfsCid, undefined);
  assert.equal(sanitizedProtected.storageKey, undefined);
  assert.equal(sanitizedProtected.fileUrl, undefined);
  assert.equal(sanitizedProtected.wrappedKey, undefined);

  // Free/public document
  const freeDoc = {
    _id: 'mat-free-2',
    title: 'Introduction to Blockchain',
    price: 0,
    isFree: true,
    cid: 'QmPublicOpenEducationalMaterialCid987654321',
    ipfsCid: 'QmPublicOpenEducationalMaterialCid987654321',
    rating: 4.5,
  };

  const sanitizedFree = sanitizeMaterialPublic(freeDoc);
  assert.equal(sanitizedFree.isProtected, false);
  assert.equal(sanitizedFree.cid, 'QmPublicOpenEducationalMaterialCid987654321');
  assert.equal(sanitizedFree.ipfsCid, 'QmPublicOpenEducationalMaterialCid987654321');
});

test('Penetration Test: Direct public gateway access to raw IPFS ciphertext cannot be decrypted without entitlement key', () => {
  const secretData = 'CONFIDENTIAL_EDUCATIONAL_CONTENT_STUDENT_COURSE_MATERIALS_2026';
  const buffer = Buffer.from(secretData, 'utf-8');

  // Server encrypts content before pinning to IPFS
  const encryptedPackage = encryptProtectedContent(buffer);

  // An attacker who somehow discovers the raw ciphertext cannot read the content directly
  assert.notEqual(encryptedPackage.ciphertext.toString('utf-8'), secretData);
  assert.equal(encryptedPackage.ciphertext.includes(secretData), false);

  // Attacker attempting decryption with forged or empty master key fails
  const rogueKey = Buffer.alloc(32, 0x99);
  assert.throws(
    () => {
      decryptProtectedContent(encryptedPackage, { masterKey: rogueKey });
    },
    /bad decrypt|cipher|unsupported state/i
  );

  // Legitimate client with verified entitlement and valid master key successfully decrypts
  const decrypted = decryptProtectedContent(encryptedPackage);
  assert.equal(decrypted.toString('utf-8'), secretData);
});
