/**
 * Tests for TerminalService
 */

import { TerminalService } from '../TerminalService';
import { ErrorCode } from '../../types';

// Mock node-pty
jest.mock('node-pty', () => {
  const mockPty = {
    onData: jest.fn(),
    onExit: jest.fn(),
    write: jest.fn(),
    kill: jest.fn(),
    resize: jest.fn(),
  };

  return {
    spawn: jest.fn(() => mockPty),
  };
});

// Mock @xterm/headless
jest.mock('@xterm/headless', () => {
  return {
    Terminal: jest.fn().mockImplementation(() => ({
      write: jest.fn(),
      resize: jest.fn(),
      loadAddon: jest.fn(),
    })),
  };
});

// Mock @xterm/addon-serialize
jest.mock('@xterm/addon-serialize', () => {
  return {
    SerializeAddon: jest.fn().mockImplementation(() => ({
      serialize: jest.fn(() => 'serialized-buffer'),
    })),
  };
});

import * as pty from 'node-pty';
import { Terminal as XtermHeadless } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

describe('TerminalService', () => {
  let service: TerminalService;
  let mockSocket: any;
  let mockPtyProcess: any;
  let mockXterm: any;
  let mockSerializeAddon: any;
  let ptyDataHandler: Function | null = null;
  let ptyExitHandler: Function | null = null;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Set up mock socket
    mockSocket = {
      id: 'test-socket',
      data: { uid: 'test-user-123' },
      emit: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
    };

    // Set up mock PTY process
    mockPtyProcess = {
      onData: jest.fn((handler: Function) => {
        ptyDataHandler = handler;
      }),
      onExit: jest.fn((handler: Function) => {
        ptyExitHandler = handler;
      }),
      write: jest.fn(),
      kill: jest.fn(),
      resize: jest.fn(),
    };

    // Set up mock xterm
    mockXterm = {
      write: jest.fn(),
      resize: jest.fn(),
      loadAddon: jest.fn(),
    };

    // Set up mock serialize addon
    mockSerializeAddon = {
      serialize: jest.fn(() => 'serialized-buffer-content'),
    };

    // Configure mocks
    (pty.spawn as jest.Mock).mockReturnValue(mockPtyProcess);
    (XtermHeadless as unknown as jest.Mock).mockImplementation(() => mockXterm);
    (SerializeAddon as unknown as jest.Mock).mockImplementation(() => mockSerializeAddon);

    // Create service
    service = new TerminalService(mockSocket, 10, 10000, '/test/root');

    // Reset handlers
    ptyDataHandler = null;
    ptyExitHandler = null;
  });

  describe('Terminal Creation', () => {
    it('should create a new terminal session', async () => {
      const result = await service.handle('create', { cols: 80, rows: 24 });

      expect(result).toMatch(/^term-/);
      expect(pty.spawn).toHaveBeenCalledWith(
        expect.any(String),
        [],
        expect.objectContaining({
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: '/test/root',
        })
      );
      expect(XtermHeadless).toHaveBeenCalledWith({
        cols: 80,
        rows: 24,
        scrollback: 10000,
      });
    });

    it('should use default dimensions if not provided', async () => {
      const result = await service.handle('create', {});

      expect(result).toMatch(/^term-/);
      expect(pty.spawn).toHaveBeenCalledWith(
        expect.any(String),
        [],
        expect.objectContaining({
          cols: 80,
          rows: 24,
        })
      );
    });

    it('should send initial buffer refresh', async () => {
      await service.handle('create', { cols: 80, rows: 24 });

      expect(mockSocket.emit).toHaveBeenCalledWith(
        'rpc',
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'terminal.bufferRefresh',
          params: expect.objectContaining({
            buffer: 'serialized-buffer-content',
          }),
        })
      );
    });

    it('should set up PTY data handler', async () => {
      await service.handle('create', { cols: 80, rows: 24 });

      expect(mockPtyProcess.onData).toHaveBeenCalled();
    });

    it('should set up PTY exit handler', async () => {
      await service.handle('create', { cols: 80, rows: 24 });

      expect(mockPtyProcess.onExit).toHaveBeenCalled();
    });

    it('should enforce terminal limit', async () => {
      // Create service with limit of 2
      service = new TerminalService(mockSocket, 2, 10000, '/test/root');

      // Create 2 terminals successfully
      await service.handle('create', { cols: 80, rows: 24 });
      await service.handle('create', { cols: 80, rows: 24 });

      // Third should fail
      await expect(
        service.handle('create', { cols: 80, rows: 24 })
      ).rejects.toMatchObject({
        code: ErrorCode.TERMINAL_LIMIT_EXCEEDED,
        message: expect.stringContaining('Terminal limit exceeded'),
      });
    });
  });

  describe('Terminal Activation', () => {
    let terminalId: string;

    beforeEach(async () => {
      terminalId = await service.handle('create', { cols: 80, rows: 24 });
      // Clear emit calls from creation
      mockSocket.emit.mockClear();
    });

    it('should activate terminal', async () => {
      await service.handle('activate', { terminalId });

      // Should send buffer refresh
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'rpc',
        expect.objectContaining({
          method: 'terminal.bufferRefresh',
          params: expect.objectContaining({
            terminalId,
            buffer: 'serialized-buffer-content',
          }),
        })
      );
    });

    it('should stream output from active terminal only', async () => {
      // Create unique mocks for each terminal
      let dataHandler1: Function | null = null;
      let dataHandler2: Function | null = null;

      const mockPty1 = {
        onData: jest.fn((handler: Function) => { dataHandler1 = handler; }),
        onExit: jest.fn(),
        write: jest.fn(),
        kill: jest.fn(),
        resize: jest.fn(),
      };

      const mockPty2 = {
        onData: jest.fn((handler: Function) => { dataHandler2 = handler; }),
        onExit: jest.fn(),
        write: jest.fn(),
        kill: jest.fn(),
        resize: jest.fn(),
      };

      // Return different mocks for each spawn call
      (pty.spawn as jest.Mock)
        .mockReturnValueOnce(mockPty1)
        .mockReturnValueOnce(mockPty2);

      // Create two terminals
      const terminal1 = await service.handle('create', { cols: 80, rows: 24 });
      const terminal2 = await service.handle('create', { cols: 80, rows: 24 });

      mockSocket.emit.mockClear();

      // Activate terminal1
      await service.handle('activate', { terminalId: terminal1 });

      mockSocket.emit.mockClear();

      // Simulate output from terminal1 (active)
      dataHandler1!('output from terminal 1');

      // Simulate output from terminal2 (inactive)
      dataHandler2!('output from terminal 2');

      // Only terminal1 should stream
      const outputCalls = mockSocket.emit.mock.calls.filter(
        (call: any[]) => call[1].method === 'terminal.output'
      );

      // Should only have output from terminal1
      expect(outputCalls.length).toBe(1);
      expect(outputCalls[0][1].params.terminalId).toBe(terminal1);
      expect(outputCalls[0][1].params.data).toBe('output from terminal 1');
    });

    it('should throw error for non-existent terminal', async () => {
      await expect(
        service.handle('activate', { terminalId: 'invalid-id' })
      ).rejects.toMatchObject({
        code: ErrorCode.TERMINAL_NOT_FOUND,
        message: 'Terminal not found',
      });
    });

    it('should prevent activation of other user terminals', async () => {
      // Create terminal for user-123
      const terminal1 = await service.handle('create', { cols: 80, rows: 24 });

      // Create new service for different user
      const otherSocket = {
        ...mockSocket,
        data: { uid: 'different-user' },
      };
      const otherService = new TerminalService(otherSocket, 10, 10000, '/test/root');

      // Try to activate terminal from different user
      await expect(
        otherService.handle('activate', { terminalId: terminal1 })
      ).rejects.toMatchObject({
        code: ErrorCode.TERMINAL_NOT_FOUND,
      });
    });
  });

  describe('Sending Input', () => {
    let terminalId: string;

    beforeEach(async () => {
      terminalId = await service.handle('create', { cols: 80, rows: 24 });
    });

    it('should send input to terminal', async () => {
      await service.handle('send', { terminalId, data: 'ls\n' });

      expect(mockPtyProcess.write).toHaveBeenCalledWith('ls\n');
    });

    it('should throw error for non-existent terminal', async () => {
      await expect(
        service.handle('send', { terminalId: 'invalid-id', data: 'test' })
      ).rejects.toMatchObject({
        code: ErrorCode.TERMINAL_NOT_FOUND,
      });
    });

    it('should throw error when sending to exited terminal', async () => {
      // Simulate terminal exit
      if (ptyExitHandler) {
        ptyExitHandler({ exitCode: 0 });
      }

      await expect(
        service.handle('send', { terminalId, data: 'test' })
      ).rejects.toMatchObject({
        code: ErrorCode.TERMINAL_PROCESS_EXITED,
        message: 'Terminal process has exited',
      });
    });

    it('should prevent sending to other user terminals', async () => {
      const otherSocket = {
        ...mockSocket,
        data: { uid: 'different-user' },
      };
      const otherService = new TerminalService(otherSocket, 10, 10000, '/test/root');

      await expect(
        otherService.handle('send', { terminalId, data: 'test' })
      ).rejects.toMatchObject({
        code: ErrorCode.TERMINAL_NOT_FOUND,
      });
    });
  });

  describe('Resizing Terminal', () => {
    let terminalId: string;

    beforeEach(async () => {
      terminalId = await service.handle('create', { cols: 80, rows: 24 });
    });

    it('should resize terminal', async () => {
      await service.handle('resize', { terminalId, cols: 120, rows: 30 });

      expect(mockPtyProcess.resize).toHaveBeenCalledWith(120, 30);
      expect(mockXterm.resize).toHaveBeenCalledWith(120, 30);
    });

    it('should throw error for non-existent terminal', async () => {
      await expect(
        service.handle('resize', { terminalId: 'invalid-id', cols: 100, rows: 50 })
      ).rejects.toMatchObject({
        code: ErrorCode.TERMINAL_NOT_FOUND,
      });
    });

    it('should prevent resizing other user terminals', async () => {
      const otherSocket = {
        ...mockSocket,
        data: { uid: 'different-user' },
      };
      const otherService = new TerminalService(otherSocket, 10, 10000, '/test/root');

      await expect(
        otherService.handle('resize', { terminalId, cols: 100, rows: 50 })
      ).rejects.toMatchObject({
        code: ErrorCode.TERMINAL_NOT_FOUND,
      });
    });
  });

  describe('Terminal Destruction', () => {
    let terminalId: string;

    beforeEach(async () => {
      terminalId = await service.handle('create', { cols: 80, rows: 24 });
    });

    it('should destroy terminal session', async () => {
      await service.handle('destroy', { terminalId });

      expect(mockPtyProcess.kill).toHaveBeenCalled();

      // Terminal should no longer exist
      await expect(
        service.handle('send', { terminalId, data: 'test' })
      ).rejects.toMatchObject({
        code: ErrorCode.TERMINAL_NOT_FOUND,
      });
    });

    it('should throw error for non-existent terminal', async () => {
      await expect(
        service.handle('destroy', { terminalId: 'invalid-id' })
      ).rejects.toMatchObject({
        code: ErrorCode.TERMINAL_NOT_FOUND,
      });
    });

    it('should not kill process if already exited', async () => {
      // Simulate exit
      if (ptyExitHandler) {
        ptyExitHandler({ exitCode: 0 });
      }

      mockPtyProcess.kill.mockClear();

      await service.handle('destroy', { terminalId });

      expect(mockPtyProcess.kill).not.toHaveBeenCalled();
    });

    it('should clear active terminal ID if destroying active terminal', async () => {
      await service.handle('activate', { terminalId });
      await service.handle('destroy', { terminalId });

      // Create and activate new terminal should work
      const newTerminalId = await service.handle('create', { cols: 80, rows: 24 });
      await expect(
        service.handle('activate', { terminalId: newTerminalId })
      ).resolves.toBeUndefined();
    });

    it('should prevent destroying other user terminals', async () => {
      const otherSocket = {
        ...mockSocket,
        data: { uid: 'different-user' },
      };
      const otherService = new TerminalService(otherSocket, 10, 10000, '/test/root');

      await expect(
        otherService.handle('destroy', { terminalId })
      ).rejects.toMatchObject({
        code: ErrorCode.TERMINAL_NOT_FOUND,
      });
    });
  });

  describe('Buffer Refresh', () => {
    let terminalId: string;

    beforeEach(async () => {
      terminalId = await service.handle('create', { cols: 80, rows: 24 });
      mockSocket.emit.mockClear();
    });

    it('should refresh terminal buffer', async () => {
      await service.handle('refresh', { terminalId });

      expect(mockSocket.emit).toHaveBeenCalledWith(
        'rpc',
        expect.objectContaining({
          method: 'terminal.bufferRefresh',
          params: expect.objectContaining({
            terminalId,
            buffer: 'serialized-buffer-content',
          }),
        })
      );
    });

    it('should throw error for non-existent terminal', async () => {
      await expect(
        service.handle('refresh', { terminalId: 'invalid-id' })
      ).rejects.toMatchObject({
        code: ErrorCode.TERMINAL_NOT_FOUND,
      });
    });

    it('should prevent refreshing other user terminals', async () => {
      const otherSocket = {
        ...mockSocket,
        data: { uid: 'different-user' },
      };
      const otherService = new TerminalService(otherSocket, 10, 10000, '/test/root');

      await expect(
        otherService.handle('refresh', { terminalId })
      ).rejects.toMatchObject({
        code: ErrorCode.TERMINAL_NOT_FOUND,
      });
    });
  });

  describe('Terminal List', () => {
    it('should list all terminals for user', async () => {
      const terminal1 = await service.handle('create', { cols: 80, rows: 24 });
      const terminal2 = await service.handle('create', { cols: 80, rows: 24 });

      const result = await service.handle('list', {});

      expect(result).toEqual([terminal1, terminal2]);
    });

    it('should return empty array when no terminals exist', async () => {
      const result = await service.handle('list', {});

      expect(result).toEqual([]);
    });

    it('should only list terminals for current user', async () => {
      // Create terminal for user-123
      const terminal1 = await service.handle('create', { cols: 80, rows: 24 });

      // Create service for different user
      const otherSocket = {
        ...mockSocket,
        data: { uid: 'different-user' },
      };
      const otherService = new TerminalService(otherSocket, 10, 10000, '/test/root');

      // Different user should see empty list
      const result = await otherService.handle('list', {});
      expect(result).toEqual([]);
    });
  });

  describe('PTY Output Handling', () => {
    let terminalId: string;

    beforeEach(async () => {
      terminalId = await service.handle('create', { cols: 80, rows: 24 });
      mockSocket.emit.mockClear();
    });

    it('should write PTY output to xterm buffer', async () => {
      // Simulate PTY output
      if (ptyDataHandler) {
        ptyDataHandler('hello world');
      }

      expect(mockXterm.write).toHaveBeenCalledWith('hello world');
    });

    it('should stream output to client when terminal is active', async () => {
      await service.handle('activate', { terminalId });
      mockSocket.emit.mockClear();

      // Simulate PTY output
      if (ptyDataHandler) {
        ptyDataHandler('hello world');
      }

      expect(mockSocket.emit).toHaveBeenCalledWith(
        'rpc',
        expect.objectContaining({
          method: 'terminal.output',
          params: {
            terminalId,
            data: 'hello world',
          },
        })
      );
    });

    it('should not stream output when terminal is inactive', async () => {
      // Don't activate, just simulate output
      if (ptyDataHandler) {
        ptyDataHandler('hello world');
      }

      const outputCalls = mockSocket.emit.mock.calls.filter(
        (call: any[]) => call[1].method === 'terminal.output'
      );

      expect(outputCalls.length).toBe(0);
    });
  });

  describe('PTY Exit Handling', () => {
    let terminalId: string;

    beforeEach(async () => {
      terminalId = await service.handle('create', { cols: 80, rows: 24 });
      mockSocket.emit.mockClear();
    });

    it('should notify client when terminal exits', async () => {
      // Simulate PTY exit
      if (ptyExitHandler) {
        ptyExitHandler({ exitCode: 0 });
      }

      expect(mockSocket.emit).toHaveBeenCalledWith(
        'rpc',
        expect.objectContaining({
          method: 'terminal.exited',
          params: {
            terminalId,
            exitCode: 0,
          },
        })
      );
    });

    it('should mark terminal as exited', async () => {
      // Simulate PTY exit
      if (ptyExitHandler) {
        ptyExitHandler({ exitCode: 127 });
      }

      // Sending to exited terminal should fail
      await expect(
        service.handle('send', { terminalId, data: 'test' })
      ).rejects.toMatchObject({
        code: ErrorCode.TERMINAL_PROCESS_EXITED,
      });
    });

    it('should preserve buffer after exit', async () => {
      // Simulate PTY exit
      if (ptyExitHandler) {
        ptyExitHandler({ exitCode: 0 });
      }

      // Should still be able to refresh buffer
      await expect(
        service.handle('refresh', { terminalId })
      ).resolves.toBeUndefined();

      expect(mockSocket.emit).toHaveBeenCalledWith(
        'rpc',
        expect.objectContaining({
          method: 'terminal.bufferRefresh',
        })
      );
    });
  });

  describe('Error Handling', () => {
    it('should throw error for unknown method', async () => {
      await expect(
        service.handle('unknownMethod', {})
      ).rejects.toMatchObject({
        code: ErrorCode.METHOD_NOT_FOUND,
        message: expect.stringContaining('Method not found'),
      });
    });
  });

  describe('Cleanup', () => {
    it('should kill all terminals on cleanup', async () => {
      const terminal1 = await service.handle('create', { cols: 80, rows: 24 });
      const terminal2 = await service.handle('create', { cols: 80, rows: 24 });

      // Clear previous calls
      mockPtyProcess.kill.mockClear();

      service.cleanup();

      // Both terminals should be killed
      expect(mockPtyProcess.kill).toHaveBeenCalledTimes(2);
    });

    it('should not kill already exited terminals', async () => {
      const terminalId = await service.handle('create', { cols: 80, rows: 24 });

      // Simulate exit
      if (ptyExitHandler) {
        ptyExitHandler({ exitCode: 0 });
      }

      mockPtyProcess.kill.mockClear();

      service.cleanup();

      // Should not kill exited terminal
      expect(mockPtyProcess.kill).not.toHaveBeenCalled();
    });

    it('should clear all sessions', async () => {
      await service.handle('create', { cols: 80, rows: 24 });
      await service.handle('create', { cols: 80, rows: 24 });

      service.cleanup();

      const result = await service.handle('list', {});
      expect(result).toEqual([]);
    });
  });
});
