import { spawnSync } from 'child_process';
import * as path from 'path';
import { createRequire } from 'module';

// One ACP-capable CLI agent on the host. We model this as a list so adding
// codex/aider/etc. is purely a registry change — no call sites to update.
export interface ResolvedAgent {
  name: string;
  binary: string;
  version: string;
  // The argv to launch the agent's ACP loop. Most agents follow `<binary> acp`,
  // but some may differ; keep it explicit per-entry.
  args: string[];
}

// Built-in registry of ACP-capable CLI agents. Each entry names the PATH
// binary plus the argv that launches its ACP loop. Adding a new agent is a
// one-line change here — capabilities() and newSession() are agent-agnostic.
//
// Conventions used by each agent's ACP entrypoint:
//   claude       Anthropic's Claude via @agentclientprotocol/claude-agent-acp,
//                bundled as a direct dependency of this cli. We resolve the
//                package's bin script through node_modules and spawn it with
//                the current `node` binary — no PATH lookup, no npx download
//                cost at runtime, no global install required. The native
//                `claude acp` binary doesn't advertise its model catalogue in
//                the ACP `initialize` response, so the editor can't render a
//                model picker; the wrapper does. Auth still uses claude-code's
//                own login (`claude login` or ANTHROPIC_API_KEY).
//   codex        OpenAI Codex via @agentclientprotocol/codex-acp, also bundled
//                and launched with the current node binary. The adapter ships
//                a compatible Codex runtime and uses the existing Codex login.
//                A global codex-acp binary remains a fallback if the bundled
//                package is missing.
//   gemini       Google's gemini-cli native ACP mode: `gemini --acp`. Auth
//                via interactive OAuth on first run, or GEMINI_API_KEY env.
//                (The older --experimental-acp flag is a deprecated alias.)

// Resolve the path to a JS entrypoint inside a bundled package's `bin` field,
// along with the package's declared version. Returns null if the package isn't
// installed so the agent gets dropped from the registry rather than crashing
// the cli at startup. Version is best-effort — packages may omit it.
function resolveBundledBin(
  pkgName: string,
  binName?: string
): { binPath: string; version: string } | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
    const pkgJson = require(pkgJsonPath) as {
      bin?: string | Record<string, string>;
      version?: string;
    };
    const pkgDir = path.dirname(pkgJsonPath);
    let rel: string | undefined;
    if (typeof pkgJson.bin === 'string') {
      rel = pkgJson.bin;
    } else if (pkgJson.bin && binName) {
      rel = pkgJson.bin[binName];
    } else if (pkgJson.bin) {
      rel = Object.values(pkgJson.bin)[0];
    }
    if (!rel) return null;
    return { binPath: path.join(pkgDir, rel), version: pkgJson.version ?? '' };
  } catch {
    return null;
  }
}

type BundledAgent = { name: string; pkg: string; binName?: string };
type PathAgent = { name: string; binary: string; args: string[] };

const BUNDLED_AGENTS: ReadonlyArray<BundledAgent> = [
  { name: 'claude', pkg: '@agentclientprotocol/claude-agent-acp', binName: 'claude-agent-acp' },
  { name: 'codex', pkg: '@agentclientprotocol/codex-acp', binName: 'codex-acp' },
];
const PATH_AGENTS: ReadonlyArray<PathAgent> = [
  { name: 'codex', binary: 'codex-acp', args: [] },
  { name: 'gemini', binary: 'gemini', args: ['--acp'] },
];

// Probe each agent: bundled ones come from node_modules and launch with the
// current `node`; PATH-based fallbacks resolve their binary via
// `which`/`where`. The actual ACP handshake — including the real model list
// — happens later via probeAgentModels() in capabilities().
export function resolveAcpAgents(): ResolvedAgent[] {
  const resolved: ResolvedAgent[] = [];
  for (const agent of BUNDLED_AGENTS) {
    const bundled = resolveBundledBin(agent.pkg, agent.binName);
    if (!bundled) continue;
    resolved.push({
      name: agent.name,
      binary: process.execPath,
      args: [bundled.binPath],
      version: bundled.version,
    });
  }
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  for (const candidate of PATH_AGENTS) {
    if (resolved.some((agent) => agent.name === candidate.name)) continue;
    const which = spawnSync(lookup, [candidate.binary], { encoding: 'utf8' });
    if (which.status !== 0) continue;
    const binary = (which.stdout || '').split('\n')[0]?.trim();
    if (!binary) continue;
    resolved.push({
      name: candidate.name,
      binary,
      args: candidate.args,
      version: '',
    });
  }
  return resolved;
}
