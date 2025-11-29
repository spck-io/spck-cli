/**
 * Interactive setup wizard for spck-networking
 * Uses spck.io OAuth device flow for authentication
 */

import * as readline from 'readline';
import * as crypto from 'crypto';
import fetch from 'node-fetch';
import { createDefaultConfig, saveConfig } from '../config/config';
import { ServerConfig } from '../types';

const SPCK_AUTH_URL = 'https://spck.io/server-auth';
const POLL_INTERVAL = 5000; // 5 seconds

interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
}

interface PollResponse {
  status: 'pending' | 'authorized' | 'expired';
  uid?: string;
  signingKey?: string;
}

/**
 * Create readline interface
 */
function createPrompt(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * Prompt user for input
 */
function question(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      resolve(answer);
    });
  });
}

/**
 * Generate device code
 */
function generateDeviceCode(): DeviceCodeResponse {
  const deviceCode = crypto.randomBytes(32).toString('hex');
  const userCode = crypto.randomBytes(3).toString('hex').toUpperCase();

  return {
    deviceCode,
    userCode,
    verificationUrl: `${SPCK_AUTH_URL}?code=${userCode}`,
    expiresIn: 600, // 10 minutes
  };
}

/**
 * Poll for authorization (simulated - would call spck.io API in production)
 */
async function pollForAuthorization(deviceCode: string): Promise<PollResponse> {
  // This is a simulation - in production, this would call spck.io API
  // For now, we'll return a mock response

  console.log('Polling for authorization...');

  // Simulate API call
  // In production:
  // const response = await fetch(`${SPCK_AUTH_URL}/poll`, {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({ deviceCode })
  // });
  // return await response.json();

  // Mock response for demonstration
  return {
    status: 'pending',
  };
}

/**
 * Run the setup wizard
 */
export async function runSetup(configPath?: string): Promise<ServerConfig> {
  const rl = createPrompt();

  console.log('\n=== Spck Networking Server Setup ===\n');

  try {
    // Step 1: Root directory
    const root = await question(rl, 'Root directory to serve [current directory]: ');
    const rootPath = root.trim() || process.cwd();

    // Step 2: Port
    const portInput = await question(rl, 'Server port [3000]: ');
    const port = parseInt(portInput) || 3000;

    // Step 3: Authentication via spck.io OAuth device flow
    console.log('\n=== Authentication Setup ===');
    console.log('Opening browser for authentication...\n');

    // Generate device code
    const deviceAuth = generateDeviceCode();

    console.log(`Please visit: ${deviceAuth.verificationUrl}`);
    console.log(`Enter code: ${deviceAuth.userCode}`);
    console.log(`\nWaiting for authorization...`);

    // In production, this would poll spck.io API
    // For now, we'll ask the user to enter their Firebase UID manually
    console.log('\n[Development Mode: Manual UID Entry]');
    const uid = await question(rl, 'Enter your Firebase UID: ');

    if (!uid.trim()) {
      console.error('UID is required');
      rl.close();
      process.exit(1);
    }

    // Generate HMAC signing key
    const signingKey = crypto.randomBytes(32).toString('base64');

    // Step 5: Create configuration
    const config = createDefaultConfig({
      port,
      root: rootPath,
      allowedUids: [uid.trim()],
      signingKey,
    });

    // Save configuration
    saveConfig(config, configPath);

    console.log('\n=== Setup Complete ===');
    console.log(`Configuration saved to: ${configPath || '.spck-editor/spck-networking.config.json'}`);
    console.log(`\nClient configuration:`);
    console.log(`  Server URL: ws://localhost:${port}/connect`);
    console.log(`  HMAC Signing Key: ${signingKey}`);
    console.log(`\nKeep the signing key secure and provide it to authorized clients.`);

    return config;

  } catch (error) {
    console.error('\nSetup failed:', error);
    throw error;
  } finally {
    rl.close();
  }
}
