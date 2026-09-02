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
For a separately owned ExcelLinx Groq account, the
`cooper2talk-managed:groq-excellinx` marker resolves only to the runtime
`GROQ_EXCELLINX_API_KEY`; no provider key is written to Dograh's database.
Apply `groq-excellinx-managed-secret-v1.45.0.patch` after the managed-secret
patch when assigning an ExcelLinx-owned Groq key to a workflow.

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

Apply `workflow-label-events-v1.45.0.patch` after the live transcript bridge.
It adds the executing workflow ID and workflow name to signed Cooper2Talk call
events so the operator console distinguishes separate receptionists sharing the
same Telnyx provider.

Apply `companion-profiles-v1.45.0.patch` after the event and instruction
patches to enable caller-specific companion profiles. The profile is selected
from the inbound E.164 caller ID before the greeting, speech-to-text, or
text-to-speech service is created. It therefore cannot affect unrelated calls.
The Punjabi companion profile uses Deepgram `nova-3` with `pa-IN` and Google
Chirp 3 HD's female `pa-IN-Chirp3-HD-Kore` voice. It also adds per-call prompt
rules for Punjabi-first, turn-by-turn language matching, a friendly companion
mode, feminine grammar, English digit pronunciation, and privacy boundaries.

Set `COOPER_COMPANION_PROFILES` only in Dograh's private runtime environment.
Its JSON value is a map from a trusted caller's E.164 number to their profile:

```json
{
  "+1XXXXXXXXXX": {
    "name": "Trusted caller",
    "sttLanguage": "pa-IN",
    "sttModel": "nova-3",
    "ttsLanguage": "pa-IN",
    "ttsModel": "chirp_3_hd",
    "ttsVoice": "pa-IN-Chirp3-HD-Kore"
  }
}
```

The caller-ID match personalises a call; it is not authentication. Do not add
private-data permissions to a profile without a separate verification step.

`deploy/apply-dograh-companion-profiles.sh` is the recommended production
installer. It copies the reviewed Python module and adds the three required
hooks through stable Dograh source markers. This accommodates the existing
Cooper modifications in a deployed Dograh tree; the patch remains available
for review and clean-source installations.

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
