import { describe, expect, it } from 'vitest';
import { createAuthKeyPair } from '../auth-seal.js';
import { sealForCli } from './seal-helper.js';

const CODE = 'a'.repeat(64);

describe('createAuthKeyPair()', () => {
  it('opens a token sealed with WebCrypto', async () => {
    const pair = createAuthKeyPair(CODE);
    expect(await sealForCli(pair.publicKey, CODE, 'refresh-token')).not.toContain('refresh-token');
    expect(pair.openRefreshToken(await sealForCli(pair.publicKey, CODE, 'refresh-token'))).toBe('refresh-token');
  });

  it('rejects a token that was altered', async () => {
    const pair = createAuthKeyPair(CODE);
    const sealed = await sealForCli(pair.publicKey, CODE, 'refresh-token');
    const last = sealed.at(-2) === 'A' ? 'B' : 'A';
    expect(() => pair.openRefreshToken(sealed.slice(0, -2) + last + sealed.at(-1))).toThrow();
  });

  it('rejects a token sealed for another session or key', async () => {
    const pair = createAuthKeyPair(CODE);
    const otherCode = await sealForCli(pair.publicKey, 'b'.repeat(64), 'refresh-token');
    const otherKey = await sealForCli(createAuthKeyPair(CODE).publicKey, CODE, 'refresh-token');
    expect(() => pair.openRefreshToken(otherCode)).toThrow();
    expect(() => pair.openRefreshToken(otherKey)).toThrow();
  });

  it('rejects malformed values and passes through unsealed tokens', () => {
    const pair = createAuthKeyPair(CODE);
    expect(() => pair.openRefreshToken('spck-sealed-v1.only-one-part')).toThrow();
    expect(pair.openRefreshToken('plain-token')).toBe('plain-token');
  });

  it('generates a new key for every session', () => {
    expect(createAuthKeyPair(CODE).publicKey).not.toBe(createAuthKeyPair(CODE).publicKey);
  });
});
