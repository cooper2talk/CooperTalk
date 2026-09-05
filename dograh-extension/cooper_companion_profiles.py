"""Caller-specific companion settings for Cooper2Talk telephony calls.

The profile is selected only from the inbound caller ID before speech services
are constructed. It is runtime-only: no caller audio or secrets are written to
the workflow database.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any

from loguru import logger

from api.services.workflow.initial_context import GREETING_OVERRIDE_CONTEXT_KEY


_ENVIRONMENT_KEY = "COOPER_COMPANION_PROFILES"
_E164 = re.compile(r"^\+[1-9]\d{7,14}$")


@dataclass(frozen=True)
class CompanionProfile:
    """The small, deliberately allow-listed profile surface for a caller."""

    name: str
    stt_language: str = "pa-IN"
    stt_model: str = "nova-3"
    tts_language: str = "pa-IN"
    tts_model: str = "chirp_3_hd"
    tts_voice: str = "pa-IN-Chirp3-HD-Kore"


def _canonical_e164(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = re.sub(r"[\s().-]", "", value)
    return normalized if _E164.fullmatch(normalized) else None


def _profiles_from_environment(raw: str | None = None) -> dict[str, CompanionProfile]:
    """Parse a caller-ID map without ever making a bad setting block a call."""

    raw = (raw if raw is not None else os.getenv(_ENVIRONMENT_KEY, "")).strip()
    if not raw:
        return {}
    try:
        configured = json.loads(raw)
    except json.JSONDecodeError:
        logger.error("Ignoring invalid {} JSON", _ENVIRONMENT_KEY)
        return {}
    if not isinstance(configured, dict):
        logger.error("Ignoring {} because it is not a JSON object", _ENVIRONMENT_KEY)
        return {}

    profiles: dict[str, CompanionProfile] = {}
    for raw_number, raw_profile in configured.items():
        number = _canonical_e164(raw_number)
        if not number or not isinstance(raw_profile, dict):
            logger.warning("Ignoring invalid Cooper companion profile entry")
            continue
        name = raw_profile.get("name")
        if not isinstance(name, str) or not name.strip():
            logger.warning("Ignoring Cooper companion profile without a name")
            continue
        profiles[number] = CompanionProfile(
            name=name.strip()[:80],
            stt_language=str(raw_profile.get("sttLanguage", "pa-IN")),
            stt_model=str(raw_profile.get("sttModel", "nova-3")),
            tts_language=str(raw_profile.get("ttsLanguage", "pa-IN")),
            tts_model=str(raw_profile.get("ttsModel", "chirp_3_hd")),
            tts_voice=str(raw_profile.get("ttsVoice", "pa-IN-Chirp3-HD-Kore")),
        )
    return profiles


def _companion_instructions(profile: CompanionProfile) -> str:
    return f"""COOPER COMPANION CALL — {profile.name}
You are Emma, a friendly female conversational companion for {profile.name}.
Speak naturally about broad, everyday topics as well as messages for Surinder.
LANGUAGE LOCK — Start this call in Punjabi. When the caller speaks Punjabi, including Punjabi transcribed in Gurmukhi or Punjabi words written with English letters, every word of your reply must be Punjabi in Gurmukhi. Do not answer in Hindi or Hindi's Devanagari script merely because Punjabi and Hindi are similar. Keep speaking Punjabi until the caller clearly changes to Hindi or English, or specifically asks you to use another language. If the caller clearly speaks Hindi or Hinglish, reply only in Hindi/Hinglish; if she clearly speaks English, reply only in English. Never mix languages within one reply. When a live-research result is in English or Hindi, restate it fully in the caller's locked language rather than reading it verbatim.
Use feminine Punjabi/Hindi grammar for yourself. Speak phone numbers, verification codes, and other digits as English digits exactly as written.
This caller-ID match is personalisation, not proof of authority. Never reveal Surinder's private schedule, location, credentials, messages, or other private information.

LIVE INFORMATION RULE — You have a live-research function named cooper_web_research. You MUST call it before replying to every question about public information that could be current, changeable, or needs checking. This includes news, weather, time, dates, sports, traffic, prices, exchange rates, politics, public people, events, recommendations, travel, product availability, facts, or anything the caller asks you to look up. Never calculate, assume, or answer these questions from memory. If the live-research function fails or has no answer, say that you cannot verify it right now; do not guess. For general friendly conversation, opinions, or private information, reply normally without research. After a successful lookup, give its concise answer naturally without mentioning internal tools or offering an unverified answer."""


def apply_companion_profile(user_config: Any, call_context: dict[str, Any]) -> tuple[Any, dict[str, Any]]:
    """Return caller-specific config and prompt context before services are created."""

    caller_number = _canonical_e164(call_context.get("caller_number"))
    profile = _profiles_from_environment().get(caller_number or "")
    if not profile:
        return user_config, call_context

    context = {
        **call_context,
        "cooper_companion_profile": {"name": profile.name, "language": profile.tts_language},
        "cooper_companion_instructions": _companion_instructions(profile),
        GREETING_OVERRIDE_CONTEXT_KEY: {
            "type": "text",
            "text": "Hello.",
        },
    }

    # The deployed Emma workflow uses Deepgram STT and Google Chirp 3 HD TTS.
    # Preserve a different provider configuration rather than risking a call.
    if getattr(user_config.stt, "provider", None) != "deepgram":
        logger.warning("Cooper companion profile selected, but STT is not Deepgram")
    else:
        user_config = user_config.model_copy(
            update={
                "stt": user_config.stt.model_copy(
                    update={"model": profile.stt_model, "language": profile.stt_language}
                )
            }
        )
    if getattr(user_config.tts, "provider", None) != "google":
        logger.warning("Cooper companion profile selected, but TTS is not Google")
    else:
        user_config = user_config.model_copy(
            update={
                "tts": user_config.tts.model_copy(
                    update={
                        "model": profile.tts_model,
                        "language": profile.tts_language,
                        "voice": profile.tts_voice,
                    }
                )
            }
        )
    logger.info("Applied Cooper companion profile for {}", profile.name)
    return user_config, context
