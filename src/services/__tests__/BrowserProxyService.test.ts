import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
/**
 * Tests for BrowserProxyService edge cases
 */

import http from 'http';
import { BrowserProxyService } from '../BrowserProxyService.js';
import { ErrorCode } from '../../types.js';

function makeService() {
  return new BrowserProxyService();
}

function startServer(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ port, close: () => new Promise<void>((res) => server.close(() => res())) });
    });
    server.on('error', reject);
  });
}

function makeParams(overrides: Record<string, any> = {}) {
  return { requestId: 'req-1', url: 'http://localhost:3000/', method: 'GET', headers: {}, body: null, ...overrides };
}

function makeSocket(deviceId = 'test-device-1') {
  return { data: { deviceId, uid: 'test-user' } } as any;
}

describe('BrowserProxyService', () => {
  let service: BrowserProxyService;
  beforeEach(() => { service = makeService(); });

  it('rejects unknown RPC methods', async () => {
    await expect(service.handle('unknown', makeParams(), makeSocket())).rejects.toMatchObject({ code: ErrorCode.METHOD_NOT_FOUND });
  });

  it.each([
    ['non-localhost hostname', 'http://example.com/'],
    ['internal IP',           'http://192.168.1.1:3000/'],
    ['0.0.0.0',               'http://0.0.0.0:3000/'],
  ])('rejects %s', async (_label, url) => {
    await expect(service.handle('request', makeParams({ url }), makeSocket())).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });
  });

  it.each([
    ['malformed URL', 'not-a-url',              ErrorCode.INVALID_PARAMS],
    ['port 0',        'http://localhost:0/',     ErrorCode.INVALID_PARAMS],
    ['port > 65535',  'http://localhost:99999/', ErrorCode.INVALID_PARAMS],
    ['TRACE method',  'http://localhost:3000/',  ErrorCode.INVALID_PARAMS],
  ])('rejects %s', async (_label, urlOrMethod, code) => {
    const isMethod = _label.includes('method');
    await expect(
      service.handle('request', makeParams(isMethod ? { method: 'TRACE' } : { url: urlOrMethod }), makeSocket())
    ).rejects.toMatchObject({ code });
  });

  it('forwards POST body bytes and returns base64-encoded response', async () => {
    let receivedBody = '';
    const srv = await startServer((req, res) => {
      req.on('data', (c) => { receivedBody += c.toString(); });
      req.on('end', () => { res.writeHead(200); res.end('pong'); });
    });
    try {
      const result = await service.handle('request', makeParams({
        url: `http://localhost:${srv.port}/`,
        method: 'POST',
        body: Array.from(Buffer.from('ping')),
      }), makeSocket());
      expect(receivedBody).toBe('ping');
      expect(result.bodyEncoding).toBe('base64');
      expect(Buffer.from(result.body, 'base64').toString()).toBe('pong');
    } finally {
      await srv.close();
    }
  });

  it('correctly encodes binary response body', async () => {
    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe]);
    const srv = await startServer((_req, res) => { res.writeHead(200); res.end(binary); });
    try {
      const result = await service.handle('request', makeParams({ url: `http://localhost:${srv.port}/` }), makeSocket());
      expect(Buffer.from(result.body, 'base64')).toEqual(binary);
    } finally {
      await srv.close();
    }
  });

  it('strips hop-by-hop headers and forwards custom headers', async () => {
    let received: http.IncomingHttpHeaders = {};
    const srv = await startServer((req, res) => { received = req.headers; res.writeHead(200); res.end(); });
    try {
      await service.handle('request', makeParams({
        url: `http://localhost:${srv.port}/`,
        headers: { 'transfer-encoding': 'chunked', 'upgrade': 'websocket', 'x-custom': 'yes' },
      }), makeSocket());
      expect(received['transfer-encoding']).toBeUndefined();
      expect(received['upgrade']).toBeUndefined();
      expect(received['x-custom']).toBe('yes');
    } finally {
      await srv.close();
    }
  });

  it('rejects with INTERNAL_ERROR on ECONNREFUSED', async () => {
    await expect(
      service.handle('request', makeParams({ url: 'http://localhost:19999/' }), makeSocket())
    ).rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
  });

  it('rejects with OPERATION_TIMEOUT when server hangs', async () => {
    const srv = await startServer(() => { /* hang */ });
    try {
      vi.spyOn(service as any, 'fetch').mockImplementation((...args: unknown[]) => {
        const url = args[0] as URL;
        return new Promise((_res, reject) => {
          const req = http.request({ hostname: url.hostname, port: url.port, path: '/', timeout: 50 });
          req.on('timeout', () => { req.destroy(); reject({ code: ErrorCode.OPERATION_TIMEOUT, message: 'timed out' }); });
          req.on('error', reject);
          req.end();
        });
      });
      await expect(service.handle('request', makeParams({ url: `http://localhost:${srv.port}/` }), makeSocket()))
        .rejects.toMatchObject({ code: ErrorCode.OPERATION_TIMEOUT });
    } finally {
      vi.restoreAllMocks();
      await srv.close();
    }
  });

  it('rejects responses exceeding 10 MB', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200);
      const chunk = Buffer.alloc(1024 * 1024);
      let sent = 0;
      const write = () => {
        while (sent < 11) {
          if (!res.write(chunk)) { res.once('drain', write); return; }
          sent++;
        }
        res.end();
      };
      write();
    });
    try {
      await expect(service.handle('request', makeParams({ url: `http://localhost:${srv.port}/` }), makeSocket()))
        .rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
    } finally {
      await srv.close();
    }
  });
});
