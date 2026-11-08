/**
 * Full-screen status dashboard shown while the CLI is serving.
 *
 * Logs are captured into a LogBuffer and only shown in the log view [l].
 * The main view shows the relay, connected editors (with ping), Fast Lane
 * status, detected capabilities and toggleable settings, including a keep-awake
 * wake lock.
 */

import * as readline from 'readline';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import { ProxyClient, ProxyStatus, ClientStatus } from '../proxy/ProxyClient.js';
import { ServerConfig, ToolDetectionResult } from '../types.js';
import { formatServerName } from '../config/server-selection.js';
import { t } from '../i18n/index.js';
import { LogBuffer, LogEntry } from './LogBuffer.js';
import { WakeLock } from './WakeLock.js';
import { SETTINGS, SettingDef, toggleSetting } from './settings.js';
import { ESCAPE_TIMEOUT_MS, fit, formatBytes, formatDuration, skipColumns, stripAnsi, truncate, visibleWidth, wrap } from './screen.js';
import { RPCRouter } from '../rpc/router.js';
import type { TerminalSummary } from '../services/TerminalService.js';

type View = 'main' | 'logs' | 'qr' | 'terminals';

type TerminalRow = TerminalSummary & { deviceId: string };

export interface DashboardOptions {
  proxy: ProxyClient;
  config: ServerConfig;
  configPath?: string;
  tools: ToolDetectionResult;
  logs: LogBuffer;
  wakeLock: WakeLock;
  onQuit: () => void;
}

const LABEL_WIDTH = 24;
const QUIT_CONFIRM_MS = 3000;
const QR_SIDE_GAP = 3;
const QR_MIN_SIDE_WIDTH = 24;

// Alternate screen, hidden cursor, and no auto-wrap: a line that a terminal
// measures wider than we do (emoji widths vary) is clipped instead of pushing
// the whole frame down a row.
const ENTER_ALT_SCREEN = '\x1b[?1049h\x1b[?25l\x1b[?7l';
const LEAVE_ALT_SCREEN = '\x1b[?7h\x1b[?25h\x1b[?1049l';
const CLEAR_SCREEN = '\x1b[2J';

export class Dashboard {
  private view: View = 'main';
  private active = false;
  private renderQueued = false;
  private tick: NodeJS.Timeout | null = null;
  private unsubscribers: Array<() => void> = [];
  private readonly startedAt = Date.now();
  // Initial values of settings that only apply after a restart
  private readonly initialValues = new Map<string, boolean>();
  private readonly changedThisSession = new Set<string>();
  private logScroll = 0; // lines scrolled up from the bottom
  private logPan = 0; // columns scrolled right, for reading long lines
  private lastFrame: string | null = null;
  private quitArmedAt = 0;
  private flash: { text: string; at: number } | null = null;
  private qrCache: { url: string; lines: string[]; width: number } | null = null;
  // New projects show the pairing QR until an editor finishes connecting.
  private autoQr = false;
  // Terminals view: selected terminal and a pending kill awaiting a second [x]
  private selectedTerminal: { deviceId: string; id: string } | null = null;
  private killArmed: { id: string; at: number } | null = null;
  // Stable "#n" labels, so numbers don't shift when a terminal goes away
  private readonly terminalNumbers = new Map<string, number>();
  private nextTerminalNumber = 1;

  constructor(private options: DashboardOptions) {
    for (const setting of SETTINGS) {
      this.initialValues.set(setting.id, setting.get(options.config));
    }
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    const { stdin, stdout } = process;

    this.options.logs.setPassthrough(false);
    stdout.write(ENTER_ALT_SCREEN);

    readline.emitKeypressEvents(stdin, { escapeCodeTimeout: ESCAPE_TIMEOUT_MS } as unknown as readline.Interface);
    stdin.setRawMode(true);
    stdin.resume();
    const onKey = (str: string | undefined, key: readline.Key) => this.handleKey(str, key);
    stdin.on('keypress', onKey);
    const onResize = () => this.repaint();
    stdout.on('resize', onResize);

    this.unsubscribers.push(
      () => stdin.off('keypress', onKey),
      () => stdout.off('resize', onResize),
      this.options.proxy.onStatusChange(() => this.onStatusChange()),
      this.options.logs.onAppend((added) => this.onLogAppend(added)),
      this.options.wakeLock.onChange(() => this.scheduleRender()),
    );

    if (!this.options.config.hasConnectedEditor && !this.options.proxy.getStatus().clients.some((client) => client.ready)) {
      this.autoQr = true;
      this.view = 'qr';
    }

    this.tick = setInterval(() => this.scheduleRender(), 1000);
    this.tick.unref();
    this.render();
  }

