import JsSIP from "jssip";

export type SoftphoneState = "idle" | "registering" | "registered" | "calling" | "in_call" | "failed";

export interface SoftphoneEvents {
  onState?: (s: SoftphoneState) => void;
  onError?: (msg: string) => void;
}

export class Softphone {
  private ua: JsSIP.UA | null = null;
  private session: any = null;
  private audio: HTMLAudioElement | null = null;
  private events: SoftphoneEvents;

  constructor(events: SoftphoneEvents = {}) {
    this.events = events;
  }

  private setState(s: SoftphoneState) {
    this.events.onState?.(s);
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
    this.ua.on("registered", () => this.setState("registered"));
    this.ua.on("unregistered", () => this.setState("idle"));
    this.ua.on("registrationFailed", (e: any) => {
      this.events.onError?.(`Registration failed: ${e.cause}`);
      this.setState("failed");
    });
    this.setState("registering");
    this.ua.start();

    // ensure an <audio> element exists to play remote stream
    if (typeof document !== "undefined" && !this.audio) {
      this.audio = document.createElement("audio");
      this.audio.autoplay = true;
      document.body.appendChild(this.audio);
    }
  }

  call(target: string, sipDomain: string) {
    if (!this.ua) return;
    const options = {
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
    };
    const uri = `sip:${target}@${sipDomain}`;
    this.session = this.ua.call(uri, options);
    this.setState("calling");
    this.session.on("accepted", () => this.setState("in_call"));
    this.session.on("confirmed", () => this.setState("in_call"));
    this.session.on("ended", () => this.setState("registered"));
    this.session.on("failed", (e: any) => {
      this.events.onError?.(`Call failed: ${e.cause}`);
      this.setState("registered");
    });
    this.session.connection?.addEventListener("addstream", (e: any) => {
      if (this.audio) this.audio.srcObject = e.stream;
    });
    this.session.connection?.addEventListener("track", (e: any) => {
      if (this.audio && e.streams?.[0]) this.audio.srcObject = e.streams[0];
    });
  }

  hangup() {
    try {
      this.session?.terminate();
    } catch {}
    this.session = null;
  }

  stop() {
    this.hangup();
    try {
      this.ua?.stop();
    } catch {}
    this.ua = null;
    if (this.audio) {
      this.audio.remove();
      this.audio = null;
    }
  }
}
