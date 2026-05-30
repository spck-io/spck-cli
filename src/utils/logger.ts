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
 * Format byte count as human-readable size string
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Debounce state for browser proxy console output
const BROWSER_PROXY_DEBOUNCE_MS = 1000;
let _browserDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let _browserSuccessCount = 0;
let _browserTotalBytes = 0;
let _browserLastUid = '';

function flushBrowserProxyLog(): void {
  if (_browserSuccessCount === 0) return;
  const timestamp = chalk.gray(formatTimeCompact());
  const uidStr = chalk.gray(formatUid(_browserLastUid));
  const sizeStr = chalk.gray(formatBytes(_browserTotalBytes));
  const countStr = chalk.white(String(_browserSuccessCount));
  console.log(`${timestamp} ${uidStr} ${chalk.green('✓')} ${chalk.blueBright('BROWSER')} ${countStr} files fetched (${sizeStr})`);
  _browserSuccessCount = 0;
  _browserTotalBytes = 0;
  _browserLastUid = '';
  _browserDebounceTimer = null;
}

// Shared core for RPC-style log lines. Every per-service helper below has the
// same structural shape: `<timestamp> <uid> <✓/✗> <CATEGORY> <method col> <detail>
// [extra tokens] [metadata]` on the console, and `[LEVEL] <FILE_TAG> <file body>
// uid=<uid> success=<bool> [extra tokens] [metadata]` to the file log. The
// per-service knobs (category label + color, how to pick `detail`, the inline
// `extraTokens`, the file tag + body) are captured in this options object; the
// helpers below assemble those before delegating.
interface RpcLogOpts {
  category: string;                       // e.g. 'FS', 'GIT', 'ACP'
  color: (s: string) => string;           // chalk color for the category label
  methodLabel: string;                    // middle column text (often `method`)
  detail: string;                         // gray right-of-method text
  extraTokens?: string[];                 // inline gray tokens (msg=…, files=…)
  uid: string;
  success: boolean;
  error?: any;
  metadata?: Record<string, any>;
  fileTag: string;                        // 'FS READ', 'GIT WRITE', 'SEARCH'…
  fileBody: string;                       // text between the tag and `uid=`
  methodPad?: number;                     // padding for the middle column; default 12
}

function logRpc(opts: RpcLogOpts): void {
  const extraStr = opts.extraTokens?.length ? ` ${chalk.gray(opts.extraTokens.join(' '))}` : '';
  const metaStr = opts.metadata ? ` ${chalk.gray(JSON.stringify(opts.metadata))}` : '';
  const ts = chalk.gray(formatTimeCompact());
  const uidStr = chalk.gray(formatUid(opts.uid));
  const categoryCol = opts.color(opts.category);
  const methodCol = chalk.white(opts.methodLabel.padEnd(opts.methodPad ?? 12));

  if (opts.success) {
    console.log(`${ts} ${uidStr} ${chalk.green('✓')} ${categoryCol} ${methodCol} ${chalk.gray(opts.detail)}${extraStr}${metaStr}`);
    writeToFile(`[INFO] ${opts.fileTag} ${opts.fileBody} uid=${opts.uid} success=true${extraStr}${metaStr}`);
  } else {
    const errMsg = opts.error?.message || String(opts.error);
    console.log(`${ts} ${uidStr} ${chalk.red('✗')} ${categoryCol} ${methodCol} ${chalk.gray(opts.detail)} ${chalk.red(errMsg)}`);
    writeToFile(`[ERROR] ${opts.fileTag} ${opts.fileBody} uid=${opts.uid} success=false error="${errMsg}"`);
  }
}

/**
 * Log a filesystem read operation
 */
export function logFsRead(
  method: string,
  params: { path?: string; src?: string; target?: string; oldpath?: string; [key: string]: any },
  uid: string,
  success: boolean,
  error?: any,
  metadata?: Record<string, any>
): void {
  const filepath = params.path || params.src || params.oldpath;
  logRpc({
    category: 'FS', color: chalk.cyan, methodLabel: method,
    detail: formatPath(filepath),
    uid, success, error, metadata,
    fileTag: 'FS READ', fileBody: `${method} ${filepath}`,
  });
}