  /**
   * Restore the terminal. With `printTail`, the most recent log lines are
   * echoed to the normal screen so the reason for an unexpected exit is
   * visible after the alternate screen is gone.
   */
  stop(options: { printTail?: boolean } = {}): void {
    if (!this.active) return;
    this.active = false;
    if (this.tick) clearInterval(this.tick);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];

    const { stdin, stdout } = process;
    try { stdin.setRawMode(false); } catch { /* stdin already closed */ }
    stdin.pause();
    stdout.write(LEAVE_ALT_SCREEN);
    this.options.logs.setPassthrough(true);

    if (options.printTail) {
      const tail = this.options.logs.entries.slice(-20).map((entry) => entry.text);
      stdout.write(tail.join('\n') + '\n');
    }
  }

  get isActive(): boolean {
    return this.active;
  }

  // ---------------------------------------------------------------- input

  private handleKey(str: string | undefined, key: readline.Key): void {
    if (key?.ctrl && key.name === 'c') {
      this.options.onQuit();
      return;
    }
    if (key?.ctrl && key.name === 'l') {
      this.repaint();
      return;
    }
    // Hotkeys are plain letters: Ctrl+U must not flip user verification. Esc
    // is excluded because readline reports it with the meta flag set.
    if ((key?.ctrl || key?.meta) && key.name !== 'escape') return;
    const name = key?.name ?? str;

    if (this.view === 'logs') {
      this.handleLogKey(name, key);
    } else if (this.view === 'terminals') {
      this.handleTerminalsKey(name);
    } else if (this.view === 'qr') {
      if (name === 'escape' || name === 'c' || name === 'return') this.setView('main');
      else if (name === 'l') this.setView('logs');
      else if (name === 'q') this.handleQuitKey();
    } else {
      this.handleMainKey(name);
    }
    this.scheduleRender();
  }

  private handleMainKey(name: string | undefined): void {
    if (name === 'l') return this.setView('logs');
    if (name === 'c') return this.setView('qr');
    if (name === 'm' && this.terminalsEnabled()) return this.setView('terminals');
    if (name === 'q') return this.handleQuitKey();
    if (name === 'w') {
      this.options.wakeLock.toggle();
      return;
    }
    const setting = SETTINGS.find((s) => s.hotkey === name);
    if (setting) this.toggle(setting);
  }

  private handleLogKey(name: string | undefined, key: readline.Key): void {
    const page = Math.max(1, this.logViewHeight() - 1);
    switch (name) {
      case 'escape':
      case 'l':
        this.setView('main');
        break;
      case 'q':
        this.handleQuitKey();
        break;
      case 'up':
      case 'k':
        this.logScroll++;
        break;
      case 'down':
      case 'j':
        this.logScroll--;
        break;
      case 'pageup':
        this.logScroll += page;
        break;
      case 'pagedown':
      case 'space':
        this.logScroll -= page;
        break;
      case 'home':
        this.logScroll = Infinity;
        break;
      case 'end':
        this.logScroll = 0;
        break;
      case 'g':
        this.logScroll = key?.shift ? 0 : Infinity;
        break;
      case 'left':
        this.logPan = Math.max(0, this.logPan - this.logPanStep());
        break;
      case 'right':
        this.logPan += this.logPanStep();
        break;
    }
    this.clampLogScroll();
  }

  private handleTerminalsKey(name: string | undefined): void {
    const terminals = this.terminalRows();
    const index = this.selectedTerminalIndex(terminals);
    switch (name) {
      case 'escape':
      case 'm':
        this.setView('main');
        break;
      case 'l':
        this.setView('logs');
        break;
      case 'q':
        this.handleQuitKey();
        break;
      case 'up':
      case 'k':
        this.selectTerminal(terminals[Math.max(0, index - 1)]);
        break;
      case 'down':
      case 'j':
        this.selectTerminal(terminals[Math.min(terminals.length - 1, index + 1)]);
        break;
      case 'x':
      case 'delete':
        this.killOrRemoveSelected(terminals[index]);
        break;
    }
  }

  private selectTerminal(terminal: TerminalRow | undefined): void {
    if (!terminal) return;
    if (this.selectedTerminal?.id !== terminal.id) this.killArmed = null;
    this.selectedTerminal = { deviceId: terminal.deviceId, id: terminal.id };
  }

  private killOrRemoveSelected(terminal: TerminalRow | undefined): void {
    if (!terminal) return;
    const label = this.terminalLabel(terminal.id);
    if (terminal.exited) {
      if (RPCRouter.removeTerminal(terminal.deviceId, terminal.id)) {
        this.setFlash(t('dashboard.terminalRemoved', { name: label }));
      }
      return;
    }
    // Killing loses the shell and whatever runs in it, so ask for a second press
    if (this.killArmed?.id === terminal.id && Date.now() - this.killArmed.at < QUIT_CONFIRM_MS) {
      this.killArmed = null;
      if (RPCRouter.killTerminal(terminal.deviceId, terminal.id)) {
        console.log(`[Dashboard] Killed terminal ${label}`);
        this.setFlash(t('dashboard.terminalKilled', { name: label }));
      }
      return;
    }
    this.killArmed = { id: terminal.id, at: Date.now() };
    this.setFlash(t('dashboard.terminalKillConfirm', { name: label }));
    setTimeout(() => this.scheduleRender(), QUIT_CONFIRM_MS).unref();
  }

  private handleQuitKey(): void {
    if (Date.now() - this.quitArmedAt < QUIT_CONFIRM_MS) {
      this.options.onQuit();
      return;
    }
    this.quitArmedAt = Date.now();
    this.setFlash(t('dashboard.quitConfirm'));
    setTimeout(() => this.scheduleRender(), QUIT_CONFIRM_MS).unref();
  }

  private setView(view: View): void {
    this.view = view;
    this.killArmed = null;
    this.autoQr = false;
    this.logScroll = 0;
    this.logPan = 0;
  }

  private toggle(setting: SettingDef): void {
    try {
      const enabled = toggleSetting(setting, this.options.config, this.options.configPath);
      this.changedThisSession.add(setting.id);
      console.log(`[Dashboard] ${t(setting.labelKey)}: ${enabled ? 'on' : 'off'}`);
    } catch (error: any) {
      this.setFlash(chalk.red(t('dashboard.saveFailed', { message: error.message })));
      console.error(`[Dashboard] ${t('dashboard.saveFailed', { message: error.message })}`);
    }
  }

  private setFlash(text: string): void {
    this.flash = { text, at: Date.now() };
  }

  // -------------------------------------------------------------- updates

  private onStatusChange(): void {
    // Leave the pairing QR on its own once an editor has connected.
    if (this.autoQr && this.view === 'qr' && this.options.proxy.getStatus().clients.some((client) => client.ready)) {
      this.view = 'main';
      this.autoQr = false;
    }
    this.scheduleRender();
  }

  private onLogAppend(added: number): void {
    // Keep the log view anchored where the user scrolled to.
    if (this.view === 'logs' && this.logScroll > 0) this.logScroll += added;
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.renderQueued || !this.active) return;
    this.renderQueued = true;
    setImmediate(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    if (!this.active) return;
    const width = process.stdout.columns || 80;
    const height = process.stdout.rows || 24;

    let lines: string[];
    if (this.view === 'logs') lines = this.renderLogs(width, height);
    else if (this.view === 'qr') lines = this.renderQr(width, height);
    else if (this.view === 'terminals') lines = this.renderTerminalsView(width, height);
    else lines = this.renderMain(width, height);

    const body = lines.slice(0, height - 1).map((line) => truncate(line, width));
    while (body.length < height - 1) body.push('');
    body.push(this.renderFooter(width));
    const frame = body.map((line) => line + '\x1b[K').join('\r\n');
    // The tick re-renders every second; don't redraw an unchanged screen (this
    // matters over SSH, and when the uptime only changes once a minute).
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;
    process.stdout.write('\x1b[H' + frame);
  }

  /** Redraw from a blank screen, after a resize or when the user asks (Ctrl+L). */
  private repaint(): void {
    this.lastFrame = null;
    if (this.active) process.stdout.write(CLEAR_SCREEN);
    this.render();
  }

  // ------------------------------------------------------------ main view

  private renderMain(width: number, height: number): string[] {
    const status = this.options.proxy.getStatus();
    const available = height - 1; // the footer takes the last row
    const inner = Math.max(20, width - 4);

    // Relay
    const relayState = status.relayConnected
      ? chalk.green('● ' + t('dashboard.relayConnected'))
      : chalk.yellow('● ' + t('dashboard.relayReconnecting'));
    const relay = [this.row(t('dashboard.relay'), `${relayState}  ${chalk.gray(formatServerName(status.relayUrl))}`)];

    // Clients
    const clients = [chalk.bold(t('dashboard.clients'))];
    if (status.clients.length === 0) {
      clients.push('  ' + chalk.gray(t('dashboard.noClients')));
    } else {
      for (const client of status.clients) {
        clients.push('  ' + this.renderClient(client, status.relayConnected));
      }
    }

    // Fast Lane
    const fastLane = [chalk.bold(t('dashboard.fastLane'))];
    for (const line of this.fastLaneLines(status, inner)) fastLane.push('  ' + line);

    // Capabilities
    const capabilities = [chalk.bold(t('dashboard.capabilities'))];
    for (const line of this.capabilityLines(inner)) capabilities.push('  ' + line);

    // Settings
    const settings = [chalk.bold(t('dashboard.settings'))];
    for (const setting of SETTINGS) {
      const enabled = setting.get(this.options.config);
      settings.push('  ' + this.settingRow(setting.hotkey, t(setting.labelKey), enabled, this.settingHint(setting, enabled, status)));
    }
    const wake = this.options.wakeLock;
    const wakeHint = wake.state === 'unavailable'
      ? chalk.red(t('dashboard.wakeUnavailable', { reason: wake.error ?? '' }))
      : chalk.gray(t('dashboard.wakeHint'));
    settings.push('  ' + this.settingRow('w', t('dashboard.settingKeepAwake'), wake.state === 'on', wakeHint));

    // Latest warning / error, so problems are noticed without opening logs
    const latest = this.options.logs.lastNotice();
    const notice = latest ? [this.renderNotice(latest)] : [];

    // Terminals are the one section that can grow large
    const terminals = this.terminalsEnabled() ? this.terminalRows() : null;
    const terminalLines = terminals ? this.terminalLines(terminals, status, null) : [];
    const terminalSection = terminals ? [
      chalk.bold(t('dashboard.terminals')) + (terminals.length > 0 ? chalk.gray('  ' + t('dashboard.terminalsManageHint')) : ''),
      ...terminalLines,
    ] : null;

    const buildSections = (withCapabilities: boolean) => [
      [this.renderHeader(width)],
      relay,
      clients,
      ...(terminalSection ? [terminalSection] : []),
      fastLane,
      ...(withCapabilities ? [capabilities] : []),
      settings,
    ];
    const countRows = (list: string[][]) => list.reduce((sum, section) => sum + section.length, notice.length);
    // Purely informational, so it goes first when the terminal is too short
    const withCapabilities = buildSections(true);
    const sections = countRows(withCapabilities) > available ? buildSections(false) : withCapabilities;
    const rows = countRows(sections);
    // Give up the blank lines between sections before hiding any content
    const compact = rows + sections.length - 1 + notice.length > available;

    const overflow = rows - available;
    if (terminalSection && overflow > 0 && terminalLines.length > 1) {
      const shown = Math.max(0, terminalLines.length - overflow - 1);
      const more = '  ' + chalk.gray(t('dashboard.moreTerminals', { count: terminalLines.length - shown }));
      terminalSection.splice(1 + shown, terminalLines.length - shown, more);
    }

    const body = sections.flatMap((section, i) => (compact || i === 0 ? section : ['', ...section]));
    // The latest problem stays visible even if something else has to be cut
    if (compact) return [...body.slice(0, Math.max(0, available - notice.length)), ...notice];
    return [...body, ...notice.flatMap((line) => ['', line])];
  }

  /** Tools found at startup, wrapped between items rather than inside one. */
  private capabilityLines(inner: number): string[] {
    const { tools, config } = this.options;
    const item = (available: boolean, label: string, detail?: string) =>
      available
        ? `${chalk.green('●')} ${label}${detail ? ` ${chalk.gray(detail)}` : ''}`
        : chalk.gray(`○ ${label}${detail ? ` (${detail})` : ''}`);

    const agents = [
      ...(tools.claude ? ['Claude Code'] : []),
      ...(tools.codex ? ['Codex'] : []),
      ...(tools.gemini ? ['Gemini CLI'] : []),
    ];
    const acpEnabled = config.acp?.enabled ?? true;
    const items = [
      item(tools.git, 'Git', tools.git ? undefined : t('dashboard.capabilityNotInstalled')),
      item(tools.ripgrep, 'ripgrep', tools.ripgrep ? undefined : t('dashboard.capabilityBasicSearch')),
      !acpEnabled
        ? item(false, 'ACP', t('dashboard.capabilityOff'))
        : agents.length > 0
          ? item(true, 'ACP', agents.join(', '))
          : item(false, 'ACP', t('dashboard.capabilityNoAgents')),
    ];

    const gap = '   ';
    const lines: string[] = [];
    for (const entry of items) {
      const last = lines[lines.length - 1];
      if (last !== undefined && visibleWidth(last) + gap.length + visibleWidth(entry) <= inner) {
        lines[lines.length - 1] = last + gap + entry;
      } else {
        lines.push(entry);
      }
    }
    return lines;
  }

  private renderHeader(width: number): string {
    const name = this.options.config.name || '';
    const left = `${chalk.bold.cyan('Spck CLI')}${name ? chalk.gray('  ·  ') + chalk.bold(name) : ''}  ${chalk.gray(this.options.config.root)}`;
    const right = chalk.gray(t('dashboard.uptime', { time: formatDuration(Date.now() - this.startedAt) }));
    const leftWidth = Math.max(0, width - 2 - visibleWidth(right));
    return ' ' + fit(left, leftWidth) + ' ' + right;
  }

  private row(label: string, value: string): string {
    return chalk.bold(fit(label, 10)) + value;
  }

  private renderClient(client: ClientStatus, relayConnected: boolean): string {
    const dot = !relayConnected ? chalk.gray('●') : client.ready ? chalk.green('●') : chalk.yellow('●');
    const id = fit(client.deviceId ? client.deviceId.slice(0, 8) : '—', 10);
    const transport = client.transport === 'fastlane'
      ? chalk.magenta(fit(t('dashboard.transportFastLane'), 11))
      : chalk.cyan(fit(t('dashboard.transportRelay'), 11));
    const ping = fit(this.formatPing(client), 9);
    const state = client.ready
      ? chalk.gray(t('dashboard.connectedFor', { time: formatDuration(Date.now() - client.connectedAt) }))
      : chalk.yellow(t('dashboard.handshaking'));
    return `${dot} ${id}${transport}${ping}${state}`;
  }

  private terminalsEnabled(): boolean {
    return this.options.config.terminal?.enabled !== false;
  }

  private terminalRows(): TerminalRow[] {
    const terminals = RPCRouter.getTerminalSummaries();
    for (const terminal of terminals) {
      if (!this.terminalNumbers.has(terminal.id)) this.terminalNumbers.set(terminal.id, this.nextTerminalNumber++);
    }
    return terminals;
  }

  private terminalLabel(id: string): string {
    return `#${this.terminalNumbers.get(id) ?? '?'}`;
  }

  private selectedTerminalIndex(terminals: TerminalRow[]): number {
    const index = terminals.findIndex((row) => row.id === this.selectedTerminal?.id);
    return index === -1 ? 0 : index;
  }

  /** One line per terminal; `selectedIndex` highlights a row (terminals view). */
  private terminalLines(terminals: TerminalRow[], status: ProxyStatus, selectedIndex: number | null): string[] {
    if (terminals.length === 0) return ['  ' + chalk.gray(t('dashboard.noTerminals'))];
    const connectedDevices = new Set(status.clients.filter((c) => c.ready && c.deviceId).map((c) => c.deviceId));
    return terminals.map((terminal, index) => {
      const viewing = !terminal.exited && terminal.active && connectedDevices.has(terminal.deviceId);
      const line = this.renderTerminal(terminal, viewing);
      if (selectedIndex === null) return '  ' + line;
      return index === selectedIndex ? chalk.inverse('> ' + stripAnsi(line)) : '  ' + line;
    });
  }

  private renderTerminalsView(width: number, height: number): string[] {
    const status = this.options.proxy.getStatus();
    const terminals = this.terminalRows();
    const index = this.selectedTerminalIndex(terminals);
    // Keep the selection valid when the selected terminal went away
    if (terminals[index]) this.selectedTerminal = { deviceId: terminals[index].deviceId, id: terminals[index].id };
    else this.selectedTerminal = null;

    const rows = this.terminalLines(terminals, status, terminals.length > 0 ? index : null);
    const above = [this.renderHeader(width), ''];
    const below = ['', chalk.gray('  ' + t('dashboard.terminalsViewHint'))];
    // One row for the title, and one for the footer
    const room = Math.max(1, height - above.length - below.length - 2);
    const start = Math.max(0, Math.min(index - Math.floor(room / 2), rows.length - room));
    const position = rows.length > room ? chalk.gray(`  ${index + 1}/${rows.length}`) : '';

    return [
      ...above,
      chalk.bold(t('dashboard.terminals')) + position,
      ...rows.slice(start, start + room),
      ...below,
    ];
  }

  private renderTerminal(terminal: TerminalRow, viewing: boolean): string {
    const now = Date.now();
    const dot = terminal.exited ? chalk.gray('●') : viewing ? chalk.green('●') : chalk.cyan('●');
    const name = fit(this.terminalLabel(terminal.id), 5);
    const state = terminal.exited
      ? chalk.gray(fit(t('dashboard.terminalExited', {
        code: terminal.exitCode ?? '?',
        time: formatDuration((terminal.exitedAt ?? now) - terminal.createdAt),
      }), 30))
      : fit(t('dashboard.terminalRunning', { time: formatDuration(now - terminal.createdAt) }), 30);
    const size = chalk.gray(fit(formatBytes(terminal.bufferBytes), 10));
    const attached = viewing
      ? chalk.green(t('dashboard.terminalViewing'))
      : chalk.gray(t('dashboard.terminalAttached', { time: formatDuration(now - terminal.lastAttachedAt) }));
    return `${dot} ${name}${state}${size}${attached}`;
  }

  private formatPing(client: ClientStatus): string {
    if (client.pingMs === null) return chalk.gray(client.ready ? '— ms' : '');
    const text = `${client.pingMs} ms`;
    // Solid green below 80 ms, blending through yellow at 175 ms to red at 300 ms.
    const hue = client.pingMs <= 80 ? 140 : client.pingMs < 175
      ? 140 - (client.pingMs - 80) * 92 / 95
      : Math.max(0, 48 - (client.pingMs - 175) * 48 / 125);
    // HSL (75% saturation, 50% lightness) converted to RGB for Chalk's color support.
    const chroma = 0.75;
    const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
    const channels = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : [0, chroma, x];
    const [red, green, blue] = channels.map(channel => Math.round((channel + 0.125) * 255));
    return chalk.rgb(red, green, blue)(text);
  }

  private fastLaneLines(status: ProxyStatus, width: number): string[] {
    const enabled = this.options.config.fastLane?.enabled ?? true;
    if (status.clients.some((c) => c.transport === 'fastlane')) {
      return [chalk.magenta('● ') + t('dashboard.fastLaneActive')];
    }
    if (!enabled) {
      return wrap(t('dashboard.fastLaneOff'), width).map((line) => chalk.gray(line));
    }
    switch (status.fastLane) {
      case 'available': {
        const [first, ...rest] = wrap(t('dashboard.fastLaneAvailable'), width - 2);
        return [chalk.magenta('★ ') + first, ...rest.map((line) => '  ' + line)];
      }
      case 'unsupported':
        return wrap(t('dashboard.fastLaneUnsupported'), width).map((line) => chalk.yellow(line));
      case 'disabled':
        // Disabled at sign-in but since turned back on from the dashboard
        return [chalk.gray(t('dashboard.restartToApply'))];
      default:
        return [chalk.gray(t('dashboard.fastLaneChecking'))];
    }
  }

  private settingRow(hotkey: string, label: string, enabled: boolean, hint: string): string {
    const key = chalk.cyan(`[${hotkey}]`);
    const value = enabled ? chalk.green(fit(t('dashboard.on'), 6)) : chalk.gray(fit(t('dashboard.off'), 6));
    return `${key} ${fit(label, LABEL_WIDTH)}${value}${hint}`;
  }

  private settingHint(setting: SettingDef, enabled: boolean, status: ProxyStatus): string {
    if (setting.apply === 'restart') {
      return enabled !== this.initialValues.get(setting.id) ? chalk.yellow(t('dashboard.restartToApply')) : '';
    }
    if (!this.changedThisSession.has(setting.id)) return '';
    if (setting.apply === 'reconnect' && status.clients.length > 0) {
      return chalk.yellow(t('dashboard.reconnectToApply'));
    }
    if (setting.apply === 'newConnections' && status.clients.length > 0) {
      return chalk.gray(t('dashboard.appliesToNewConnections'));
    }
    return '';
  }

  private renderNotice(notice: LogEntry): string {
    const time = new Date(notice.time).toTimeString().substring(0, 8);
    const color = notice.level === 'error' ? chalk.red : chalk.yellow;
    const text = stripAnsi(notice.text).trim();
    return `${chalk.bold(t('dashboard.latest'))} ${chalk.gray(time)} ${color(text)}`;
  }

  // ------------------------------------------------------------- QR view

  private renderQr(width: number, height: number): string[] {
    const header = this.renderHeader(width);
    const url = this.options.proxy.getConnectUrl();
    const settings = this.options.proxy.getConnectionSettings();
    if (!url || !settings) {
      return [header, '', '  ' + chalk.gray(t('dashboard.qrUnavailable'))];
    }
    if (this.qrCache?.url !== url) {
      let qr = '';
      qrcode.generate(url, { small: true }, (output: string) => { qr = output; });
      const lines = qr.split('\n').filter((line) => line.length > 0);
      this.qrCache = { url, lines, width: Math.max(...lines.map((line) => visibleWidth(line))) };
    }
    const { lines: qr, width: qrWidth } = this.qrCache;
    const details = [t('connection.clientId', { id: settings.clientId }), t('connection.secret', { secret: settings.secret })];
    if (this.options.config.name) details.push(t('connection.name', { name: this.options.config.name }));

    const available = height - 1; // the footer takes the last row
    const indented = (text: string, style: (line: string) => string = (line) => line) =>
      wrap(text, Math.max(20, width - 2)).map((line) => '  ' + style(line));

    // A clipped code can't be scanned, so never draw one that doesn't fit
    if (qr.length + 1 > available || qrWidth + 2 > width) {
      const message = t('dashboard.qrTooSmall', { cols: qrWidth + 2, rows: qr.length + 2 });
      return [header, '', ...indented(message, chalk.yellow), '', ...details.flatMap((line) => indented(line))];
    }

    // Beside the code: the only layout that fits a default 80x24 terminal
    const sideWidth = width - 2 - qrWidth - QR_SIDE_GAP;
    if (sideWidth >= QR_MIN_SIDE_WIDTH) {
      const side = [
        ...wrap(t('connection.scanQR'), sideWidth).map((line) => chalk.bold(line)),
        '',
        ...details.flatMap((line) => wrap(line, sideWidth)),
      ];
      const top = Math.max(0, Math.floor((qr.length - side.length) / 2));
      const rows = qr.map((line, i) => `  ${fit(line, qrWidth)}${' '.repeat(QR_SIDE_GAP)}${side[i - top] ?? ''}`);
      return [header, ...(qr.length + 2 <= available ? [''] : []), ...rows];
    }

    // Narrow terminal: stack the details under the code, as far as they fit
    const title = indented(t('connection.scanQR'), chalk.bold);
    const below = details.flatMap((line) => indented(line));
    const showTitle = 1 + title.length + qr.length + below.length <= available;
    return [header, ...(showTitle ? title : []), ...qr.map((line) => '  ' + line), ...below];
  }

  // ------------------------------------------------------------ log view

  private logViewHeight(): number {
    return Math.max(1, (process.stdout.rows || 24) - 3);
  }

  private logPanStep(): number {
    return Math.max(8, Math.floor((process.stdout.columns || 80) / 2));
  }

  private clampLogScroll(): void {
    const max = Math.max(0, this.options.logs.entries.length - this.logViewHeight());
    this.logScroll = Math.min(Math.max(0, this.logScroll), max);
  }

  private renderLogs(width: number, height: number): string[] {
    this.clampLogScroll();
    const entries = this.options.logs.entries;
    const viewHeight = this.logViewHeight();
    const end = entries.length - this.logScroll;
    const start = Math.max(0, end - viewHeight);
    const visible = entries.slice(start, end);
    // Pan no further than the longest line on screen needs
    if (this.logPan > 0) {
      const longest = visible.reduce((max, entry) => Math.max(max, visibleWidth(entry.text)), 0);
      this.logPan = Math.min(this.logPan, Math.max(0, longest - width));
    }
    const position = [
      this.logScroll > 0 ? chalk.yellow(t('dashboard.logsScrolled', { lines: this.logScroll })) : '',
      this.logPan > 0 ? chalk.yellow(`→ ${this.logPan}`) : '',
    ].filter(Boolean).join('  ');
    const lines = [
      ' ' + chalk.bold.cyan(t('dashboard.logsTitle')) + '  ' + chalk.gray(t('dashboard.logsHint')) + '  ' + position,
      chalk.gray('─'.repeat(width)),
    ];
    for (const entry of visible) lines.push(skipColumns(entry.text, this.logPan));
    return lines.slice(0, height - 1);
  }

  // -------------------------------------------------------------- footer

  private renderFooter(width: number): string {
    if (this.flash && Date.now() - this.flash.at < QUIT_CONFIRM_MS) {
      return chalk.inverse(fit(' ' + this.flash.text, width));
    }
    const key = (k: string, label: string) => `${chalk.inverse(` ${k} `)} ${label}`;
    let items: string[];
    if (this.view === 'logs') {
      items = [
        key('↑↓', t('dashboard.keyScroll')),
        key('←→', t('dashboard.keyPan')),
        key('l', t('dashboard.keyBack')),
        key('q', t('dashboard.keyQuit')),
      ];
    } else if (this.view === 'terminals') {
      const selected = this.terminalRows().find((row) => row.id === this.selectedTerminal?.id);
      items = [key('↑↓', t('dashboard.keySelect'))];
      if (selected) items.push(key('x', selected.exited ? t('dashboard.keyRemove') : t('dashboard.keyKill')));
      items.push(key('m', t('dashboard.keyBack')), key('q', t('dashboard.keyQuit')));
    } else if (this.view === 'qr') {
      items = [key('c', t('dashboard.keyBack')), key('l', t('dashboard.keyLogs')), key('q', t('dashboard.keyQuit'))];
    } else {
      items = [key('l', t('dashboard.keyLogs')), key('c', t('dashboard.keyQr'))];
      if (this.terminalsEnabled()) items.push(key('m', t('dashboard.keyTerminals')));
      items.push(key('q', t('dashboard.keyQuit')));
    }
    return truncate(' ' + items.join('   '), width);
  }
}
