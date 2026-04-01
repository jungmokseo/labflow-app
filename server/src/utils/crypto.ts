import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Derive a 32-byte encryption key from an arbitrary-length secret.
 */
function getKey(): Buffer {
  const secret = process.env.TOKEN_ENCRYPTION_KEY || process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error(
      'Missing encryption key: set TOKEN_ENCRYPTION_KEY or SUPABASE_JWT_SECRET env var',
    );
  }
  return createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a string in the format `iv:authTag:ciphertext` (all hex-encoded).
 */
export function encryptToken(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

/**
 * Decrypt a token previously encrypted with `encryptToken`.
 * Expects input in the format `iv:authTag:ciphertext` (all hex-encoded).
 */
export function decryptToken(encrypted: string): string {
  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format: expected iv:authTag:ciphertext');
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const key = getKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Check whether a value looks like an encrypted token (hex:hex:hex format).
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split(':');
  if (parts.length !== 3) return false;

  const hexPattern = /^[0-9a-f]+$/i;
  return parts.every((part) => part.length > 0 && hexPattern.test(part));
}
