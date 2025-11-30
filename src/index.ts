/**
 * Spck Networking Server
 * Unified server for filesystem, git, and terminal operations
 */

import { createServer } from 'http';
import { Server } from 'socket.io';
import { loadConfig, ConfigNotFoundError } from './config/config';
import { verifyFirebaseToken } from './connection/auth';
import { requireValidHMAC } from './connection/hmac';
import {
  AuthenticatedSocket,
  JSONRPCRequest,
  JSONRPCResponse,
  ErrorCode,
  createRPCError,
} from './types';
import { RPCRouter } from './rpc/router';
import { FileWatcher } from './watcher/FileWatcher';

/**
 * Start the server
 */
export async function startServer(configPath?: string) {
  // Load configuration
  let config;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    if (error instanceof ConfigNotFoundError) {
      // Run setup wizard
      const { runSetup } = await import('./setup/wizard');
      config = await runSetup(configPath);

      console.log('\n✅ Configuration saved successfully!');
      console.log('Starting server...\n');
    } else {
      throw error;
    }
  }

  console.log('Starting spck-networking server...');
  console.log(`Root directory: ${config.root}`);
  console.log(`Port: ${config.port}`);
  console.log(`Allowed UIDs: ${config.allowedUids.join(', ')}`);

  // Create HTTP server
  const httpServer = createServer();

  // Create Socket.IO server
  const io = new Server(httpServer, {
    path: '/connect',
    transports: ['websocket'],
    cors: {
      origin: '*',
      credentials: true,
    },
  });

  // Initialize services
  RPCRouter.initialize(config.root, config);

  // Start file watcher
  const fileWatcher = new FileWatcher(config.root, config.filesystem.watchIgnorePatterns);

  fileWatcher.on('change', (path, mtime) => {
    io.emit('rpc', {
      jsonrpc: '2.0',
      method: 'fs.changed',
      params: { path, mtime },
    });
  });

  fileWatcher.on('removed', (path) => {
    io.emit('rpc', {
      jsonrpc: '2.0',
      method: 'fs.removed',
      params: { path },
    });
  });

  fileWatcher.on('added', (path, mtime) => {
    io.emit('rpc', {
      jsonrpc: '2.0',
      method: 'fs.added',
      params: { path, mtime },
    });
  });

  // Firebase JWT authentication middleware
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;

    if (!token) {
      return next(new Error('No authentication token provided'));
    }

    try {
      // Verify Firebase token
      const payload = await verifyFirebaseToken(
        token,
        'spck-editor',
        config.allowedUids
      );

      // Attach user data to socket
      (socket as AuthenticatedSocket).data = {
        uid: payload.sub,
      };

      next();
    } catch (error: any) {
      console.error('Authentication failed:', error.message);
      next(new Error(error.message || 'Authentication failed'));
    }
  });

  // Handle connections
  io.on('connection', (socket: AuthenticatedSocket) => {
    const uid = socket.data.uid;
    console.log(`Client connected: ${socket.id}, UID: ${uid}`);

    // Handle RPC messages
    socket.on('rpc', async (message: JSONRPCRequest) => {
      try {
        // Validate HMAC if configured
        if (config.signingKey) {
          requireValidHMAC(message, config.signingKey);
        }

        // Route to appropriate service
        const result = await RPCRouter.route(message, socket);

        // Send response
        const response: JSONRPCResponse = {
          jsonrpc: '2.0',
          result,
          id: message.id || null,
        };

        socket.emit('rpc', response);
      } catch (error: any) {
        // Send error response
        const response: JSONRPCResponse = {
          jsonrpc: '2.0',
          error: error.code && error.message ? error : createRPCError(
            ErrorCode.INTERNAL_ERROR,
            error.message || 'Internal error'
          ),
          id: message.id || null,
        };

        socket.emit('rpc', response);
      }
    });

    // Handle binary data
    socket.on('rpc:binary', async ({ id, buffer }) => {
      // Binary data handling is context-dependent
      // The service that initiated the request should handle it
      console.log(`Received binary data for request ${id}, size: ${buffer.length} bytes`);
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
      // Note: Terminal sessions persist across disconnections
    });

    // Handle socket errors
    socket.on('error', (error) => {
      console.error(`Socket error for ${socket.id}:`, error);
    });
  });

  // Start HTTP server
  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, () => {
      console.log(`Server listening on port ${config.port}`);
      console.log(`WebSocket endpoint: ws://localhost:${config.port}/connect`);
      resolve();
    });
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down gracefully...');
    fileWatcher.close();
    io.close(() => {
      httpServer.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    });
  });

  return { io, httpServer, fileWatcher };
}

// Start server if run directly
if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}
