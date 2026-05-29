/**
 * Tool detection for git and ripgrep
 * Checks if required tools are installed and displays warnings
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import { ToolDetectionResult } from '../types.js';
import { t } from '../i18n/index.js';

const execAsync = promisify(exec);

/**
 * Check if a command is available
 */
async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    await execAsync(`${command} --version`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect available tools (git and ripgrep)
 */
export async function detectTools(options?: {
  disableGit?: boolean;
  disableRipgrep?: boolean;
}): Promise<ToolDetectionResult> {
  console.log(`\n=== ${t('tools.title')} ===\n`);

  const result: ToolDetectionResult = {
    git: false,
    ripgrep: false,
    claude: false,
    codex: false,
    gemini: false
  };

  // Check Git (unless force-disabled for development)
  if (options?.disableGit) {
    console.log(`⚠️  ${t('tools.gitForceDisabled')}`);
  } else {
    result.git = await isCommandAvailable('git');

    if (result.git) {
      try {
        const { stdout } = await execAsync('git --version');
        console.log(`✅ ${t('tools.gitDetected', { version: stdout.trim() })}`);
      } catch {
        console.log(`✅ ${t('tools.gitDetectedShort')}`);
      }
    } else {
      console.warn(`⚠️  ${t('tools.gitNotDetected')}`);
      console.warn(`   ${t('tools.gitDisabledHint')}`);
      console.warn(`   ${t('tools.gitInstallHint')}`);
      console.warn(`   ${t('tools.gitInstallUrl')}\n`);
    }
  }

  // Check Ripgrep (unless force-disabled for development)
  if (options?.disableRipgrep) {
    console.log(`⚠️  ${t('tools.ripgrepForceDisabled')}`);
  } else {
    result.ripgrep = await isCommandAvailable('rg');

    if (result.ripgrep) {
      try {
        const { stdout } = await execAsync('rg --version');
        const firstLine = stdout.split('\n')[0];
        console.log(`✅ ${t('tools.ripgrepDetected', { version: firstLine })}`);
      } catch {
        console.log(`✅ ${t('tools.ripgrepDetectedShort')}`);
      }
    } else {
      console.warn(`⚠️  ${t('tools.ripgrepNotDetected')}`);
      console.warn(`   ${t('tools.ripgrepDisabledHint')}`);
      console.warn(`   ${t('tools.ripgrepInstallHint')}`);
      console.warn(`   ${t('tools.ripgrepInstallUrl')}\n`);
    }
  }

  // Probe each ACP-capable agent binary in parallel — they're on the cold
  // startup path. None of these are required; the Source switcher in the
  // editor hides agents that aren't on PATH and the client falls back to the
  // server-routed path when none are available.
  // Claude rides on @agentclientprotocol/claude-agent-acp, which is bundled
  // as a dep of this cli — the native `claude acp` binary doesn't advertise
  // its model catalogue in the ACP `initialize` response, so the editor
  // wouldn't be able to render a model picker.
  const pathAgents: Array<{ key: 'codex' | 'gemini'; binary: string; label: string }> = [
    { key: 'codex',  binary: 'codex-acp',  label: 'Codex (codex-acp)' },
    { key: 'gemini', binary: 'gemini',     label: 'Gemini CLI' }
  ];
  const probes = await Promise.all(pathAgents.map(async (agent) => {
    const available = await isCommandAvailable(agent.binary);
    if (!available) return { agent, available, version: '' };
    // Thin wrappers (e.g. codex-acp) don't always implement --version; ACP
    // still works without it, so version is best-effort.
    let version = '';
    try {
      const { stdout } = await execAsync(`${agent.binary} --version`);
      version = stdout.trim();
    } catch {
      // ignore
    }
    return { agent, available, version };
  }));

  let claudeVersion = '';
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('@agentclientprotocol/claude-agent-acp/package.json') as { version?: string };
    claudeVersion = pkg.version ?? '';
    result.claude = true;
  } catch {
    result.claude = false;
  }

  console.log(`\n--- ACP Agents (local AI coding agents) ---`);
  if (result.claude) {
    console.log(claudeVersion
      ? `✅ Claude (via claude-agent-acp) bundled: ${claudeVersion} (ACP transport available)`
      : `✅ Claude (via claude-agent-acp) bundled (ACP transport available)`);
  } else {
    console.log(`⚪ Claude (via claude-agent-acp) not bundled — run \`npm install\` to enable`);
  }
  for (const { agent, available, version } of probes) {
    result[agent.key] = available;
    if (available) {
      console.log(version
        ? `✅ ${agent.label} detected: ${version} (ACP transport available)`
        : `✅ ${agent.label} detected (ACP transport available)`);
    } else {
      console.log(`⚪ ${agent.label} not detected (binary: ${agent.binary})`);
    }
  }
  if (!result.claude && !result.codex && !result.gemini) {
    console.log(`   No local ACP agents available — will use server-routed agents instead.`);
  }

  return result;
}

/**
 * Display feature summary based on detected tools
 */
export function displayFeatureSummary(
  tools: ToolDetectionResult,
  terminalEnabled: boolean,
  userAuthEnabled?: boolean,
  browserProxyEnabled?: boolean,
  languageServerEnabled?: boolean
): void {
  console.log(`\n=== ${t('features.title')} ===\n`);

  const features: string[] = [];

  // Always available
  features.push(`✅ ${t('features.filesystem')}`);

  // Conditional features
  if (tools.git) {
    features.push(`✅ ${t('features.gitEnabled')}`);
  } else {
    features.push(`❌ ${t('features.gitDisabled')}`);
  }

  if (tools.ripgrep) {
    features.push(`✅ ${t('features.searchFast')}`);
  } else {
    features.push(`⚠️  ${t('features.searchBasic')}`);
  }

  if (terminalEnabled) {
    features.push(`✅ ${t('features.terminalEnabled')}`);
  } else {
    features.push(`❌ ${t('features.terminalDisabled')}`);
  }

  if (browserProxyEnabled !== false) {
    features.push(`✅ ${t('features.browserProxyEnabled')}`);
  } else {
    features.push(`❌ ${t('features.browserProxyDisabled')}`);
  }

  if (languageServerEnabled !== false) {
    features.push(`✅ ${t('features.lspEnabled')}`);
  } else {
    features.push(`❌ ${t('features.lspDisabled')}`);
  }

  const acpAgents: string[] = [];
  if (tools.claude) acpAgents.push('Claude Code');
  if (tools.codex) acpAgents.push('Codex');
  if (tools.gemini) acpAgents.push('Gemini CLI');
  if (acpAgents.length > 0) {
    features.push(`✅ ACP agents: ${acpAgents.join(', ')}`);
  } else {
    features.push(`⚠️  ACP agents (no local agent binaries on PATH)`);
  }

  features.forEach(feature => console.log(`   ${feature}`));

  // Display authentication mode
  console.log(`\n=== ${t('features.securityTitle')} ===\n`);
  if (userAuthEnabled) {
    console.log(`   🔐 ${t('features.userAuthEnabled')}`);
    console.log(`   → ${t('features.userAuthEnabledHint1')}`);
    console.log(`   → ${t('features.userAuthEnabledHint2')}`);
    console.log(`   → ${t('features.userAuthEnabledHint3')}\n`);
  } else {
    console.log(`   🔓 ${t('features.userAuthDisabled')}`);
    console.log(`   → ${t('features.userAuthDisabledHint1')}`);
    console.log(`   → ${t('features.userAuthDisabledHint2')}`);
    console.log(`   → ${t('features.userAuthDisabledHint3')}\n`);
  }
}