/**
 * Log a filesystem write operation
 */
export function logFsWrite(
  method: string,
  params: { path?: string; src?: string; target?: string; oldpath?: string; [key: string]: any },
  uid: string,
  success: boolean,
  error?: any,
  metadata?: Record<string, any>
): void {
  const filepath = params.path || params.src || params.target || params.oldpath;
  // src→target rendering for move/copy ops; falls back to the single path.
  const detail = params.src && params.target
    ? `${formatPath(params.src, 25)} → ${formatPath(params.target, 25)}`
    : formatPath(filepath);
  logRpc({
    category: 'FS', color: chalk.yellow, methodLabel: method,
    detail,
    uid, success, error, metadata,
    fileTag: 'FS WRITE', fileBody: `${method} ${filepath}`,
  });
}

/**
 * Log a git read operation
 */
export function logGitRead(
  method: string,
  params: { dir?: string; [key: string]: any },
  uid: string,
  success: boolean,
  error?: any,
  metadata?: Record<string, any>
): void {
  logRpc({
    category: 'GIT', color: chalk.magenta, methodLabel: method,
    detail: formatPath(params.dir),
    uid, success, error, metadata,
    fileTag: 'GIT READ', fileBody: `${method} dir=${params.dir}`,
  });
}

/**
 * Log a git write operation
 */
export function logGitWrite(
  method: string,
  params: { dir?: string; message?: string; filepaths?: string[]; ref?: string; [key: string]: any },
  uid: string,
  success: boolean,
  error?: any,
  metadata?: Record<string, any>
): void {
  const extraTokens: string[] = [];
  if (params.message) extraTokens.push(`msg="${params.message.substring(0, 30)}${params.message.length > 30 ? '...' : ''}"`);
  if (params.filepaths?.length) extraTokens.push(`files=${params.filepaths.length}`);
  if (params.ref) extraTokens.push(`ref=${params.ref}`);
  logRpc({
    category: 'GIT', color: chalk.yellow, methodLabel: method,
    detail: formatPath(params.dir), extraTokens,
    uid, success, error, metadata,
    fileTag: 'GIT WRITE', fileBody: `${method} dir=${params.dir}`,
  });
}

/**
 * Log a terminal read operation
 */
export function logTerminalRead(
  method: string,
  params: { terminalId?: string; [key: string]: any },
  uid: string,
  success: boolean,
  error?: any,
  metadata?: Record<string, any>
): void {
  const termId = params.terminalId || 'all';
  logRpc({
    category: 'TERM', color: chalk.blue, methodLabel: method,
    detail: termId,
    uid, success, error, metadata,
    fileTag: 'TERMINAL READ', fileBody: `${method} terminalId=${termId}`,
  });
}

/**
 * Log a terminal write operation
 */
export function logTerminalWrite(
  method: string,
  params: { terminalId?: string; data?: string; cols?: number; rows?: number; [key: string]: any },
  uid: string,
  success: boolean,
  error?: any,
  metadata?: Record<string, any>
): void {
  const termId = params.terminalId || metadata?.terminalId || 'new';
  const extraTokens: string[] = [];
  if (params.cols && params.rows) extraTokens.push(`${params.cols}x${params.rows}`);
  if (params.data) extraTokens.push(`${params.data.length}b`);
  // `terminalId` in metadata is already shown as the detail — strip it so we
  // don't render the same id twice on the line.
  const cleanedMeta = metadata && !metadata.terminalId ? metadata : undefined;
  logRpc({
    category: 'TERM', color: chalk.yellow, methodLabel: method,
    detail: termId, extraTokens,
    uid, success, error, metadata: cleanedMeta,
    fileTag: 'TERMINAL WRITE', fileBody: `${method} terminalId=${termId}`,
  });
}

/**
 * Log a search operation
 */
