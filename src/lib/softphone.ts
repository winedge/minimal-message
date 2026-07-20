import JsSIP from "jssip";

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
  private ua: JsSIP.UA | null = null;
  private session: any = null;
  private audio: HTMLAudioElement | null = null;
  private ringAudioCtx: AudioContext | null = null;
  private ringTimer: number | null = null;
  private events: SoftphoneEvents;
  private outputDeviceId: string | null = null;
  private inputDeviceId: string | null = null;
  private registrationTimer: number | null = null;

  constructor(events: SoftphoneEvents = {}) {
    this.events = events;
  }

  private setState(s: SoftphoneState) {
    this.events.onState?.(s);
  }

  private clearRegistrationTimer() {
    if (this.registrationTimer) {
      clearTimeout(this.registrationTimer);
      this.registrationTimer = null;
    }
  }

  register(opts: { username: string; password: string; wssUrl: string; sipDomain: string }) {
    if (!opts.wssUrl || !opts.sipDomain) {
      this.events.onError?.("Softphone: missing WSS URL / SIP domain");
      return;
    }
    const socket = new JsSIP.WebSocketInterface(opts.wssUrl);
    this.ua = new JsSIP.UA({
      sockets: [socket],
      uri: `sip:${opts.username}@${opts.sipDomain}`,
      password: opts.password,
      register: true,
      session_timers: false,
    });
    this.ua.on("registered", () => {
      this.clearRegistrationTimer();
      this.setState("registered");
    });
    this.ua.on("unregistered", () => {
      this.clearRegistrationTimer();
      this.setState("idle");
    });
    this.ua.on("registrationFailed", (e: any) => {
      this.clearRegistrationTimer();
      this.events.onError?.(`Registration failed: ${e.cause}`);
      this.setState("failed");
    });
    this.ua.on("disconnected", (e: any) => {
      this.clearRegistrationTimer();
      const reason = e?.reason || e?.cause || "WebSocket connection failed";
      const origin = typeof window !== "undefined" ? window.location.origin : "this app origin";
      this.events.onError?.(
        `PBX WebSocket failed from ${origin} to ${opts.wssUrl}: ${reason}. If Asterisk already allows this origin, use the published app directly or proxy PBX WSS through standard HTTPS port 443.`,
      );
      this.setState("failed");
    });
    this.ua.on("newRTCSession", (data: any) => {
      const session = data.session;
      if (session.direction === "incoming") {
        this.handleIncoming(session);
      }
    });
    this.setState("registering");
    this.registrationTimer = window.setTimeout(() => {
      const origin = typeof window !== "undefined" ? window.location.origin : "this app origin";
      this.events.onError?.(
        `Registration timed out from ${origin} to ${opts.wssUrl}. Check Asterisk allowed_origins, then use the published app directly or expose WSS on port 443 if the embedded preview blocks port 8089.`,
      );
      this.setState("failed");
      try { this.ua?.stop(); } catch {}
    }, 12000);
    this.ua.start();

    if (typeof document !== "undefined" && !this.audio) {
      this.audio = document.createElement("audio");
      this.audio.autoplay = true;
      document.body.appendChild(this.audio);
    }
  }

  private handleIncoming(session: any) {
    if (this.session) {
      try { session.terminate({ status_code: 486 }); } catch {}
      return;
    }
    this.session = session;
    const from = session.remote_identity?.uri?.user ?? "unknown";
    const displayName = session.remote_identity?.display_name;
    this.wireSession(session);
    const action = this.events.onIncoming?.({ from, displayName });
    if (action === "auto-answer") {
      this.answer();
      return;
    }
    this.startRinger();
    this.setState("incoming");
    session.on("failed", () => this.stopRinger());
    session.on("ended", () => this.stopRinger());
    session.on("accepted", () => this.stopRinger());
  }

  answer() {
    if (!this.session) return;
    this.session.answer({
      mediaConstraints: {
        audio: this.inputDeviceId ? { deviceId: { exact: this.inputDeviceId } } : true,
        video: false,
      },
      pcConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
    });
    this.stopRinger();
  }

  reject() {
    try { this.session?.terminate({ status_code: 486 }); } catch {}
    this.session = null;
    this.stopRinger();
    this.setState("registered");
  }

  call(target: string, sipDomain: string) {
    if (!this.ua) return;
    const options = {
      mediaConstraints: {
        audio: this.inputDeviceId ? { deviceId: { exact: this.inputDeviceId } } : true,
        video: false,
      },
      pcConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
    };
    const uri = `sip:${target}@${sipDomain}`;
    this.session = this.ua.call(uri, options);
    this.setState("calling");
    this.wireSession(this.session);
  }

  private wireSession(session: any) {
    session.on("accepted", () => this.setState("in_call"));
    session.on("confirmed", () => this.setState("in_call"));
    session.on("ended", () => {
      this.session = null;
      this.events.onEnded?.();
      this.setState("registered");
    });
    session.on("failed", (e: any) => {
      this.events.onError?.(`Call failed: ${e.cause}`);
      this.session = null;
      this.events.onEnded?.();
      this.setState("registered");
    });
    const attach = (stream: MediaStream) => {
      if (!this.audio) return;
      this.audio.srcObject = stream;
      if (this.outputDeviceId && (this.audio as any).setSinkId) {
        (this.audio as any).setSinkId(this.outputDeviceId).catch(() => {});
      }
    };
    session.connection?.addEventListener("addstream", (e: any) => attach(e.stream));
    session.connection?.addEventListener("track", (e: any) => {
      if (e.streams?.[0]) attach(e.streams[0]);
    });
  }

  hangup() {
    try { this.session?.terminate(); } catch {}
    this.session = null;
    this.stopRinger();
  }

  // --- Mute ---
  toggleMute(): boolean {
    if (!this.session) return false;
    const muted = this.session.isMuted?.().audio;
    if (muted) this.session.unmute({ audio: true });
    else this.session.mute({ audio: true });
    const now = !muted;
    this.events.onMuteChange?.(now);
    return now;
  }

  // --- Hold ---
  toggleHold(): boolean {
    if (!this.session) return false;
    const held = this.session.isOnHold?.().local;
    if (held) this.session.unhold();
    else this.session.hold();
    const now = !held;
    this.events.onHoldChange?.(now);
    return now;
  }

  // --- DTMF ---
  sendDtmf(tone: string) {
    try { this.session?.sendDTMF(tone); } catch {}
  }

  // --- Devices ---
  async listDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [] };
    // Ensure labels populate
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
    if (this.audio && (this.audio as any).setSinkId) {
      try { await (this.audio as any).setSinkId(deviceId); } catch {}
    }
  }

  setInputDevice(deviceId: string) {
    this.inputDeviceId = deviceId;
  }

  // --- Ringer (WebAudio, no asset) ---
  private startRinger() {
    if (typeof window === "undefined") return;
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      this.ringAudioCtx = new Ctx();
      const play = () => {
        if (!this.ringAudioCtx) return;
        const ctx = this.ringAudioCtx;
        const now = ctx.currentTime;
        [0, 0.4].forEach((offset) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.frequency.value = 440;
          gain.gain.setValueAtTime(0.0001, now + offset);
          gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.25);
          osc.connect(gain).connect(ctx.destination);
          osc.start(now + offset);
          osc.stop(now + offset + 0.3);
        });
      };
      play();
      this.ringTimer = window.setInterval(play, 2000);
    } catch {}
  }

  private stopRinger() {
    if (this.ringTimer) {
      clearInterval(this.ringTimer);
      this.ringTimer = null;
    }
    try { this.ringAudioCtx?.close(); } catch {}
    this.ringAudioCtx = null;
  }

  // --- Ringback tone (played locally while waiting for the callee to answer) ---
  private ringbackCtx: AudioContext | null = null;
  private ringbackTimer: number | null = null;
  private ringbackNodes: { osc: OscillatorNode; gain: GainNode }[] = [];

  startRingback() {
    if (typeof window === "undefined") return;
    if (this.ringbackCtx) return;
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new Ctx();
      this.ringbackCtx = ctx;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(ctx.destination);
      // US ringback: 440Hz + 480Hz, 2s on / 4s off
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      osc1.frequency.value = 440;
      osc2.frequency.value = 480;
      osc1.connect(gain);
      osc2.connect(gain);
      osc1.start();
      osc2.start();
      this.ringbackNodes = [
        { osc: osc1, gain },
        { osc: osc2, gain },
      ];
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
    this.ringbackNodes.forEach(({ osc }) => { try { osc.stop(); } catch {} });
    this.ringbackNodes = [];
    try { this.ringbackCtx?.close(); } catch {}
    this.ringbackCtx = null;
  }

  stop() {
    this.clearRegistrationTimer();
    this.hangup();
    try { this.ua?.stop(); } catch {}
    this.ua = null;
    if (this.audio) {
      this.audio.remove();
      this.audio = null;
    }
  }
}

