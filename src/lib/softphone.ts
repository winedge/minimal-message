// Twilio Voice SDK wrapper. Keeps the same public API our dialer already uses,
// so switching from JsSIP/Asterisk to Twilio only needs a token + a TwiML app.
import { Device, Call } from "@twilio/voice-sdk";

export type SoftphoneState =
  | "idle"
  | "registering"
  | "registered"
  | "calling"
  | "incoming"
  | "in_call"
  | "failed";

export interface IncomingCallInfo {
  from: string;
  displayName?: string;
}

export interface SoftphoneEvents {
  onState?: (s: SoftphoneState) => void;
  onError?: (msg: string) => void;
  onIncoming?: (info: IncomingCallInfo) => "auto-answer" | void;
  onEnded?: () => void;
  onMuteChange?: (muted: boolean) => void;
  onHoldChange?: (held: boolean) => void;
}

export class Softphone {
  private device: Device | null = null;
  private activeCall: Call | null = null;
  private events: SoftphoneEvents;
  private outputDeviceId: string | null = null;
  private inputDeviceId: string | null = null;
  private muted = false;
  private held = false;
  private holdProcessor: HoldMusicProcessor | null = null;

  constructor(events: SoftphoneEvents = {}) {
    this.events = events;
  }

  private setState(s: SoftphoneState) {
    this.events.onState?.(s);
  }

  async register(opts: { token: string; identity: string }) {
    if (!opts.token) {
      this.events.onError?.("Softphone: missing Twilio access token");
      return;
    }
    this.setState("registering");
    try {
      this.device = new Device(opts.token, {
        logLevel: "warn",
        closeProtection: true,
      });
      this.device.on("registered", () => this.setState("registered"));
      this.device.on("unregistered", () => this.setState("idle"));
      this.device.on("error", (e: any) => {
        const msg = e?.message ?? String(e);
        this.events.onError?.(`Twilio device error: ${msg}`);
        this.setState("failed");
      });
      this.device.on("tokenWillExpire", () => {
        console.warn("[softphone] Twilio access token will expire soon");
      });
      this.device.on("incoming", (call: Call) => this.handleIncoming(call));
      await this.device.register();
      // Attach hold-music audio processor. Twilio invokes createProcessedStream
      // once the input stream is available; our processor mixes synthesized
      // music alongside the mic and swaps gains when hold toggles.
      try {
        this.holdProcessor = new HoldMusicProcessor();
        await this.device.audio?.addProcessor(this.holdProcessor as any);
      } catch (e) {
        console.warn("[softphone] hold processor unavailable", e);
      }
    } catch (e: any) {
      this.events.onError?.(`Twilio setup failed: ${e?.message ?? e}`);
      this.setState("failed");
    }
  }

  private handleIncoming(call: Call) {
    if (this.activeCall) {
      try { call.reject(); } catch {}
      return;
    }
    this.activeCall = call;
    const from = (call.parameters as any)?.From ?? "unknown";
    const action = this.events.onIncoming?.({ from });
    this.wireCall(call);
    if (action === "auto-answer") {
      try { call.accept({ rtcConstraints: this.audioConstraints() as any }); } catch {}
      return;
    }
    this.setState("incoming");
  }

  answer() {
    if (!this.activeCall) return;
    try { this.activeCall.accept({ rtcConstraints: this.audioConstraints() as any }); } catch {}
  }

  reject() {
    try { this.activeCall?.reject(); } catch {}
    this.activeCall = null;
    this.setState("registered");
  }

  async dialOut(params: { to: string; from: string; callId: string }) {
    if (!this.device) {
      this.events.onError?.("Softphone not ready — Twilio device not registered");
      return;
    }
    try {
      const call = await this.device.connect({
        params: { To: params.to, From: params.from, CallId: params.callId },
        rtcConstraints: this.audioConstraints() as any,
      });
      this.activeCall = call;
      this.setState("calling");
      this.wireCall(call);
    } catch (e: any) {
      this.events.onError?.(`Dial failed: ${e?.message ?? e}`);
      this.setState("registered");
    }
  }

  private audioConstraints() {
    return {
      audio: this.inputDeviceId ? { deviceId: { exact: this.inputDeviceId } } : true,
      video: false,
    };
  }

  private wireCall(call: Call) {
    call.on("accept", () => this.setState("in_call"));
    call.on("ringing", () => this.setState("calling"));
    call.on("disconnect", () => this.cleanupCall());
    call.on("cancel", () => this.cleanupCall());
    call.on("reject", () => this.cleanupCall());
    call.on("error", (e: any) => {
      this.events.onError?.(`Call error: ${e?.message ?? e}`);
      this.cleanupCall();
    });
  }

