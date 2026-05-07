import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ErrorCode } from '../../types.js';

// Mock both bridge factories before importing LanguageServerService so the
// service receives our stubs instead of spawning real LSP processes.
const tsHandle = vi.fn();
const pyHandle = vi.fn();
const tsStop = vi.fn();
const pyStop = vi.fn();

vi.mock('../../lsp/TsServerBridge.js', () => ({
  createTsServerBridge: vi.fn(() => ({ handleMessage: tsHandle, stop: tsStop })),
}));
vi.mock('../../lsp/PyrightBridge.js', () => ({
  createPyrightBridge: vi.fn(() => ({ handleMessage: pyHandle, stop: pyStop })),
}));

import { LanguageServerService } from '../LanguageServerService.js';

const makeSocket = () => ({ data: { deviceId: 'd1', uid: 'u1' } }) as any;

describe('LanguageServerService', () => {
  beforeEach(() => {
    tsHandle.mockReset();
    pyHandle.mockReset();
    tsStop.mockReset();
    pyStop.mockReset();
  });

  describe('capabilities', () => {
    it('answers when enabled with both languages', async () => {
      const svc = new LanguageServerService('/tmp', { enabled: true });
      const caps = await svc.handle('capabilities', {}, makeSocket());
      expect(caps.enabled).toBe(true);
      expect(caps.modes).toEqual(expect.arrayContaining(['typescript', 'javascript', 'python']));
      expect(caps.methods).toEqual(expect.arrayContaining(['completion', 'info', 'def', 'rename']));
    });

    it('answers with enabled=false when service is disabled', async () => {
      const svc = new LanguageServerService('/tmp', { enabled: false });
      const caps = await svc.handle('capabilities', {}, makeSocket());
      expect(caps.enabled).toBe(false);
      expect(caps.modes).toEqual([]);
    });

    it('drops modes for languages that are individually disabled', async () => {
      const svc = new LanguageServerService('/tmp', { enabled: true, python: false });
      const caps = await svc.handle('capabilities', {}, makeSocket());
      expect(caps.modes).not.toContain('python');
      expect(caps.modes).toContain('typescript');
    });
  });

  describe('disabled-state gating', () => {
    it('always answers capabilities, never throws on disabled', async () => {
      const svc = new LanguageServerService('/tmp', { enabled: false });
      await expect(svc.handle('capabilities', {}, makeSocket())).resolves.toBeDefined();
    });

    it('rejects message calls with FEATURE_DISABLED', async () => {
      const svc = new LanguageServerService('/tmp', { enabled: false });
      await expect(svc.handle('message', { type: 'add', name: 'x.py' }, makeSocket()))
        .rejects.toMatchObject({ code: ErrorCode.FEATURE_DISABLED });
    });

    it('rejects unknown methods with METHOD_NOT_FOUND', async () => {
      const svc = new LanguageServerService('/tmp', { enabled: true });
      await expect(svc.handle('mystery', {}, makeSocket()))
        .rejects.toMatchObject({ code: ErrorCode.METHOD_NOT_FOUND });
    });
  });

  describe('extension routing', () => {
    it('routes .ts to the TS bridge', async () => {
      tsHandle.mockResolvedValue({ type: 'completion', completions: [{ caption: 'foo' }] });
      const svc = new LanguageServerService('/tmp', { enabled: true });
      const req = { type: 'completion', name: 'src/a.ts', position: { line: 0, character: 0 } };
      const res = await svc.handle('message', req, makeSocket());
      expect(tsHandle).toHaveBeenCalledTimes(1);
      expect(pyHandle).not.toHaveBeenCalled();
      expect(res.completions).toBeDefined();
    });

    it('routes .py to the Python bridge', async () => {
      pyHandle.mockResolvedValue({ type: 'info', info: { displayParts: [] } });
      const svc = new LanguageServerService('/tmp', { enabled: true });
      const req = { type: 'info', name: 'src/a.py', position: { line: 0, character: 0 } };
      const res = await svc.handle('message', req, makeSocket());
      expect(pyHandle).toHaveBeenCalledTimes(1);
      expect(tsHandle).not.toHaveBeenCalled();
      expect(res.info).toBeDefined();
    });

    it.each([['.tsx'], ['.jsx'], ['.mjs'], ['.cjs'], ['.cts'], ['.mts']])(
      'routes %s to the TS bridge',
      async (ext) => {
        tsHandle.mockResolvedValue({});
        const svc = new LanguageServerService('/tmp', { enabled: true });
        await svc.handle('message', { type: 'add', name: `src/file${ext}`, text: '' }, makeSocket());
        expect(tsHandle).toHaveBeenCalledTimes(1);
      }
    );

    it('marks query requests with unsupported extensions as missing', async () => {
      const svc = new LanguageServerService('/tmp', { enabled: true });
      const res = await svc.handle('message', {
        type: 'completion', name: 'README.md', position: { line: 0, character: 0 },
      }, makeSocket());
      expect(res.missing).toBe(true);
      expect(tsHandle).not.toHaveBeenCalled();
      expect(pyHandle).not.toHaveBeenCalled();
    });

    it('does not mark file-sync requests with unsupported extensions as missing', async () => {
      const svc = new LanguageServerService('/tmp', { enabled: true });
      const res = await svc.handle('message', { type: 'add', name: 'README.md', text: '' }, makeSocket());
      expect(res.missing).toBeUndefined();
    });

    it('skips Python bridge when language disabled, marks query missing', async () => {
      const svc = new LanguageServerService('/tmp', { enabled: true, python: false });
      const res = await svc.handle('message', {
        type: 'def', name: 'app.py', position: { line: 0, character: 0 },
      }, makeSocket());
      expect(res.missing).toBe(true);
      expect(pyHandle).not.toHaveBeenCalled();
    });
  });

  describe('lazy bridge construction', () => {
    it('does not spawn a bridge until a relevant message arrives', async () => {
      const tsFactory = await import('../../lsp/TsServerBridge.js');
      const pyFactory = await import('../../lsp/PyrightBridge.js');
      vi.mocked(tsFactory.createTsServerBridge).mockClear();
      vi.mocked(pyFactory.createPyrightBridge).mockClear();

      const svc = new LanguageServerService('/tmp', { enabled: true });
      // capabilities and a non-routed message should not spawn bridges
      await svc.handle('capabilities', {}, makeSocket());
      await svc.handle('message', { type: 'add', name: 'x.md', text: '' }, makeSocket());
      expect(tsFactory.createTsServerBridge).not.toHaveBeenCalled();
      expect(pyFactory.createPyrightBridge).not.toHaveBeenCalled();

      tsHandle.mockResolvedValue({});
      await svc.handle('message', { type: 'add', name: 'a.ts', text: '' }, makeSocket());
      expect(tsFactory.createTsServerBridge).toHaveBeenCalledTimes(1);
      expect(pyFactory.createPyrightBridge).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('stops both bridges if they were spawned', async () => {
      tsHandle.mockResolvedValue({});
      pyHandle.mockResolvedValue({});
      const svc = new LanguageServerService('/tmp', { enabled: true });
      await svc.handle('message', { type: 'add', name: 'a.ts', text: '' }, makeSocket());
      await svc.handle('message', { type: 'add', name: 'b.py', text: '' }, makeSocket());
      await svc.cleanup();
      expect(tsStop).toHaveBeenCalled();
      expect(pyStop).toHaveBeenCalled();
    });

    it('does not throw when bridges were never spawned', async () => {
      const svc = new LanguageServerService('/tmp', { enabled: true });
      await expect(svc.cleanup()).resolves.toBeUndefined();
    });
  });
});
