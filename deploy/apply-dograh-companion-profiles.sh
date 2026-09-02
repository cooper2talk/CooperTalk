#!/usr/bin/env bash
set -euo pipefail

# Apply the reviewed caller-profile extension to a pinned Dograh source tree.
# This is intentionally idempotent: a second run only confirms it is present.

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dograh_root="${1:-/opt/dograh}"
patch_file="$project_root/dograh-extension/companion-profiles-v1.45.0.patch"

if [[ ! -d "$dograh_root/.git" ]]; then
  echo "Dograh source repository not found: $dograh_root" >&2
  exit 1
fi
if [[ ! -f "$patch_file" ]]; then
  echo "Companion-profile patch not found: $patch_file" >&2
  exit 1
fi

if git -C "$dograh_root" apply --reverse --check "$patch_file" >/dev/null 2>&1; then
  echo "Dograh companion-profile extension is already applied."
  exit 0
fi

git -C "$dograh_root" apply --check "$patch_file"
git -C "$dograh_root" apply "$patch_file"
echo "Applied Dograh companion-profile extension. Rebuild the Dograh API service before testing a call."
