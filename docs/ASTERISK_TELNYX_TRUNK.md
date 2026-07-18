# Asterisk ↔ Telnyx trunk & outbound Caller ID

This doc pairs with `docs/ASTERISK_DIALPLAN.md` (inbound + spy contexts).
Apply these on the VPS running Asterisk, then reload with `pjsip reload` and
`dialplan reload`.

---

## 1. Telnyx portal — SIP Connection

Create a **Credentials-auth** SIP Connection in the Telnyx portal:

- **Connection name**: `lovable-dialer`
- **Username / Password**: generate strong values, keep them for step 2
- **Outbound → ANI override**: leave blank (we set Caller ID per call from the app)
- **Inbound → SIP URI**: point your DIDs at this connection so calls hit your
  Asterisk (`sip:<did>@<your-vps-ip>` or your FQDN)
- **Media**: G722, PCMU, PCMA — leave defaults unless you have preferences
- Assign each purchased DID to this connection

---

## 2. `pjsip.conf` — trunk to Telnyx

Append (keep your existing WebRTC agent blocks intact):

```ini
;================ TELNYX TRUNK ================
[telnyx-auth]
type=auth
auth_type=userpass
username=YOUR_TELNYX_SIP_USERNAME
password=YOUR_TELNYX_SIP_PASSWORD

[telnyx-aor]
type=aor
contact=sip:sip.telnyx.com:5060
qualify_frequency=60

[telnyx]
type=endpoint
transport=transport-udp        ; or transport-tls if you use TLS to Telnyx
context=from-telnyx            ; inbound context (see ASTERISK_DIALPLAN.md)
disallow=all
allow=ulaw
allow=alaw
outbound_auth=telnyx-auth
aors=telnyx-aor
from_domain=sip.telnyx.com
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes

[telnyx-identify]
type=identify
endpoint=telnyx
match=sip.telnyx.com
match=192.76.120.0/22          ; Telnyx signaling range — see Telnyx docs for current list

[telnyx-reg]
type=registration
outbound_auth=telnyx-auth
server_uri=sip:sip.telnyx.com
client_uri=sip:YOUR_TELNYX_SIP_USERNAME@sip.telnyx.com
retry_interval=60
```

Reload: `asterisk -rx "pjsip reload"` — verify with
`pjsip show registrations` (state should be **Registered**).

---

## 3. `extensions.conf` — outbound context

The app originates through ARI into `context=from-internal` with:
- `${EXTEN}` = the customer number (E.164)
- Channel variable `CALLERID_NUM` = the DID selected by the agent in the UI
  (falls back to the admin-marked default DID; if none, the agent's extension)

Add:

```ini
[from-internal]
; Set outbound Caller ID from the ARI variable, fall back to a house number.
exten => _X.,1,NoOp(Outbound to ${EXTEN} as ${CALLERID_NUM})
 same => n,ExecIf($["${CALLERID_NUM}" != ""]?Set(CALLERID(num)=${CALLERID_NUM}))
 same => n,ExecIf($["${CALLERID_NUM}" != ""]?Set(CALLERID(name)=${CALLERID_NUM}))
 same => n,Dial(PJSIP/${EXTEN}@telnyx,60)
 same => n,Hangup()
```

Reload: `asterisk -rx "dialplan reload"`.

> The app **never** hardcodes a Caller ID. Manage the number pool in
> **Admin → Outbound**, mark one as default, and each agent can override per
> call from the softphone dropdown.

---

## 4. Verify

1. In the Lovable admin UI go to **Admin → Outbound**, pick a Telnyx DID
   from the dropdown, click **Add**, then **Make default**.
2. On the VPS run:
   ```bash
   asterisk -rx "pjsip show registrations"     # telnyx must be Registered
   asterisk -rx "pjsip show endpoints"         # 'telnyx' Available, agent_XXXX Available
   ```
3. From `/dialer`, place a call to your own mobile. The mobile should show
   the DID you marked default. Selecting a different DID from the softphone
   dropdown before dialing should change the displayed Caller ID.
4. In **Admin → Live** the agent flips to *on_call*; **Admin → All calls**
   shows the row with `direction=outbound`, `status=answered/completed`.

---

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `pjsip show registrations` shows `Rejected` | Wrong username/password, or Telnyx SIP Connection not credentials-auth. |
| Outbound call fails with `403 Forbidden` from Telnyx | The presented Caller ID isn't a DID assigned to this SIP Connection. Add it in the Telnyx portal, then re-add in **Admin → Outbound**. |
| Callee sees your agent extension (`1001`), not the DID | Dialplan didn't apply `CALLERID_NUM`, or the ARI variable didn't reach the channel — check `asterisk -rvvv` while dialing. |
| `Dial` returns `CHANUNAVAIL` | Telnyx endpoint down (`pjsip show endpoint telnyx`) or firewall blocking UDP 5060 / RTP 10000-20000 to Telnyx signaling ranges. |
