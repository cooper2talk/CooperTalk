#!/usr/bin/env bash
set -euo pipefail
umask 077

project="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
template="${1:-.env}"
output="${2:-.env.runtime}"

if [[ -z "$project" || "$project" == "(unset)" ]]; then
  echo "GCP_PROJECT or a configured gcloud project is required." >&2
  exit 1
fi

first_render=false
if [[ ! -f "$output" ]]; then
  cp "$template" "$output"
  first_render=true
fi
chmod 600 "$output"

configured_value() {
  local key="$1"
  local value
  value="$(sed -n "s/^${key}=//p" "$template" | head -n 1)"
  [[ -n "$value" && "$value" != *"replace-with"* && "$value" != "admin@example.ca" ]]
}

if ! configured_value ADMIN_EMAIL || ! configured_value ADMIN_PASSWORD; then
  echo "Set a real ADMIN_EMAIL and ADMIN_PASSWORD in $template before deployment." >&2
  exit 1
fi

set_value() {
  local key="$1"
  local value="$2"
  KEY="$key" VALUE="$value" node - "$output" <<'NODE'
const fs = require("node:fs");
const [file] = process.argv.slice(2);
const key = process.env.KEY;
const value = process.env.VALUE;
const source = fs.readFileSync(file, "utf8");
const line = `${key}=${value}`;
const matcher = new RegExp(`^${key}=.*$`, "m");
fs.writeFileSync(file, matcher.test(source) ? source.replace(matcher, line) : `${source}\n${line}\n`, { mode: 0o600 });
NODE
}

secret_value() {
  gcloud secrets versions access latest --project="$project" --secret="$1"
}

optional_secret_value() {
  local secret_name="$1"
  local value
  if value="$(secret_value "$secret_name" 2>/dev/null)"; then
    printf '%s' "$value"
  fi
}

set_value NODE_ENV production
set_value PUBLIC_HOST "${PUBLIC_HOST:-34-130-230-27.sslip.io}"
set_value PUBLIC_BASE_URL "https://${PUBLIC_HOST:-34-130-230-27.sslip.io}"
if [[ "$first_render" == true ]]; then
  set_value POSTGRES_PASSWORD "$(openssl rand -hex 32)"
  set_value SESSION_SECRET "$(openssl rand -base64 48)"
  set_value DOGRAH_EVENT_SECRET "$(openssl rand -base64 48)"
  set_value WHATSAPP_VERIFY_TOKEN "$(openssl rand -base64 48)"
fi
set_value DEEPGRAM_API_KEY "$(secret_value cooper-deepgram-api-key)"
set_value GROQ_API_KEY "$(secret_value cooper-groq-api-key)"
set_value RUMIK_API_KEY "$(secret_value cooper-rumik-api-key)"
set_value TWILIO_ACCOUNT_SID "$(secret_value cooper-twilio-account-sid)"
set_value TWILIO_AUTH_TOKEN "$(secret_value cooper-twilio-auth-token)"
set_value TELNYX_API_KEY "$(optional_secret_value cooper-telnyx-api-key)"

echo "Updated $output with mode 600."
