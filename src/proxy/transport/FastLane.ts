/**
 * Fast Lane — direct (peer-to-peer) WebRTC transport between the CLI and the
 * editor. The relay server is only used for signaling (SDP offer/answer and
 * ICE candidates); once the DataChannel opens, RPC traffic bypasses the relay.
 *
 * The relay decides who may use Fast Lane (Supporter tier or higher) and only
 * forwards signals for connections it has granted. The CLI never trusts the
 * DataChannel on its own: the same HMAC handshake used over the relay must
 * complete over the DataChannel before any RPC is served, and on Fast Lane
 * that handshake also signs both DTLS fingerprints (channelBinding), so a
 * relay that rewrote the SDP to man-in-the-middle the connection is detected.
 *
 * WebRTC comes from the optional `node-datachannel` dependency. If it failed
 * to install (unsupported platform), Fast Lane is reported as unsupported and
 * every connection uses the relay exactly as before.
 */

import { encodeMessage, FrameReassembler, FRAMING_VERSION } from './framing.js';

export { FRAMING_VERSION };

export const DATA_CHANNEL_LABEL = 'spck';
// Give up on a negotiation that hasn't produced an open channel in time; the
// editor falls back to the relay on its own schedule (shorter than this).
const NEGOTIATION_TIMEOUT_MS = 30_000;
// Backpressure: stop handing fragments to SCTP above HIGH_WATER and resume
// when the channel's buffer drains below LOW_WATER.
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;
const MAX_SDP_LENGTH = 16 * 1024;
const MAX_CANDIDATE_LENGTH = 1024;
const MAX_ICE_SERVERS = 8;

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type FastLaneSignal =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'candidate'; candidate: string; sdpMid?: string | null }
  | { type: 'abort'; reason?: string };

interface WebRTCModule {
  RTCPeerConnection: new (config?: any) => any;
}

let webrtcPromise: Promise<WebRTCModule | null> | null = null;

/** Lazily load the optional native WebRTC binding. Resolves null if absent. */
export function loadWebRTC(): Promise<WebRTCModule | null> {
  if (!webrtcPromise) {
    // Variable specifier keeps tsc from requiring the optional package's types.
    const specifier = 'node-datachannel/polyfill';
    webrtcPromise = import(specifier)
      .then((mod: any) => {
        const candidate = mod?.RTCPeerConnection ? mod : mod?.default;
        return candidate?.RTCPeerConnection ? (candidate as WebRTCModule) : null;
      })
      .catch(() => null);
  }
  return webrtcPromise;
}

/** Canonical `alg HEX` list of the DTLS fingerprints in an SDP, or '' if none. */
function sdpFingerprints(sdp: string): string {
  const found = new Set<string>();
  for (const match of sdp.matchAll(/^a=fingerprint:(\S+)[ \t]+([0-9A-Fa-f:]+)[ \t]*\r?$/gm)) {
    found.add(`${match[1].toLowerCase()} ${match[2].toUpperCase()}`);
  }
  return Array.from(found).sort().join(',');
}

/**
 * Channel binding for the auth handshake: both DTLS certificate fingerprints,
 * offer (editor) first. The WebRTC stack refuses a DTLS peer whose certificate
 * doesn't match the remote SDP fingerprint, so if both ends sign the same
 * binding, nobody — including the signaling relay — swapped fingerprints to
 * sit in the middle. Must stay byte-identical to PeerTransport.channelBinding
 * in app-fs/peer-transport.js. Returns null when either side lacks one.
 */
export function channelBinding(offerSdp: string, answerSdp: string): string | null {
  const offer = sdpFingerprints(offerSdp);
  const answer = sdpFingerprints(answerSdp);
  if (!offer || !answer) return null;
  return `offer=${offer};answer=${answer}`;
}

/** Only accept ICE server entries that look like STUN/TURN URLs. */
export function sanitizeIceServers(input: unknown): IceServer[] {
  if (!Array.isArray(input)) return [];
  const valid = (url: unknown) => typeof url === 'string' && /^(stun|stuns|turn|turns):/i.test(url) && url.length < 512;
  const out: IceServer[] = [];
  for (const entry of input.slice(0, MAX_ICE_SERVERS)) {
    if (!entry || typeof entry !== 'object') continue;
    const urls = (entry as any).urls;
    const list = Array.isArray(urls) ? urls.filter(valid) : valid(urls) ? [urls] : [];
    if (list.length === 0) continue;
    const server: IceServer = { urls: list };
    if (typeof (entry as any).username === 'string') server.username = (entry as any).username;
    if (typeof (entry as any).credential === 'string') server.credential = (entry as any).credential;
    out.push(server);
  }
  return out;
}

