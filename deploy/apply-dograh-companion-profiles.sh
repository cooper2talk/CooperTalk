#!/usr/bin/env bash
set -euo pipefail

# Install the reviewed caller-profile extension into a customized Dograh source
# tree. Existing Cooper patches can change ordinary diff context, so this uses
# stable source markers and writes only after every required marker is found.

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dograh_root="${1:-/opt/dograh}"
profile_source="$project_root/dograh-extension/cooper_companion_profiles.py"

if [[ "$EUID" -ne 0 ]]; then
  echo "Run this installer with sudo so it can update the protected Dograh source tree." >&2
  exit 1
fi

if [[ ! -d "$dograh_root/.git" ]]; then
  echo "Dograh source repository not found: $dograh_root" >&2
  exit 1
fi
if [[ ! -f "$profile_source" ]]; then
  echo "Companion-profile source not found: $profile_source" >&2
  exit 1
fi

install -m 0644 "$profile_source" "$dograh_root/api/services/pipecat/cooper_companion_profiles.py"

python3 - "$dograh_root" <<'PY'
from __future__ import annotations

from pathlib import Path
import sys

root = Path(sys.argv[1])
pipeline_path = root / "api/services/pipecat/run_pipeline.py"
engine_path = root / "api/services/workflow/pipecat_engine.py"

profile_import = "from api.services.pipecat.cooper_companion_profiles import apply_companion_profile\n"
profile_call = """    # Caller profile selection is deliberately before STT/TTS construction so
    # the greeting and the very first caller turn use the selected language.
    user_config, merged_call_context_vars = apply_companion_profile(
        user_config, merged_call_context_vars
    )

"""
prompt_call = """        companion_instructions = self._call_context_vars.get(
            \"cooper_companion_instructions\"
        )
        if isinstance(companion_instructions, str) and companion_instructions.strip():
            system_prompt = f\"{system_prompt}\\n\\n{companion_instructions.strip()}\"
"""

def write_if_changed(path: Path, value: str) -> None:
    temporary = path.with_suffix(path.suffix + ".cooper-tmp")
    temporary.write_text(value, encoding="utf-8")
    temporary.chmod(path.stat().st_mode)
    temporary.replace(path)

pipeline = pipeline_path.read_text(encoding="utf-8")
if profile_import not in pipeline:
    import_marker = "from api.services.pipecat.audio_config import AudioConfig, create_audio_config\n"
    if import_marker not in pipeline:
        raise SystemExit(f"Unsupported Dograh run_pipeline import layout: {pipeline_path}")
    pipeline = pipeline.replace(import_marker, import_marker + profile_import, 1)
if "user_config, merged_call_context_vars = apply_companion_profile(" not in pipeline:
    config_marker = "    workflow_graph = WorkflowGraph(\n"
    if config_marker not in pipeline:
        raise SystemExit(f"Unsupported Dograh run_pipeline configuration layout: {pipeline_path}")
    pipeline = pipeline.replace(config_marker, profile_call + config_marker, 1)

engine = engine_path.read_text(encoding="utf-8")
if "cooper_companion_instructions" not in engine:
    functions_marker = "        functions = await compose_functions_for_node(\n"
    if functions_marker not in engine:
        raise SystemExit(f"Unsupported Dograh PipecatEngine layout: {engine_path}")
    engine = engine.replace(functions_marker, prompt_call + functions_marker, 1)

compile(pipeline, str(pipeline_path), "exec")
compile(engine, str(engine_path), "exec")
write_if_changed(pipeline_path, pipeline)
write_if_changed(engine_path, engine)
PY

python3 -m py_compile "$dograh_root/api/services/pipecat/cooper_companion_profiles.py"
echo "Applied Dograh companion-profile extension. Rebuild the Dograh API service before testing a call."
