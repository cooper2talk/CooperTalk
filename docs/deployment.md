# Deployment checklist

## GCP Toronto

- Resize the VM to `e2-standard-4`, reserve a static external IP, and attach a domain.
- Allow TCP 80 and 443 publicly; limit SSH TCP 22 to the administrator's current public IP.
- Install Docker Engine and Docker Compose. Keep PostgreSQL private to the VM/VPC.
- Store every value from `.env.example` in GCP Secret Manager. Generate runtime `.env` files with mode `0600`; do not place secrets in images or Git.
- Deploy the pinned Dograh source image with the Cooper2Talk extension. Point `DOGRAH_EVENT_URL` to `https://YOUR_DOMAIN/internal/dograh/events`.

## Telnyx direct-call pilot

The existing US number `+14095060390` is for direct technical testing only. Do not configure Canadian mobile forwarding to it. Keep the Twilio configuration intact as rollback.

1. In Telnyx, create an API key with Call Control access and copy the account webhook public key. Never put the API key in Git or chat.
2. In GCP Secret Manager, create `cooper-telnyx-api-key` and grant `cooper2talk-runtime@PROJECT_ID.iam.gserviceaccount.com` the **Secret Manager Secret Accessor** role on that secret. Run `bash deploy/render-runtime-env.sh` and `bash deploy/render-dograh-runtime-env.sh` on the VM, then restart the relevant containers.
3. In Dograh, add a Telnyx telephony configuration. Set its API-key field to `cooper2talk-managed` (the deployment resolves this marker inside the container), paste the Telnyx webhook public key, leave the Call Control App ID blank, and add `+14095060390`. Dograh will create/configure its Call Control application.
4. Bind `+14095060390` to that Call Control application and select the receptionist workflow as inbound. Confirm the Telnyx number is voice-enabled before placing a test call.
5. Place a direct call only. Verify a signed inbound event, live transcript, fixed Emma voice, console injection, transfer and hang-up. Stop if the Telnyx pretrial blocks Call Control; do not fund it just to proceed.

The API records `provider`, `provider_call_id`, `call_leg_id`, and `call_session_id`, so Telnyx Call Control identifiers do not get mistaken for Twilio SIDs. It stores transcripts and call metadata only; recordings remain disabled.

## Other external setup required

- Twilio (rollback): keep its configuration and any number assignment intact, but do not use it for this pilot.
- Production carrier forwarding: after acquiring or porting a Canadian Telnyx voice number, enable conditional forwarding (busy/no-answer/unreachable) to that Canadian number.
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

## Meenakshi Punjabi companion profile

The caller-specific Punjabi route is part of the pinned Dograh extension; it
does not change Emma for other callers. Create the private GCP secret once,
then grant the VM runtime service account access if it does not already have
the same Secret Manager access as the existing Cooper secrets:

```bash
printf '%s' '{"+1XXXXXXXXXX":{"name":"Trusted caller","sttLanguage":"pa-IN","sttModel":"nova-3","ttsLanguage":"pa-IN","ttsModel":"chirp_3_hd","ttsVoice":"pa-IN-Chirp3-HD-Kore"}}' \
  | gcloud secrets create cooper-companion-profiles --data-file=-
```

For later edits, use `gcloud secrets versions add cooper-companion-profiles
--data-file=-` instead of creating a second secret. On the VM, apply the
extension to the existing pinned Dograh checkout, refresh its private runtime
environment, and rebuild the Dograh API service using the same compose command
used for Dograh's current deployment:

```bash
cd /opt/cooper2talk
sudo bash deploy/apply-dograh-companion-profiles.sh /opt/dograh
sudo -E bash deploy/render-dograh-runtime-env.sh
```

Start Dograh with its Cooper override so the private profile variable reaches
the API container:

```bash
cd /opt/dograh
sudo docker compose -f docker-compose.yml -f /opt/cooper2talk/deploy/dograh-compose.cooper2talk.yml up -d --build
```

The extension detects the incoming E.164 caller ID before Emma's greeting. For
that profile it uses Deepgram `nova-3` / `pa-IN` and Google `pa-IN-Chirp3-HD-Kore`,
then gives Emma Punjabi-first, language-matching companion instructions. The
caller-ID match is not authentication, so it still cannot unlock Surinder's
private data.
