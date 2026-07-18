# Asterisk 20 + Telnyx + WebRTC on your VPS

## 1. VPS prep (Ubuntu 22.04)

Open ports:

- 5060/tcp+udp (SIP)
- 5061/tcp (SIP over TLS)
- 8089/tcp (WSS for browser softphone)
- 10000-20000/udp (RTP media)

DNS: `pbx.yourdomain.com` A-record → VPS IP.

```bash
sudo apt update && sudo apt install -y build-essential wget git subversion \
  libjansson-dev libxml2-dev libsqlite3-dev uuid-dev libssl-dev libedit-dev \
  libsrtp2-dev pkg-config certbot nginx nodejs npm
```

## 2. Let's Encrypt cert

```bash
sudo certbot certonly --standalone -d pbx.yourdomain.com
sudo mkdir -p /etc/asterisk/keys
sudo cp /etc/letsencrypt/live/pbx.yourdomain.com/fullchain.pem /etc/asterisk/keys/
sudo cp /etc/letsencrypt/live/pbx.yourdomain.com/privkey.pem  /etc/asterisk/keys/
sudo chown -R asterisk:asterisk /etc/asterisk/keys
```

## 3. Install Asterisk 20

```bash
cd /usr/src
sudo wget https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-20-current.tar.gz
sudo tar xf asterisk-20-current.tar.gz && cd asterisk-20*/
sudo contrib/scripts/install_prereq install
sudo ./configure --with-pjproject-bundled --with-srtp --with-crypto --with-ssl
sudo make menuselect        # enable: res_pjsip, res_srtp, res_http_websocket, chan_pjsip, res_ari*
sudo make -j$(nproc) && sudo make install && sudo make samples && sudo make config
sudo systemctl enable --now asterisk
```

## 4. `/etc/asterisk/http.conf`

```ini
[general]
enabled=yes
bindaddr=0.0.0.0
bindport=8088
tlsenable=yes
tlsbindaddr=0.0.0.0:8089
tlscertfile=/etc/asterisk/keys/fullchain.pem
tlsprivatekey=/etc/asterisk/keys/privkey.pem
allowed_origins=https://minimal-message.lovable.app,https://id-preview--26f42832-1131-4dbf-9ae3-890974080e25.lovable.app,https://26f42832-1131-4dbf-9ae3-890974080e25.lovableproject.com
```

Browsers send the app's `Origin` header during WSS registration. If the
softphone stays on `REGISTERING`, add the exact published/preview origins above
to `http.conf`, then run `asterisk -rx "http reload"` and
`asterisk -rx "pjsip reload"`.

## 5. `/etc/asterisk/ari.conf`

```ini
[general]
enabled=yes
pretty=yes
allowed_origins=*

[dialer_api]
type=user
read_only=no
password=SUPER_SECRET_ARI_PASSWORD
```

## 6. `/etc/asterisk/pjsip.conf`

```ini
;; -------- Transports --------
[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0

[transport-tls]
type=transport
protocol=tls
bind=0.0.0.0:5061
cert_file=/etc/asterisk/keys/fullchain.pem
priv_key_file=/etc/asterisk/keys/privkey.pem
method=tlsv1_2

[transport-wss]
type=transport
protocol=wss
bind=0.0.0.0

;; -------- Telnyx trunk --------
[telnyx]
type=endpoint
transport=transport-udp
context=from-telnyx
disallow=all
allow=ulaw,alaw
outbound_auth=telnyx-auth
aors=telnyx-aor
from_domain=sip.telnyx.com
direct_media=no

[telnyx-auth]
type=auth
auth_type=userpass
username=YOUR_TELNYX_SIP_USER
password=YOUR_TELNYX_SIP_PASSWORD

[telnyx-aor]
type=aor
contact=sip:sip.telnyx.com

[telnyx-identify]
type=identify
endpoint=telnyx
match=sip.telnyx.com

;; -------- Agent template (WebRTC) --------
[webrtc-endpoint](!)
type=endpoint
transport=transport-wss
context=from-internal
disallow=all
allow=opus,ulaw
webrtc=yes
use_avpf=yes
media_encryption=dtls
dtls_auto_generate_cert=yes
ice_support=yes
media_use_received_transport=yes
rtcp_mux=yes

[webrtc-auth](!)
type=auth
auth_type=userpass

[webrtc-aor](!)
type=aor
max_contacts=1
remove_existing=yes

;; -------- Per-agent — one block per agent (see below) --------
[agent_1001](webrtc-endpoint)
auth=auth_1001
aors=aor_1001

[auth_1001](webrtc-auth)
username=agent_1001
password=REPLACE_WITH_PASSWORD_FROM_ADMIN_UI

[aor_1001](webrtc-aor)
```

