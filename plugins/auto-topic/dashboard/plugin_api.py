"""Auto-topic plugin backend — AI session topics with a leading emoji.

Mounted at /api/plugins/auto-topic/. Read-only: never writes to the store.
The desktop half fills the Rename dialog input with the returned title; the
app's own save flow performs the actual rename (user-typed provenance + live
sidebar sync stay 100% app-native).

Flow: resolve the session (exact ``session_id`` or exact-title match against
the profile's store) → load its recent transcript → ask the
``title_generation`` auxiliary model for a short topic prefixed with one
relevant emoji → normalize (emoji first, single spaces, <=80 chars).
"""

from __future__ import annotations

import json
import logging
import re
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

log = logging.getLogger("auto-topic")

router = APIRouter()

# --------------------------------------------------------------------------- limits
_MAX_CONV_MSGS = 30      # last N user/assistant messages fed to the model
_MAX_CONV_CHARS = 6000   # hard cap on the transcript excerpt
_MAX_TITLE_CHARS = 80
_REQUEST_TIMEOUT_S = 45.0
_FALLBACK_EMOJI = "\U0001f4ac"  # 💬 — used only if the model forgets the emoji

_TITLE_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "session_topic",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {"title": {"type": "string"}},
            "required": ["title"],
            "additionalProperties": False,
        },
    },
}

_SYSTEM_PROMPT = (
    "You name chat sessions. Read the conversation and write a short topic title "
    "that lets the owner find this chat again in a list.\n\n"
    "Rules:\n"
    "- The title MUST start with exactly ONE relevant emoji, then a space, then "
    "2-7 words naming the topic (example: \U0001f9ee Fix Postgres pool exhaustion).\n"
    "- The emoji must match the topic: server \u2192 \U0001f5a5\ufe0f, deploy \u2192 \U0001f680, "
    "payment \u2192 \U0001f4b3, chat/telegram \u2192 \U0001f4ac, bug \u2192 \U0001f41b, \u2026\n"
    "- Write the title in the same language as the conversation.\n"
    "- Name what the user wants done; keep technical terms, filenames, numbers "
    "and error codes exact.\n"
    "- No quotes, no 'Title:' prefix, no trailing punctuation.\n"
    'Reply with JSON only: {"title": "..."}'
)


# --------------------------------------------------------------------------- request model
class AutoTopicBody(BaseModel):
    session_id: str = ""        # durable id or unique prefix — preferred
    title: Optional[str] = ""   # fallback: locate the session by its exact title
    profile: str = ""           # "" = this process's own profile


# --------------------------------------------------------------------------- resolution
def _resolve_session(db, body: AutoTopicBody) -> Optional[str]:
    """Return a store session id, or None when unresolvable."""
    if body.session_id:
        try:
            return db.resolve_session_id(body.session_id)
        except Exception:
            return None
    title = (body.title or "").strip()
    if not title:
        # Untitled session: the rename input is empty and the DOM carries no
        # id — fall back to the most recently active session with no title,
        # which is overwhelmingly the row the user just opened for renaming.
        try:
            rows = db.list_sessions_rich(
                limit=50,
                order_by_last_active=True,
                include_archived=False,
                compact_rows=True,
            )
        except Exception as exc:
            log.warning("auto-topic: session list failed: %s", exc)
            return None
        for row in rows:
            if not (row.get("title") or "").strip():
                return row.get("id")
        return None
    # Titles are unique per store (unique-title index). A scan is only
    # acceptable here because renames are rare, human-initiated actions.
    try:
        rows = db.list_sessions_rich(
            limit=5000,
            include_archived=True,
            include_hidden=True,
            compact_rows=True,
        )
    except Exception as exc:
        log.warning("auto-topic: session list failed: %s", exc)
        return None
    for row in rows:
        if (row.get("title") or "").strip() == title:
            return row.get("id")
    return None


