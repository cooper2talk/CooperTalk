# Deployment checklist

## GCP Toronto

- Resize the VM to `e2-standard-4`, reserve a static external IP, and attach a domain.
- Allow TCP 80 and 443 publicly; limit SSH TCP 22 to the administrator's current public IP.
- Install Docker Engine and Docker Compose. Keep PostgreSQL private to the VM/VPC.
- Store every value from `.env.example` in GCP Secret Manager. Generate runtime `.env` files with mode `0600`; do not place secrets in images or Git.
- Deploy the pinned Dograh source image with the Cooper2Talk extension. Point `DOGRAH_EVENT_URL` to `https://YOUR_DOMAIN/internal/dograh/events`.

## External setup required

- Twilio: add the Canadian number to Dograh's Twilio configuration and assign the inbound workflow. Dograh updates the Voice URL to `https://DOGRAH_DOMAIN/api/v1/telephony/inbound/run` using POST.
- Carrier: enable conditional forwarding (busy/no-answer/unreachable) from the personal mobile number to the Twilio number.
- Meta: create a WhatsApp Cloud API app, register its webhook at `https://YOUR_DOMAIN/webhooks/whatsapp`, subscribe to messages and statuses, and approve the configured alert template.

## Operational checks

`GET /health` reports service and provider configuration without exposing secrets. Purge transcripts with the built-in retention job; recordings remain disabled.
# Cooper2Talk deployment

## Temporary hostname before buying a domain

For the current server IP, use `34-130-230-27.sslip.io`. It resolves to the VM without a DNS purchase and Caddy can obtain a public HTTPS certificate for it. Reserve the GCP address before using the system beyond a test; changing the address changes this hostname and breaks Twilio and Meta webhooks.

Open GCP ingress TCP 80 and TCP 443 to the VM. Keep TCP 22 restricted to the administrator's current IP address.

## Launch

On the VM, clone this repository to `/opt/cooper2talk` and create `/opt/cooper2talk/.env` with permissions `600`. Use `.env.example` as the names-only template. Set at least:

```dotenv
NODE_ENV=production
PUBLIC_HOST=34-130-230-27.sslip.io
PUBLIC_BASE_URL=https://34-130-230-27.sslip.io
POSTGRES_PASSWORD=a-long-url-safe-password
DATABASE_URL=postgres://cooper:a-long-url-safe-password@postgres:5432/cooper2talk
SESSION_SECRET=a-long-random-secret
DOGRAH_EVENT_SECRET=a-different-long-random-secret
WHATSAPP_VERIFY_TOKEN=a-different-long-random-secret
ADMIN_EMAIL=your-admin-email@example.ca
ADMIN_PASSWORD=a-strong-unique-password
TRANSCRIPT_RETENTION_DAYS=30
```

Add provider values directly on the VM; never commit them. Start Cooper2Talk with:

```bash
bash deploy/render-runtime-env.sh
sudo docker compose --env-file .env.runtime -f deploy/production-compose.yml up -d --build
curl -fsS https://34-130-230-27.sslip.io/health
```

`POSTGRES_PASSWORD` must be URL-safe because it is inserted into the container database URL. Generate a long value containing letters, numbers, hyphens, and underscores only.
