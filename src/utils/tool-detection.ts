/**
 * Tool detection for git and ripgrep
 * Checks if required tools are installed and displays warnings
 */

import { exec } from 'child_process';
import { promisify } from 'util';
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
    ripgrep: false
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

  return result;
}

/**
 * Display feature summary based on detected tools
 */
export function displayFeatureSummary(
  tools: ToolDetectionResult,
  terminalEnabled: boolean,
  userAuthEnabled?: boolean
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