  private cleanupCall() {
    this.activeCall = null;
    this.muted = false;
    this.held = false;
    this.holdProcessor?.setHold(false);
    this.events.onMuteChange?.(false);
    this.events.onHoldChange?.(false);
    this.events.onEnded?.();
    this.setState("registered");
  }

  hangup() {
    try { this.activeCall?.disconnect(); } catch {}
    try { this.device?.disconnectAll(); } catch {}
    this.activeCall = null;
  }

  toggleMute(): boolean {
    if (!this.activeCall) return false;
    this.muted = !this.muted;
    try { this.activeCall.mute(this.muted); } catch {}
    this.events.onMuteChange?.(this.muted);
    return this.muted;
  }

  // Real hold: swap mic for synthesized music via Twilio's AudioProcessor.
  // Customer hears music; agent's mic is silenced upstream. On resume, mic
  // is restored and music fades out.
  toggleHold(): boolean | null {
    if (!this.activeCall) return null;
    this.held = !this.held;
    if (this.holdProcessor) {
      this.holdProcessor.setHold(this.held);
    } else {
      // Processor unavailable — fall back to mute so customer at least hears silence
      try { this.activeCall.mute(this.held); } catch {}
    }
    this.events.onHoldChange?.(this.held);
    return this.held;
  }

  sendDtmf(tone: string) {
    try { this.activeCall?.sendDigits(tone); } catch {}
  }

  async listDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [] };
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch {}
    const all = await navigator.mediaDevices.enumerateDevices();
    return {
      inputs: all.filter((d) => d.kind === "audioinput"),
      outputs: all.filter((d) => d.kind === "audiooutput"),
    };
  }

  async setOutputDevice(deviceId: string) {
    this.outputDeviceId = deviceId;
    try { await this.device?.audio?.speakerDevices.set([deviceId]); } catch {}
  }

  setInputDevice(deviceId: string) {
    this.inputDeviceId = deviceId;
    try { this.device?.audio?.setInputDevice(deviceId); } catch {}
  }

  // Local ringback while waiting for the callee. Twilio plays remote early
  // media once the carrier signals, but the gap between device.connect and
  // that first SIP progress packet is silent — fill it with a US ringback.
  private ringbackCtx: AudioContext | null = null;
  private ringbackTimer: number | null = null;
  private ringbackNodes: OscillatorNode[] = [];

  startRingback() {
    if (typeof window === "undefined" || this.ringbackCtx) return;
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new Ctx();
      this.ringbackCtx = ctx;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(ctx.destination);
      const o1 = ctx.createOscillator(); o1.frequency.value = 440;
      const o2 = ctx.createOscillator(); o2.frequency.value = 480;
      o1.connect(gain); o2.connect(gain);
      o1.start(); o2.start();
      this.ringbackNodes = [o1, o2];
      const cycle = () => {
        if (!this.ringbackCtx) return;
        const t = this.ringbackCtx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.15, t + 0.05);
        gain.gain.setValueAtTime(0.15, t + 2);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 2.05);
      };
      cycle();
      this.ringbackTimer = window.setInterval(cycle, 6000);
    } catch {}
  }

  stopRingback() {
    if (this.ringbackTimer) {
      clearInterval(this.ringbackTimer);
      this.ringbackTimer = null;
    }
    this.ringbackNodes.forEach((o) => { try { o.stop(); } catch {} });
    this.ringbackNodes = [];
    try { this.ringbackCtx?.close(); } catch {}
    this.ringbackCtx = null;
  }

  stop() {
    this.stopRingback();
    this.hangup();
    try { this.device?.destroy(); } catch {}
    this.device = null;
  }
}

// Legacy diagnostic kept so the dialer UI compiles. Twilio manages its own
// WebSocket, so we just report that no manual probe is needed.
export function testSoftphoneWebSocket(_url: string): Promise<{
  ok: boolean;
  origin: string;
  url: string;
  code?: number;
  reason?: string;
  message: string;
}> {
  return Promise.resolve({
    ok: true,
    origin: typeof window !== "undefined" ? window.location.origin : "unknown",
    url: "twilio-managed",
    message: "Twilio Voice SDK manages its own WebSocket — no manual probe needed.",
  });
}

