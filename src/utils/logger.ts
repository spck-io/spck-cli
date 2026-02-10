/**
 * Simple, readable logging utility for network operations
 */

import chalk from 'chalk';
import * as path from 'path';
import * as fs from 'fs';

const LOG_RETENTION_DAYS = 30;
let logDirInitialized = false;
let cleanupScheduled = false;

/**
 * Get log directory path (lazy - doesn't create it)
 */
function getLogDir(): string {
  return path.join(process.cwd(), '.spck-editor', 'logs');
}

/**
 * Ensure log directory exists (lazy initialization)
 * Called only when actually writing logs
 */
function ensureLogDirectory(): void {
  if (logDirInitialized) {
    return;
  }

  try {
    const logDir = getLogDir();

    // Check if .spck-editor exists and is accessible
    const spckEditorDir = path.join(process.cwd(), '.spck-editor');
    if (!fs.existsSync(spckEditorDir)) {
      // .spck-editor directory not set up yet - skip logging to file
      return;
    }

    // Create logs subdirectory if needed
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    logDirInitialized = true;

    // Schedule cleanup only once, after first successful initialization
    if (!cleanupScheduled) {
      cleanupScheduled = true;
      // Run cleanup after a short delay (not immediately on import)
      setTimeout(() => {
        cleanOldLogs();
        setInterval(cleanOldLogs, 24 * 60 * 60 * 1000).unref();
      }, 1000).unref();
    }
  } catch (error) {
    // Silently fail if we can't create log directory
    // Logging will just go to console only
  }
}

/**
 * Get current log file path with date
 */
function getCurrentLogFile(): string {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return path.join(getLogDir(), `spck-cli-${date}.log`);
}

/**
 * Clean up old log files (retention policy)
 */
function cleanOldLogs(): void {
  try {
    const logDir = getLogDir();
    if (!fs.existsSync(logDir)) {
      return;
    }

    const files = fs.readdirSync(logDir);
    const now = Date.now();
    const retentionMs = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (file.startsWith('spck-cli-') && file.endsWith('.log')) {
        const filePath = path.join(logDir, file);
        const stats = fs.statSync(filePath);

        if (now - stats.mtimeMs > retentionMs) {
          fs.unlinkSync(filePath);
          console.log(chalk.gray(`[Logger] Deleted old log file: ${file}`));
        }
      }
    }
  } catch (error) {
    // Silently fail cleanup errors
  }
}

/**
 * Format timestamp for display (compact format for files)
 * Format: MM-DD HH:MM:SS
 */
