# Cooper2Talk Dograh extension contract

Cooper2Talk keeps Dograh pinned to a reviewed release and adds a small server-side extension. It must never send provider secrets to Cooper2Talk.

## Outbound events

POST signed JSON to `DOGRAH_EVENT_URL` using `X-Cooper-Signature: sha256=<hex HMAC of raw body>`:

```json
{"id":"uuid","type":"transcript.final","occurredAt":"2026-08-15T00:00:00.000Z","call":{"dograhRunId":"42","provider":"telnyx","providerCallId":"v3:call-control-id","callLegId":"v3:call-leg-id","callSessionId":"v3:call-session-id","from":"+1409...","to":"+1409...","forwardedFrom":null},"payload":{"speaker":"caller","text":"Are you open?"}}
```

Supported types are `call.started`, `transcript.final`, `call.interrupted`, and `call.ended`. The extension normalizes numbers and treats forwarding headers as optional metadata. `provider`, `providerCallId`, `callLegId`, and `callSessionId` are provider-neutral fields; legacy `twilioCallSid` and `streamSid` remain accepted only for existing Twilio calls.

## Operator injection

Expose `POST /api/v1/cooper/calls/{workflowRunId}/operator-instructions` inside Dograh. Authenticate it with its server-only API key. The handler must cancel bot speech, flush queued TTS, append an `operator` context message, then request a concise new LLM response. It returns `202` with a stable instruction ID. The same instruction ID must be idempotent.