/**
 * Twilio AudioProcessor that mixes synthesized hold music with the mic input.
 * When hold is off: mic goes to Twilio, music is silent.
 * When hold is on: mic is muted upstream, music plays to the customer.
 * Uses Web Audio oscillators (no external MP3 asset needed).
 */
class HoldMusicProcessor {
  private ctx: AudioContext;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicNodes: AudioNode[] = [];
  private arpTimer: number | null = null;

  constructor() {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    this.ctx = new Ctx();
  }

  async createProcessedStream(stream: MediaStream): Promise<MediaStream> {
    if (this.ctx.state === "suspended") { try { await this.ctx.resume(); } catch {} }
    this.destination = this.ctx.createMediaStreamDestination();
    this.micSource = this.ctx.createMediaStreamSource(stream);
    this.micGain = this.ctx.createGain();
    this.musicGain = this.ctx.createGain();
    this.micGain.gain.value = 1;
    this.musicGain.gain.value = 0;
    this.micSource.connect(this.micGain).connect(this.destination);
    this.buildMusic();
    this.musicGain.connect(this.destination);
    // Also route music to agent's speakers so they hear what the customer hears.
    try { this.musicGain.connect(this.ctx.destination); } catch {}
    return this.destination.stream;
  }

  async destroyProcessedStream(_processed: MediaStream): Promise<void> {
    this.stopMusic();
    try { this.micSource?.disconnect(); } catch {}
    try { this.micGain?.disconnect(); } catch {}
    try { this.musicGain?.disconnect(); } catch {}
    try { this.destination?.disconnect(); } catch {}
    this.micSource = null;
    this.micGain = null;
    this.musicGain = null;
    this.destination = null;
  }

  setHold(hold: boolean) {
    if (!this.micGain || !this.musicGain) return;
    const t = this.ctx.currentTime;
    this.micGain.gain.cancelScheduledValues(t);
    this.musicGain.gain.cancelScheduledValues(t);
    this.micGain.gain.setTargetAtTime(hold ? 0 : 1, t, 0.03);
    this.musicGain.gain.setTargetAtTime(hold ? 0.6 : 0, t, 0.15);
  }

  private playPianoNote(freq: number, when: number, velocity = 0.45) {
    if (!this.musicGain) return;
    const harmonics = [
      { mult: 1, amp: 1.0, decay: 2.4 },
      { mult: 2, amp: 0.45, decay: 1.6 },
      { mult: 3, amp: 0.22, decay: 1.0 },
      { mult: 4, amp: 0.12, decay: 0.7 },
    ];
    const noteGain = this.ctx.createGain();
    noteGain.gain.setValueAtTime(0.0001, when);
    noteGain.gain.exponentialRampToValueAtTime(velocity, when + 0.008);
    noteGain.gain.exponentialRampToValueAtTime(0.0001, when + 2.6);
    noteGain.connect(this.musicGain);
    harmonics.forEach((h) => {
      const o = this.ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = freq * h.mult;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(h.amp, when);
      g.gain.exponentialRampToValueAtTime(0.0001, when + h.decay);
      o.connect(g).connect(noteGain);
      o.start(when);
      o.stop(when + 2.8);
      this.musicNodes.push(o, g);
    });
    this.musicNodes.push(noteGain);
  }

  private buildMusic() {
    if (!this.musicGain) return;
    // Gentle "Für Elise"-style piano melody in A minor — soothing and recognizable.
    const melody = [
      { f: 659.25, d: 0.35 }, { f: 622.25, d: 0.35 },
      { f: 659.25, d: 0.35 }, { f: 622.25, d: 0.35 },
      { f: 659.25, d: 0.35 }, { f: 493.88, d: 0.35 },
      { f: 587.33, d: 0.35 }, { f: 523.25, d: 0.35 },
      { f: 440.0, d: 0.9 },
      { f: 0, d: 0.8 },
    ];
    const patternLen = melody.reduce((s, n) => s + n.d, 0);
    const schedule = (base: number) => {
      let t = base;
      melody.forEach((n) => {
        if (n.f > 0) this.playPianoNote(n.f, t, 0.45);
        t += n.d;
      });
    };
    schedule(this.ctx.currentTime + 0.1);
    this.arpTimer = window.setInterval(() => schedule(this.ctx.currentTime + 0.02), patternLen * 1000);
  }

  private stopMusic() {
    if (this.arpTimer) { clearInterval(this.arpTimer); this.arpTimer = null; }
    this.musicNodes.forEach((n) => { try { (n as OscillatorNode).stop?.(); } catch {} try { n.disconnect(); } catch {} });
    this.musicNodes = [];
  }
}
