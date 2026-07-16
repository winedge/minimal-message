# Self-hosted Supabase on your VPS

For a 5-agent dialer, a 4 vCPU / 8 GB VPS with 80 GB SSD is comfortable.
Run this separate from Asterisk if possible.

## 1. Prerequisites

- Ubuntu 22.04 LTS
- Docker + Docker Compose plugin
- DNS: `supabase.yourdomain.com` A-record → VPS IP
- Ports open: 80/443 (public), 5432 (only from Asterisk VPS or your own IP)

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin certbot nginx
sudo systemctl enable --now docker
```

## 2. Clone Supabase Docker setup

```bash
git clone --depth 1 https://github.com/supabase/supabase
cd supabase/docker
cp .env.example .env
```

Edit `.env`:

- `POSTGRES_PASSWORD` — strong random
- `JWT_SECRET` — strong random (≥40 chars)
- `ANON_KEY` / `SERVICE_ROLE_KEY` — generate with the Supabase JWT tool: <https://supabase.com/docs/guides/self-hosting/docker#generate-api-keys>
- `SITE_URL=https://your-lovable-app.lovable.app`
- `API_EXTERNAL_URL=https://supabase.yourdomain.com`
- `SUPABASE_PUBLIC_URL=https://supabase.yourdomain.com`
- `STUDIO_DEFAULT_ORGANIZATION` / `PROJECT`
- `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` — Studio basic-auth
- `SMTP_*` — required for password-reset emails (use Postmark / SES / Resend)
- `ADDITIONAL_REDIRECT_URLS=https://your-lovable-app.lovable.app,https://id-preview--<project>.lovable.app`
- CORS: add your Lovable preview + published origins to `SUPABASE_PUBLIC_URL` and Kong config below.

Start it:

```bash
docker compose pull
docker compose up -d
```

## 3. TLS + reverse proxy

`/etc/nginx/sites-available/supabase`:

```nginx
server {
  listen 80;
  server_name supabase.yourdomain.com;
  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / { return 301 https://$host$request_uri; }
}
server {
  listen 443 ssl http2;
  server_name supabase.yourdomain.com;
  ssl_certificate     /etc/letsencrypt/live/supabase.yourdomain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/supabase.yourdomain.com/privkey.pem;

  client_max_body_size 50m;
  location / {
    proxy_pass http://127.0.0.1:8000;   # Kong on host network
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600;
  }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/supabase /etc/nginx/sites-enabled/
sudo certbot certonly --webroot -w /var/www/html -d supabase.yourdomain.com
sudo nginx -t && sudo systemctl reload nginx
```

## 4. Apply the schema

Copy `db/0001_init.sql` from this project to the VPS, then:

```bash
docker exec -i supabase-db psql -U postgres -d postgres < 0001_init.sql
```

Or with Supabase CLI linked to your self-hosted project.

## 5. Google OAuth (optional)

In `.env`:

```
GOTRUE_EXTERNAL_GOOGLE_ENABLED=true
GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID=...
GOTRUE_EXTERNAL_GOOGLE_SECRET=...
GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI=https://supabase.yourdomain.com/auth/v1/callback
```

Add that redirect URI to your Google OAuth client. `docker compose up -d`.

## 6. Backups

`/etc/cron.daily/supabase-backup`:

```bash
#!/bin/bash
set -e
DAY=$(date +%F)
mkdir -p /backups
docker exec supabase-db pg_dumpall -U postgres | gzip > /backups/pg-$DAY.sql.gz
tar czf /backups/storage-$DAY.tar.gz /var/lib/docker/volumes/supabase_storage/_data
find /backups -mtime +14 -delete
# optional: aws s3 cp /backups/ s3://your-bucket/ --recursive
```

`chmod +x` it.

## 7. Wire this Lovable app to your Supabase

In this project, add secrets (Lovable Settings → Secrets):

- `SUPABASE_URL=https://supabase.yourdomain.com`
- `SUPABASE_PUBLISHABLE_KEY=<your ANON_KEY>`
- `SUPABASE_SERVICE_ROLE_KEY=<your SERVICE_ROLE_KEY>`
- `VITE_SUPABASE_URL=https://supabase.yourdomain.com`
- `VITE_SUPABASE_PUBLISHABLE_KEY=<your ANON_KEY>`
- `SIP_ENCRYPTION_KEY=<any long random string>`

Then bootstrap the first admin:

1. Sign up (or have Supabase Studio create you) an auth user.
2. Sign in on this app → visit `/admin/agents` → click **Claim first admin**.
3. Create agent accounts; each returns a SIP username/password to add to Asterisk.
