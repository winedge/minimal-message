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
  onIncoming?: (info: IncomingCallInfo) => void;
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
      this.events.onError?.(
        `PBX WebSocket failed: ${reason}. Check Asterisk allowed_origins includes this app URL.`,
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
      this.events.onError?.(
        "Registration timed out. Check Asterisk http.conf allowed_origins for this app URL and reload Asterisk HTTP/PJSIP.",
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
    this.startRinger();
    this.setState("incoming");
    this.events.onIncoming?.({ from, displayName });
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
      this.setState("registered");
    });
    session.on("failed", (e: any) => {
      this.events.onError?.(`Call failed: ${e.cause}`);
      this.session = null;
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
