import { describe, it, expect } from 'vitest';
import { encodeMessage, decodeMessage, FrameReassembler, FRAGMENT_SIZE } from '../framing.js';
import { FastLaneManager, loadWebRTC, sanitizeIceServers, DATA_CHANNEL_LABEL } from '../FastLane.js';

function roundTrip(event: string, data: any) {
  const reassembler = new FrameReassembler();
  let out: { event: string; data: any } | null = null;
  for (const fragment of encodeMessage(event, data)) {
    expect(fragment.byteLength).toBeLessThanOrEqual(FRAGMENT_SIZE);
    out = reassembler.push(fragment) ?? out;
  }
  return out!;
}

describe('Fast Lane framing', () => {
  it('round-trips JSON payloads', () => {
    const out = roundTrip('handshake', { type: 'auth_result', success: true, n: null, list: [1, 'two'] });
    expect(out).toEqual({ event: 'handshake', data: { type: 'auth_result', success: true, n: null, list: [1, 'two'] } });
  });

  it('carries nested binary values as Buffers across many fragments', () => {
    const blob = Buffer.alloc(FRAGMENT_SIZE * 5 + 123, 7);
    const view = new Uint8Array([1, 2, 3]);
    const out = roundTrip('rpc', { id: 1, result: { data: blob, parts: [view] } });
    expect(Buffer.isBuffer(out.data.result.data)).toBe(true);
    expect(Buffer.compare(out.data.result.data, blob)).toBe(0);
    expect([...out.data.result.parts[0]]).toEqual([1, 2, 3]);
  });

  it('does not serialize Buffers through Buffer#toJSON', () => {
    const [single] = encodeMessage('rpc', { data: Buffer.from('hi') });
    expect(Buffer.from(single).toString('utf8')).not.toContain('"type":"Buffer"');
  });

  it('rejects malformed and oversized messages', () => {
    expect(() => decodeMessage(Buffer.from([0, 0, 0, 99, 1]))).toThrow();
    const reassembler = new FrameReassembler(1024);
    expect(() => {
      for (const fragment of encodeMessage('rpc', { data: Buffer.alloc(4096) })) reassembler.push(fragment);
    }).toThrow(/maximum size/);
  });
});

describe('sanitizeIceServers', () => {
  it('keeps STUN/TURN entries and drops anything else', () => {
    expect(sanitizeIceServers([
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: ['turn:turn.example.com:3478', 'http://evil'], username: 'u', credential: 'p' },
      { urls: 'javascript:alert(1)' },
      null,
    ])).toEqual([
      { urls: ['stun:stun.l.google.com:19302'] },
      { urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' },
    ]);
    expect(sanitizeIceServers('nope')).toEqual([]);
  });
});

const webrtc = await loadWebRTC();

describe.skipIf(!webrtc)('FastLaneManager (real node-datachannel loopback)', () => {
  it('answers an offer, opens the channel and exchanges framed messages', async () => {
    const { RTCPeerConnection } = webrtc!;
    const received: Array<{ event: string; data: any }> = [];
    let editorPc: any;
    let opened!: () => void;
    const openPromise = new Promise<void>((resolve) => { opened = resolve; });

    const manager = new FastLaneManager({
      sendSignal: (_id, signal) => {
        if (signal.type === 'answer') editorPc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        if (signal.type === 'candidate') editorPc.addIceCandidate({ candidate: signal.candidate, sdpMid: signal.sdpMid ?? '0' });
      },
      onOpen: () => opened(),
      onMessage: (_id, event, data) => received.push({ event, data }),
      onClose: () => {},
    });

    expect(await manager.prepare('c1', [])).toBe(true);
    // Signals for connections the relay never granted are ignored.
    await manager.handleSignal('unknown', { type: 'offer', sdp: 'v=0' });
    expect(manager.has('unknown')).toBe(false);

    editorPc = new RTCPeerConnection({ iceServers: [] });
    editorPc.onicecandidate = (e: any) => {
      if (e.candidate?.candidate) manager.handleSignal('c1', { type: 'candidate', candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid });
    };
    const channel = editorPc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
    channel.binaryType = 'arraybuffer';
    const editorReassembler = new FrameReassembler();
    const fromCli = new Promise<any>((resolve) => {
      channel.onmessage = (e: any) => {
        const msg = editorReassembler.push(e.data);
        if (msg) resolve(msg);
      };
    });
    channel.onopen = () => {
      for (const f of encodeMessage('rpc', { jsonrpc: '2.0', id: 9, method: 'fs.stat', params: { blob: Buffer.alloc(50_000, 1) } })) channel.send(f);
    };

    const offer = await editorPc.createOffer();
    await editorPc.setLocalDescription(offer);
    await manager.handleSignal('c1', { type: 'offer', sdp: editorPc.localDescription.sdp });

    await openPromise;
    expect(manager.isOpen('c1')).toBe(true);
    await expect.poll(() => received.length, { timeout: 5000 }).toBe(1);
    expect(received[0].data.params.blob.length).toBe(50_000);

    expect(manager.send('c1', 'handshake', { type: 'connected' })).toBe(true);
    expect((await fromCli).data).toEqual({ type: 'connected' });

    manager.closeAll();
    expect(manager.has('c1')).toBe(false);
    editorPc.close();
  }, 15_000);
});
