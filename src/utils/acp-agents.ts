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
  // Start through cmd.exe. Set for Windows .cmd/.bat files (npm's shims for
  // global installs), which Node can't spawn directly.
  shell?: boolean;
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
  const isWindows = process.platform === 'win32';
  const lookup = isWindows ? 'where' : 'which';
  for (const candidate of PATH_AGENTS) {
    if (resolved.some((agent) => agent.name === candidate.name)) continue;
    const which = spawnSync(lookup, [candidate.binary], { encoding: 'utf8' });
    if (which.status !== 0) continue;
    const found = isWindows
      ? pickWindowsCommand(which.stdout || '')
      : { binary: (which.stdout || '').split('\n')[0]?.trim(), shell: false };
    if (!found?.binary) continue;
    resolved.push({
      name: candidate.name,
      binary: found.binary,
      args: candidate.args,
      version: '',
      ...(found.shell ? { shell: true } : {}),
    });
  }
  return resolved;
}

/**
 * Pick the match Windows can start from `where` output. `where` lists every
 * match in PATH order, including the extensionless sh script npm installs
 * beside its .cmd shim, which Windows can't run. .exe and .com files start
 * directly; .cmd and .bat files need cmd.exe.
 */
export function pickWindowsCommand(whereOutput: string): { binary: string; shell: boolean } | null {
  for (const line of whereOutput.split(/\r?\n/)) {
    const binary = line.trim();
    const ext = path.win32.extname(binary).toLowerCase();
    if (ext === '.exe' || ext === '.com') return { binary, shell: false };
    if (ext === '.cmd' || ext === '.bat') return { binary, shell: true };
  }
  return null;
}
