#!/usr/bin/env bash
set -euo pipefail

dograh_env="${DOGRAH_ENV_FILE:-/opt/dograh/.env}"

if [[ ! -f "$dograh_env" ]]; then
  echo "Dograh runtime environment file not found: $dograh_env" >&2
  exit 1
fi

put_secret() {
  local environment_key="$1"
  local secret_name="$2"
  local secret_value temporary_file
  secret_value="$(gcloud secrets versions access latest --secret="$secret_name")"
  temporary_file="$(mktemp "${dograh_env}.XXXXXX")"
  awk -v key="$environment_key" -v value="$secret_value" '
    BEGIN { replaced = 0 }
    index($0, key "=") == 1 {
      if (!replaced) print key "=" value
      replaced = 1
      next
    }
    { print }
    END { if (!replaced) print key "=" value }
  ' "$dograh_env" > "$temporary_file"
  chmod 600 "$temporary_file"
  mv "$temporary_file" "$dograh_env"
}

put_secret DEEPGRAM_API_KEY cooper-deepgram-api-key
put_secret GROQ_API_KEY cooper-groq-api-key
put_secret RUMIK_API_KEY cooper-rumik-api-key
put_secret TWILIO_ACCOUNT_SID cooper-twilio-account-sid
put_secret TWILIO_AUTH_TOKEN cooper-twilio-auth-token

if gcloud secrets versions access latest --secret=cooper-telnyx-api-key >/dev/null 2>&1; then
  put_secret TELNYX_API_KEY cooper-telnyx-api-key
fi
