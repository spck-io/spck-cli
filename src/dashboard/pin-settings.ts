import { getLocale } from '../i18n/index.js';
import { updateConfigFile } from '../config/config.js';
import { createPinVerifier, validPinVerifier } from '../connection/pin.js';
import { ServerConfig } from '../types.js';

const labels: Record<string, string> = {
  en: 'Require PIN to connect', es: 'Exigir PIN para conectar', fr: 'Exiger un PIN',
  id: 'Wajib PIN untuk terhubung', ja: '接続時にPINを要求', ko: '연결 시 PIN 요구',
  pt: 'Exigir PIN para conectar', 'zh-Hans': '连接时需要 PIN',
};
export const pinSettingLabel = () => labels[getLocale()] ?? labels.en;

export const pinSetupText = {
  title: 'Protect CLI connections', enter: 'Choose a connection PIN', confirm: 'Confirm your PIN',
  help: 'Use 4–6 digits. Enter this PIN in Spck Editor when connecting.',
  confirmHelp: 'Enter the same PIN again to enable protection.',
  invalid: 'Enter 4–6 digits.', mismatch: 'The PINs do not match. Try again.',
  keys: 'Digits  PIN     Backspace  Delete     Enter  Continue     Esc  Cancel',
};

export function saveConnectionPin(config: ServerConfig, pin: string, configPath?: string): void {
  const verifier = createPinVerifier(pin);
  // Save before enabling, so a write failure cannot silently change the PIN.
  updateConfigFile(file => { file.security.pin = verifier; file.security.requirePin = true; }, configPath);
  config.security.pin = verifier;
  config.security.requirePin = true;
}

export function setRequirePin(config: ServerConfig, enabled: boolean): void {
  if (enabled && !validPinVerifier(config.security.pin)) throw new Error('Set a connection PIN in the CLI dashboard.');
  config.security.requirePin = enabled;
}