/**
 * One open DataChannel, speaking the framing protocol. Provides an ordered,
 * backpressured send queue so large file transfers don't overflow SCTP.
 */
export class PeerChannel {
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private drainWaiters: Array<() => void> = [];
  private reassembler = new FrameReassembler();
  private closed = false;

  constructor(
    private readonly channel: any,
    private readonly handlers: {
      onOpen: () => void;
      onMessage: (event: string, data: any) => void;
      onClose: (reason: string) => void;
    }
  ) {
    channel.binaryType = 'arraybuffer';
    try {
      channel.bufferedAmountLowThreshold = LOW_WATER;
    } catch {
      // Older bindings may not expose the setter; flush() still polls.
    }
    channel.onbufferedamountlow = () => this.flush();
    channel.onmessage = (event: { data: any }) => this.receive(event.data);
    channel.onclose = () => this.handleClose('closed');
    channel.onerror = () => this.handleClose('error');
    if (channel.readyState === 'open') {
      queueMicrotask(() => this.handlers.onOpen());
    } else {
      channel.onopen = () => this.handlers.onOpen();
    }
  }

  get isOpen(): boolean {
    return !this.closed && this.channel.readyState === 'open';
  }

  send(event: string, data: any): boolean {
    if (!this.isOpen) return false;
    for (const fragment of encodeMessage(event, data)) {
      this.queue.push(fragment);
      this.queuedBytes += fragment.byteLength;
    }
    this.flush();
    return true;
  }

  /** Resolves once queued-but-unsent data is below the high-water mark. */
  whenWritable(): Promise<void> {
    if (this.closed || this.queuedBytes < HIGH_WATER) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseWaiters();
    try {
      this.channel.close();
    } catch {
      // Already closed.
    }
  }

  private flush(): void {
    if (this.closed) return;
    try {
      while (this.queue.length > 0 && this.channel.bufferedAmount < HIGH_WATER) {
        const fragment = this.queue.shift()!;
        this.queuedBytes -= fragment.byteLength;
        this.channel.send(fragment);
      }
    } catch {
      this.handleClose('send_failed');
      return;
    }
    if (this.queuedBytes < HIGH_WATER) this.releaseWaiters();
  }

  private releaseWaiters(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  private receive(raw: any): void {
    if (this.closed) return;
    if (typeof raw === 'string') {
      // Protocol is binary-only; a text frame means a confused or hostile peer.
      this.handleClose('protocol_error');
      return;
    }
    try {
      const message = this.reassembler.push(raw);
      if (message) this.handlers.onMessage(message.event, message.data);
    } catch {
      this.handleClose('protocol_error');
    }
  }

  private handleClose(reason: string): void {
    if (this.closed) return;
    this.close();
    this.handlers.onClose(reason);
  }
}

interface Session {
  pc: any;
  channel: PeerChannel | null;
  remoteDescriptionSet: boolean;
  pendingCandidates: Array<{ candidate: string; sdpMid?: string | null }>;
  timer: NodeJS.Timeout | null;
  open: boolean;
  offerSdp: string | null;
  answerSdp: string | null;
}

export interface FastLaneHooks {
  sendSignal: (connectionId: string, signal: FastLaneSignal) => void;
  onOpen: (connectionId: string) => void;
  onMessage: (connectionId: string, event: string, data: any) => void;
  onClose: (connectionId: string, reason: string, wasOpen: boolean) => void;
}

/**
 * Manages one WebRTC session per relay connectionId. The editor is always the
 * offerer; the CLI answers. Sessions only exist after the relay sends
 * `client_fast_lane`, i.e. after it has verified the subscription.
 */
export class FastLaneManager {
  private sessions = new Map<string, Session>();

  constructor(private readonly hooks: FastLaneHooks) {}

  static async isSupported(): Promise<boolean> {
    return (await loadWebRTC()) !== null;
  }

  has(connectionId: string): boolean {
    return this.sessions.has(connectionId);
  }

  isOpen(connectionId: string): boolean {
    return this.sessions.get(connectionId)?.channel?.isOpen ?? false;
  }

