import os from 'os';

/**
 * Validate current working directory and recover if invalid
 *
 * This MUST be called before importing any modules that might call process.cwd()
 * during initialization (e.g., yargs, graceful-fs, @npmcli/config).
 *
 * Handles edge case where:
 * - User cd'd into a directory that was then deleted
 * - Network filesystem became inaccessible
 * - Directory permissions changed
 */
export function validateCurrentWorkingDirectory() {
  try {
    process.cwd();
  } catch (error) {
    if (error.code === 'ENOENT') {
      // Current directory doesn't exist - fall back to home directory
      const homeDir = os.homedir();

      console.error('\n⚠️  Warning: Current working directory no longer exists');
      console.error(`   Changing to home directory: ${homeDir}\n`);

      try {
        process.chdir(homeDir);
        console.log('✅ Successfully changed to home directory\n');
      } catch (chdirError) {
        console.error('\n❌ Fatal Error: Cannot access home directory');
        console.error('   Your filesystem may be corrupted or inaccessible.');
        console.error(`   Error: ${chdirError.message}\n`);
        process.exit(1);
      }
    } else {
      // Some other error with process.cwd()
      console.error('\n❌ Fatal Error: Cannot determine current working directory');
      console.error(`   Error: ${error.message}\n`);
      process.exit(1);
    }
  }
}
