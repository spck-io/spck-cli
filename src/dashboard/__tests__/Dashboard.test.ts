import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { Dashboard } from '../Dashboard.js';
import { LogBuffer } from '../LogBuffer.js';
import { setWideChars, stripAnsi, visibleWidth } from '../screen.js';
import { RPCRouter } from '../../rpc/router.js';
import * as pinSettings from '../pin-settings.js';
import { createRequire } from 'module';

// The QR style and character widths depend on the terminal running the tests
// (the classic Windows console differs): pin them.
const qr = vi.hoisted(() => ({ style: 'halfBlocks' as 'halfBlocks' | 'cells' }));
vi.mock('../../utils/qr.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/qr.js')>()),
  terminalQrStyle: () => qr.style,
}));
const winConsole = vi.hoisted(() => ({ classic: false, wide: [] as string[] }));
vi.mock('../../utils/windows-console.js', () => ({
  isClassicWindowsConsole: () => winConsole.classic,
  wideInConsole: (chars: string) => [...chars].filter((ch) => winConsole.wide.includes(ch)),
}));
// What the classic console draws wide with a Chinese code page (936)
const WIDE_IN_GBK = [...'·●○★↑↓←→—–…‘’“”█▄'];

const pkg = createRequire(import.meta.url)('../../../package.json') as { version: string };
const SECRET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQR';

function fakeClient(id: string) {
  return { connectionId: id, deviceId: id, transport: 'relay', connectedAt: Date.now(), ready: true, pingMs: 20 };
}

const RELAYS = [
  { url: 'cli-na-1.spck.io', label: { en: 'Relay US' }, locale: {} },
  { url: 'cli-eu-1.spck.io', label: { en: 'Relay EU' }, locale: {} },
  { url: 'cli-ea-1.spck.io', label: { en: 'Relay Asia' }, locale: {} },
];
const PINGS: Record<string, number> = { 'cli-na-1.spck.io': 42, 'cli-eu-1.spck.io': 118, 'cli-ea-1.spck.io': Infinity };

function fakeTerminal(n: number) {
  return {
    id: `term-${n}`, deviceId: 'device-1', createdAt: Date.now(), lastAttachedAt: Date.now(),
    active: false, exited: false, exitCode: null, exitedAt: null, bufferBytes: 1024,
  };
}

