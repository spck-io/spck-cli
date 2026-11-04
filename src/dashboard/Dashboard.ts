/**
 * Full-screen status dashboard shown while the CLI is serving.
 *
 * Logs are captured into a LogBuffer and only shown in the log view [l].
 * The main view shows the relay, connected editors (with ping), Fast Lane
 * status and toggleable settings, including a keep-awake wake lock.
 */

import * as readline from 'readline';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import { ProxyClient, ProxyStatus, ClientStatus } from '../proxy/ProxyClient.js';
import { ServerConfig } from '../types.js';
import { formatServerName } from '../config/server-selection.js';
import { t } from '../i18n/index.js';
import { LogBuffer, LogEntry } from './LogBuffer.js';
import { WakeLock } from './WakeLock.js';
import { SETTINGS, SettingDef, toggleSetting } from './settings.js';
import { fit, formatDuration, stripAnsi, truncate, visibleWidth, wrap } from './screen.js';

type View = 'main' | 'logs' | 'qr';

export interface DashboardOptions {
  proxy: ProxyClient;
  config: ServerConfig;
  configPath?: string;
  logs: LogBuffer;
  wakeLock: WakeLock;
  onQuit: () => void;
}

const LABEL_WIDTH = 24;
const QUIT_CONFIRM_MS = 3000;

