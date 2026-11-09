import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('http', () => ({ createServer: vi.fn() }));
vi.mock('open', () => ({ default: vi.fn() }));
vi.mock('qrcode-terminal', () => ({ default: { generate: vi.fn() } }));
vi.mock('jsonwebtoken', () => ({ default: { decode: vi.fn() } }));
vi.mock('../../config/credentials.js', () => ({ saveCredentials: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({ logAuth: vi.fn() }));
vi.mock('../../i18n/index.js', () => ({ t: (key: string) => key }));
vi.mock('../../config/server-selection.js', () => ({
  fetchServerList: vi.fn().mockResolvedValue([]),
  selectBestServer: vi.fn().mockResolvedValue({ server: { url: 'cli-na-1.spck.io' } }),
  isValidDomain: vi.fn().mockReturnValue(true),
}));

import * as http from 'http';
import open from 'open';
import qrcode from 'qrcode-terminal';
import jwt from 'jsonwebtoken';
import { saveCredentials } from '../../config/credentials.js';
import { abortCurrentAuth, authenticateWithFirebase, getValidFirebaseToken } from '../firebase-auth.js';

describe('authenticateWithFirebase()', () => {
  let callbackServer: EventEmitter & { close: ReturnType<typeof vi.fn> };
  let fetchMock: ReturnType<typeof vi.fn>;
  let deliverRelayToken: (value: unknown) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(open).mockResolvedValue(undefined as never);
    vi.mocked(jwt.decode).mockReturnValue({ sub: 'user-123', exp: 2000000000 } as never);
    vi.mocked(http.createServer).mockImplementation(() => {
      const server = Object.assign(new EventEmitter(), {
        listen: vi.fn((_port: number, listener: () => void) => listener()),
        address: () => ({ port: 45678 }),
        close: vi.fn((listener?: () => void) => listener?.()),
      });
      callbackServer = server;
      return server as unknown as http.Server;
    });
    fetchMock = vi.fn().mockImplementation((_url, { signal }) => new Promise((resolve, reject) => {
      deliverRelayToken = resolve;
      signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    abortCurrentAuth();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const linkParams = (url: URL) => new URLSearchParams(url.hash.slice(1));

  async function startAuth() {
    const result = authenticateWithFirebase();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const url = new URL(vi.mocked(open).mock.calls[0][0] as string);
    return { result, url };
  }

  function completeViaRelay() {
    deliverRelayToken({ ok: true, json: async () => ({ idToken: 'id-token', refreshToken: 'refresh-token' }) });
  }

  it.each(['missing', 'expired', 'failed'])('reveals interactive sign-in when token refresh is %s', async (mode) => {
    if (mode === 'expired') {
      fetchMock.mockResolvedValueOnce({
        ok: false, json: async () => ({ error: { message: 'INVALID_REFRESH_TOKEN' } }),
      });
    } else if (mode === 'failed') {
      fetchMock.mockRejectedValueOnce(new Error('Network unavailable'));
    }
    const onInteractiveAuth = vi.fn();
    const result = getValidFirebaseToken({
      userId: 'user-123', refreshToken: mode === 'missing' ? '' : 'old-refresh-token',
    }, onInteractiveAuth);
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(onInteractiveAuth).toHaveBeenCalledOnce();
    completeViaRelay();
    await expect(result).resolves.toMatchObject({ firebaseToken: 'id-token' });
  });

  it('keeps link secrets in the fragment, with a relay-only manual QR and independent state', async () => {
    const { result, url } = await startAuth();
    expect(url.origin + url.pathname).toBe('https://spck.io/auth');
    expect(url.search).toBe('');
    const params = linkParams(url);
    expect(params.get('auto')).toBe('1');
    expect(params.get('server')).toBe('cli-na-1.spck.io');
    const code = params.get('code');
    expect(code).toMatch(/^[a-f0-9]{64}$/);
    expect(params.get('state')).toMatch(/^[a-f0-9]{64}$/);
    expect(params.get('state')).not.toBe(code);
    expect(params.get('redirect')).toBe('http://localhost:45678/callback');

    const manualUrl = new URL(vi.mocked(qrcode.generate).mock.calls[0][0]);
    expect(manualUrl.search).toBe('');
    const manualParams = linkParams(manualUrl);
    expect(manualParams.get('code')).toBe(code);
    expect(manualParams.get('server')).toBe('cli-na-1.spck.io');
    expect(manualParams.has('auto')).toBe(false);
    expect(manualParams.has('redirect')).toBe(false);
    expect(manualParams.has('state')).toBe(false);
    expect(fetchMock.mock.calls[0][0]).toBe('https://cli-na-1.spck.io/api/auth/token/poll');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ code });

    completeViaRelay();
    await expect(result).resolves.toEqual({
      firebaseToken: 'id-token', firebaseTokenExpiry: 2000000000000,
      refreshToken: 'refresh-token', userId: 'user-123',
    });
    expect(saveCredentials).toHaveBeenCalledOnce();
    expect(callbackServer.close).toHaveBeenCalled();
  });

  it('accepts the optional localhost POST and stops relay polling', async () => {
    const { result, url } = await startAuth();
    const request = Object.assign(new EventEmitter(), {
      method: 'POST', url: '/callback', headers: { 'content-type': 'application/json' },
    });
    const response = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
    callbackServer.emit('request', request, response);
    request.emit('data', JSON.stringify({
      token: 'id-token', refreshToken: 'refresh-token', state: linkParams(url).get('state'),
    }));
    request.emit('end');

    await expect(result).resolves.toMatchObject({ firebaseToken: 'id-token', userId: 'user-123' });
    expect(response.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(saveCredentials).toHaveBeenCalledOnce();
  });

  it('rejects a localhost POST that presents the relay code as its state', async () => {
    const { result, url } = await startAuth();
    const request = Object.assign(new EventEmitter(), {
      method: 'POST', url: '/callback', headers: { 'content-type': 'application/json' },
    });
    const response = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
    callbackServer.emit('request', request, response);
    request.emit('data', JSON.stringify({
      token: 'id-token', refreshToken: 'refresh-token', state: linkParams(url).get('code'),
    }));
    request.emit('end');

    await expect(result).rejects.toThrow('Invalid state parameter');
    expect(saveCredentials).not.toHaveBeenCalled();
  });

  it('still accepts relay tokens if the browser cannot be opened', async () => {
    vi.mocked(open).mockRejectedValue(new Error('Browser unavailable'));
    const { result } = await startAuth();
    completeViaRelay();
    await expect(result).resolves.toMatchObject({ firebaseToken: 'id-token' });
    expect(qrcode.generate).toHaveBeenCalledOnce();
  });
});