export function testSoftphoneWebSocket(wssUrl: string): Promise<{
  ok: boolean;
  origin: string;
  url: string;
  code?: number;
  reason?: string;
  message: string;
}> {
  return new Promise((resolve) => {
    const origin = typeof window !== "undefined" ? window.location.origin : "unknown";
    if (!wssUrl) {
      resolve({ ok: false, origin, url: wssUrl, message: "Missing PBX WSS URL" });
      return;
    }

    let settled = false;
    let ws: WebSocket | null = null;
    const finish = (result: { ok: boolean; code?: number; reason?: string; message: string }) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve({ ...result, origin, url: wssUrl });
    };
    const timer = window.setTimeout(() => {
      try { ws?.close(); } catch {}
      finish({ ok: false, message: "WebSocket probe timed out" });
    }, 5000);

    try {
      ws = new WebSocket(wssUrl, "sip");
      ws.onopen = () => {
        try { ws?.close(1000, "probe-complete"); } catch {}
        finish({ ok: true, message: "PBX WebSocket opened successfully" });
      };
      ws.onerror = () => {
        finish({ ok: false, message: "Browser rejected the PBX WebSocket before SIP registration" });
      };
      ws.onclose = (event) => {
        if (!settled) {
          finish({
            ok: false,
            code: event.code,
            reason: event.reason,
            message: "PBX WebSocket closed before opening",
          });
        }
      };
    } catch (error) {
      finish({
        ok: false,
        message: error instanceof Error ? error.message : "Failed to create WebSocket",
      });
    }
  });
}
