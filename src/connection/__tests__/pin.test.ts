import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createPinVerifier, PinGate, validPinVerifier } from '../pin.js';

describe('connection PIN', () => {
  afterEach(() => vi.useRealTimers());

  it('accepts 4–6 digits and stores a salted verifier without the PIN', () => {
    const pin = createPinVerifier('0123');
    expect(validPinVerifier(pin)).toBe(true);
    expect(pin.hash).not.toContain('0123');
    expect(createPinVerifier('0123').salt).not.toBe(pin.salt);
    for (const value of ['123', '1234567', 'abcd', '12 34', '１２３４']) expect(() => createPinVerifier(value)).toThrow();
    expect(validPinVerifier({ ...pin, hash: 'bad' })).toBe(false);
  });

  it('verifies a challenge response and rejects another challenge’s proof', () => {
    const pin = createPinVerifier('123456');
    const gate = new PinGate();
    const challenge = gate.challenge();
    const proof = createHmac('sha256', Buffer.from(pin.hash, 'hex')).update('spck-pin-v1:' + challenge.challenge).digest('hex');
    expect(gate.verify(pin, challenge, proof)).toBe(true);
    expect(gate.verify(pin, gate.challenge(), proof)).toBe(false);
    expect(gate.verify(pin, { ...challenge, expiresAt: Date.now() - 1 }, proof)).toBe(false);
  });

  it('locks all connections out after five wrong attempts, then allows retry', () => {
    vi.useFakeTimers();
    const pin = createPinVerifier('1234');
    const gate = new PinGate();
    for (let i = 0; i < 5; i++) expect(gate.verify(pin, gate.challenge(), '00'.repeat(32))).toBe(false);
    expect(gate.retryAfter()).toBe(60);
    const challenge = gate.challenge();
    const proof = createHmac('sha256', Buffer.from(pin.hash, 'hex')).update('spck-pin-v1:' + challenge.challenge).digest('hex');
    expect(gate.verify(pin, challenge, proof)).toBe(false);
    vi.advanceTimersByTime(60000);
    expect(gate.retryAfter()).toBe(0);
    expect(gate.verify(pin, challenge, proof)).toBe(true);
  });
});
