/**
 * Decrypts refresh tokens that the browser encrypts for this CLI session, so
 * the relay and anyone holding the sign-in link only ever see ciphertext.
 *
 * ECDH P-256 + HKDF-SHA-256 + AES-256-GCM. The browser side is
 * pvSealRefreshTokenAsync in app/views/auth/auth.template.js.
 */

import * as crypto from 'crypto';

const SEALED_PREFIX = 'spck-sealed-v1.';
const HKDF_SALT = 'spck-cli-auth-v1';
const GCM_TAG_BYTES = 16;

export interface AuthKeyPair {
  /** Base64url public key, safe to include in the sign-in link. */
  publicKey: string;
  /** Decrypts a sealed token. Throws if it was altered or sealed for another session. */
  openRefreshToken(value: string): string;
}

export function createAuthKeyPair(code: string): AuthKeyPair {
  const ecdh = crypto.createECDH('prime256v1');
  const publicKey = ecdh.generateKeys().toString('base64url');

  return {
    publicKey,
    openRefreshToken(value) {
      // A page deployed before encryption still sends the token as-is.
      if (!value.startsWith(SEALED_PREFIX)) return value;

      const parts = value.slice(SEALED_PREFIX.length).split('.');
      if (parts.length !== 3) throw new Error('Malformed sealed token');
      const [browserKey, iv, sealed] = parts.map((part) => Buffer.from(part, 'base64url'));

      const secret = ecdh.computeSecret(browserKey);
      const key = Buffer.from(crypto.hkdfSync('sha256', secret, HKDF_SALT, code, 32));
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      // WebCrypto appends the authentication tag to the ciphertext.
      decipher.setAuthTag(sealed.subarray(-GCM_TAG_BYTES));
      return Buffer.concat([decipher.update(sealed.subarray(0, -GCM_TAG_BYTES)), decipher.final()]).toString('utf8');
    },
  };
}
