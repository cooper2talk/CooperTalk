# Cooper2Talk Rumik extension

This extension targets Dograh `dograh-v1.45.0`, commit
`48aa0f600b21bbdaf89ac59c704dd77b0bb22202`. It adds Rumik, rather than
Rime, as a TTS provider and installs the Rumik Pipecat adapter version `0.1.4`
from its integrity-pinned wheel.

Apply `rumik-v1.45.0.patch` only to that exact Dograh release, then rebuild the
Dograh API image. It deliberately uses the Rumik WebSocket service with
`full_response_aggregation=False` so an interrupted receptionist can begin a
new response at the first generated sentence. The adapter itself cancels active
synthesis when Pipecat receives an interruption.

The extension does not validate a Rumik API key by generating speech. Rumik
validates the credential during its WebSocket handshake on a live call.

Apply `managed-secrets-v1.45.0.patch` after the Rumik patch. It keeps the
`cooper2talk-managed` marker in Dograh's database and replaces it only inside
the running API from `DEEPGRAM_API_KEY`, `GROQ_API_KEY`, and `RUMIK_API_KEY`.

Apply `telnyx-managed-secret-v1.45.0.patch` after those patches when enabling
the Telnyx pilot. Its Telnyx configuration also stores only the
`cooper2talk-managed` marker; the API resolves the real key from
`TELNYX_API_KEY` at runtime, including while Dograh auto-creates the Call
Control Application.

Apply `no-audio-recording-v1.45.0.patch` after the provider patches. It
disables audio capture and object-storage uploads, preserving only the text
transcript and call metadata required by Cooper2Talk's retention policy.

Apply `live-transcript-bridge-v1.45.0.patch` after the no-recording patch. It
sends signed final call and transcript events over the private Docker network
to Cooper2Talk. Set `COOPER_EVENT_URL` and `COOPER_EVENT_SECRET` only in
Dograh's runtime environment; do not place either value in the patch.

Apply `operator-instructions-redis-v1.45.0.patch` after the live transcript
bridge. Dograh runs multiple API workers, so this patch uses Redis to deliver
an authenticated operator instruction to the worker that owns the active call.
It rejects inactive calls, deduplicates retries, interrupts active speech, and
does not persist audio.

The current deployment uses Dograh's native Google Chirp 3 HD TTS service with
the fixed female `en-US-Chirp3-HD-Aoede` voice. The retained Rumik patch is
kept only as a pinned rollback option; Rumik is not the active voice provider.

Compatibility checks executed against the deployed release:

- The Rumik provider parses from Dograh's discriminated `TTSConfig` union.
- The registry exposes the Rumik TTS configuration.
- The factory creates `RumikTTSService` with the Muga default without making a
  provider request.
- The Dograh API health endpoint stays healthy after rebuilding.
- Audio recordings are not created or uploaded; transcript upload remains
  available.
- A cross-process HTTP instruction is delivered exactly once through Redis to
  the active call handler.
