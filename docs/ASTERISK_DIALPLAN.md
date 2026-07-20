# Asterisk Dialplan — Spy & Inbound Routing

Snippets required to enable admin listen/whisper/barge and inbound DID routing through the platform.

Apply on the VPS by editing `/etc/asterisk/extensions.conf`, then reload:

```bash
asterisk -rx "dialplan reload"
```

---

## 1. `[lovable-spy]` — admin listen / whisper / barge

Used by `src/lib/admin-spy.functions.ts`. The server function originates a
`Local/<adminExt>@lovable-spy` channel and passes the target agent's live
channel name in `SPY_TARGET` and the mode in `SPY_MODE`.

```ini
[lovable-spy]
; Called as Local/<adminExt>@lovable-spy
; Vars set by ARI originate:
;   SPY_TARGET = PJSIP/agent_1001-0000000a  (target channel name)
;   SPY_MODE   = q | qw | qB
exten => _X.,1,NoOp(Spy ${SPY_MODE} on ${SPY_TARGET} by ext ${EXTEN})
 same => n,Answer()
 same => n,ChanSpy(${SPY_TARGET},${SPY_MODE})
 same => n,Hangup()
```

Mode mapping used by the app:

| Server fn      | Mode  | Effect                                |
| -------------- | ----- | ------------------------------------- |
| `spyCall`      | `q`   | Silent listen only                    |
| `whisperCall`  | `qw`  | Whisper to agent (customer can't hear) |
| `bargeCall`    | `qB`  | Full three-way barge                  |

---

## 2. `[from-telnyx]` — inbound DID routing via CURL

Telnyx delivers the call into `[from-telnyx]`. Asterisk calls the app's
public endpoint to resolve which agent extension to ring for the DID, using
the strategy configured on **Admin → Inbound**.

Add to `[globals]`:

```ini
[globals]
LOVABLE_APP=https://minimal-message.lovable.app
INBOUND_SECRET=<same value as ASTERISK_WEBHOOK_SECRET>
```

Then the routing context:

```ini
[from-telnyx]
exten => _X.,1,NoOp(Inbound ${EXTEN} from ${CALLERID(num)})
 same => n,Set(SIG=${SHA1(${EXTEN}:${INBOUND_SECRET})})
 same => n,Set(RESP=${CURL(${LOVABLE_APP}/api/public/inbound-route?did=${EXTEN}&sig=${SIG})})
 same => n,Set(EXT=${CUT(RESP,|,1)})
 same => n,Set(RING=${CUT(RESP,|,2)})
 same => n,Set(FALLBACK=${CUT(RESP,|,3)})
 same => n,GotoIf($["${EXT}" = ""]?fallback)
 same => n,Dial(PJSIP/${EXT},${RING})
 same => n,Goto(fallback)
 same => n(fallback),NoOp(Fallback ${FALLBACK})
 same => n,GotoIf($["${FALLBACK}" = ""]?end)
 same => n,Dial(PJSIP/${FALLBACK},20)
 same => n(end),Hangup()
```

### Endpoint contract

`GET /api/public/inbound-route?did=<E164>&sig=<sha1(did:secret)>`

Response body (pipe-delimited, plain text):

```
<agent_extension>|<ring_seconds>|<fallback_extension>
```

- Empty `<agent_extension>` → no route configured, dialplan jumps to fallback.
- Round-robin routes rotate through the ring group using the `inbound_state`
  cursor in the DB, so successive calls hit different agents.

### Prerequisites

1. Asterisk built with `func_curl` and `func_strings` (both in `asterisk-core`).
2. `INBOUND_SECRET` on the VPS must equal the `ASTERISK_WEBHOOK_SECRET`
   stored in Lovable secrets — the signature check will fail otherwise.
3. Telnyx SIP trunk must route incoming calls into context `from-telnyx`
   (set in `pjsip.conf` on the `telnyx` endpoint's `context=`).

---

## Verifying

```bash
# Reload after edits
asterisk -rx "dialplan reload"

# Confirm contexts are loaded
asterisk -rx "dialplan show lovable-spy"
asterisk -rx "dialplan show from-telnyx"

# Watch a live inbound call
asterisk -rvvv
```

If `CURL()` returns empty, check that the VPS can reach the app URL and
that `INBOUND_SECRET` matches on both sides.

---

## 3. `[lovable-outbound]` — agent-originated outbound calls (real ringback)

Used by `originateCall` in `src/lib/calls.functions.ts`. ARI originates the
agent's PJSIP endpoint into this context so the softphone hears **real
carrier ringback** (Telnyx early media, SIT tones, "number disconnected"
announcements) instead of just silence.

Add to `/etc/asterisk/extensions.conf`:

```ini
[lovable-outbound]
; Called by ARI originate for agent outbound calls.
; Vars set by originateCall():
;   CALLERID_NUM    = the outbound DID selected by the agent
;   CUSTOMER_PHONE  = raw dialed number (for logging)
;   LOVABLE_CALL_ID = DB row id
;   LOVABLE_AGENT_ID
exten => _X.,1,NoOp(Outbound ${EXTEN} caller ${CALLERID_NUM} agent ${LOVABLE_AGENT_ID})
 same => n,Set(CALLERID(num)=${CALLERID_NUM})
 same => n,Set(CALLERID(all)=${CALLERID_NUM})
 same => n,Progress()
 ; Dial options:
 ;   r = generate ringback to the caller (agent) until the callee answers,
 ;       automatically switches to real early media once Telnyx sends 183+SDP.
 ;   T = allow caller (agent) to transfer with blind-xfer feature.
 ;   t = allow callee to transfer.
 ;   b(...) = pre-dial hook we could use later for CDR tagging.
 same => n,Dial(PJSIP/telnyx/${EXTEN},60,rtT)
 same => n,NoOp(Dial ended DIALSTATUS=${DIALSTATUS} HANGUPCAUSE=${HANGUPCAUSE})
 same => n,Hangup()
```

Reload:

```bash
asterisk -rx "dialplan reload"
asterisk -rx "dialplan show lovable-outbound"
```

### Why not `from-internal`?

`from-internal` typically bridges directly without `Progress()` and without
the `r` Dial option, so between the moment the softphone auto-answers and
the moment Telnyx returns 200 OK the agent hears silence. `[lovable-outbound]`
guarantees continuous ringback → early media → answered audio.

### Verifying a live call end-to-end

On the VPS, in one terminal:

```bash
asterisk -rvvvvv
# then inside the CLI:
pjsip set logger on
```

Place a call from the softphone. You should see, in order:

1. `Executing [<number>@lovable-outbound:1] NoOp(...)` — ARI hit our context.
2. `<--- Transmitting SIP request (INVITE) --->` to `sip.telnyx.com`.
3. `100 Trying`, then `183 Session Progress` or `180 Ringing` from Telnyx.
4. Real ringback audible in the softphone.
5. `200 OK` → `DIALSTATUS=ANSWER` → talk path bridged.

Also cross-check in the Telnyx portal → **Reporting → Debugging → SIP Call
Flow Tool**: filter by your DID / destination and confirm Telnyx received
your INVITE and what the downstream carrier replied. If Telnyx shows no
INVITE, the problem is between Asterisk and Telnyx (auth / IP ACL / trunk).
