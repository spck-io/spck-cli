import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;
const encode = (text: string) => new TextEncoder().encode(text);
const base64Url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes as ArrayBuffer).toString('base64url');

/** Same steps as pvSealRefreshTokenAsync in the web auth page. */
export async function sealForCli(publicKey: string, code: string, refreshToken: string): Promise<string> {
  const algorithm = { name: 'ECDH', namedCurve: 'P-256' };
  const cliKey = await subtle.importKey('raw', Buffer.from(publicKey, 'base64url'), algorithm, false, []);
  const pair = await subtle.generateKey(algorithm, false, ['deriveBits']);
  const secret = await subtle.deriveBits({ name: 'ECDH', public: cliKey }, pair.privateKey, 256);
  const hkdfKey = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const aesKey = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encode('spck-cli-auth-v1'), info: encode(code) },
    hkdfKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const sealed = await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encode(refreshToken));
  return 'spck-sealed-v1.' + [await subtle.exportKey('raw', pair.publicKey), iv, sealed].map(base64Url).join('.');
}