# --------------------------------------------------------------------------- transcript
def _load_transcript(db, session_id: str) -> str:
    from agent.message_content import flatten_message_text

    try:
        sid = db.resolve_resume_session_id(session_id)
    except Exception:
        sid = session_id
    try:
        messages = db.get_messages_as_conversation(sid, repair_alternation=True)
    except Exception as exc:
        log.warning("auto-topic: transcript read failed: %s", exc)
        raise HTTPException(status_code=422, detail=f"could not read transcript: {exc}")

    lines = []
    for message in messages:
        role = message.get("role")
        if role not in ("user", "assistant"):
            continue  # system notes, tool I/O
        text = flatten_message_text(message.get("content")).strip()
        if not text:
            continue
        lines.append(f"{role}: {text}")

    conv = "\n".join(lines[-_MAX_CONV_MSGS:])
    if len(conv) > _MAX_CONV_CHARS:
        conv = conv[-_MAX_CONV_CHARS:]
        conv = "... [earlier messages omitted] ...\n" + conv
    return conv


# --------------------------------------------------------------------------- title shaping
def _first_char_is_emoji(s: str) -> bool:
    """Broad emoji-range check on the first character (no regex-\u005cp dependency)."""
    if not s:
        return False
    cp = ord(s[0])
    return (
        0x1F000 <= cp <= 0x1FAFF          # pictographs, flags (1F1E6..1F1FF inside)
        or 0x2600 <= cp <= 0x27BF         # misc symbols + dingbats
        or 0x2B00 <= cp <= 0x2BFF
        or cp == 0xFE0F                   # variation selector (won't be first, safe)
        or cp in (0x231A, 0x231B, 0x23E9, 0x23EA, 0x23EB, 0x23EC, 0x23F0,
                  0x23F3, 0x25AA, 0x25AB, 0x25FD, 0x25FE, 0x2934, 0x2935,
                  0x2B05, 0x2B06, 0x2B07, 0x2B1B, 0x2B1C, 0x2B50, 0x3030,
                  0x303D, 0x3297, 0x3299)
    )


def _parse_title(content: str) -> str:
    """Extract the title from a model response (JSON schema, loose JSON, prose)."""
    raw = (content or "").strip()
    fenced = re.match(r"^```(?:json)?\s*(.*?)\s*```$", raw, re.S)
    if fenced:
        raw = fenced.group(1).strip()
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict) and isinstance(parsed.get("title"), str):
            return parsed["title"].strip()
    except (ValueError, TypeError):
        pass
    match = re.search(r'"title"\s*:\s*"((?:[^"\\]|\\.)*)"', raw)
    if match:
        try:
            return json.loads('"' + match.group(1) + '"')
        except ValueError:
            return match.group(1)
    raw = re.sub(r"^```(?:json)?|```$", "", raw)
    return raw.strip().strip("\"'")


def _finalize(raw: str) -> str:
    """Normalize + enforce the leading emoji on a model title."""
    raw = re.sub(r"\s+", " ", raw.strip().strip("\"'"))
    if raw.lower().startswith("title:"):
        raw = raw[6:].strip()
    raw = raw.rstrip(".,;!?")

    if raw and _first_char_is_emoji(raw):
        emoji = raw[0]
        rest = raw[1:].lstrip()
    else:
        emoji = _FALLBACK_EMOJI
        rest = raw

    title = f"{emoji} {rest}" if rest else emoji
    title = re.sub(r"\s+", " ", title)
    if len(title) > _MAX_TITLE_CHARS:
        title = title[: _MAX_TITLE_CHARS - 3].rstrip() + "..."
    return title