function formatTime(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Format timestamp for terminal display (compact format)
 */
function formatTimeCompact(): string {
  const now = new Date();
  // Format: HH:MM:SS
  return now.toTimeString().substring(0, 8);
}

/**
 * Format UID for display (truncate if needed)
 */
function formatUid(uid: string, maxLen: number = 12): string {
  if (uid.length <= maxLen) return uid;
  return uid.substring(0, maxLen - 3) + '...';
}

/**
 * Write log entry to file
 */
function writeToFile(message: string): void {
  try {
    // Lazy initialization - only create log directory when actually writing
    ensureLogDirectory();

    if (!logDirInitialized) {
      // Log directory couldn't be initialized, skip file logging
      return;
    }

    const logFile = getCurrentLogFile();
    const timestamp = formatTime();
    fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
  } catch (error) {
    // Silently fail file writes to not disrupt service
  }
}

/**
 * Format path for display (truncate if too long)
 */
function formatPath(p: string | undefined, maxLen: number = 50): string {
  if (!p) return '';
  if (p.length <= maxLen) return p;
  return '...' + p.substring(p.length - maxLen + 3);
}

/**
 * Log a filesystem read operation
 */
export function logFsRead(
  method: string,
  params: {
    path?: string;
    src?: string;
    target?: string;
    oldpath?: string;
    [key: string]: any;
  },
  uid: string,
  success: boolean,
  error?: any,
  metadata?: Record<string, any>
): void {
  const filepath = params.path || params.src || params.oldpath;
  const displayPath = formatPath(filepath);
  const metaStr = metadata ? ` ${chalk.gray(JSON.stringify(metadata))}` : '';
  const timestamp = chalk.gray(formatTimeCompact());
  const uidStr = chalk.gray(formatUid(uid));

  if (success) {
    const msg = `${timestamp} ${uidStr} ${chalk.green('✓')} ${chalk.cyan('FS')} ${chalk.white(method.padEnd(12))} ${chalk.gray(displayPath)}${metaStr}`;
    console.log(msg);
    writeToFile(`[INFO] FS READ ${method} ${filepath} uid=${uid} success=true${metaStr}`);
  } else {
    const errMsg = error?.message || String(error);
    const msg = `${timestamp} ${uidStr} ${chalk.red('✗')} ${chalk.cyan('FS')} ${chalk.white(method.padEnd(12))} ${chalk.gray(displayPath)} ${chalk.red(errMsg)}`;
    console.log(msg);
    writeToFile(`[ERROR] FS READ ${method} ${filepath} uid=${uid} success=false error="${errMsg}"`);
  }
}

/**
 * Log a filesystem write operation
 */
export function logFsWrite(
  method: string,
  params: {
    path?: string;
    src?: string;
    target?: string;
    oldpath?: string;
    [key: string]: any;
  },
  uid: string,
  success: boolean,
  error?: any,
  metadata?: Record<string, any>
): void {
  const filepath = params.path || params.src || params.target || params.oldpath;
  const displayPath = formatPath(filepath);
  const srcTarget = params.src && params.target
    ? `${formatPath(params.src, 25)} → ${formatPath(params.target, 25)}`
    : displayPath;
  const metaStr = metadata ? ` ${chalk.gray(JSON.stringify(metadata))}` : '';
  const timestamp = chalk.gray(formatTimeCompact());
  const uidStr = chalk.gray(formatUid(uid));

  if (success) {
    const msg = `${timestamp} ${uidStr} ${chalk.green('✓')} ${chalk.yellow('FS')} ${chalk.white(method.padEnd(12))} ${chalk.gray(srcTarget)}${metaStr}`;
    console.log(msg);
    writeToFile(`[INFO] FS WRITE ${method} ${filepath} uid=${uid} success=true${metaStr}`);
  } else {
    const errMsg = error?.message || String(error);
    const msg = `${timestamp} ${uidStr} ${chalk.red('✗')} ${chalk.yellow('FS')} ${chalk.white(method.padEnd(12))} ${chalk.gray(srcTarget)} ${chalk.red(errMsg)}`;
    console.log(msg);
    writeToFile(`[ERROR] FS WRITE ${method} ${filepath} uid=${uid} success=false error="${errMsg}"`);
  }
}

/**
 * Log a git read operation
 */
export function logGitRead(
  method: string,
  params: {
    dir?: string;
    [key: string]: any;
  },
  uid: string,
  success: boolean,
  error?: any,
  metadata?: Record<string, any>
): void {
  const dir = formatPath(params.dir);
  const metaStr = metadata ? ` ${chalk.gray(JSON.stringify(metadata))}` : '';
  const timestamp = chalk.gray(formatTimeCompact());
  const uidStr = chalk.gray(formatUid(uid));

  if (success) {
    const msg = `${timestamp} ${uidStr} ${chalk.green('✓')} ${chalk.magenta('GIT')} ${chalk.white(method.padEnd(12))} ${chalk.gray(dir)}${metaStr}`;
    console.log(msg);
    writeToFile(`[INFO] GIT READ ${method} dir=${params.dir} uid=${uid} success=true${metaStr}`);
  } else {
    const errMsg = error?.message || String(error);
    const msg = `${timestamp} ${uidStr} ${chalk.red('✗')} ${chalk.magenta('GIT')} ${chalk.white(method.padEnd(12))} ${chalk.gray(dir)} ${chalk.red(errMsg)}`;
    console.log(msg);
    writeToFile(`[ERROR] GIT READ ${method} dir=${params.dir} uid=${uid} success=false error="${errMsg}"`);
  }
}

/**
 * Log a git write operation
 */
export function logGitWrite(
  method: string,
  params: {
    dir?: string;
    message?: string;
    filepaths?: string[];
    ref?: string;
    [key: string]: any;
  },
  uid: string,
  success: boolean,
  error?: any,
  metadata?: Record<string, any>
): void {
  const dir = formatPath(params.dir);
  const details = [];
  if (params.message) details.push(`msg="${params.message.substring(0, 30)}${params.message.length > 30 ? '...' : ''}"`);
  if (params.filepaths?.length) details.push(`files=${params.filepaths.length}`);
  if (params.ref) details.push(`ref=${params.ref}`);
  const detailStr = details.length ? ` ${chalk.gray(details.join(' '))}` : '';
  const metaStr = metadata ? ` ${chalk.gray(JSON.stringify(metadata))}` : '';
  const timestamp = chalk.gray(formatTimeCompact());
  const uidStr = chalk.gray(formatUid(uid));

  if (success) {
    const msg = `${timestamp} ${uidStr} ${chalk.green('✓')} ${chalk.yellow('GIT')} ${chalk.white(method.padEnd(12))} ${chalk.gray(dir)}${detailStr}${metaStr}`;
    console.log(msg);
    writeToFile(`[INFO] GIT WRITE ${method} dir=${params.dir} uid=${uid} success=true${detailStr}${metaStr}`);
  } else {
    const errMsg = error?.message || String(error);
    const msg = `${timestamp} ${uidStr} ${chalk.red('✗')} ${chalk.yellow('GIT')} ${chalk.white(method.padEnd(12))} ${chalk.gray(dir)} ${chalk.red(errMsg)}`;
    console.log(msg);
    writeToFile(`[ERROR] GIT WRITE ${method} dir=${params.dir} uid=${uid} success=false error="${errMsg}"`);
  }
}

/**
 * Log a terminal read operation
 */
export function logTerminalRead(
  method: string,
  params: {
    terminalId?: string;
    [key: string]: any;
  },
  uid: string,
  success: boolean,
  error?: any,
  metadata?: Record<string, any>
): void {
  const termId = params.terminalId || 'all';
  const metaStr = metadata ? ` ${chalk.gray(JSON.stringify(metadata))}` : '';
  const timestamp = chalk.gray(formatTimeCompact());
  const uidStr = chalk.gray(formatUid(uid));

  if (success) {
    const msg = `${timestamp} ${uidStr} ${chalk.green('✓')} ${chalk.blue('TERM')} ${chalk.white(method.padEnd(12))} ${chalk.gray(termId)}${metaStr}`;
    console.log(msg);
    writeToFile(`[INFO] TERMINAL READ ${method} terminalId=${termId} uid=${uid} success=true${metaStr}`);
  } else {
    const errMsg = error?.message || String(error);
    const msg = `${timestamp} ${uidStr} ${chalk.red('✗')} ${chalk.blue('TERM')} ${chalk.white(method.padEnd(12))} ${chalk.gray(termId)} ${chalk.red(errMsg)}`;
    console.log(msg);
    writeToFile(`[ERROR] TERMINAL READ ${method} terminalId=${termId} uid=${uid} success=false error="${errMsg}"`);
  }
}

/**
 * Log a terminal write operation
 */
export function logTerminalWrite(
  method: string,
  params: {
    terminalId?: string;
    data?: string;
    cols?: number;
    rows?: number;
    [key: string]: any;
  },
  uid: string,
  success: boolean,
  error?: any,
  metadata?: Record<string, any>
): void {
  const termId = params.terminalId || metadata?.terminalId || 'new';
  const details = [];
  if (params.cols && params.rows) details.push(`${params.cols}x${params.rows}`);
  if (params.data) details.push(`${params.data.length}b`);
  const detailStr = details.length ? ` ${chalk.gray(details.join(' '))}` : '';
  const metaStr = metadata && !metadata.terminalId ? ` ${chalk.gray(JSON.stringify(metadata))}` : '';
  const timestamp = chalk.gray(formatTimeCompact());
  const uidStr = chalk.gray(formatUid(uid));

  if (success) {
    const msg = `${timestamp} ${uidStr} ${chalk.green('✓')} ${chalk.yellow('TERM')} ${chalk.white(method.padEnd(12))} ${chalk.gray(termId)}${detailStr}${metaStr}`;
    console.log(msg);
    writeToFile(`[INFO] TERMINAL WRITE ${method} terminalId=${termId} uid=${uid} success=true${detailStr}${metaStr}`);
  } else {
    const errMsg = error?.message || String(error);
    const msg = `${timestamp} ${uidStr} ${chalk.red('✗')} ${chalk.yellow('TERM')} ${chalk.white(method.padEnd(12))} ${chalk.gray(termId)} ${chalk.red(errMsg)}`;
    console.log(msg);
    writeToFile(`[ERROR] TERMINAL WRITE ${method} terminalId=${termId} uid=${uid} success=false error="${errMsg}"`);
  }
}

/**
 * Log a search operation
 */
export function logSearchRead(
  method: string,
  params: {
    path?: string;
    searchTerm?: string;
    [key: string]: any;
  },
  uid: string,
  success: boolean,
  error?: any,
  metadata?: Record<string, any>
): void {
  const filepath = formatPath(params.path);
  const searchTerm = params.searchTerm ? `"${params.searchTerm.substring(0, 30)}${params.searchTerm.length > 30 ? '...' : ''}'"` : '';
  const details = [];
  if (searchTerm) details.push(searchTerm);
  if (metadata?.matches !== undefined) details.push(`matches=${metadata.matches}`);
  if (metadata?.method) details.push(metadata.method);
  const detailStr = details.length ? ` ${chalk.gray(details.join(' '))}` : '';
  const metaStr = metadata && !metadata.matches && !metadata.method ? ` ${chalk.gray(JSON.stringify(metadata))}` : '';
  const timestamp = chalk.gray(formatTimeCompact());
  const uidStr = chalk.gray(formatUid(uid));

  if (success) {
    const msg = `${timestamp} ${uidStr} ${chalk.green('✓')} ${chalk.green('SEARCH')} ${chalk.white(method.padEnd(12))} ${chalk.gray(filepath)}${detailStr}${metaStr}`;
    console.log(msg);
    writeToFile(`[INFO] SEARCH ${method} ${params.path} searchTerm="${params.searchTerm}" uid=${uid} success=true${detailStr}${metaStr}`);
  } else {
    const errMsg = error?.message || String(error);
    const msg = `${timestamp} ${uidStr} ${chalk.red('✗')} ${chalk.green('SEARCH')} ${chalk.white(method.padEnd(12))} ${chalk.gray(filepath)} ${chalk.red(errMsg)}`;
    console.log(msg);
    writeToFile(`[ERROR] SEARCH ${method} ${params.path} searchTerm="${params.searchTerm}" uid=${uid} success=false error="${errMsg}"`);
  }
}

/**
 * Log an authentication event
 */
export function logAuth(
  event: string,
  details: Record<string, any>,
  level: 'info' | 'warn' | 'error' = 'info'
): void {
  const timestamp = chalk.gray(formatTimeCompact());
  const deviceId = details.deviceId ? chalk.gray(formatUid(details.deviceId)) : '';
  const userId = details.userId ? chalk.gray(`user=${details.userId}`) : '';
  const metaStr = Object.entries(details)
    .filter(([key]) => key !== 'deviceId' && key !== 'userId')
    .map(([key, val]) => `${key}=${val}`)
    .join(' ');

  let symbol: string;
  let color: (str: string) => string;
  let logLevel: string;

  if (level === 'error') {
    symbol = chalk.red('✗');
    color = chalk.red;
    logLevel = 'ERROR';
  } else if (level === 'warn') {
    symbol = chalk.yellow('⚠');
    color = chalk.yellow;
    logLevel = 'WARN';
  } else {
    symbol = chalk.green('✓');
    color = chalk.green;
    logLevel = 'INFO';
  }

  const msg = `${timestamp} ${deviceId} ${userId} ${symbol} ${color('AUTH')} ${chalk.white(event.padEnd(20))} ${chalk.gray(metaStr)}`;
  console.log(msg);
  writeToFile(`[${logLevel}] AUTH ${event} ${metaStr}`);
}

/**
 * Log connection events (client connecting, authenticated, disconnected)
 */
export function logConnection(
  event: 'connecting' | 'authenticated' | 'auth_failed' | 'disconnected' | 'ready',
  deviceId?: string,
  metadata?: Record<string, any>
): void {
  const timestamp = chalk.gray(formatTimeCompact());
  const deviceStr = deviceId ? chalk.gray(formatUid(deviceId)) : chalk.gray('...');
  const metaStr = metadata ? ` ${chalk.gray(JSON.stringify(metadata))}` : '';

  let symbol: string;
  let color: (str: string) => string;
  let logLevel: string;

  switch (event) {
    case 'connecting':
      symbol = '🔌';
      color = chalk.blue;
      logLevel = 'INFO';
      break;
    case 'authenticated':
      symbol = chalk.green('✓');
      color = chalk.green;
      logLevel = 'INFO';
      break;
    case 'auth_failed':
      symbol = chalk.red('✗');
      color = chalk.red;
      logLevel = 'ERROR';
      break;
    case 'disconnected':
      symbol = '🔌';
      color = chalk.gray;
      logLevel = 'INFO';
      break;
    case 'ready':
      symbol = '🎉';
      color = chalk.green;
      logLevel = 'INFO';
      break;
    default:
      symbol = 'ℹ';
      color = chalk.gray;
      logLevel = 'INFO';
  }

  const msg = `${timestamp} ${deviceStr} ${symbol} ${color('CONN')} ${chalk.white(event.padEnd(15))}${metaStr}`;
  console.log(msg);
  writeToFile(`[${logLevel}] CONN ${event} deviceId=${deviceId || 'unknown'}${metaStr}`);
}

export default {
  logFsRead,
  logFsWrite,
  logGitRead,
  logGitWrite,
  logTerminalRead,
  logTerminalWrite,
  logSearchRead,
  logAuth,
  logConnection,
};
