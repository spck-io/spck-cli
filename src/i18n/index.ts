/**
 * Lightweight i18n system for the CLI
 * No external dependencies — uses JSON locale files with dot-path keys and {{variable}} interpolation
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import osLocale from 'os-locale';

type Translations = Record<string, any>;

// Support both CJS (ts-jest) and ESM (runtime) contexts
// eslint-disable-next-line no-eval
const __dirname = dirname(fileURLToPath(import.meta.url));
const localesDir = join(__dirname, 'locales');

function loadLocale(file: string): Translations {
  try {
    return JSON.parse(readFileSync(join(localesDir, file), 'utf-8'));
  } catch {
    return {};
  }
}

const en = loadLocale('en.json');

const locales: Record<string, Translations> = {
  en,
  es: loadLocale('es.json'),
  fr: loadLocale('fr.json'),
  id: loadLocale('id.json'),
  ja: loadLocale('ja.json'),
  ko: loadLocale('ko.json'),
  pt: loadLocale('pt.json'),
  'zh-Hans': loadLocale('zh-Hans.json'),
};

const SUPPORTED_LOCALES = Object.keys(locales);

let currentLocale = 'en';

/**
 * Map system locale string (e.g. "ja_JP.UTF-8") to a supported locale code
 */
function mapLocale(raw: string): string {
  // Normalize: lowercase, replace - with _
  const normalized = raw.toLowerCase().replace(/-/g, '_');

  // zh_cn / zh_sg → zh-Hans
  if (normalized.startsWith('zh_cn') || normalized.startsWith('zh_sg') || normalized === 'zh_hans' || normalized.startsWith('zh_hans')) {
    return 'zh-Hans';
  }

  // Extract language code (before _ or .)
  const lang = normalized.split(/[_.]/)[0];

  if (SUPPORTED_LOCALES.includes(lang)) {
    return lang;
  }

  return 'en';
}

/**
 * Detect locale using os-locale (reads LC_ALL, LANG, LANGUAGE, and OS-specific APIs)
 */
export function detectLocale(): string {
  const raw = osLocale();
  currentLocale = mapLocale(raw);
  return currentLocale;
}

/**
 * Set locale explicitly (e.g. from --locale CLI flag)
 */
export function setLocale(locale: string): void {
  currentLocale = mapLocale(locale);
}

/**
 * Get the current locale
 */
export function getLocale(): string {
  return currentLocale;
}

/**
 * Resolve a dot-path key from a translations object
 * e.g. resolve('tools.gitDetected', translations) → translations.tools.gitDetected
 */
function resolve(key: string, obj: Translations): string | undefined {
  const parts = key.split('.');
  let current: any = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return typeof current === 'string' ? current : undefined;
}

/**
 * Translate a key with optional parameter interpolation
 *
 * @param key - Dot-path key (e.g. 'tools.gitDetected')
 * @param params - Optional parameters for {{variable}} interpolation
 * @returns Translated string, falling back to English, then the key itself
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let text = resolve(key, locales[currentLocale]) ?? resolve(key, en) ?? key;

  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), String(value));
    }
  }

  return text;
}
