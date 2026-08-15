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
