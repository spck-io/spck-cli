/**
 * Message Chunking Utility
 *
 * Handles chunking of large payloads to avoid Socket.IO buffer limits
 * Chunks messages over 800kB into smaller pieces with reassembly metadata
 */

const CHUNK_SIZE = 800 * 1024; // 800kB
const CHUNK_THRESHOLD = 800 * 1024; // Start chunking at 800kB

export interface ChunkMetadata {
  type: 'chunk';
  chunkId: string;
  index: number;
  total: number;
  originalEvent: string;
  data: any;
}

export interface ChunkedMessage {
  needsChunking: boolean;
  chunks?: ChunkMetadata[];
  originalMessage?: any;
}

/**
 * Check if a message needs chunking
 */
export function needsChunking(data: any): boolean {
  const size = estimateSize(data);
  return size > CHUNK_THRESHOLD;
}

/**
 * Chunk a large message into smaller pieces
 */
export function chunkMessage(event: string, data: any): ChunkMetadata[] {
  // Serialize the data
  const serialized = JSON.stringify(data);
  const totalBytes = Buffer.byteLength(serialized, 'utf8');

  // Calculate number of chunks needed
  const numChunks = Math.ceil(totalBytes / CHUNK_SIZE);

  // Generate unique chunk ID
  const chunkId = generateChunkId();

  // Split into chunks
  const chunks: ChunkMetadata[] = [];
  let offset = 0;

  for (let i = 0; i < numChunks; i++) {
    const chunkData = serialized.slice(offset, offset + CHUNK_SIZE);
    offset += CHUNK_SIZE;

    chunks.push({
      type: 'chunk',
      chunkId,
      index: i,
      total: numChunks,
      originalEvent: event,
      data: chunkData,
    });
  }

  return chunks;
}

/**
 * Estimate size of an object in bytes
 */
function estimateSize(obj: any): number {
  const serialized = JSON.stringify(obj);
  return Buffer.byteLength(serialized, 'utf8');
}

/**
 * Generate unique chunk ID
 */
function generateChunkId(): string {
  return `chunk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Chunk reassembler (for client side)
 */
export class ChunkReassembler {
  private chunks: Map<string, Map<number, string>> = new Map();
  private totalChunks: Map<string, number> = new Map();
  private originalEvents: Map<string, string> = new Map();

  /**
   * Add a chunk and check if message is complete
   * @returns Reassembled data if complete, null otherwise
   */
  addChunk(chunk: ChunkMetadata): { complete: boolean; event?: string; data?: any } {
    const { chunkId, index, total, originalEvent, data } = chunk;

    // Initialize chunk storage for this chunkId
    if (!this.chunks.has(chunkId)) {
      this.chunks.set(chunkId, new Map());
      this.totalChunks.set(chunkId, total);
      this.originalEvents.set(chunkId, originalEvent);
    }

    // Store this chunk
    const chunkMap = this.chunks.get(chunkId)!;
    chunkMap.set(index, data);

    // Check if we have all chunks
    const expectedTotal = this.totalChunks.get(chunkId)!;
    if (chunkMap.size === expectedTotal) {
      // Reassemble message
      const reassembled = this.reassemble(chunkId);

      // Clean up
      this.chunks.delete(chunkId);
      this.totalChunks.delete(chunkId);
      this.originalEvents.delete(chunkId);

      return {
        complete: true,
        event: originalEvent,
        data: reassembled,
      };
    }

    return { complete: false };
  }

  /**
   * Reassemble chunks into original message
   */
  private reassemble(chunkId: string): any {
    const chunkMap = this.chunks.get(chunkId)!;
    const total = this.totalChunks.get(chunkId)!;

    // Concatenate chunks in order
    let reassembled = '';
    for (let i = 0; i < total; i++) {
      const chunk = chunkMap.get(i);
      if (!chunk) {
        throw new Error(`Missing chunk ${i} for chunkId ${chunkId}`);
      }
      reassembled += chunk;
    }

    // Parse back to object
    return JSON.parse(reassembled);
  }

  /**
   * Clean up stale chunks (older than 30 seconds)
   */
  cleanup(maxAge: number = 30000): void {
    // Note: This is a simple implementation that clears all chunks
    // A more sophisticated version could track timestamps
    this.chunks.clear();
    this.totalChunks.clear();
    this.originalEvents.clear();
  }
}
