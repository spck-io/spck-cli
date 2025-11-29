#!/usr/bin/env node

/**
 * CLI entry point for spck-networking server
 */

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const path = require('path');

const argv = yargs(hideBin(process.argv))
  .option('config', {
    alias: 'c',
    type: 'string',
    description: 'Path to configuration file',
    default: '.spck-editor/spck-networking.config.json',
  })
  .option('setup', {
    type: 'boolean',
    description: 'Run interactive setup wizard',
    default: false,
  })
  .option('port', {
    alias: 'p',
    type: 'number',
    description: 'Server port',
  })
  .option('root', {
    alias: 'r',
    type: 'string',
    description: 'Root directory to serve',
  })
  .help()
  .alias('help', 'h')
  .version()
  .alias('version', 'v').argv;

async function main() {
  if (argv.setup) {
    // Run setup wizard
    const { runSetup } = require('../dist/setup/wizard');
    await runSetup();
  } else {
    // Start server
    const { startServer } = require('../dist/index');

    // Override config if CLI options provided
    if (argv.port || argv.root) {
      console.log('Note: CLI options override config file values');
    }

    await startServer(argv.config);
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
