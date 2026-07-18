# Points 3, 5, 6 — Implementation Plan

## 3. Admin live monitoring polish

**Agent presence**
- New `agent_status` table: `user_id (pk)`, `status` (`available` | `on_call` | `offline`), `updated_at`.
- Client heartbeat: while the softphone is registered, the dialer page upserts `status='available'` every 20s and on unmount marks `offline`. When `state==='in_call'` it marks `on_call`.
- `/admin/live` subscribes to Postgres realtime on `agent_status` + `calls` and renders a live grid: agent, extension, status pill, current customer, call duration timer.

**Listen / whisper / barge (ChanSpy)**
- Add three admin server functions (`spyCall`, `whisperCall`, `bargeCall`) that call ARI `POST /channels` to originate a leg from the admin's own SIP extension into `ChanSpy(<agent_channel>,<mode>)` via a dialplan hook.
- Dialplan snippet added to `docs/ASTERISK_SETUP.md`: `[lovable-spy]` context accepting `SPY_TARGET` + `SPY_MODE` (`q`, `qw`, `qB`).
- Admin row gets three icon buttons enabled only when the agent is `on_call`.

## 5. Contact / lead list

**Schema**
- `contact_lists (id, name, created_by, created_at)`
- `contacts (id, list_id, phone, first_name, last_name, email, notes, custom jsonb, created_at)` with RLS: admins read/write all; agents read all, no writes.

**Admin CSV upload** at `/admin/contacts`
- Upload `.csv` (papaparse), preview first 5 rows, map columns to `phone / first / last / email / notes`, bulk insert in 500-row chunks.
- List management: create/rename/delete lists, delete rows.

**Agent view** at `/dialer`
- New left panel above the softphone: list selector + searchable contact table. Clicking a row fills the softphone number and prefills CRM fields (name, email) into the notes form.
- Small "Recent" tab showing the agent's last 20 dialed customers.

## 6. Inbound routing

**Schema**
- `inbound_routes (id, did text unique, strategy 'direct'|'roundrobin', target_user_id nullable, ring_group jsonb, ring_seconds int default 20)`
- `inbound_state (did pk, last_agent_index int)` — round-robin cursor.

**Admin UI** at `/admin/inbound`
- Table of DIDs with strategy, agent picker (direct) or multi-select (round-robin), ring timeout.

**Routing endpoint**
- New public server route `POST /api/public/inbound-route` (HMAC-signed like the events webhook). Takes `{ did, callId }`, looks up the route, and returns `{ extension }` (direct) or picks the next available agent from `agent_status` (round-robin), advancing `last_agent_index`. Falls back to voicemail extension if none available.
- Dialplan snippet in `docs/ASTERISK_SETUP.md`: the Telnyx inbound context uses `CURL()` to hit this endpoint, then `Dial(PJSIP/${extension},${ring_seconds})`.

## Technical notes

- All new tables get GRANTs (`authenticated` read, `service_role` all) plus RLS with `has_role('admin')` for writes.
- Realtime uses the existing self-hosted Supabase — enable replication on `agent_status` and `calls` in a migration.
- All admin server functions verify `has_role('admin')` before hitting ARI or `supabaseAdmin`.
- ChanSpy needs a dialplan context; documented in `docs/ASTERISK_SETUP.md`, no code change on the VPS beyond editing `extensions.conf`.

## Delivery order

1. Migration: `agent_status`, `contact_lists`, `contacts`, `inbound_routes`, `inbound_state` + RLS + realtime.
2. Live monitoring (presence + spy/whisper/barge).
3. Contacts (admin upload + agent panel).
4. Inbound routing (admin UI + `/api/public/inbound-route`).
5. Update `docs/ASTERISK_SETUP.md` with the dialplan snippets.

Shall I proceed?
