// AMI → webhook forwarder. Runs on the Asterisk VPS.
// Translates AMI events into signed POSTs to /api/public/asterisk-events.
//
// Install:
//   npm init -y && npm i asterisk-manager node-fetch
// Run:  node index.js  (see systemd unit in docs/ASTERISK_SETUP.md)

import crypto from "node:crypto";
import AsteriskManager from "asterisk-manager";
import fetch from "node-fetch";

const {
  AMI_HOST = "127.0.0.1",
  AMI_PORT = "5038",
  AMI_USER,
  AMI_PASS,
  WEBHOOK_URL,
  WEBHOOK_SECRET,
} = process.env;

if (!AMI_USER || !AMI_PASS || !WEBHOOK_URL || !WEBHOOK_SECRET) {
  console.error("Missing env: AMI_USER/AMI_PASS/WEBHOOK_URL/WEBHOOK_SECRET");
  process.exit(1);
}

const ami = new AsteriskManager(Number(AMI_PORT), AMI_HOST, AMI_USER, AMI_PASS, true);
ami.keepConnected();

async function send(payload) {
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": sig },
      body,
    });
    if (!res.ok) console.error("webhook", res.status, await res.text());
  } catch (e) {
    console.error("webhook err", e.message);
  }
}

// Track LOVABLE_CALL_ID per channel (set via ARI originate variables)
const callIdByChannel = new Map();

ami.on("managerevent", async (evt) => {
  switch (evt.event) {
    case "Newchannel":
      // no-op; call id assigned by ARI originate return
      break;
    case "VarSet":
      if (evt.variable === "LOVABLE_CALL_ID" && evt.uniqueid) {
        callIdByChannel.set(evt.uniqueid, evt.value);
      }
      break;
    case "DialBegin":
      await send({ type: "channel_ringing", callId: callIdByChannel.get(evt.uniqueid) });
      break;
    case "DialEnd":
      if (evt.dialstatus === "ANSWER")
        await send({ type: "channel_answered", callId: callIdByChannel.get(evt.uniqueid) });
      break;
    case "Cdr":
      await send({
        type: "cdr",
        callId: callIdByChannel.get(evt.uniqueid),
        duration: Number(evt.billableseconds || evt.duration || 0),
        disposition: evt.disposition,
      });
      callIdByChannel.delete(evt.uniqueid);
      break;
    case "Hangup":
      await send({ type: "channel_hangup", callId: callIdByChannel.get(evt.uniqueid) });
      break;
    case "PeerStatus": {
      // Reachable/Unreachable — treat as available/offline for the mapped agent.
      // Requires you to maintain a mapping from PJSIP/extXXX → agent uuid; keep
      // it here or extend the forwarder to read from your Supabase table.
      break;
    }
  }
});

ami.on("connect", () => console.log("AMI connected"));
ami.on("error", (e) => console.error("AMI err", e));
