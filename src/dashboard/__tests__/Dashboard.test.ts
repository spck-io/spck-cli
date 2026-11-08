import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { Dashboard } from '../Dashboard.js';
import { LogBuffer } from '../LogBuffer.js';
import { stripAnsi, visibleWidth } from '../screen.js';
import { RPCRouter } from '../../rpc/router.js';

const SECRET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQR';

function fakeClient(id: string) {
  return { connectionId: id, deviceId: id, transport: 'relay', connectedAt: Date.now(), ready: true, pingMs: 20 };
}

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
  const original = { columns: process.stdout.columns, rows: process.stdout.rows, setRawMode: process.stdin.setRawMode };

  /** Plain text of the most recent frame, one string per row. */
  const screen = () => stripAnsi(frames[frames.length - 1]).split('\r\n').map((line) => line.replace(/\x1b\[K/g, ''));
  const text = () => screen().join('\n');
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const press = async (name: string, modifiers: Record<string, boolean> = {}) => {
    process.stdin.emit('keypress', name.length === 1 ? name : undefined, { name, ...modifiers });
    await settle();
  };

  function start(columns: number, rows: number) {
    process.stdout.columns = columns;
    process.stdout.rows = rows;
    dashboard = new Dashboard({
      proxy: {
        getStatus: () => ({ relayUrl: 'cli-na-1.spck.io', relayConnected: true, fastLane: 'available', clients }),
        onStatusChange: (listener: () => void) => { statusChanged = listener; return () => {}; },
        getConnectUrl: () => `spck://connect?clientId=abcdefghijkl&secret=${SECRET}&rs=cli-na-1.spck.io&name=project`,
        getConnectionSettings: () => ({ clientId: 'abcdefghijkl', secret: SECRET }),
      } as any,
      config,
      tools,
      logs,
      wakeLock: { state: 'off', error: null, onChange: () => () => {}, toggle: toggleWake } as any,
      onQuit,
    });
    dashboard.start();
  }

  beforeEach(() => {
    frames = [];
    clients = [fakeClient('device-1')];
    tools = { git: true, ripgrep: true, claude: true, codex: true, gemini: false };
    config = {
      version: 1, root: '/project', name: 'project',
      terminal: { enabled: true }, security: { userAuthenticationEnabled: false }, filesystem: {},
    };
    onQuit = vi.fn();
    toggleWake = vi.fn();
    logs = new LogBuffer();
    logs.install();
    (process.stdin as any).setRawMode = vi.fn();
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      const data = String(chunk);
      if (data.startsWith('\x1b[H')) frames.push(data.slice(3));
      return true;
    });
    vi.spyOn(RPCRouter, 'getTerminalSummaries').mockReturnValue([]);
  });

  afterEach(() => {
    dashboard.stop();
    logs.uninstall();
    vi.restoreAllMocks();
    process.stdout.columns = original.columns;
    process.stdout.rows = original.rows;
    (process.stdin as any).setRawMode = original.setRawMode;
  });

  describe('keys', () => {
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
  });

  describe('main view on a small terminal', () => {
    it('keeps every setting and the latest problem visible with many terminals', async () => {
      vi.mocked(RPCRouter.getTerminalSummaries).mockReturnValue(Array.from({ length: 12 }, (_, i) => fakeTerminal(i)) as any);
      console.warn('relay is slow');
      start(100, 24);
      expect(text()).toContain('Keep computer awake');
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
});
