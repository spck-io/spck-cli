import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

export const PIN_ITERATIONS = 600000;
export interface PinVerifier { salt: string; hash: string; iterations: number }
export interface PinChallenge { challenge: string; expiresAt: number }

export function validPinVerifier(pin: unknown): pin is PinVerifier {
  const value = pin as PinVerifier | undefined;
  return !!value && /^[a-f0-9]{32}$/.test(value.salt) && /^[a-f0-9]{64}$/.test(value.hash)
    && Number.isInteger(value.iterations) && value.iterations >= 100000 && value.iterations <= 1000000;
}

export function createPinVerifier(pin: string): PinVerifier {
  if (!/^\d{4,6}$/.test(pin)) throw new Error('PIN must contain 4–6 digits.');
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: pbkdf2Sync(pin, Buffer.from(salt, 'hex'), PIN_ITERATIONS, 32, 'sha256').toString('hex'), iterations: PIN_ITERATIONS };
}

/** Shared across all devices/connections, so changing device IDs cannot reset guesses. */
export class PinGate {
  private failures = 0;
  private blockedUntil = 0;

  retryAfter(): number { return Math.max(0, Math.ceil((this.blockedUntil - Date.now()) / 1000)); }

  challenge(): PinChallenge {
    return { challenge: randomBytes(32).toString('hex'), expiresAt: Date.now() + 5 * 60 * 1000 };
  }

  verify(pin: PinVerifier, challenge: PinChallenge, proof: unknown): boolean {
    if (this.retryAfter() || challenge.expiresAt < Date.now()) return false;
    const expected = createHmac('sha256', Buffer.from(pin.hash, 'hex')).update('spck-pin-v1:' + challenge.challenge).digest();
    const valid = typeof proof === 'string' && /^[a-f0-9]{64}$/.test(proof)
      && timingSafeEqual(expected, Buffer.from(proof, 'hex'));
    if (valid) {
      this.failures = 0;
    } else {
      this.failures++;
      if (this.failures >= 5) {
        this.blockedUntil = Date.now() + 60000;
        this.failures = 0;
      }
    }
    return valid;
  }
}