describe('Dashboard', () => {
  let dashboard: Dashboard;
  let logs: LogBuffer;
  let config: any;
  let clients: any[];
  let frames: string[];
  let tools: any;
  let statusChanged: () => void;
  let onQuit: Mock<() => void>;
  let toggleWake: Mock<() => void>;
  let relays: { list: Mock; ping: Mock; switchTo: Mock };
  const original = { columns: process.stdout.columns, rows: process.stdout.rows, setRawMode: process.stdin.setRawMode };

  /** Rows of the most recent frame, as written (each is drawn at its own position). */
  const rawRows = () => frames[frames.length - 1].split(/\x1b\[\d+;1H/).slice(1);
  /** Plain text of the most recent frame, one string per row. */
  const screen = () => rawRows().map((row) => stripAnsi(row));
  const text = () => screen().join('\n');
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const press = async (name: string, modifiers: Record<string, boolean> = {}) => {
    process.stdin.emit('keypress', name.length === 1 ? name : undefined, { name, ...modifiers });
    await settle();
  };

  function fakeProxy(relayUrl: string, clientId = 'abcdefghijkl') {
    const unsubscribe = vi.fn();
    return {
      unsubscribe,
      getStatus: () => ({ relayUrl, relayConnected: true, fastLane: 'available', clients }),
      onStatusChange: (listener: () => void) => { statusChanged = listener; return unsubscribe; },
      getConnectUrl: () => `spck://connect?clientId=${clientId}&secret=${SECRET}&rs=${relayUrl}&name=project`,
      getConnectionSettings: () => ({ clientId, secret: SECRET }),
    };
  }

  function start(columns: number, rows: number, proxy = fakeProxy('cli-na-1.spck.io')) {
    process.stdout.columns = columns;
    process.stdout.rows = rows;
    dashboard = new Dashboard({
      proxy: proxy as any,
      config,
      tools,
      logs,
      wakeLock: { state: 'off', error: null, onChange: () => () => {}, toggle: toggleWake } as any,
      relays: relays as any,
      onQuit,
    });
    dashboard.start();
  }

  beforeEach(() => {
    qr.style = 'halfBlocks';
    winConsole.classic = false;
    winConsole.wide = [];
    frames = [];
    clients = [fakeClient('device-1')];
    tools = { git: true, ripgrep: true, claude: true, codex: true, gemini: false };
    config = {
      version: 1, root: '/project', name: 'project',
      terminal: { enabled: true }, security: { userAuthenticationEnabled: false }, filesystem: {},
    };
    onQuit = vi.fn();
    toggleWake = vi.fn();
    relays = {
      list: vi.fn(async () => RELAYS),
      ping: vi.fn(async (url: string) => PINGS[url] ?? Infinity),
      switchTo: vi.fn(),
    };
    logs = new LogBuffer();
    logs.install();
    (process.stdin as any).setRawMode = vi.fn();
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      const data = String(chunk);
      if (data.startsWith('\x1b[1;1H')) frames.push(data);
      return true;
    });
    vi.spyOn(RPCRouter, 'getTerminalSummaries').mockReturnValue([]);
  });

  afterEach(() => {
    dashboard.stop();
    setWideChars([]);
    logs.uninstall();
    vi.restoreAllMocks();
    process.stdout.columns = original.columns;
    process.stdout.rows = original.rows;
    (process.stdin as any).setRawMode = original.setRawMode;
  });

  describe('keys', () => {
    it('requires local PIN confirmation before enabling protection and never renders digits', async () => {
      const save = vi.spyOn(pinSettings, 'saveConnectionPin').mockImplementation((config) => { config.security.requirePin = true; });
      start(80, 24);
      expect(text()).toContain('Require PIN to connect');
      await press('i');
      for (const digit of '0123') await press(digit);
      expect(text()).not.toContain('0123');
      expect(save).not.toHaveBeenCalled();
      await press('return');
      expect(text()).toContain('Confirm your PIN');
      for (const digit of '1234') await press(digit);
      await press('return');
      expect(text()).toContain('do not match');
      expect(save).not.toHaveBeenCalled();
      for (const digit of '0123') await press(digit);
      await press('return');
      expect(save).toHaveBeenCalledWith(config, '0123', undefined);
      expect(config.security.requirePin).toBe(true);
      expect(text()).toContain('Require PIN to connect');
      expect(text()).not.toContain('0123');
    });

    it('leaves PIN protection off when local setup is cancelled', async () => {
      start(80, 24);
      await press('i');
      for (const digit of '1234') await press(digit);
      await press('escape', { meta: true });
      expect(config.security.requirePin).not.toBe(true);
      expect(text()).toContain('Settings');
      await press('i');
      expect(text()).not.toContain('●');
    });
    it('ignores hotkeys pressed with Ctrl or Alt', async () => {
      start(80, 24);
      await press('u', { ctrl: true });
      await press('w', { ctrl: true });
      await press('w', { meta: true });
      expect(config.security.userAuthenticationEnabled).toBe(false);
      expect(toggleWake).not.toHaveBeenCalled();
      await press('w');
      expect(toggleWake).toHaveBeenCalledOnce();
    });

    it('leaves a view on Esc, which readline reports with the meta flag', async () => {
      start(80, 24);
      await press('l');
      expect(text()).toContain('Logs');
      await press('escape', { meta: true });
      expect(text()).toContain('Settings');
    });

    it('quits on Ctrl+C, and on a second q', async () => {
      start(80, 24);
      await press('q');
      expect(onQuit).not.toHaveBeenCalled();
      await press('q');
      expect(onQuit).toHaveBeenCalledOnce();
      await press('c', { ctrl: true });
      expect(onQuit).toHaveBeenCalledTimes(2);
    });
  });

  describe('rendering', () => {
    it('does not redraw a screen that has not changed', async () => {
      start(80, 24);
      const count = frames.length;
      await press('z'); // not bound to anything
      expect(frames.length).toBe(count);
    });

    it('fills exactly the terminal and never overflows its width', async () => {
      vi.mocked(RPCRouter.getTerminalSummaries).mockReturnValue(Array.from({ length: 4 }, (_, i) => fakeTerminal(i)) as any);
      start(60, 20);
      expect(screen()).toHaveLength(20);
      for (const row of screen()) expect(visibleWidth(row)).toBeLessThanOrEqual(60);
    });

    it('leaves the alternate screen before stdin leaves raw mode', () => {
      // On Windows 10 the console host crashes, closing the shell, if turning
      // raw mode off starts a line-mode read while the alternate screen is up
      start(80, 24);
      dashboard.stop();
      const write = vi.mocked(process.stdout.write);
      const leave = write.mock.calls.findIndex(([chunk]) => String(chunk).includes('\x1b[?1049l'));
      const setRawMode = process.stdin.setRawMode as unknown as Mock;
      const rawOff = setRawMode.mock.calls.findIndex(([flag]) => flag === false);
      expect(leave).toBeGreaterThanOrEqual(0);
      expect(rawOff).toBeGreaterThanOrEqual(0);
      expect(write.mock.invocationCallOrder[leave]).toBeLessThan(setRawMode.mock.invocationCallOrder[rawOff]);
    });

    it('draws each row at its own position, so a line that wraps cannot push the frame down', () => {
      start(80, 24);
      const positions = frames[frames.length - 1].match(/\x1b\[(\d+);1H/g)!;
      expect(positions).toEqual(Array.from({ length: 24 }, (_, i) => `\x1b[${i + 1};1H`));
      expect(frames[frames.length - 1]).not.toContain('\n');
    });

    it('does not clear past a row that fills the width, which would erase its last character', () => {
      start(80, 24);
      const rows = rawRows();
      // The header and the footer are padded to the full width
      expect(visibleWidth(rows[0])).toBe(80);
      expect(rows[0]).not.toContain('\x1b[K');
      expect(rows[23]).not.toContain('\x1b[K');
      // Shorter rows clear what an earlier frame left after them
      expect(visibleWidth(rows[1])).toBeLessThan(80);
      expect(rows[1].endsWith('\x1b[K')).toBe(true);
    });
  });

  describe('in a classic Windows console with a CJK code page', () => {
    const header = () => screen()[0];

    beforeEach(() => {
      winConsole.classic = true;
      winConsole.wide = WIDE_IN_GBK;
    });

    it('counts the symbols the console draws two columns wide', () => {
      start(80, 24);
      expect(visibleWidth('·●')).toBe(4);
      // The header's "·" takes two columns, and the row still ends with the uptime
      expect(visibleWidth(header())).toBe(80);
      expect(header()).toMatch(/project .*\d+s$/);
      for (const row of screen()) expect(visibleWidth(row)).toBeLessThanOrEqual(80);
    });

    it('leaves the usual widths in any other terminal', () => {
      winConsole.classic = false;
      start(80, 24);
      expect(visibleWidth('·●')).toBe(2);
    });
  });

  describe('main view on a small terminal', () => {
    it('keeps every setting and the latest problem visible with many terminals', async () => {
      vi.mocked(RPCRouter.getTerminalSummaries).mockReturnValue(Array.from({ length: 12 }, (_, i) => fakeTerminal(i)) as any);
      console.warn('relay is slow');
      start(100, 24);
      expect(text()).toContain('Keep computer awake');
      expect(text()).toContain('[p] Compact shell prompt');
      expect(text()).toContain('relay is slow');
      expect(text()).toMatch(/\+\d+ more/);
    });

    it('lists detected tools and agents under Capabilities', () => {
      start(120, 40);
      expect(text()).toContain('Capabilities');
      expect(text()).toContain('● Git');
      expect(text()).toContain('● ripgrep');
      expect(text()).toContain('● ACP Claude Code, Codex');
      expect(text()).not.toContain('Gemini CLI');
    });

    it('says briefly what a missing tool means', () => {
      tools = { git: false, ripgrep: false, claude: false, codex: false, gemini: false };
      start(120, 40);
      expect(text()).toContain('○ Git (not installed)');
      expect(text()).toContain('○ ripgrep (basic search)');
      expect(text()).toContain('○ ACP (no agents found)');
    });

    it('shows ACP as off when it is turned off, even with agents installed', () => {
      config.acp = { enabled: false };
      start(120, 40);
      expect(text()).toContain('○ ACP (off)');
    });

    it('wraps capabilities between items on a narrow terminal', () => {
      tools = { git: true, ripgrep: false, claude: true, codex: true, gemini: true };
      start(50, 40);
      expect(text()).toContain('● Git   ○ ripgrep (basic search)');
      expect(text()).toContain('● ACP Claude Code, Codex, Gemini CLI');
    });

    it('drops capabilities before settings on a short terminal', () => {
      start(100, 18);
      expect(text()).not.toContain('Capabilities');
      expect(text()).toContain('Keep computer awake');
      expect(text()).toContain('[p] Compact shell prompt');
    });

    it('shows all terminals when they fit', async () => {
      vi.mocked(RPCRouter.getTerminalSummaries).mockReturnValue(Array.from({ length: 3 }, (_, i) => fakeTerminal(i)) as any);
      start(100, 50);
      expect(text()).toContain('#3');
      expect(text()).not.toMatch(/\+\d+ more/);
    });
  });

  describe('QR view', () => {
    const qrRows = () => screen().filter((row) => /[█▀▄]/.test(row));

    it('opens the dashboard for a previously connected project and lets c show the QR again', async () => {
      config.hasConnectedEditor = true;
      clients = [];
      start(80, 24);
      expect(qrRows()).toHaveLength(0);
      expect(text()).toContain('Settings');

      await press('c');
      expect(qrRows().length).toBeGreaterThan(15);
      clients = [fakeClient('device-1')];
      statusChanged();
      await settle();
      expect(qrRows().length).toBeGreaterThan(15);
    });

    it('leaves the initial QR only after the editor finishes its handshake', async () => {
      clients = [{ ...fakeClient('device-1'), ready: false }];
      start(80, 24);
      expect(qrRows().length).toBeGreaterThan(15);
      statusChanged();
      await settle();
      expect(qrRows().length).toBeGreaterThan(15);

      clients[0].ready = true;
      statusChanged();
      await settle();
      expect(qrRows()).toHaveLength(0);
      expect(text()).toContain('Settings');

      clients = [];
      statusChanged();
      await settle();
      expect(qrRows()).toHaveLength(0);
    });

    it('fits the code and the details on a default 80x24 terminal', () => {
      clients = [];
      start(80, 24);
      expect(qrRows().length).toBeGreaterThan(15);
      // The secret wraps in the column beside the code
      const beside = screen().map((row) => row.replace(/^.*[█▀▄]/, '').trim()).join('');
      expect(beside).toContain(SECRET);
    });

    it('shows the details instead of a clipped code when the terminal is too short', () => {
      clients = [];
      start(80, 15);
      expect(qrRows()).toHaveLength(0);
      expect(text()).toContain('too small');
      expect(text()).toContain(SECRET);
    });

    it('stacks the code above the details on a narrow, tall terminal', () => {
      clients = [];
      start(50, 50);
      expect(qrRows().length).toBeGreaterThan(15);
      expect(text()).toContain('Client ID: abcdefghijkl');
      expect(text().replace(/\s/g, '')).toContain(SECRET);
    });

    describe('in the classic Windows console', () => {
      const cellRows = () => rawRows().filter((row) => row.includes('\x1b[107m'));

      beforeEach(() => {
        qr.style = 'cells';
        clients = [];
      });

      it('draws the code with background colors beside the details', () => {
        start(120, 50);
        expect(qrRows()).toHaveLength(0);
        expect(cellRows().length).toBeGreaterThan(30);
        expect(text()).toContain('Client ID: abcdefghijkl');
        for (const row of screen()) expect(visibleWidth(row)).toBeLessThanOrEqual(120);
      });

      it('falls back to half blocks when the larger code does not fit', () => {
        start(80, 24);
        expect(cellRows()).toHaveLength(0);
        expect(qrRows().length).toBeGreaterThan(15);
      });

      it('shows the details instead of half blocks when the font draws block characters wide', () => {
        winConsole.classic = true;
        winConsole.wide = WIDE_IN_GBK;
        start(80, 24);
        expect(qrRows()).toHaveLength(0);
        expect(cellRows()).toHaveLength(0);
        expect(text()).toContain('too small');
        expect(text()).toContain(SECRET);
      });
    });
  });

  describe('log view', () => {
    it('stays anchored when multi-line messages arrive while scrolled up', async () => {
      for (let i = 0; i < 100; i++) console.log(`line ${i}`);
      start(80, 24);
      await press('l');
      await press('k');
      const anchored = screen()[2];
      console.log('new a\nnew b\nnew c');
      await settle();
      expect(screen()[2]).toBe(anchored);
    });

    it('pans sideways to reveal the end of a long line', async () => {
      console.log('x'.repeat(100) + 'THE-END');
      start(80, 24);
      await press('l');
      expect(text()).not.toContain('THE-END');
      await press('right');
      expect(text()).toContain('THE-END');
      await press('left');
      expect(text()).not.toContain('THE-END');
    });
  });

  describe('version', () => {
    const footer = () => screen().filter((line) => line.includes('Quit') || line.includes('quit')).pop()!;

    it('shows the package version in the bottom-right corner without overflowing', () => {
      start(100, 24);
      expect(footer().endsWith(`v${pkg.version}`)).toBe(true);
      expect(visibleWidth(footer())).toBe(100);
    });

    it('gives narrow terminals the key hints instead of the version', () => {
      start(30, 24);
      expect(text()).not.toContain(`v${pkg.version}`);
    });
  });

  describe('terminals view', () => {
    it('keeps the selected terminal on screen when the list is taller than the window', async () => {
      vi.mocked(RPCRouter.getTerminalSummaries).mockReturnValue(Array.from({ length: 20 }, (_, i) => fakeTerminal(i)) as any);
      start(100, 12);
      await press('m');
      for (let i = 0; i < 19; i++) await press('j');
      expect(text()).toContain('> ● #20');
      expect(text()).toContain('20/20');
    });
  });

  describe('relays view', () => {
    const row = (name: string) => screen().find((line) => line.includes(name)) ?? '';

    it('lists every relay with its ping and marks the current one', async () => {
      start(100, 24);
      expect(text()).toContain('[r] change');
      await press('r');
      await settle();

      expect(row('Relay US')).toMatch(/> ● Relay US\s+cli-na-1\.spck\.io\s+42 ms\s+current/);
      expect(row('Relay EU')).toMatch(/○ Relay EU\s+cli-eu-1\.spck\.io\s+118 ms\s*$/);
      expect(row('Relay Asia')).toContain('unreachable');
      expect(relays.ping).toHaveBeenCalledTimes(3);
    });

    it('lists the current relay even when it is not a listed one', async () => {
      start(100, 24, fakeProxy('custom.spck.io'));
      await press('r');
      await settle();
      expect(row('custom.spck.io')).toMatch(/> ● custom\.spck\.io\s+unreachable\s+current/);
      expect(relays.ping).toHaveBeenCalledWith('custom.spck.io');
      expect(row('Relay US')).toContain('42 ms');
    });

    it('measures again while open, and stops once closed', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        start(100, 24);
        await press('r');
        await settle();
        expect(relays.ping).toHaveBeenCalledTimes(3);
        vi.advanceTimersByTime(10_000);
        await settle();
        expect(relays.ping).toHaveBeenCalledTimes(6);

        await press('escape', { meta: true });
        vi.advanceTimersByTime(30_000);
        await settle();
        expect(relays.ping).toHaveBeenCalledTimes(6);
      } finally {
        vi.useRealTimers();
      }
    });

    it('switches to the selected relay and follows the new connection', async () => {
      const first = fakeProxy('cli-na-1.spck.io');
      const next = fakeProxy('cli-eu-1.spck.io');
      let finish!: (proxy: unknown) => void;
      relays.switchTo.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      start(100, 24, first);
      await press('r');
      await settle();

      await press('return');
      expect(relays.switchTo).not.toHaveBeenCalled();
      expect(text()).toContain('Already connected through Relay US');

      await press('j');
      await press('return');
      expect(relays.switchTo).toHaveBeenCalledWith('cli-eu-1.spck.io');
      expect(row('Relay EU')).toContain('switching…');
      await press('return'); // one switch at a time
      expect(relays.switchTo).toHaveBeenCalledOnce();

      await press('escape', { meta: true });
      expect(row('Relay ')).toContain('switching to Relay EU…');

      finish(next);
      await settle();
      await settle();
      expect(row('Relay ')).toContain('Connected  Relay EU (cli-eu-1.spck.io)  [r] change');
      expect(text()).toContain('Now connected through Relay EU');
      expect(first.unsubscribe).toHaveBeenCalled();
    });

    it('says so when a switch fails, and stays on the current relay', async () => {
      relays.switchTo.mockRejectedValue(new Error('relay refused the connection'));
      start(100, 24);
      await press('r');
      await settle();
      await press('j');
      await press('return');
      await settle();
      await settle();

      expect(text()).toContain('Could not switch to Relay EU: relay refused the connection');
      expect(row('Relay US')).toContain('current');
      await press('r');
      expect(row('Relay ')).toContain('Relay US (cli-na-1.spck.io)');
      expect(row('Latest:')).toContain('Could not switch to Relay EU: relay refused the connection');
    });

    it('shows the QR code when the new relay gave the CLI a new client ID', async () => {
      clients = [];
      config.hasConnectedEditor = true;
      relays.switchTo.mockResolvedValue(fakeProxy('cli-eu-1.spck.io', 'newclientid1'));
      start(80, 24);
      await press('r');
      await settle();
      await press('j');
      await press('return');
      await settle();
      await settle();

      expect(text()).toContain('Client ID: newclientid1');
      expect(text()).toContain('new client ID');
    });
  });
});
