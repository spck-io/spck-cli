#!/usr/bin/env node

/**
 * CLI entry point - thin wrapper that executes the main TypeScript entry point
 * All CLI logic is in dist/index.js (compiled from src/index.ts)
 */

import { validateCurrentWorkingDirectory } from './validate-cwd.js';

// CRITICAL: Validate CWD BEFORE importing any other modules
// Many Node.js modules call process.cwd() during initialization and will crash
// if the current directory doesn't exist (deleted, network fs unmounted, etc.)
validateCurrentWorkingDirectory();

import('../dist/index.js').then((module) => {
  module.main().catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
});
