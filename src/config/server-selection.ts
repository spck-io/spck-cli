/**
 * CLI Server Selection
 * Fetches available relay servers, checks ping, and auto-selects the best one
 */

import { t } from '../i18n/index.js';
import { getLocale } from '../i18n/index.js';

export interface CLIServer {
  label: Record<string, string>;
  url: string;
  locale: Record<string, number>;
}

const LABEL_LOCALES = ['en', 'es', 'fr', 'de', 'pt', 'ru', 'ja', 'ko', 'zh', 'zhTW', 'id'];

function relayLabel(name: string): Record<string, string> {
  return Object.fromEntries(LABEL_LOCALES.map(locale => [locale, name]));
}

/**
 * Hardcoded default server list — used as fallback when no server responds
 */
const DEFAULT_SERVERS: CLIServer[] = [
  {
    label: relayLabel('Relay US'),
    url: 'cli-na-1.spck.io',
    locale: {en: 1, es: 1, fr: 2, de: 2, pt: 1, ru: 2, ja: 3, ko: 3, zh: 3, zhTW: 3, id: 3}
  },
  {
    label: relayLabel('Relay EU'),
    url: 'cli-eu-1.spck.io',
    locale: {en: 3, es: 2, fr: 1, de: 1, pt: 2, ru: 1, ja: 2, ko: 2, zh: 2, zhTW: 2, id: 2}
  },
  {
    label: relayLabel('Relay Asia'),
    url: 'cli-ea-1.spck.io',
    locale: {en: 2, es: 3, fr: 3, de: 3, pt: 3, ru: 3, ja: 1, ko: 1, zh: 1, zhTW: 1, id: 1}
  }
];

/**
 * Retired relay hostnames that are now DNS aliases of a canonical relay.
 * Old CLIs/apps keep working through DNS; new code canonicalizes saved values.
 */
const LEGACY_SERVER_ALIASES: Record<string, string> = {
  'cli-sa-1.spck.io': 'cli-na-1.spck.io',
  'cli-sas-1.spck.io': 'cli-ea-1.spck.io',
};

/**
 * Map a retired relay hostname to the canonical one it now resolves to.
 * Any other value is returned unchanged.
 */
export function normalizeServerUrl(url: string): string {
  return LEGACY_SERVER_ALIASES[url.toLowerCase()] ?? url;
}

/**
 * Most recent server list (fetched from /servers, else the defaults), used to
 * turn hostnames into display names in CLI messages.
 */
let knownServers: CLIServer[] = DEFAULT_SERVERS;

/**
 * Localized display name for a relay hostname (e.g. "Relay US"), resolving
 * retired alias hostnames to their canonical relay. Null when unknown.
 */
export function getServerLabel(url: string): string | null {
  const canonical = normalizeServerUrl(url).toLowerCase();
  const server = knownServers.find(s => s.url.toLowerCase() === canonical);
  if (!server) return null;
  return server.label[getLocale()] || server.label.en || null;
}

/**
 * Name + hostname for CLI messages, e.g. "Relay US (cli-na-1.spck.io)".
 * Falls back to the bare hostname for servers not in the list.
 */
export function formatServerName(url: string): string {
  const label = getServerLabel(url);
  return label ? `${label} (${url})` : url;
}

/**
 * Validate that a server URL belongs to spck.io (any subdomain).
 * Rejects bare IPs, other domains, and URLs with protocols.
 */
export function isValidDomain(url: string): boolean {
  return /^([a-zA-Z0-9-]+\.)*spck\.io$/.test(url);
}

/**
 * Get the hardcoded default server list
 */
export function getDefaultServerList(): CLIServer[] {
  return DEFAULT_SERVERS;
}

/**
 * Fetch the list of available CLI servers from the closest relay server.
 * Tries servers sorted by locale proximity, falls back to hardcoded list.
 */
export async function fetchServerList(): Promise<CLIServer[]> {
  // Race all servers in parallel — first successful response wins
  try {
    return await Promise.any(
      DEFAULT_SERVERS.map(async (server) => {
        const response = await fetch(`https://${server.url}/servers`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`${response.status}`);
        const list = await response.json() as CLIServer[];
        // Reject any server whose URL is not a *.spck.io domain
        const valid = list.filter(s => isValidDomain(s.url));
        if (valid.length > 0) knownServers = valid;
        return valid;
      })
    );
  } catch {
    // All servers failed — fall back to hardcoded list
    return DEFAULT_SERVERS;
  }
}

/**
 * Check ping to a server by making 4 parallel HTTP calls to /health
 * and averaging the latency
 */
export async function checkServerPing(serverUrl: string): Promise<number> {
  const shortestTime = await Promise.any(
    Array.from({ length: 4 }, async () => {
      const start = Date.now();
      try {
        const response = await fetch(`https://${serverUrl}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) return Infinity;
      } catch {
        return Infinity;
      }
      return Date.now() - start;
    })
  );
  return Math.round(shortestTime);
}

/**
 * Ping all servers in parallel and select the one with the lowest latency
 */
export async function selectBestServer(
  servers: CLIServer[]
): Promise<{ server: CLIServer; ping: number }> {
  const results = await Promise.all(
    servers.map(async (server) => {
      try {
        const ping = await checkServerPing(server.url);
        return { server, ping };
      } catch {
        return { server, ping: Infinity };
      }
    })
  );
  results.sort((a, b) => a.ping - b.ping);
  return results[0];
}

/**
 * Display ping results for all servers
 */
export async function displayServerPings(servers: CLIServer[]): Promise<Map<string, number>> {
  console.log('\n   ' + t('server.checkingLatency') + '\n');

  const pingResults = new Map<string, number>();
  const results = await Promise.all(
    servers.map(async (server) => {
      try {
        const ping = await checkServerPing(server.url);
        return { server, ping };
      } catch {
        return { server, ping: Infinity };
      }
    })
  );

  const locale = getLocale();
  for (const { server, ping } of results) {
    const label = server.label[locale] || server.label.en || server.url;
    const pingStr = ping === Infinity ? t('server.unreachable') : `${ping}ms`;
    console.log(`   ${label}: ${pingStr}`);
    pingResults.set(server.url, ping);
  }

  console.log('');
  return pingResults;
}