const ENTER_ALT_SCREEN = '\x1b[?1049h\x1b[?25l';
const LEAVE_ALT_SCREEN = '\x1b[?25h\x1b[?1049l';

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
  private quitArmedAt = 0;
  private flash: { text: string; at: number } | null = null;
  private qrCache: { url: string; lines: string[] } | null = null;
  // Show the pairing QR until the first editor connects, since entering the
  // alternate screen hides the one printed during startup.
  private autoQr = false;

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

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    const onKey = (str: string | undefined, key: readline.Key) => this.handleKey(str, key);
    stdin.on('keypress', onKey);
    const onResize = () => this.render();
    stdout.on('resize', onResize);

    this.unsubscribers.push(
      () => stdin.off('keypress', onKey),
      () => stdout.off('resize', onResize),
      this.options.proxy.onStatusChange(() => this.onStatusChange()),
      this.options.logs.onAppend(() => this.onLogAppend()),
      this.options.wakeLock.onChange(() => this.scheduleRender()),
    );

    if (this.options.proxy.getStatus().clients.length === 0) {
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
    const name = key?.name ?? str;

    if (this.view === 'logs') {
      this.handleLogKey(name, key);
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
    }
    this.clampLogScroll();
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
    this.autoQr = false;
    this.logScroll = 0;
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
    if (this.autoQr && this.view === 'qr' && this.options.proxy.getStatus().clients.length > 0) {
      this.view = 'main';
      this.autoQr = false;
    }
    this.scheduleRender();
  }

  private onLogAppend(): void {
    // Keep the log view anchored where the user scrolled to.
    if (this.view === 'logs' && this.logScroll > 0) this.logScroll++;
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
    else if (this.view === 'qr') lines = this.renderQr(width);
    else lines = this.renderMain(width);

    const body = lines.slice(0, height - 1).map((line) => truncate(line, width));
    while (body.length < height - 1) body.push('');
    body.push(this.renderFooter(width));
    process.stdout.write('\x1b[H' + body.map((line) => line + '\x1b[K').join('\r\n'));
  }

  // ------------------------------------------------------------ main view

  private renderMain(width: number): string[] {
    const status = this.options.proxy.getStatus();
    const lines: string[] = [];
    const inner = Math.max(20, width - 4);

    lines.push(this.renderHeader(width));
    lines.push('');

    // Relay
    const relayState = status.relayConnected
      ? chalk.green('● ' + t('dashboard.relayConnected'))
      : chalk.yellow('● ' + t('dashboard.relayReconnecting'));
    lines.push(this.row(t('dashboard.relay'), `${relayState}  ${chalk.gray(formatServerName(status.relayUrl))}`));
    lines.push('');

    // Clients
    lines.push(chalk.bold(t('dashboard.clients')));
    if (status.clients.length === 0) {
      lines.push('  ' + chalk.gray(t('dashboard.noClients')));
    } else {
      for (const client of status.clients) {
        lines.push('  ' + this.renderClient(client, status.relayConnected));
      }
    }
    lines.push('');

    // Fast Lane
    lines.push(chalk.bold(t('dashboard.fastLane')));
    for (const line of this.fastLaneLines(status, inner)) lines.push('  ' + line);
    lines.push('');

    // Settings
    lines.push(chalk.bold(t('dashboard.settings')));
    for (const setting of SETTINGS) {
      const enabled = setting.get(this.options.config);
      lines.push('  ' + this.settingRow(setting.hotkey, t(setting.labelKey), enabled, this.settingHint(setting, enabled, status)));
    }
    const wake = this.options.wakeLock;
    const wakeHint = wake.state === 'unavailable'
      ? chalk.red(t('dashboard.wakeUnavailable', { reason: wake.error ?? '' }))
      : chalk.gray(t('dashboard.wakeHint'));
    lines.push('  ' + this.settingRow('w', t('dashboard.settingKeepAwake'), wake.state === 'on', wakeHint));

    // Latest warning / error, so problems are noticed without opening logs
    const notice = this.options.logs.lastNotice();
    if (notice) {
      lines.push('');
      lines.push(this.renderNotice(notice));
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

  private formatPing(client: ClientStatus): string {
    if (client.pingMs === null) return chalk.gray(client.ready ? '— ms' : '');
    const text = `${client.pingMs} ms`;
    if (client.pingMs < 80) return chalk.green(text);
    if (client.pingMs < 200) return chalk.yellow(text);
    return chalk.red(text);
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

  private renderQr(width: number): string[] {
    const lines: string[] = [this.renderHeader(width), ''];
    const url = this.options.proxy.getConnectUrl();
    const settings = this.options.proxy.getConnectionSettings();
    if (!url || !settings) {
      lines.push('  ' + chalk.gray(t('dashboard.qrUnavailable')));
      return lines;
    }
    if (this.qrCache?.url !== url) {
      let qr = '';
      qrcode.generate(url, { small: true }, (output: string) => { qr = output; });
      this.qrCache = { url, lines: qr.split('\n') };
    }
    lines.push('  ' + chalk.bold(t('connection.scanQR')));
    lines.push('');
    for (const line of this.qrCache.lines) lines.push('  ' + line);
    lines.push('');
    lines.push('  ' + t('connection.clientId', { id: settings.clientId }));
    lines.push('  ' + t('connection.secret', { secret: settings.secret }));
    if (this.options.config.name) lines.push('  ' + t('connection.name', { name: this.options.config.name }));
    return lines;
  }

  // ------------------------------------------------------------ log view

  private logViewHeight(): number {
    return Math.max(1, (process.stdout.rows || 24) - 3);
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
    const position = this.logScroll > 0 ? chalk.yellow(t('dashboard.logsScrolled', { lines: this.logScroll })) : '';
    const lines = [
      ' ' + chalk.bold.cyan(t('dashboard.logsTitle')) + '  ' + chalk.gray(t('dashboard.logsHint')) + '  ' + position,
      chalk.gray('─'.repeat(width)),
    ];
    for (const entry of entries.slice(start, end)) lines.push(entry.text);
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
      items = [key('↑↓', t('dashboard.keyScroll')), key('l', t('dashboard.keyBack')), key('q', t('dashboard.keyQuit'))];
    } else if (this.view === 'qr') {
      items = [key('c', t('dashboard.keyBack')), key('l', t('dashboard.keyLogs')), key('q', t('dashboard.keyQuit'))];
    } else {
      items = [key('l', t('dashboard.keyLogs')), key('c', t('dashboard.keyQr')), key('q', t('dashboard.keyQuit'))];
    }
    return truncate(' ' + items.join('   '), width);
  }
}
