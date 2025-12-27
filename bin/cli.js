#!/usr/bin/env node

/**
 * CLI entry point - thin wrapper that executes the main TypeScript entry point
 * All CLI logic is in dist/index.js (compiled from src/index.ts)
 */

import('../dist/index.js').then((module) => {
  module.main().catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
});
