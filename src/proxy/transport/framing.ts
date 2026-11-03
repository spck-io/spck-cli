/**
 * Fast Lane wire framing — shared protocol with the editor
 * (app-fs/peer-transport.js). Keep both implementations byte-compatible.
 *
 * Socket.IO used to give us two things for free that a raw RTCDataChannel
 * does not: event names, and binary attachments nested inside JSON payloads
 * (fs.readBinary results, fs.writeBinary params, __binaryChunk streams).
 *
 * Message layout (before fragmentation):
 *   [uint32 BE headerLength][header JSON, UTF-8][blob 0][blob 1]...
 *   header = { e: eventName, d: payloadWithPlaceholders, b: [blobLength, ...] }
 *   every binary value in the payload is replaced by { "__spckBin": index }
 *
 * Fragmentation: each DataChannel message is
 *   [flags byte][fragment bytes]   flags bit 0 = FINAL fragment
 * The channel is ordered + reliable, so fragments are simply concatenated
 * until a FINAL one arrives. Fragments are capped at FRAGMENT_SIZE because
 * browsers disagree on the SCTP max-message-size (16 KiB is safe everywhere).
 */

export const FRAMING_VERSION = 1;
export const FRAGMENT_SIZE = 16 * 1024;
const FLAG_FINAL = 0x01;
const BIN_KEY = '__spckBin';

type Bin = Uint8Array;

function isBinary(value: any): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function toBytes(value: ArrayBuffer | ArrayBufferView): Bin {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * Replace binary values with placeholders. Buffers must be swapped out
 * before JSON.stringify, which would otherwise call Buffer#toJSON.
 */
function extractBinary(value: any, blobs: Bin[]): any {
  if (value === null || typeof value !== 'object') return value;
  if (isBinary(value)) {
    blobs.push(toBytes(value));
    return { [BIN_KEY]: blobs.length - 1 };
  }
  if (Array.isArray(value)) return value.map((v) => extractBinary(v, blobs));
  if (typeof value.toJSON === 'function') return value;
  const out: Record<string, any> = {};
  for (const key of Object.keys(value)) {
    out[key] = extractBinary(value[key], blobs);
  }
  return out;
}

function restoreBinary(value: any, blobs: Buffer[]): any {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => restoreBinary(v, blobs));
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === BIN_KEY && typeof value[BIN_KEY] === 'number') {
    const blob = blobs[value[BIN_KEY]];
    if (!blob) throw new Error('Fast Lane frame references a missing binary blob');
    return blob;
  }
  for (const key of keys) value[key] = restoreBinary(value[key], blobs);
  return value;
}

/** Encode one event into a list of DataChannel fragments. */
export function encodeMessage(event: string, data: any, fragmentSize = FRAGMENT_SIZE): Bin[] {
  const blobs: Bin[] = [];
  const payload = extractBinary(data, blobs);
  const header = Buffer.from(JSON.stringify({ e: event, d: payload, b: blobs.map((b) => b.byteLength) }), 'utf8');
  const total = 4 + header.byteLength + blobs.reduce((n, b) => n + b.byteLength, 0);
  const message = Buffer.allocUnsafe(total);
  message.writeUInt32BE(header.byteLength, 0);
  header.copy(message, 4);
  let offset = 4 + header.byteLength;
  for (const blob of blobs) {
    message.set(blob, offset);
    offset += blob.byteLength;
  }

  const body = fragmentSize - 1;
  const fragments: Bin[] = [];
  for (let start = 0; start < total || fragments.length === 0; start += body) {
    const end = Math.min(total, start + body);
    const fragment = new Uint8Array(1 + end - start);
    fragment[0] = end === total ? FLAG_FINAL : 0;
    fragment.set(message.subarray(start, end), 1);
    fragments.push(fragment);
  }
  return fragments;
}

/** Decode one fully reassembled message. Binary values come back as Buffer. */
export function decodeMessage(message: Buffer): { event: string; data: any } {
  if (message.byteLength < 4) throw new Error('Fast Lane frame too short');
  const headerLength = message.readUInt32BE(0);
  if (4 + headerLength > message.byteLength) throw new Error('Fast Lane frame header overflow');
  const header = JSON.parse(message.subarray(4, 4 + headerLength).toString('utf8'));
  if (typeof header?.e !== 'string' || !Array.isArray(header.b)) {
    throw new Error('Malformed Fast Lane frame header');
  }
  const blobs: Buffer[] = [];
  let offset = 4 + headerLength;
  for (const length of header.b) {
    if (typeof length !== 'number' || length < 0 || offset + length > message.byteLength) {
      throw new Error('Fast Lane frame blob overflow');
    }
    // Copy so callers can keep the blob without pinning the whole message.
    blobs.push(Buffer.from(message.subarray(offset, offset + length)));
    offset += length;
  }
  return { event: header.e, data: restoreBinary(header.d, blobs) };
}

/**
 * Reassembles fragments into messages. Caps the size of a single message so
 * a misbehaving peer cannot make us buffer without bound.
 */
export class FrameReassembler {
  private parts: Buffer[] = [];
  private size = 0;

  constructor(private readonly maxMessageBytes = 512 * 1024 * 1024) {}

  /** Returns a decoded message when `fragment` completes one, else null. */
  push(fragment: ArrayBuffer | ArrayBufferView): { event: string; data: any } | null {
    const bytes = toBytes(fragment);
    if (bytes.byteLength < 1) throw new Error('Empty Fast Lane fragment');
    const flags = bytes[0];
    const body = Buffer.from(bytes.subarray(1));
    this.size += body.byteLength;
    if (this.size > this.maxMessageBytes) {
      this.reset();
      throw new Error('Fast Lane message exceeds maximum size');
    }
    this.parts.push(body);
    if (!(flags & FLAG_FINAL)) return null;
    const message = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.size);
    this.reset();
    return decodeMessage(message);
  }

  reset(): void {
    this.parts = [];
    this.size = 0;
  }
}