When admin creates an agent in the app, add another `agent_<ext>` / `auth_<ext>` / `aor_<ext>` block using the SIP username + password shown once in the UI. Then `asterisk -rx "pjsip reload"`.

## 7. `/etc/asterisk/extensions.conf`

```ini
[from-internal]
; Outbound to any number, routed via Telnyx
exten => _X.,1,NoOp(Outbound ${EXTEN})
 same => n,Set(CDR(userfield)=${LOVABLE_CALL_ID})
 same => n,MixMonitor(${LOVABLE_CALL_ID}.wav)
 same => n,Dial(PJSIP/${EXTEN}@telnyx,60)
 same => n,Hangup()

[from-telnyx]
; Inbound — simplest: ring first available agent extension range 1001-1005
exten => _X.,1,NoOp(Inbound to ${EXTEN})
 same => n,Dial(PJSIP/1001&PJSIP/1002&PJSIP/1003&PJSIP/1004&PJSIP/1005,30)
 same => n,Hangup()
```

## 8. `/etc/asterisk/manager.conf` (AMI)

```ini
[general]
enabled=yes
port=5038
bindaddr=127.0.0.1

[forwarder]
secret=SUPER_SECRET_AMI_PASSWORD
read=all
write=all
```

## 9. Telnyx config

1. **Mission Control → Voice → SIP Connections** — create a Credentials-based connection. Set username/password matching `pjsip.conf` `[telnyx-auth]`.
2. **Outbound Voice Profile** — attach to the connection; set outbound caller ID.
3. **Numbers → Buy** — assign the number to the SIP connection.
4. **Networking** — whitelist your VPS public IP.

## 10. AMI → webhook forwarder

Install the small forwarder that translates AMI events into signed POSTs to this app.

```bash
sudo mkdir -p /opt/ami-forwarder && cd /opt/ami-forwarder
sudo npm init -y
sudo npm i asterisk-manager node-fetch
```

Save `index.js` from `ami-forwarder/index.js` in this repo. Set env vars:

```bash
sudo tee /etc/systemd/system/ami-forwarder.service <<'EOF'
[Unit]
Description=AMI → dialer webhook forwarder
After=network.target
[Service]
Environment=AMI_HOST=127.0.0.1
Environment=AMI_USER=forwarder
Environment=AMI_PASS=SUPER_SECRET_AMI_PASSWORD
Environment=WEBHOOK_URL=https://your-lovable-app.lovable.app/api/public/asterisk-events
Environment=WEBHOOK_SECRET=<same value you saved as ASTERISK_WEBHOOK_SECRET in Lovable>
ExecStart=/usr/bin/node /opt/ami-forwarder/index.js
Restart=always
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now ami-forwarder
```

## 11. Wire this Lovable app

Add these secrets (Lovable → Settings → Secrets):

- `ASTERISK_ARI_URL=https://pbx.yourdomain.com:8089/ari`
- `ASTERISK_ARI_USER=dialer_api`
- `ASTERISK_ARI_PASSWORD=SUPER_SECRET_ARI_PASSWORD`
- `ASTERISK_WSS_URL=wss://pbx.yourdomain.com:8089/ws`
- `ASTERISK_SIP_DOMAIN=pbx.yourdomain.com`
- `ASTERISK_WEBHOOK_SECRET=<the same value as WEBHOOK_SECRET above>`

For the browser softphone the client reads the same values via env: also add
`VITE_ASTERISK_WSS_URL` and `VITE_ASTERISK_SIP_DOMAIN` with the same URLs.
(The server fn `getSipCredentials` also returns these to the browser so agents
don't need them baked in.)
