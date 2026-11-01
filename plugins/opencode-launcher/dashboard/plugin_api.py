"""OpenCode launcher backend — make the OpenCode web UI exist, then show it.

OpenCode **v2** rewrote the web story. In v1 the plugin spawned
``opencode serve --hostname 0.0.0.0`` (port 4096, no auth) and opened the bare
URL. In v2:

  * the web UI is served by the ONE shared background server every local
    client connects to (channel default ``http://127.0.0.1:49374``, loopback
    only) and it is **password protected** — a bare visit shows a sign-in page,
    not the UI, so opening the base URL in the pane is useless;
  * access is granted by a one-time connect link printed by ``opencode pair``
    (single use, expires in 5 minutes); opening it in a browser plants a
    30-day session cookie and then loads the UI. Pairing needs the shared
    service, so the service must be up first (``opencode service status`` /
    ``opencode service start``).

Mounted at /api/plugins/opencode-launcher/ (dashboard plugin mount, shared by
the Hermes desktop app). Two verbs:

  GET  /status — is the shared OpenCode service up, and on which URL?
  POST /start  — idempotent launcher. NEVER restarts a running service: if it
                 already answers it is left alone (``already_running: True``)
                 and only a fresh connect link is minted. Then it asks the
                 desktop renderer to open THAT link in the preview pane (the
                 same ``preview.open`` gateway event the built-in
                 ``desktop_preview`` tool emits) — the link both signs the pane
                 in and loads the web UI.

The Python half is deliberately the only place with process/network power —
the desktop ``plugin.js`` half is UI-only (the renderer has no exec).
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException

log = logging.getLogger("opencode-launcher")

router = APIRouter()

# --------------------------------------------------------------------------- defaults
# v2's channel default. Only used for reporting when the service is down — the
# live URL always comes from the CLI (`opencode service status`).
DEFAULT_PORT = 49374
PREVIEW_LABEL = "OpenCode Web"

STATUS_TIMEOUT_S = 20.0
PAIR_TIMEOUT_S = 20.0

_URL_RE = re.compile(r"https?://[^\s'\"]+")


def _plugin_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # dashboard/ → plugin root


def _find_binary() -> str | None:
    """opencode CLI — PATH first, then the known install location."""
    exe = shutil.which("opencode")
    if exe:
        return exe
    candidate = os.path.expanduser("~/.opencode/bin/opencode")
    return candidate if os.path.exists(candidate) else None


def _run(args: list[str], timeout: float) -> tuple[int, str]:
    """Run an opencode subcommand; return (returncode, combined output)."""
    exe = _find_binary()
    if not exe:
        raise HTTPException(
            500,
            "opencode binary not found — checked PATH and ~/.opencode/bin/opencode. "
            "Install OpenCode 2 first (curl -fsSL https://opencode.ai/v2/install | bash).",
        )
    try:
        proc = subprocess.run(
            [exe, *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
            cwd=os.path.expanduser("~"),
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(500, f"`opencode {' '.join(args)}` timed out after {timeout:.0f}s")
    except OSError as exc:
        raise HTTPException(500, f"failed to run `opencode {' '.join(args)}`: {exc}")
    return proc.returncode, (proc.stdout or "").strip()


def _service_url() -> str | None:
    """The shared service's URL, or None while it is stopped.

    ``opencode service status`` prints exactly one line: the URL while the
    background server answers, or ``stopped`` when it does not.
    """
    code, out = _run(["service", "status"], STATUS_TIMEOUT_S)
    if code != 0:
        return None
    match = _URL_RE.search(out)
    return match.group(0).rstrip("/") if match else None


def _service_start() -> str | None:
    """Start the shared background service; returns its URL once it answers."""
    code, out = _run(["service", "start"], STATUS_TIMEOUT_S)
    match = _URL_RE.search(out)
    if code == 0 and match:
        return match.group(0).rstrip("/")
    log.warning("opencode service start failed (exit %s): %s", code, out[:400])
    return None


def _pair_link() -> str | None:
    """Mint a one-time connect link (``opencode pair``) for the running service.

    Links are single use and expire in 5 minutes, so a fresh one is minted on
    every launch; the session cookie it plants lasts 30 days inside the pane.
    """
    code, out = _run(["pair"], PAIR_TIMEOUT_S)
    match = _URL_RE.search(out)
    if code == 0 and match:
        return match.group(0)
    log.warning("opencode pair did not yield a link (exit %s): %s", code, out[:400])
    return None


def _port_of(url: str) -> int | None:
    try:
        port = urlparse(url).port
    except ValueError:
        return None
    return port or (443 if url.startswith("https://") else 80)


def _status() -> dict:
    """Current launcher/service state (never raises: the chip polls this)."""
    url = _service_url()
    if not url:
        return {
            "running": False,
            "service": "stopped",
            "url": f"http://127.0.0.1:{DEFAULT_PORT}",
            "port": DEFAULT_PORT,
        }
    return {
        "running": True,
        "service": "running",
        "url": url,
        "port": _port_of(url),
    }


# --------------------------------------------------------------------------- preview pane
def _open_in_preview(url: str, label: str = PREVIEW_LABEL) -> str:
    """Ask the desktop renderer to open ``url`` in the preview pane.

    Returns ``"opened"`` or ``"unavailable"``. Same ``preview.open`` gateway
    event the built-in desktop_preview tool emits; the renderer honors a
    session-less broadcast and opens the pane for the window on screen. Falls
    back to the session-scoped emitter, then to nothing.
    """
    try:
        from tui_gateway.server import _broadcast_global_event  # noqa: PLC2701 — internal, same process

        _broadcast_global_event("preview.open", {"url": url, "label": label})
        return "opened"
    except Exception:  # noqa: BLE001
        pass
    try:
        from tools.desktop_ui import emit

        if emit("preview.open", {"url": url, "label": label}):
            return "opened"
    except Exception:  # noqa: BLE001
        pass
    return "unavailable"


# --------------------------------------------------------------------------- routes
@router.get("/status")
def status_endpoint() -> dict:
    return _status()


@router.post("/start")
def start_endpoint() -> dict:
    """Ensure the OpenCode web UI is reachable, then open it in the preview pane.

    Idempotent: a service that already answers is never restarted — it just
    gets a fresh one-time connect link.
    """
    base = _status()
    started = False
    if not base["running"]:
        url = _service_start()
        if not url:
            raise HTTPException(
                500,
                "the OpenCode background service did not come up — check "
                "`opencode service status` in a terminal.",
            )
        started = True
        base = _status()

    # Sign-in door: v2's web UI is password protected, so open the one-time
    # connect link (it authenticates the pane and then loads the UI).
    pair_url = _pair_link()
    if pair_url:
        target = pair_url
    else:
        target = base["url"]
        base["pair_error"] = (
            "could not mint a connect link (`opencode pair`) — opening the base URL instead; "
            "the pane will show the sign-in page. Run `opencode pair` in a terminal and open "
            "the printed link."
        )

    base.update(
        {
            "started": started,
            "already_running": not started,
            "pair_url": pair_url,
            "open_url": target,
            "preview": _open_in_preview(target, PREVIEW_LABEL),
        }
    )
    return base