def _suggest_title(conv: str) -> str:
    if not conv.strip():
        raise HTTPException(
            status_code=422,
            detail="session has no readable user/assistant text yet",
        )
    try:
        from agent.auxiliary_client import call_llm
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"title model unavailable: {exc}"
        )
    try:
        response = call_llm(
            task="title_generation",
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": f"<conversation>\n{conv}\n</conversation>"},
            ],
            max_tokens=64,
            temperature=0.3,
            timeout=_REQUEST_TIMEOUT_S,
            extra_body={"response_format": _TITLE_SCHEMA},
        )
        content = response.choices[0].message.content or ""
    except Exception as exc:
        log.warning("auto-topic: LLM call failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"title generation failed: {exc}")
    return _finalize(_parse_title(content))


# --------------------------------------------------------------------------- routes
@router.get("/auto-topic/status")
def auto_topic_status():
    """What the automatic half installed at import time (for verification)."""
    return {
        "auto_emoji_titles": AUTO_EMOJI_STATUS,
        "prompt_patched": bool(getattr(_tg(), "_HERMES_AUTO_TOPIC_EMOJI", False)),
        "provider": _title_provider(),
    }


# --------------------------------------------------------------------------- automatic mode
# New chats must get emoji titles WITHOUT anyone clicking the Rename button. The
# app's own titler (agent/title_generator.py) runs on the first exchange for every
# surface (desktop, TUI, messaging gateways) and writes an `llm` title — a title a
# plugin can't overwrite afterwards (provenance: a second `llm` write is a no-op).
# So the emoji has to originate THERE. The titler's prompt is a module constant
# with no config door, hence the two-part install below. Both parts are additive
# and idempotent; if upstream renames the anchor we log and degrade to plain
# titles (never break titling).

_EMOJI_RULE_ANCHOR = "- 3 to 7 words, sentence case"
_EMOJI_RULE = (
    "- Start the title with exactly ONE emoji that fits the topic, then a space, then the words\n"
    "  (server → 🖥️, deploy → 🚀, payment → 💳, chat/telegram → 💬, bug → 🐛, …).\n"
    "- 3 to 7 words, sentence case"
)


def _tg():
    import agent.title_generator as tg

    return tg


def _ensure_emoji(title: Optional[str]) -> Optional[str]:
    """Prepend the fallback emoji when the model ignored the emoji rule."""
    if not title or _first_char_is_emoji(title):
        return title
    return f"{_FALLBACK_EMOJI} {title}".strip()


def install_auto_emoji_titles() -> str:
    """Make the app's own auto-titler emit emoji-first titles, everywhere."""
    try:
        tg = _tg()
    except Exception as exc:
        log.warning("auto-topic: title_generator unavailable: %s", exc)
        return f"unavailable: {exc}"

    if getattr(tg, "_HERMES_AUTO_TOPIC_EMOJI", False):
        return "already installed"

    applied = []

    prompt = getattr(tg, "_TITLE_PROMPT_TEMPLATE", None)
    if isinstance(prompt, str) and "ONE emoji that fits the topic" not in prompt:
        if _EMOJI_RULE_ANCHOR in prompt:
            tg._TITLE_PROMPT_TEMPLATE = prompt.replace(_EMOJI_RULE_ANCHOR, _EMOJI_RULE, 1)
            applied.append("prompt")
        else:
            log.warning("auto-topic: title prompt anchor moved — emoji rule not injected")
            applied.append("prompt-anchor-missing")

    generate = getattr(tg, "generate_title", None)
    if callable(generate) and not getattr(generate, "_hermes_auto_topic_wrapped", False):
        def _generate_title_emoji_first(*args, **kwargs):
            return _ensure_emoji(generate(*args, **kwargs))

        _generate_title_emoji_first._hermes_auto_topic_wrapped = True
        tg.generate_title = _generate_title_emoji_first
        applied.append("guard")

    tg._HERMES_AUTO_TOPIC_EMOJI = True
    log.info("auto-topic: automatic emoji titles installed (%s)", ", ".join(applied) or "no-op")
    return ", ".join(applied) or "no-op"


def _title_provider() -> str:
    try:
        cfg = _tg()._title_config()
        return f"{cfg.get('provider') or 'auto'}/{cfg.get('model') or 'auto'}"
    except Exception:
        return "unknown"


AUTO_EMOJI_STATUS = install_auto_emoji_titles()


@router.post("/auto-topic")
def auto_topic(body: AutoTopicBody):
    try:
        # Defining module first: web_server.py is a facade and its re-exports of
        # the session-store helpers were dropped (Sep 2026 decomposition), so the
        # old `from hermes_cli.web_server import ...` path ImportErrors on newer
        # builds. Keep the facade as a fallback for older runtimes.
        try:
            from hermes_cli.web_server_sessions import _open_session_db_for_profile
        except ImportError:
            from hermes_cli.web_server import _open_session_db_for_profile
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"gateway store unavailable: {exc}")

    db = _open_session_db_for_profile(body.profile or None, read_only=True)
    try:
        sid = _resolve_session(db, body)
        if not sid:
            raise HTTPException(
                status_code=404,
                detail="session not found — rename a session that already has a title",
            )
        conv = _load_transcript(db, sid)
        title = _suggest_title(conv)
        return {"title": title, "session_id": sid}
    finally:
        try:
            db.close()
        except Exception:
            pass