  /** Called when the relay grants Fast Lane for a connection. */
  async prepare(connectionId: string, iceServers: unknown): Promise<boolean> {
    this.close(connectionId, 'renegotiate', false);
    const webrtc = await loadWebRTC();
    if (!webrtc) {
      this.hooks.sendSignal(connectionId, { type: 'abort', reason: 'unsupported' });
      return false;
    }

    let pc: any;
    try {
      pc = new webrtc.RTCPeerConnection({ iceServers: sanitizeIceServers(iceServers) });
    } catch {
      this.hooks.sendSignal(connectionId, { type: 'abort', reason: 'init_failed' });
      return false;
    }

    const session: Session = {
      pc,
      channel: null,
      remoteDescriptionSet: false,
      pendingCandidates: [],
      timer: null,
      open: false,
      offerSdp: null,
      answerSdp: null,
    };
    this.sessions.set(connectionId, session);

    session.timer = setTimeout(() => {
      if (!session.open) this.close(connectionId, 'timeout');
    }, NEGOTIATION_TIMEOUT_MS);

    pc.onicecandidate = (event: any) => {
      const candidate = event?.candidate;
      if (!candidate?.candidate) return;
      this.hooks.sendSignal(connectionId, {
        type: 'candidate',
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
      });
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'failed' || state === 'closed') this.close(connectionId, state);
    };

    pc.ondatachannel = (event: any) => {
      const channel = event?.channel;
      if (!channel || channel.label !== DATA_CHANNEL_LABEL || session.channel) {
        try { channel?.close(); } catch { /* ignore */ }
        return;
      }
      session.channel = new PeerChannel(channel, {
        onOpen: () => {
          if (this.sessions.get(connectionId) !== session) return;
          session.open = true;
          if (session.timer) clearTimeout(session.timer);
          session.timer = null;
          this.hooks.onOpen(connectionId);
        },
        onMessage: (name, data) => {
          if (this.sessions.get(connectionId) === session) this.hooks.onMessage(connectionId, name, data);
        },
        onClose: (reason) => {
          if (this.sessions.get(connectionId) === session) this.close(connectionId, reason);
        },
      });
    };

    return true;
  }

  /** Handle a signal relayed from the editor. Unknown sessions are ignored. */
  async handleSignal(connectionId: string, signal: any): Promise<void> {
    const session = this.sessions.get(connectionId);
    if (!session || !signal || typeof signal !== 'object') return;

    try {
      switch (signal.type) {
        case 'offer': {
          if (typeof signal.sdp !== 'string' || signal.sdp.length > MAX_SDP_LENGTH || session.remoteDescriptionSet) return;
          await session.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
          session.remoteDescriptionSet = true;
          session.offerSdp = signal.sdp;
          for (const candidate of session.pendingCandidates.splice(0)) {
            await session.pc.addIceCandidate(candidate).catch(() => {});
          }
          const answer = await session.pc.createAnswer();
          await session.pc.setLocalDescription(answer);
          if (this.sessions.get(connectionId) !== session) return;
          const sdp = session.pc.localDescription?.sdp ?? answer.sdp;
          session.answerSdp = sdp;
          this.hooks.sendSignal(connectionId, { type: 'answer', sdp });
          break;
        }
        case 'candidate': {
          if (typeof signal.candidate !== 'string' || signal.candidate.length > MAX_CANDIDATE_LENGTH) return;
          const candidate = {
            candidate: signal.candidate,
            sdpMid: typeof signal.sdpMid === 'string' ? signal.sdpMid : '0',
          };
          if (!session.remoteDescriptionSet) {
            if (session.pendingCandidates.length < 64) session.pendingCandidates.push(candidate);
            return;
          }
          await session.pc.addIceCandidate(candidate).catch(() => {});
          break;
        }
        case 'abort':
          this.close(connectionId, 'aborted');
          break;
      }
    } catch {
      this.hooks.sendSignal(connectionId, { type: 'abort', reason: 'negotiation_failed' });
      this.close(connectionId, 'negotiation_failed');
    }
  }

  /** Channel binding of an open session (see channelBinding), else null. */
  channelBinding(connectionId: string): string | null {
    const session = this.sessions.get(connectionId);
    if (!session?.open || !session.offerSdp || !session.answerSdp) return null;
    return channelBinding(session.offerSdp, session.answerSdp);
  }

  send(connectionId: string, event: string, data: any): boolean {
    return this.sessions.get(connectionId)?.channel?.send(event, data) ?? false;
  }

  whenWritable(connectionId: string): Promise<void> {
    return this.sessions.get(connectionId)?.channel?.whenWritable() ?? Promise.resolve();
  }

  close(connectionId: string, reason = 'closed', notify = true): void {
    const session = this.sessions.get(connectionId);
    if (!session) return;
    this.sessions.delete(connectionId);
    if (session.timer) clearTimeout(session.timer);
    session.channel?.close();
    try {
      session.pc.close();
    } catch {
      // Already closed.
    }
    if (notify) this.hooks.onClose(connectionId, reason, session.open);
  }

  closeAll(): void {
    for (const connectionId of Array.from(this.sessions.keys())) {
      this.close(connectionId, 'shutdown', false);
    }
  }
}
