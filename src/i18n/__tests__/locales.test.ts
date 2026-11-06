import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'locales');

function loadStrings(file: string): Map<string, string> {
  const locale = JSON.parse(readFileSync(join(localesDir, file), 'utf8')) as Record<string, Record<string, string>>;
  return new Map(Object.entries(locale).flatMap(([section, strings]) =>
    Object.entries(strings).map(([key, text]) => [`${section}.${key}`, text] as [string, string])));
}

function placeholders(text: string): string[] {
  return (text.match(/\{\{\w+\}\}/g) ?? []).sort();
}

const en = loadStrings('en.json');

describe.each(readdirSync(localesDir).filter((file) => file !== 'en.json'))('locale %s', (file) => {
  const strings = loadStrings(file);

  it('has the same keys as English', () => {
    expect([...strings.keys()].sort()).toEqual([...en.keys()].sort());
  });

  it('uses the same placeholders as English', () => {
    for (const [key, text] of en) {
      expect(placeholders(strings.get(key) ?? ''), key).toEqual(placeholders(text));
    }
  });
});
