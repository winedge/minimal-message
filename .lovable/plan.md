# Manual Dialer Platform — Self-Hosted Supabase + Asterisk/Telnyx

## Architecture

```text
 ┌────────────┐    HTTPS      ┌──────────────────┐
 │  Browser   │──────────────▶│  Lovable app     │
 │ (agent /   │◀──────────────│  React + TSS     │
 │  admin)    │   WSS (SIP)   │                  │
 │            │◀────────┐     └───────┬──────────┘
 └─────┬──────┘         │             │ ARI (HTTPS)
       │ RTP (audio)    │             ▼
       ▼                │     ┌──────────────────┐   SIP/TLS + SRTP
 ┌─────────────┐        └─────│ Asterisk 20 VPS  │◀───────────────▶ Telnyx
 │  Telnyx     │◀─────────────│ res_pjsip + WSS  │
 │  PSTN       │              │ ARI + AMI        │
 └─────────────┘              └──────────────────┘
                                       │ HMAC webhook
                                       ▼
                              ┌──────────────────┐
                              │  Self-hosted     │
                              │  Supabase (VPS)  │
                              │  Postgres/GoTrue │
                              │  Realtime/Store  │
                              └──────────────────┘
```

- Browser softphone: **JsSIP** → `wss://pbx.yourdomain.com:8089/ws` on Asterisk `chan_pjsip`.
- Dial: agent clicks Dial → server fn → Asterisk **ARI** `/channels` originates leg A (agent WebRTC) → leg B (Telnyx trunk).
- Events: Asterisk **AMI** → small forwarder on VPS → signed POST to `/api/public/asterisk-events` → Postgres → Supabase Realtime → admin live view.

## Data model (Postgres via self-hosted Supabase)

- `profiles` (id, full_name)
- `user_roles` (user_id, role) — separate table, `has_role()` security-definer fn
- `sip_endpoints` (user_id, sip_username, sip_password_encrypted, extension)
- `customers` (id, phone, created_by)
- `crm_field_defs` (id, key, label, type, options jsonb, sort_order, required) — admin-defined
- `crm_entries` (id, customer_id, call_id, agent_id, values jsonb)
- `calls` (id, agent_id, customer_phone, status, started_at, answered_at, ended_at, duration, recording_url, asterisk_channel_id, asterisk_linkedid, disposition)
- `agent_status` (user_id, state, updated_at)
- All tables: GRANTs + RLS. Agents see own data. Admins see all via `has_role('admin')`.

## Screens

- `/auth` — email/password sign-in
- `/_authenticated/dialer` — softphone (JsSIP) + dynamic CRM form
- `/_authenticated/history` — agent's own call history + recordings
- `/_authenticated/admin/agents` — create/disable agents, provision SIP creds
- `/_authenticated/admin/fields` — CRM field builder
- `/_authenticated/admin/live` — realtime status grid for all agents
- `/_authenticated/admin/calls` — global call history, filters, export

## Server functions & routes

- `getSipCredentials()` — agent gets their own SIP username + password
- `originateCall({ customerPhone })` — POST to Asterisk ARI
- `hangupCall({ channelId })`
- Admin: `createAgent`, `resetSipPassword`, `listAgents`, field CRUD
- `/api/public/asterisk-events` — HMAC-verified webhook from AMI forwarder

## Self-hosted Supabase (on your VPS)

- Docker Compose from `supabase/docker` — Postgres, GoTrue, PostgREST, Realtime, Storage, Kong, Studio
- Nginx/Caddy + Let's Encrypt in front of Kong on `supabase.yourdomain.com`
- Daily pg_dump + storage backup cron
- Migrations delivered as SQL under `supabase/migrations/`, applied with `supabase db push` or `psql`

## Secrets you'll be asked to provide

- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (anon), `SUPABASE_SERVICE_ROLE_KEY`
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (browser)
- `ASTERISK_ARI_URL`, `ASTERISK_ARI_USER`, `ASTERISK_ARI_PASSWORD`
- `ASTERISK_WEBHOOK_SECRET` (HMAC for AMI forwarder)
- `SIP_ENCRYPTION_KEY` (auto-generated) — encrypts stored SIP passwords
- Public browser config: `VITE_ASTERISK_WSS_URL`, `VITE_ASTERISK_SIP_DOMAIN`

## Deliverables

- Full schema migrations in `supabase/migrations/`
- Hand-rolled Supabase integration in `src/integrations/supabase/`
- All screens listed above
- `docs/SUPABASE_SELFHOST_SETUP.md` — Docker install, TLS, backups, Google OAuth
- `docs/ASTERISK_SETUP.md` — Asterisk 20 + Telnyx + WSS + ARI + AMI forwarder

## Not in v1

- Skills-based inbound routing (rings first available)
- Admin whisper/barge (`ChanSpy`)
- SMS via Telnyx
- Caller-ID rotation

## Build order

1. Migrations + hand-rolled Supabase integration + auth gate
2. Auth pages + role-based shell
3. Admin: agents CRUD + SIP provisioning, CRM field builder
4. Agent dialer + JsSIP softphone + dynamic CRM form
5. Webhook route + realtime admin live + history
6. Docs + AMI forwarder script