export function logSearchRead(
  method: string,
  params: { path?: string; searchTerm?: string; [key: string]: any },
  uid: string,
  success: boolean,
  error?: any,
  metadata?: Record<string, any>
): void {
  const extraTokens: string[] = [];
  if (params.searchTerm) {
    const trimmed = params.searchTerm.substring(0, 30) + (params.searchTerm.length > 30 ? '...' : '');
    extraTokens.push(`"${trimmed}'"`);
  }
  if (metadata?.matches !== undefined) extraTokens.push(`matches=${metadata.matches}`);
  if (metadata?.method) extraTokens.push(metadata.method);
  // matches/method are already pulled out into extraTokens — only forward
  // remaining metadata to avoid duplicating those keys in the trailing JSON.
  const cleanedMeta = metadata && !metadata.matches && !metadata.method ? metadata : undefined;
  logRpc({
    category: 'SEARCH', color: chalk.green, methodLabel: method,
    detail: formatPath(params.path), extraTokens,
    uid, success, error, metadata: cleanedMeta,
    fileTag: 'SEARCH', fileBody: `${method} ${params.path} searchTerm="${params.searchTerm}"`,
  });
}

/**
 * Log an LSP operation
 */
export function logLsp(
  method: string,
  params: { name?: string; type?: string; types?: string[]; [key: string]: any },
  uid: string,
  success: boolean,
  error?: any,
  metadata?: Record<string, any>
): void {
  // LSP's middle column shows the type(s) rather than the RPC method — same
  // RPC handles many request types, the type is the user-relevant signal.
  const types = params.types?.length ? params.types.join('+') : (params.type || method);
  logRpc({
    category: 'LSP', color: chalk.cyan, methodLabel: types,
    detail: formatPath(params.name),
    uid, success, error, metadata,
    fileTag: 'LSP', fileBody: `${types} ${params.name || ''}`,
  });
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

/**
 * Log a browser proxy request
 */
export function logBrowserProxy(
  params: {
    url?: string;
    method?: string;
    requestId?: string;
    [key: string]: any;
  },
  uid: string,
  success: boolean,
  error?: any,
  metadata?: Record<string, any>
): void {
  const httpMethod = (params.method || 'GET').toUpperCase();

  if (success) {
    writeToFile(`[INFO] BROWSER PROXY ${httpMethod} ${params.url} uid=${uid} success=true status=${metadata?.status}`);
    // Accumulate and debounce console output into a single summary line
    _browserSuccessCount++;
    _browserTotalBytes += metadata?.size ?? 0;
    _browserLastUid = uid;
    if (_browserDebounceTimer) clearTimeout(_browserDebounceTimer);
    _browserDebounceTimer = setTimeout(flushBrowserProxyLog, BROWSER_PROXY_DEBOUNCE_MS);
  } else {
    const displayUrl = formatPath(params.url, 60);
    const timestamp = chalk.gray(formatTimeCompact());
    const uidStr = chalk.gray(formatUid(uid));
    const errMsg = error?.message || String(error);
    const msg = `${timestamp} ${uidStr} ${chalk.red('✗')} ${chalk.blueBright('BROWSER')} ${chalk.white(httpMethod.padEnd(7))} ${chalk.gray(displayUrl)} ${chalk.red(errMsg)}`;
    console.log(msg);
    writeToFile(`[ERROR] BROWSER PROXY ${httpMethod} ${params.url} uid=${uid} success=false error="${errMsg}"`);
  }
}

/**
 * Log an ACP RPC call (capabilities, newSession, setModel, prompt, cancel,
 * closeSession). Detail is the chatId for session-scoped calls, or the
 * model id for setModel — whatever helps identify the call at a glance.
 */
export function logAcp(
  method: string,
  params: { chatId?: string; model?: string | null; [key: string]: any },
  uid: string,
  success: boolean,
  error?: any,
  metadata?: Record<string, any>
): void {
  const detail = params.chatId ? formatUid(params.chatId) : (params.model || '');
  logRpc({
    category: 'ACP', color: chalk.magenta, methodLabel: method,
    detail,
    uid, success, error, metadata,
    fileTag: 'ACP', fileBody: `${method} chatId=${params.chatId || ''} model=${params.model || ''}`,
    methodPad: 14,
  });
}

export default {
  logFsRead,
  logFsWrite,
  logGitRead,
  logGitWrite,
  logTerminalRead,
  logTerminalWrite,
  logSearchRead,
  logLsp,
  logBrowserProxy,
  logAuth,
  logConnection,
  logAcp,
};
