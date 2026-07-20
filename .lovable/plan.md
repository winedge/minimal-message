# Switch telephony from Asterisk to Twilio Voice (backed by Lovable Cloud)

Asterisk on your VPS is fighting you (SIP scanners, dialplan drift, TLS errors, enum migrations). Let's park it and get a working dialer using **Twilio Programmable Voice** with **Lovable Cloud** hosting the backend. You keep the same UI, agent list, call history, admin monitoring — only the call path changes.

## Why this works
- **Browser calling**: Twilio Voice JS SDK runs in the agent's browser — no SIP, no WSS, no PJSIP endpoints to maintain.
- **Carrier included**: Twilio is both the SDK and the PSTN carrier. Buy a number in their console, done.
- **Lovable Cloud** hosts: auth, `calls`/`contacts`/`agent_status` tables, and the small server functions that mint Twilio access tokens and receive status webhooks.
- **No VPS required** for the app to work. You can decommission Asterisk later or keep it idle.

## What stays the same
- All existing UI: `/dialer`, `/admin/live`, `/admin/calls`, `/admin/contacts`, `/admin/outbound`, `/admin/inbound`, CRM fields.
- Data model: `calls`, `contacts`, `agent_status`, `outbound_dids`, `inbound_routes`, `user_roles`.
- Admin flows: live monitoring, call history, CSV import, caller-ID selection.

## What changes
- Remove `src/lib/softphone.ts` JsSIP layer. Replace with Twilio Voice SDK (`@twilio/voice-sdk`) wrapper exposing the same shape (`register/dial/hangup/mute/hold/sendDtmf/onIncoming`) so the dialer UI is a near drop-in.
- Replace `originateCall`/`hangupCall` server fns with:
  - `getVoiceToken` — mints a Twilio JWT capability token for the agent.
  - `logCallStart` — inserts the placeholder `calls` row (same schema).
- Replace Asterisk webhook (`/api/public/asterisk-events`) with `/api/public/twilio-voice` and `/api/public/twilio-status`:
  - `twilio-voice` returns TwiML that dials the customer with the selected outbound DID as caller ID.
  - `twilio-status` receives `initiated/ringing/answered/completed` callbacks and updates the `calls` row — same status transitions the UI already handles.
- Inbound: point the Twilio number's Voice webhook at `/api/public/twilio-voice-inbound`, which returns TwiML that `<Dial><Client>agent_<uuid></Client></Dial>` using the existing round-robin logic from `inbound_routes`.

## Backend move: self-hosted Supabase → Lovable Cloud
Your app currently talks to `supabase.accentrixmailer.online`. To use Lovable Cloud I'll enable it (provisions a fresh Cloud DB), re-run migrations `0001`–`0004`, and swap the client URL/keys. **Existing users, contacts, and call history on the VPS Supabase will not migrate automatically** — if you need them, tell me and I'll add a one-time export/import step before cutover.

## Secrets you'll provide
- `TWILIO_ACCOUNT_SID`
- `TWILIO_API_KEY_SID` + `TWILIO_API_KEY_SECRET` (created in Twilio console → Account → API keys)
- `TWILIO_TWIML_APP_SID` (created in Console → Voice → TwiML Apps, Voice Request URL = your `/api/public/twilio-voice`)
- `TWILIO_AUTH_TOKEN` (for validating incoming webhook signatures)

You'll also buy one Twilio number in the console and paste it into **Admin → Outbound** as before.

## Steps
1. Enable Lovable Cloud and re-apply migrations `0001`–`0004`.
2. Install `@twilio/voice-sdk` (browser) and `twilio` (server).
3. Add Twilio secrets via secure form.
4. Add `src/lib/voice-client.ts` (Twilio wrapper) and swap `src/lib/softphone.ts` usage in `src/routes/_authenticated/dialer.tsx`.
5. Add server fns `getVoiceToken`, `logCallStart` in `src/lib/calls.functions.ts` (replace Asterisk ARI code).
6. Add `src/routes/api/public/twilio-voice.ts`, `twilio-voice-inbound.ts`, `twilio-status.ts` with signature verification.
7. Verify: buy $1 test number, place a call from `/dialer`, confirm audio both ways and status transitions in `/admin/live` + `/admin/calls`.
8. Archive Asterisk files (`ami-forwarder/`, `docs/ASTERISK_*.md`) into `docs/archive/` — kept for reference, not deleted.

## Cost snapshot
- Twilio number: ~$1.15/month
- Outbound US calls: ~$0.014/min
- Inbound to number: ~$0.0085/min
- Browser client: free

## Alternatives if you'd rather not use Twilio
- **Telnyx WebRTC SDK** — same shape, you already have a Telnyx account and DIDs. Slightly more setup for the credential/connection object but avoids introducing a new vendor. Say the word and I'll target Telnyx instead.
- **SignalWire** — Twilio-compatible API, cheaper per minute.

Approve and I'll enable Lovable Cloud and start the swap. If you prefer **Telnyx WebRTC** (reusing your existing DIDs and account), tell me and I'll rewrite the plan for that path.
