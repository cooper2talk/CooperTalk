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

## Emma WhatsApp call summaries

After a completed call to Emma's routed number (`+1 705 300 4321`), Cooper queues one call-close WhatsApp summary for the configured operator. The summary follows the caller's language: Hinglish/Hindi calls receive a Hinglish update and English calls receive an English update. If Groq is rate-limited, Cooper safely sends the latest caller statements instead of delaying the completed call.

Before enabling production delivery, create and approve the Meta template `cooper_call_summary` with four body parameters: caller, duration, update, and urgency. Set the Meta sender secrets in GCP Secret Manager using the existing `cooper-whatsapp-*` secret names, then re-render the runtime environment and restart the Cooper API. Missing sender credentials or an unapproved template is shown as a real outbox delivery error; it is never simulated as delivered.
