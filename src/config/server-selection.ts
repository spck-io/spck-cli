/**
 * CLI Server Selection
 * Fetches available relay servers, checks ping, and auto-selects the best one
 */

export interface CLIServer {
  label: Record<string, string>;
  url: string;
  locale: Record<string, number>;
}

/**
 * Hardcoded default server list — used as fallback when no server responds
 */
const DEFAULT_SERVERS: CLIServer[] = [
  {
    label: {en: 'Europe', es: 'Europa', fr: 'Europe', de: 'Europa', pt: 'Europa', ru: '\u0415\u0432\u0440\u043e\u043f\u0430', ja: '\u30e8\u30fc\u30ed\u30c3\u30d1', ko: '\uc720\ub7fd', zh: '\u6b27\u6d32', zhTW: '\u6b50\u6d32', id: 'Eropa'},
    url: 'cli-eu-1.spck.io',
    locale: {en: 3, es: 2, fr: 1, de: 1, pt: 2, ru: 1, ja: 3, ko: 3, zh: 3, zhTW: 3, id: 3}
  },
  {
    label: {en: 'North America', es: 'Am\u00e9rica del Norte', fr: 'Am\u00e9rique du Nord', de: 'Nordamerika', pt: 'Am\u00e9rica do Norte', ru: '\u0421\u0435\u0432\u0435\u0440\u043d\u0430\u044f \u0410\u043c\u0435\u0440\u0438\u043a\u0430', ja: '\u5317\u30a2\u30e1\u30ea\u30ab', ko: '\ubd81\uc544\uba54\ub9ac\uce74', zh: '\u5317\u7f8e\u6d32', zhTW: '\u5317\u7f8e\u6d32', id: 'Amerika Utara'},
    url: 'cli-na-1.spck.io',
    locale: {en: 1, es: 1, fr: 2, de: 2, pt: 1, ru: 2, ja: 4, ko: 4, zh: 4, zhTW: 4, id: 4}
  },
  {
    label: {en: 'South Asia', es: 'Asia del Sur', fr: 'Asie du Sud', de: 'S\u00fcdasien', pt: '\u00c1sia Meridional', ru: '\u042e\u0436\u043d\u0430\u044f \u0410\u0437\u0438\u044f', ja: '\u5357\u30a2\u30b8\u30a2', ko: '\ub0a8\uc544\uc2dc\uc544', zh: '\u5357\u4e9a', zhTW: '\u5357\u4e9e', id: 'Asia Selatan'},
    url: 'cli-sas-1.spck.io',
    locale: {en: 2, es: 4, fr: 4, de: 4, pt: 4, ru: 4, ja: 2, ko: 2, zh: 2, zhTW: 2, id: 1}
  },
  {
    label: {en: 'East Asia', es: 'Asia Oriental', fr: 'Asie de l\u2019Est', de: 'Ostasien', pt: '\u00c1sia Oriental', ru: '\u0412\u043e\u0441\u0442\u043e\u0447\u043d\u0430\u044f \u0410\u0437\u0438\u044f', ja: '\u6771\u30a2\u30b8\u30a2', ko: '\ub3d9\uc544\uc2dc\uc544', zh: '\u4e1c\u4e9a', zhTW: '\u6771\u4e9e', id: 'Asia Timur'},
    url: 'cli-ea-1.spck.io',
    locale: {en: 4, es: 3, fr: 3, de: 3, pt: 3, ru: 3, ja: 1, ko: 1, zh: 1, zhTW: 1, id: 2}
  }
];

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
        return response.json() as Promise<CLIServer[]>;
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
  const shortestTime = await Promise.race(
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
  console.log('\n   Checking server latency...\n');

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

  for (const { server, ping } of results) {
    const label = server.label.en || server.url;
    const pingStr = ping === Infinity ? 'unreachable' : `${ping}ms`;
    console.log(`   ${label}: ${pingStr}`);
    pingResults.set(server.url, ping);
  }

  console.log('');
  return pingResults;
}
