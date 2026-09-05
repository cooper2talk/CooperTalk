"""Live web research for trusted Cooper2Talk companion calls.

The caller's question is the only user content sent to Groq. Webpage text is
treated as untrusted reference material; neither it nor the caller can alter
system instructions or access any Cooper2Talk data.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

import aiohttp
from loguru import logger
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.services.llm_service import FunctionCallParams


_GROQ_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions"
_MAX_QUERY_LENGTH = 320
_MAX_ANSWER_LENGTH = 1_200
_REQUEST_TIMEOUT_SECONDS = 15
_MAX_RATE_LIMIT_RETRIES = 1


def web_research_schema() -> FunctionSchema:
    return FunctionSchema(
        name="cooper_web_research",
        description=(
            "MANDATORY for public information that is current, changeable, "
            "or needs verification: news, weather, time, dates, sports, "
            "prices, travel, events, public people, recommendations, and "
            "factual lookups. Research the caller's request using live internet "
            "sources before replying. Do not use this for casual conversation, "
            "personal data, or private Cooper2Talk information."
        ),
        properties={
            "query": {
                "type": "string",
                "description": "A concise web-search question based only on the caller's request.",
            }
        },
        required=["query"],
    )


def _source_list(executed_tools: Any) -> list[dict[str, str]]:
    """Extract a small, non-sensitive source list across Groq response shapes."""

    sources: list[dict[str, str]] = []
    seen: set[str] = set()

    def visit(value: Any) -> None:
        if len(sources) >= 5:
            return
        if isinstance(value, dict):
            url = value.get("url") or value.get("link")
            if isinstance(url, str) and url.startswith(("https://", "http://")):
                if url not in seen:
                    seen.add(url)
                    title = value.get("title") or value.get("name") or url
                    sources.append({"title": str(title)[:160], "url": url[:1_000]})
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(executed_tools)
    return sources


async def research(function_call_params: FunctionCallParams) -> None:
    """Use Groq Compound's server-side web search without persisting queries."""

    raw_query = function_call_params.arguments.get("query")
    query = str(raw_query or "").strip()[:_MAX_QUERY_LENGTH]
    if not query:
        await function_call_params.result_callback({"error": "A search question is required."})
        return

    # Keep live research off the conversational model's capacity when the
    # separately managed ExcelLinx Groq credential is available. The fallback
    # preserves the current single-key installation without exposing either
    # credential to source code or logs.
    api_key = os.getenv("GROQ_EXCELLINX_API_KEY", "").strip() or os.getenv(
        "GROQ_API_KEY", ""
    ).strip()
    if not api_key:
        await function_call_params.result_callback(
            {"error": "Live web research is not configured right now."}
        )
        return

    # Compound Mini has built-in web search enabled by default.  Keeping the
    # request to Groq's documented minimum avoids provider-side request-size
    # failures and lets Groq decide when to perform its single web search.
    payload = {
        "model": "groq/compound-mini",
        "messages": [
            {
                "role": "user",
                "content": (
                    "Use live web search to answer this current-information question. "
                    "Answer plainly and briefly for a phone call: "
                    f"{query}"
                ),
            }
        ],
    }

    try:
        timeout = aiohttp.ClientTimeout(total=_REQUEST_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Groq-Model-Version": "latest",
            }
            for attempt in range(_MAX_RATE_LIMIT_RETRIES + 1):
                async with session.post(
                    _GROQ_COMPLETIONS_URL,
                    json=payload,
                    headers=headers,
                ) as response:
                    response_body = await response.json(content_type=None)
                    if response.status < 300:
                        break
                    if response.status == 429 and attempt < _MAX_RATE_LIMIT_RETRIES:
                        retry_after = response.headers.get("Retry-After", "1")
                        try:
                            delay = min(max(float(retry_after), 1), 3)
                        except ValueError:
                            delay = 1
                        logger.warning("Cooper live web research rate limited; retrying once")
                        await asyncio.sleep(delay)
                        continue

                    detail = ""
                    if isinstance(response_body, dict):
                        detail = str(response_body.get("error") or response_body.get("message") or "")[:160]
                    logger.warning(
                        "Cooper live web research request failed with status {}{}",
                        response.status,
                        f": {detail}" if detail else "",
                    )
                    await function_call_params.result_callback(
                        {
                            "error": "Live web research is temporarily unavailable.",
                            "status": response.status,
                        }
                    )
                    return
    except (aiohttp.ClientError, TimeoutError, ValueError):
        logger.warning("Cooper live web research request failed before a response")
        await function_call_params.result_callback(
            {"error": "Live web research is temporarily unavailable."}
        )
        return

    choices = response_body.get("choices") if isinstance(response_body, dict) else None
    first_choice = choices[0] if isinstance(choices, list) and choices else None
    message = first_choice.get("message") if isinstance(first_choice, dict) else None
    answer = message.get("content") if isinstance(message, dict) else None
    if not isinstance(answer, str) or not answer.strip():
        logger.warning("Cooper live web research returned no usable answer")
        await function_call_params.result_callback(
            {"error": "Live web research returned no usable answer."}
        )
        return

    logger.info("Cooper live web research request completed")
    await function_call_params.result_callback(
        {
            "answer": answer.strip()[:_MAX_ANSWER_LENGTH],
            "sources": _source_list(message.get("executed_tools")),
        }
    )
