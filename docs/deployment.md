# Deployment — Tiara Pilot Backend

## Prereqs

- Node 20+
- PostgreSQL access to `vonage_reports` (creds = same as mitra)
- MySQL read-only user on `lavender_lavenderPOS` (the actual Prestisa DB)
- WAHA instance running with a dedicated pilot session (separate from mitra's `finance1`)
- API keys: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`
- Caddy as the reverse proxy (never nginx on this VPS)

## First deploy

```bash
cd /home/krttpt/crm
cp .env.example .env  # then fill in secrets
mkdir -p logs
cd backend
npm ci
npm run migrate         # applies 001_init.sql, 002_seed_persona.sql
npm run seed:staff      # creates staff_users + first admin
npm test                # full suite must pass
npm run eval            # live eval — must be ≥85% (needs ANTHROPIC_API_KEY)
```

## Start under PM2

```bash
cd /home/krttpt/crm
pm2 start ecosystem.config.js
pm2 save
pm2 logs crm-pilot-backend
```

## Caddy block

Append to `/etc/caddy/Caddyfile`:

```
salesai.prestisa.net {
    encode gzip

    handle /api/*       { reverse_proxy 127.0.0.1:3009 }
    handle /webhook/*   { reverse_proxy 127.0.0.1:3009 }
    handle /admin/*     { reverse_proxy 127.0.0.1:3009 }
    handle /socket.io/* { reverse_proxy 127.0.0.1:3009 }

    handle {
        respond "Tiara backend is up. Frontend coming." 200
    }
}
```

Reload Caddy:
```bash
sudo caddy reload --config /etc/caddy/Caddyfile
```

## WAHA webhook config

Configure WAHA pilot session to POST inbound to:
```
https://salesai.prestisa.net/webhook/waha
Header: X-Webhook-Secret: <value of WAHA_WEBHOOK_SECRET in .env>
```

If using an n8n forwarder, the body shape is `{ wa_jid, push_name, body, waha_message_id, attachment_type, attachment_url, media_url, media_mimetype }` (matches `wahaAdapter.parseInbound`).

## Cron entries

```
30 0 * * * cd /home/krttpt/crm/backend && /usr/bin/node scripts/dailyMetricsRollup.js >> /home/krttpt/crm/logs/rollup.log 2>&1
```

## Rollback / kill switch

```bash
# disable AI globally (per-instance) without restart:
curl -s -X POST -H "Content-Type: application/json" \
  -b "crm_pilot_token=<jwt>" \
  -d '{"enabled": false}' \
  http://localhost:3009/api/admin/ai/global

# stop entire backend:
pm2 stop crm-pilot-backend

# rollback to previous commit:
git log --oneline -10
git checkout <prev-sha>
pm2 restart crm-pilot-backend
```

## Health checks

- `GET /healthz` — process alive
- `GET /readyz` — PG + MySQL connectivity
- `GET /api/admin/metrics/today` (auth required) — live counters

## Provisioning the WAHA pilot session

After first deploy, an admin must scan the WhatsApp QR to authenticate the session:

1. Visit `https://salesai.prestisa.net/admin/login.html`
2. Login with the seeded admin (`finance` / `Bunga123` by default — change in production)
3. Click "Create + Start" with the session name from `.env` (`WAHA_SESSION`)
4. Wait ~5s, then click "QR" — scan from WhatsApp on phone (Settings → Linked Devices → Link a Device)
5. Status flips to `WORKING` within ~10s — pilot is live.
