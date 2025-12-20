/**
 * Tool detection for git and ripgrep
 * Checks if required tools are installed and displays warnings
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { ToolDetectionResult } from '../types';

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
export async function detectTools(): Promise<ToolDetectionResult> {
  console.log('\n=== Tool Detection ===\n');

  const result: ToolDetectionResult = {
    git: false,
    ripgrep: false
  };

  // Check Git
  result.git = await isCommandAvailable('git');

  if (result.git) {
    try {
      const { stdout } = await execAsync('git --version');
      console.log(`✅ Git detected: ${stdout.trim()}`);
    } catch {
      console.log('✅ Git detected');
    }
  } else {
    console.warn('⚠️  Git not detected');
    console.warn('   Git features will be disabled in this session.');
    console.warn('   Install Git to enable version control features:');
    console.warn('   https://git-scm.com/downloads\n');
  }

  // Check Ripgrep
  result.ripgrep = await isCommandAvailable('rg');

  if (result.ripgrep) {
    try {
      const { stdout } = await execAsync('rg --version');
      const firstLine = stdout.split('\n')[0];
      console.log(`✅ Ripgrep detected: ${firstLine}`);
    } catch {
      console.log('✅ Ripgrep detected');
    }
  } else {
    console.warn('⚠️  Ripgrep not detected');
    console.warn('   Fast search features will be disabled in this session.');
    console.warn('   Install ripgrep for high-performance code search:');
    console.warn('   https://github.com/BurntSushi/ripgrep#installation\n');
  }

  return result;
}

/**
 * Display feature summary based on detected tools
 */
export function displayFeatureSummary(
  tools: ToolDetectionResult,
  terminalEnabled: boolean
): void {
  console.log('\n=== Available Features ===\n');

  const features: string[] = [];

  // Always available
  features.push('✅ Filesystem operations');

  // Conditional features
  if (tools.git) {
    features.push('✅ Git version control');
  } else {
    features.push('❌ Git version control (git not installed)');
  }

  if (tools.ripgrep) {
    features.push('✅ Fast search (ripgrep)');
  } else {
    features.push('⚠️  Basic search (ripgrep not installed)');
  }

  if (terminalEnabled) {
    features.push('✅ Terminal service');
  } else {
    features.push('❌ Terminal service (disabled in config)');
  }

  features.forEach(feature => console.log(`   ${feature}`));
  console.log('');
}
