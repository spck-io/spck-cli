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
 * Short device id for display (no ellipsis): "wq5jzwu11abc" -> "wq5jzwu1"
 */
function formatUid(uid: string, maxLen: number = 8): string {
  return uid.length <= maxLen ? uid : uid.substring(0, maxLen);
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

// Console layout, one line per event:
//   HH:MM:SS  <symbol>  CATEGORY  message            detail  ·  detail   device xxxxxxxx
const CATEGORY_WIDTH = 7;
const MESSAGE_WIDTH = 28;

type Level = 'ok' | 'info' | 'warn' | 'error';

const LEVEL_SYMBOL: Record<Level, string> = {
  ok: chalk.green('✓'),
  info: chalk.blue('●'),
  warn: chalk.yellow('⚠'),
  error: chalk.red('✗'),
};

// Internal identifiers that only matter in the log file, not on screen.
const HIDDEN_META_KEYS = new Set(['connectionId', 'newConnectionId', 'userId', 'deviceId', 'firstConnection', 'clientId']);

/**
 * Render metadata as readable "key: value" text, skipping internal ids.
 */
function formatMeta(metadata?: Record<string, any>): string[] {
  if (!metadata) return [];
  return Object.entries(metadata)
    .filter(([key, val]) => !HIDDEN_META_KEYS.has(key) && val !== undefined && val !== null && val !== '')
    .map(([key, val]) => `${key}: ${typeof val === 'object' ? JSON.stringify(val) : val}`);
}

/**
 * Plain (uncolored) metadata for the log file.
 */
function plainMeta(metadata?: Record<string, any>): string {
  return metadata ? ` ${JSON.stringify(metadata)}` : '';
}

function consoleLine(opts: {
  level: Level;
  category: string;
  color: (s: string) => string;
  message: string;
  details?: string[];
  error?: string;
  device?: string;
  messageWidth?: number;
}): void {
  const parts = [
    chalk.gray(formatTimeCompact()),
    LEVEL_SYMBOL[opts.level],
    opts.color(opts.category.padEnd(CATEGORY_WIDTH)),
    chalk.white(opts.message.padEnd(opts.messageWidth ?? MESSAGE_WIDTH)),
  ];
  const details = (opts.details ?? []).filter(Boolean).join(chalk.gray(' · '));
  if (details) parts.push(chalk.gray(details));
  if (opts.error) parts.push(chalk.red(opts.error));
  if (opts.device) parts.push(chalk.gray(`[${formatUid(opts.device)}]`));
  console.log(parts.join('  ').trimEnd());
}

// Debounce state for browser proxy console output
const BROWSER_PROXY_DEBOUNCE_MS = 1000;
let _browserDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let _browserSuccessCount = 0;
let _browserTotalBytes = 0;
let _browserLastUid = '';

function flushBrowserProxyLog(): void {
  if (_browserSuccessCount === 0) return;
  consoleLine({
    level: 'ok', category: 'BROWSER', color: chalk.blueBright,
    message: `Fetched ${_browserSuccessCount} ${_browserSuccessCount === 1 ? 'file' : 'files'}`,
    details: [formatBytes(_browserTotalBytes)],
    device: _browserLastUid,
  });
  _browserSuccessCount = 0;
  _browserTotalBytes = 0;
  _browserLastUid = '';
  _browserDebounceTimer = null;
}

// Shared core for RPC-style log lines (FS, GIT, TERM, SEARCH, LSP, ACP). The
// per-service knobs (category label + color, how to pick `detail`, the inline
// `extraTokens`, the file tag + body) are captured in this options object; the
// helpers below assemble those before delegating.
interface RpcLogOpts {
  category: string;                       // e.g. 'FS', 'GIT', 'ACP'
  color: (s: string) => string;           // chalk color for the category label
  methodLabel: string;                    // message column text (often `method`)
  detail: string;                         // right-of-method text (path, dir, id)
  extraTokens?: string[];                 // inline tokens (msg=…, files=…)
  uid: string;
  success: boolean;
  error?: any;
  metadata?: Record<string, any>;
  fileTag: string;                        // 'FS READ', 'GIT WRITE', 'SEARCH'…
  fileBody: string;                       // text between the tag and `uid=`
  methodPad?: number;                     // padding for the message column
}

function logRpc(opts: RpcLogOpts): void {
  const details = [opts.detail, ...(opts.extraTokens ?? []), ...formatMeta(opts.metadata)];
  if (opts.success) {
    consoleLine({
      level: 'ok', category: opts.category, color: opts.color,
      message: opts.methodLabel, messageWidth: opts.methodPad ?? 20,
      details, device: opts.uid,
    });
    writeToFile(`[INFO] ${opts.fileTag} ${opts.fileBody} uid=${opts.uid} success=true${opts.extraTokens?.length ? ' ' + opts.extraTokens.join(' ') : ''}${plainMeta(opts.metadata)}`);
  } else {
    const errMsg = opts.error?.message || String(opts.error);
    consoleLine({
      level: 'error', category: opts.category, color: opts.color,
      message: opts.methodLabel, messageWidth: opts.methodPad ?? 20,
      details: [opts.detail], error: errMsg, device: opts.uid,
    });
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

const AUTH_LABELS: Record<string, string> = {
  token_refresh_start: 'Refreshing session token',
  token_refresh_success: 'Session token refreshed',
  token_refresh_failed: 'Session token expired',
  token_refresh_error: 'Session token refresh failed',
  reconnect_with_new_token: 'Reconnecting with new token',
  proxy_authenticated: 'Signed in to relay',
  firebase_auth_success: 'Signed in',
  multiple_connection_attempt: 'Another client is connected',
  new_device_connecting: 'New device connecting',
  credentials_corrupted: 'Stored credentials are corrupted',
  connection_settings_corrupted: 'Connection settings are corrupted',
};

const CONNECTION_LABELS: Record<string, string> = {
  connecting: 'Client connecting',
  authenticated: 'Client authenticated',
  auth_failed: 'Authentication failed',
  disconnected: 'Client disconnected',
  ready: 'Client ready',
  fast_lane_open: 'Fast Lane connected',
  fast_lane_closed: 'Fast Lane closed',
  transport_mismatch_dropped: 'Message dropped',
};

/** "some_event_name" -> "Some event name" for events without an explicit label */
function humanize(event: string): string {
  const text = event.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const TRANSPORT_NAMES: Record<string, string> = { relay: 'Relay', fastlane: 'Fast Lane' };

/**
 * Log an authentication event
 */
export function logAuth(
  event: string,
  details: Record<string, any>,
  level: 'info' | 'warn' | 'error' = 'info'
): void {
  const metaStr = Object.entries(details)
    .filter(([key]) => key !== 'deviceId' && key !== 'userId')
    .map(([key, val]) => `${key}=${val}`)
    .join(' ');

  const consoleLevel: Level = level === 'info' ? 'ok' : level;
  consoleLine({
    level: consoleLevel, category: 'AUTH', color: level === 'error' ? chalk.red : level === 'warn' ? chalk.yellow : chalk.green,
    message: AUTH_LABELS[event] ?? humanize(event),
    details: formatMeta(details),
    device: details.deviceId,
  });
  writeToFile(`[${level.toUpperCase()}] AUTH ${event} ${metaStr}`);
}

/**
 * Log connection events (client connecting, authenticated, disconnected)
 */
export function logConnection(
  event: 'connecting' | 'authenticated' | 'auth_failed' | 'disconnected' | 'ready' | 'fast_lane_open' | 'fast_lane_closed' | 'transport_mismatch_dropped',
  deviceId?: string,
  metadata?: Record<string, any>
): void {
  const levels: Record<string, { level: Level; color: (s: string) => string; file: string }> = {
    connecting: { level: 'info', color: chalk.blue, file: 'INFO' },
    authenticated: { level: 'ok', color: chalk.green, file: 'INFO' },
    auth_failed: { level: 'error', color: chalk.red, file: 'ERROR' },
    disconnected: { level: 'info', color: chalk.gray, file: 'INFO' },
    ready: { level: 'ok', color: chalk.green, file: 'INFO' },
    fast_lane_open: { level: 'ok', color: chalk.green, file: 'INFO' },
    fast_lane_closed: { level: 'info', color: chalk.gray, file: 'INFO' },
    transport_mismatch_dropped: { level: 'warn', color: chalk.yellow, file: 'WARN' },
  };
  const style = levels[event] ?? { level: 'info' as Level, color: chalk.gray, file: 'INFO' };

  // Friendlier rendering for the fields these events carry
  const details: string[] = [];
  if (metadata?.reason) details.push(`reason: ${metadata.reason}`);
  if (metadata?.protocolVersion !== undefined) details.push(`protocol v${metadata.protocolVersion}`);
  if (metadata?.pinned && metadata?.received) {
    details.push(`connection uses ${TRANSPORT_NAMES[metadata.pinned] ?? metadata.pinned}, received on ${TRANSPORT_NAMES[metadata.received] ?? metadata.received}`);
  }
  const rest = metadata ? Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !['reason', 'protocolVersion', 'pinned', 'received', 'error'].includes(key))
  ) : undefined;
  details.push(...formatMeta(rest));

  consoleLine({
    level: style.level, category: 'CONN', color: style.color,
    message: CONNECTION_LABELS[event] ?? humanize(event),
    details,
    error: metadata?.error,
    device: deviceId,
  });
  writeToFile(`[${style.file}] CONN ${event} deviceId=${deviceId || 'unknown'}${plainMeta(metadata)}`);
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
    const errMsg = error?.message || String(error);
    consoleLine({
      level: 'error', category: 'BROWSER', color: chalk.blueBright,
      message: httpMethod, messageWidth: 7,
      details: [formatPath(params.url, 60)], error: errMsg, device: uid,
    });
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
