/**
 * BrowserProxyService - Handles browser.proxy.request RPC calls
 *
 * Fetches from localhost:PORT/path and returns the HTTP response
 * back to the editor client, which forwards it to the browser.spck.io SW.
 */

import http from 'http';
import https from 'https';
import { AuthenticatedSocket, ErrorCode, createRPCError } from '../types.js';
import { logBrowserProxy } from '../utils/logger.js';

const REQUEST_TIMEOUT_MS = 30000;
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1']);
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

interface ProxyRequestParams {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: number[] | null;
}

interface ProxyResponse {
  requestId: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;           // base64-encoded response body
  bodyEncoding: 'base64';
}

export class BrowserProxyService {
  async handle(method: string, params: any, socket: AuthenticatedSocket): Promise<any> {
    switch (method) {
      case 'request':
        return await this.proxyRequest(params, socket.data.deviceId);
      default:
        throw createRPCError(ErrorCode.METHOD_NOT_FOUND, `Method not found: browser.proxy.${method}`);
    }
  }

  private async proxyRequest(params: ProxyRequestParams, uid: string): Promise<ProxyResponse> {
    const { requestId, url, method, headers, body } = params;

    // Validate method
    const upperMethod = (method || 'GET').toUpperCase();
    if (!ALLOWED_METHODS.has(upperMethod)) {
      throw createRPCError(ErrorCode.INVALID_PARAMS, `Disallowed HTTP method: ${method}`);
    }

    // Validate URL — must be localhost only
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw createRPCError(ErrorCode.INVALID_PARAMS, `Invalid URL: ${url}`);
    }

    if (!ALLOWED_HOSTS.has(parsed.hostname)) {
      throw createRPCError(ErrorCode.PERMISSION_DENIED, `Only localhost requests are allowed`);
    }

    const port = parseInt(parsed.port || '80', 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      throw createRPCError(ErrorCode.INVALID_PARAMS, `Invalid port: ${parsed.port}`);
    }

    // Convert body array back to Buffer
    const bodyBuffer = body && body.length > 0 ? Buffer.from(body) : undefined;

    // Strip hop-by-hop headers that should not be forwarded
    const forwardHeaders: Record<string, string> = {};
    const hopByHop = new Set([
      'connection', 'keep-alive', 'transfer-encoding', 'te',
      'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate'
    ]);
    for (const [key, value] of Object.entries(headers || {})) {
      if (!hopByHop.has(key.toLowerCase())) {
        forwardHeaders[key] = value;
      }
    }
    if (bodyBuffer) {
      forwardHeaders['content-length'] = String(bodyBuffer.length);
    }

    try {
      const response = await this.fetch(parsed, upperMethod, forwardHeaders, bodyBuffer);
      logBrowserProxy(params, uid, true, undefined, {
        status: response.status,
        size: Buffer.byteLength(response.body, 'base64') * 3 / 4 | 0,
      });
      return { requestId, ...response };
    } catch (error: any) {
      logBrowserProxy(params, uid, false, error);
      throw error;
    }
  }

  private fetch(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body?: Buffer
  ): Promise<Omit<ProxyResponse, 'requestId'>> {
    return new Promise((resolve, reject) => {
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
        timeout: REQUEST_TIMEOUT_MS,
      };

      const req = lib.request(options, (res) => {
        const chunks: Buffer[] = [];
        let totalLength = 0;

        res.on('data', (chunk: Buffer) => {
          totalLength += chunk.length;
          if (totalLength > MAX_RESPONSE_BODY_BYTES) {
            req.destroy();
            reject(createRPCError(ErrorCode.INTERNAL_ERROR, 'Response body too large'));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);

          // Collect response headers (flatten multi-value headers)
          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined) {
              responseHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
            }
          }

          resolve({
            status: res.statusCode || 200,
            statusText: res.statusMessage || '',
            headers: responseHeaders,
            body: bodyBuffer.toString('base64'),
            bodyEncoding: 'base64',
          });
        });

        res.on('error', (err) => {
          reject(createRPCError(ErrorCode.INTERNAL_ERROR, `Response error: ${err.message}`));
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(createRPCError(ErrorCode.OPERATION_TIMEOUT, 'Request to localhost timed out'));
      });

      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNREFUSED') {
          reject(createRPCError(ErrorCode.INTERNAL_ERROR, `Connection refused on port ${(err as any).port || ''} — is the dev server running?`));
        } else {
          reject(createRPCError(ErrorCode.INTERNAL_ERROR, `Request failed: ${err.message}`));
        }
      });

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }
}
