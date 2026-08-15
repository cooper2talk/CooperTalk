# Cooper2Talk

Canadian AI receptionist demo: Dograh connects Telnyx for the direct-call pilot and retains Twilio as rollback; Cooper2Talk provides secure operator control, transcript retention, and WhatsApp injection.

## Local development

1. Copy `.env.example` to `.env` and enter only local/development values.
2. Run `npm install` and `docker compose up postgres -d`.
3. Run `npm run dev`; open `http://localhost:3000`.
4. Run `npm test` for the core API suite.

The API accepts signed Dograh events at `/internal/dograh/events`. The dashboard can be tested using the included simulation endpoint only in development.

## Production boundary

Deploy the API and Dograh on the resized GCP Toronto VM. Use a domain with TLS and expose only HTTPS. Store real values in GCP Secret Manager; never commit `.env` or `cooper_voice_key`.

See [`docs/deployment.md`](docs/deployment.md) and [`docs/dograh-extension.md`](docs/dograh-extension.md).
