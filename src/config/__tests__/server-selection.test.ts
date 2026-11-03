import { describe, it, expect, vi } from 'vitest';

vi.mock('../../i18n/index.js', () => ({
  t: (key: string) => key,
  getLocale: () => 'en',
}));

import {
  getDefaultServerList,
  normalizeServerUrl,
  getServerLabel,
  formatServerName,
} from '../server-selection.js';

describe('server-selection', () => {
  it('lists exactly the three relays', () => {
    expect(getDefaultServerList().map(s => [s.label.en, s.url])).toEqual([
      ['Relay US', 'cli-na-1.spck.io'],
      ['Relay EU', 'cli-eu-1.spck.io'],
      ['Relay Asia', 'cli-ea-1.spck.io'],
    ]);
  });

  it('maps retired alias hostnames to their canonical relay', () => {
    expect(normalizeServerUrl('cli-sa-1.spck.io')).toBe('cli-na-1.spck.io');
    expect(normalizeServerUrl('cli-sas-1.spck.io')).toBe('cli-ea-1.spck.io');
    expect(normalizeServerUrl('cli-eu-1.spck.io')).toBe('cli-eu-1.spck.io');
    expect(normalizeServerUrl('custom.spck.io')).toBe('custom.spck.io');
  });

  it('resolves display names, including for alias hostnames', () => {
    expect(getServerLabel('cli-na-1.spck.io')).toBe('Relay US');
    expect(getServerLabel('cli-sas-1.spck.io')).toBe('Relay Asia');
    expect(getServerLabel('custom.spck.io')).toBeNull();
  });

  it('formats name plus hostname, falling back to the bare hostname', () => {
    expect(formatServerName('cli-eu-1.spck.io')).toBe('Relay EU (cli-eu-1.spck.io)');
    expect(formatServerName('custom.spck.io')).toBe('custom.spck.io');
  });
});
