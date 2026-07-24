// Twilio Voice SDK wrapper. Keeps the same public API our dialer already uses,
// so switching from JsSIP/Asterisk to Twilio only needs a token + a TwiML app.
import { Device, Call } from "@twilio/voice-sdk";
import holdMusicAsset from "@/assets/hold-music.mp3.asset.json";

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
 * Twilio AudioProcessor that mixes hold music (a real piano recording,
 * Chopin Nocturne Op. 9 No. 2, ~3:23, looped) with the mic input.
 * Hold off: mic → customer, music silent.
 * Hold on:  mic muted, music → customer AND agent's local speakers.
 */

class HoldMusicProcessor {
  private ctx: AudioContext;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private musicSource: MediaElementAudioSourceNode | null = null;

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

    // Real recorded piano piece, looped.
    this.audioEl = new Audio(holdMusicAsset.url);
    this.audioEl.loop = true;
    this.audioEl.crossOrigin = "anonymous";
    this.audioEl.preload = "auto";
    try {
      this.musicSource = this.ctx.createMediaElementSource(this.audioEl);
      this.musicSource.connect(this.musicGain);
    } catch (e) {
      console.warn("[hold-music] source init failed", e);
    }
    this.musicGain.connect(this.destination);
    // Also route music to agent's speakers so they hear what the customer hears.
    try { this.musicGain.connect(this.ctx.destination); } catch {}
    // Pre-start playback (muted via gain=0) so hold engages instantly.
    try { await this.audioEl.play(); } catch {}
    return this.destination.stream;
  }

  async destroyProcessedStream(_processed: MediaStream): Promise<void> {
    try { this.audioEl?.pause(); } catch {}
    try { this.musicSource?.disconnect(); } catch {}
    try { this.micSource?.disconnect(); } catch {}
    try { this.micGain?.disconnect(); } catch {}
    try { this.musicGain?.disconnect(); } catch {}
    try { this.destination?.disconnect(); } catch {}
    this.audioEl = null;
    this.musicSource = null;
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
    this.musicGain.gain.setTargetAtTime(hold ? 0.7 : 0, t, 0.15);
    if (hold && this.audioEl) {
      try { void this.audioEl.play(); } catch {}
    }
  }
}

