"""DeepSeek Harness launcher backend — make `dsh web` exist, then show it.

Mounted at /api/plugins/dsh-launcher/ (dashboard plugin mount, shared by the
Hermes desktop app). Verbs:

  GET  /status — is a dsh web server answering, and is it one we can show?
  POST /start  — idempotent launcher. NEVER restarts a running server. If our
                 own instance is still up it re-opens the saved URL; otherwise
                 it spawns ``dsh web --no-open`` detached (own session), waits
                 for the startup line, and asks the desktop renderer to open it
                 in the preview pane via the same ``preview.open`` gateway
                 event the built-in desktop_preview tool emits.
  POST /takeover — the ONLY destructive verb: stop a `dsh web` another terminal
                 owns (so ours can bind the standard port) and then /start.
                 Never called unless the user asked for it.

WHY THE TOKEN MATTERS
---------------------
`dsh web` fences its UI: every request needs a cookie signed by the secret in
~/.dsh/.credentials.yaml, and the only way to mint that cookie is the one-time
``/?token=<launch-token>`` URL printed at startup. The launch token lives in the
process memory of whoever started the server — so a server started in the user's
own terminal cannot be adopted by the preview pane (its token never left that
terminal's scrollback). That is why this plugin OWNS its instance: it spawns
`dsh web` with stdout captured to its own log, reads the tokenized URL from that
log, and hands that URL to the preview pane (which exchanges it for the cookie
and persists it).

Port policy (FIXED, Max's rule): the UI always lives on ``DEFAULT_PORT`` — 3080.
Never an OS-picked port. When something else holds 3080 and it is a `dsh web`
(usually one started in the user's own terminal, which can never be adopted
because its launch token stays in that terminal), that process is stopped so
this plugin can bind the fixed port; a non-dsh holder is reported instead of
killed. An instance of ours caught on another port is moved onto the fixed one.
``POST /start`` accepts ``{"port": N}`` to use a different fixed port for that
call.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time

from fastapi import APIRouter, HTTPException

log = logging.getLogger("dsh-launcher")

router = APIRouter()

# --------------------------------------------------------------------------- defaults
DEFAULT_PORT = 3080
PROBE_HOST = "127.0.0.1"  # dsh binds loopback; --host 0.0.0.0 is refused by design
PREVIEW_LABEL = "DeepSeek Harness"
SUBPROFILE = "web"

START_TIMEOUT_S = 40.0  # dsh boots a cordis plugin tree; slower than opencode
PROBE_TIMEOUT_S = 1.0
POLL_STEP_S = 0.4


def _plugin_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # dashboard/ → plugin root


def _log_path() -> str:
    return os.path.join(_plugin_root(), "serve.log")


def _state_path() -> str:
    return os.path.join(_plugin_root(), "state.json")


def _find_binary() -> str | None:
    """dsh CLI — PATH first, then the known install location."""
    exe = shutil.which("dsh")
    if exe:
        return exe
    candidate = os.path.expanduser("~/.local/bin/dsh")
    return candidate if os.path.exists(candidate) else None


# --------------------------------------------------------------------------- probes
def _port_open(port: int, host: str = PROBE_HOST, timeout: float = PROBE_TIMEOUT_S) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _http_status(url: str, timeout: float = PROBE_TIMEOUT_S) -> int | None:
    """Raw HTTP GET (no redirects, no proxy env) → status code or None.

    ``urllib`` would honour proxy environment variables and follow the 303 the
    token exchange sends, so it cannot tell us which of the two we got.
    """
    match = re.match(r"http://([^/:]+):(\d+)(/.*)?$", url)
    if not match:
        return None
    host, port, path = match.group(1), int(match.group(2)), match.group(3) or "/"
    try:
        with socket.create_connection((host, port), timeout=timeout) as sock:
            sock.settimeout(timeout)
            request = (
                f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\n"
                "Connection: close\r\n\r\n"
            ).encode()
            sock.sendall(request)
            data = b""
            while b"\r\n" not in data and len(data) < 4096:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                data += chunk
    except OSError:
        return None
    head = data.split(b"\r\n", 1)[0].decode("latin-1", "replace")
    parts = head.split()
    return int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else None


def _tail(path: str, nbytes: int = 800) -> str:
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - nbytes))
            return handle.read().decode("utf-8", "replace")
    except OSError:
        return ""


# --------------------------------------------------------------------------- own-instance state
def _read_state() -> dict:
    try:
        with open(_state_path()) as handle:
            state = json.load(handle)
        return state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_state(state: dict) -> None:
    """Atomic write — a torn state file would look like 'nothing running'."""
    tmp = _state_path() + ".tmp"
    try:
        with open(tmp, "w") as handle:
            json.dump(state, handle, indent=2)
        os.replace(tmp, _state_path())
    except OSError as exc:  # nonfatal: the probe path still works, /start just respawns
        log.warning("dsh-launcher: cannot persist state: %s", exc)


def _owned_and_live(state: dict) -> bool:
    """Our instance is usable only if its port still answers AND its saved
    tokenized URL still authenticates (303 = the token exchange, not the 401)."""
    port = state.get("port")
    url = state.get("url")
    if not isinstance(port, int) or not isinstance(url, str):
        return False
    if not _port_open(port):
        return False
    return _http_status(url) == 303


def _foreign_dsh_pids() -> list[int]:
    """PIDs of `dsh … web …` node processes we did not start (same user only).

    argv-shape match, not a substring search on the whole command line: argv[1]
    must be a `dsh` launcher and `web` must be one of its own arguments.
    """
    mine = _read_state().get("pid")
    pids: list[int] = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid == mine:
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as handle:
                argv = handle.read().split(b"\0")
        except OSError:
            continue
        argv = [part.decode("utf-8", "replace") for part in argv if part]
        if len(argv) < 3 or not argv[1].endswith("dsh"):
            continue
        if SUBPROFILE in argv[2:]:
            pids.append(pid)
    return pids


def _status() -> dict:
    state = _read_state()
    if _owned_and_live(state):
        return {
            "port": state["port"],
            "url": state["url"],
            "running": True,
            "owned": True,
            "authenticated": True,
            "pid": state.get("pid"),
            "started_at": state.get("started_at"),
            "log_file": _log_path(),
            "foreign_pids": [],
            "port_policy": "fixed",
            "fixed_port": DEFAULT_PORT,
            "on_fixed_port": state.get("port") == DEFAULT_PORT,
        }

    # 401 is dsh's auth fence: the port is served by a dsh web we cannot
    # authenticate into (started elsewhere) — a real but unusable instance.
    foreign = _port_open(DEFAULT_PORT) and _http_status(f"http://{PROBE_HOST}:{DEFAULT_PORT}/") == 401
    return {
        "port": DEFAULT_PORT,
        "url": f"http://{PROBE_HOST}:{DEFAULT_PORT}",
        "running": foreign,
        "owned": False,
        "authenticated": False,
        "pid": None,
        "started_at": None,
        "log_file": _log_path(),
        "foreign_pids": _foreign_dsh_pids(),
        "blocked_by_foreign": foreign,
        "port_policy": "fixed",
        "fixed_port": DEFAULT_PORT,
        "on_fixed_port": False,
    }


# --------------------------------------------------------------------------- spawn
def _url_from_log(log_path: str, start_pos: int) -> str | None:
    """The tokenized URL from a `dsh web: <url>` line appended after start_pos."""
    try:
        with open(log_path, "rb") as handle:
            handle.seek(start_pos)
            appended = handle.read()
    except OSError:
        return None
    match = re.search(rb"dsh web:\s*(http://[^\s]+)", appended)
    return match.group(1).decode("utf-8", "replace") if match else None


def _spawn(port: int) -> dict:
    """Start `dsh web --no-open` detached and wait for its tokenized URL."""
    exe = _find_binary()
    if not exe:
        raise HTTPException(
            500,
            "dsh binary not found — checked PATH and ~/.local/bin/dsh.",
        )

    log_path = _log_path()
    args = [exe, SUBPROFILE, "--no-open"]
    if port != DEFAULT_PORT:
        # An explicit fixed port only — never `--port 0`: the UI's address must be
        # stable, so a busy port is freed by _free_port() before we get here.
        args += ["--port", str(port)]

    try:
        log_file = open(log_path, "ab")  # noqa: SIM115 — the child holds the fd
        start_pos = log_file.tell()
    except OSError as exc:
        raise HTTPException(500, f"cannot open log file {log_path}: {exc}") from exc

    try:
        proc = subprocess.Popen(
            args,
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,  # own process group → survives this request
            cwd=os.path.expanduser("~"),
        )
    except OSError as exc:
        log_file.close()
        raise HTTPException(500, f"failed to start dsh web: {exc}") from exc
    finally:
        log_file.close()

    url = None
    deadline = time.time() + START_TIMEOUT_S
    while time.time() < deadline:
        url = _url_from_log(log_path, start_pos)
        if url and _http_status(url) == 303:  # token exchange answered
            break
        if proc.poll() is not None:  # died (port race, bad profile, …)
            break
        url = None
        time.sleep(POLL_STEP_S)

    if not url:
        tail = _tail(log_path, 1200).strip()
        raise HTTPException(
            500,
            "dsh web did not come up. Log tail:\n" + (tail or "(empty log)"),
        )

    parsed = re.match(r"http://[^/:]+:(\d+)", url)
    state = {
        "pid": proc.pid,
        "port": int(parsed.group(1)) if parsed else port,
        "url": url,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    _write_state(state)
    return state


# --------------------------------------------------------------------------- port policy
def _port_holder(port: int) -> str:
    """Best-effort description of whatever listens on ``port`` (for error text)."""
    try:
        proc = subprocess.run(["ss", "-tlnp"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    for line in proc.stdout.splitlines():
        if f":{port} " not in line:
            continue
        match = re.search(r"pid=(\d+)", line)
        if not match:
            return "unknown"
        pid = match.group(1)
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as handle:
                argv = " ".join(part.decode("utf-8", "replace") for part in handle.read().split(b"\0") if part)
        except OSError:
            return f"pid {pid}"
        return f"pid {pid} ({argv.strip()})"
    return "unknown"


def _wait_port_free(port: int, timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not _port_open(port):
            return True
        time.sleep(POLL_STEP_S)
    return not _port_open(port)


def _free_port(port: int) -> list[int]:
    """Make ``port`` bindable, stopping only *dsh* holders. Returns those pids.

    The UI must always answer on the same address, so a `dsh web` started
    elsewhere (his own terminal, typically) is stopped rather than worked around
    with an OS-picked port. A holder that is NOT a dsh is left running and
    reported — killing unknown programs is not this plugin's business.
    """
    if not _port_open(port):
        return []

    foreign = _foreign_dsh_pids()
    if not foreign:
        raise HTTPException(
            409,
            f"port {port} is busy and no `dsh web` process owns it — holder: {_port_holder(port)}. "
            'Free the port, or call /start with {"port": N} for another fixed port.',
        )

    for pid in foreign:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError as exc:
            log.warning("dsh-launcher: cannot stop pid %s: %s", pid, exc)

    if not _wait_port_free(port, 12.0):
        for pid in foreign:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        if not _wait_port_free(port, 6.0):
            raise HTTPException(409, f"port {port} is still held after SIGTERM/SIGKILL of {foreign}")
        log.warning("dsh-launcher: port %s needed SIGKILL for %s", port, foreign)

    log.warning("dsh-launcher: freed port %s by stopping dsh pid(s) %s", port, foreign)
    return foreign


def _stop_own(state: dict) -> bool:
    """Stop OUR instance — only to move it onto the fixed port.

    We spawn with ``start_new_session=True``, so our pid is its own process-group
    leader; the pgid==pid guard keeps a recycled pid from ever signalling the
    asking process's own group.
    """
    pid = state.get("pid")
    if not isinstance(pid, int):
        return False
    try:
        pgid = os.getpgid(pid)
        if pgid == pid:
            os.killpg(pgid, signal.SIGTERM)
        else:
            os.kill(pid, signal.SIGTERM)
        return True
    except OSError as exc:
        log.warning("dsh-launcher: cannot stop our pid %s: %s", pid, exc)
        return False


# --------------------------------------------------------------------------- preview pane
def _open_in_preview(url: str, label: str = PREVIEW_LABEL) -> str:
    """Ask the desktop renderer to open ``url`` in the preview pane.

    Same ``preview.open`` gateway event the built-in desktop_preview tool emits;
    the renderer honours a session-less broadcast for the window on screen.
    """
    try:
        from tui_gateway.server import _broadcast_global_event  # noqa: PLC2701

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


# --------------------------------------------------------------------------- rtl pass
RTL_TOOL = os.path.join(_plugin_root(), "tools", "apply_dsh_rtl.py")


def _ensure_rtl_patch() -> str:
    """Keep the «فارسی‌ساز» RTL + Vazirmatn pass installed in the served dist.

    `npm i -g @deepseek-ai/dsh` — or any pnpm update — replaces the whole package,
    dist included, so the Persian pass silently disappears and the UI goes back to
    left-aligned English typography with no error anywhere. Checking here repairs
    it at the moment of use, i.e. before the pane loads the page. Best effort by
    design: a failure must never block the launcher.
    """
    if not os.path.isfile(RTL_TOOL):
        return "tool_missing"

    def _run(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, RTL_TOOL, *args],
            capture_output=True,
            text=True,
            timeout=150,
        )

    try:
        if _run("--check").returncode == 0:
            return "ok"
        _run()
        if _run("--check").returncode == 0:
            log.warning("dsh-launcher: re-installed the RTL pass (was missing or stale)")
            return "reinstalled"
        log.warning("dsh-launcher: RTL pass still not installed after a repair attempt")
        return "failed"
    except (OSError, subprocess.SubprocessError) as exc:  # noqa: BLE001
        log.warning("dsh-launcher: RTL pass check failed: %s", exc)
        return "failed"


# --------------------------------------------------------------------------- routes
@router.get("/status")
def status_endpoint() -> dict:
    return _status()


@router.post("/start")
def start_endpoint(payload: dict | None = None) -> dict:
    """Ensure the harness web UI is up on the FIXED port, then open it.

    Port policy (Max's rule): always ``DEFAULT_PORT`` (3080), never an OS-picked
    port. A `dsh web` holding the port from another terminal is stopped — it
    cannot be adopted anyway (its launch token never left that terminal) — and an
    instance of ours found on some other port is moved onto the fixed one.
    Idempotent otherwise: a live instance of ours already on the fixed port is
    reused untouched. ``{"port": N}`` selects a different fixed port for one call.
    """
    requested = DEFAULT_PORT
    if payload and payload.get("port") is not None:
        try:
            requested = int(payload["port"])
        except (TypeError, ValueError):
            raise HTTPException(400, "port must be an integer")

    state = _read_state()
    stopped: list[int] = []
    moved_from: int | None = None

    if _owned_and_live(state) and state.get("port") == requested:
        result = {
            "port": state["port"],
            "url": state["url"],
            "running": True,
            "owned": True,
            "authenticated": True,
            "started": False,
            "already_running": True,
            "pid": state.get("pid"),
        }
    else:
        if _owned_and_live(state):
            # Ours, but on the wrong port (a stale pick from the old policy):
            # move it onto the fixed port, which needs a fresh launch token.
            moved_from = state["port"]
            _stop_own(state)
            _wait_port_free(moved_from, 12.0)
            _write_state({})

        stopped = _free_port(requested)
        state = _spawn(requested)
        result = {
            "port": state["port"],
            "url": state["url"],
            "running": True,
            "owned": True,
            "authenticated": True,
            "started": True,
            "already_running": False,
            "pid": state["pid"],
        }

    result["port_policy"] = "fixed"
    if stopped:
        result["stopped_foreign_pids"] = stopped
    if moved_from is not None:
        result["moved_from_port"] = moved_from

    # The pane is about to load the UI — make sure the Persian pass is in the dist
    # first (a harness upgrade wipes it silently).
    result["rtl_pass"] = _ensure_rtl_patch()
    result["preview"] = _open_in_preview(result["url"], PREVIEW_LABEL)
    if payload and payload.get("takeover"):
        result["note"] = "takeover was requested but our instance was already usable"
    return result


@router.post("/takeover")
def takeover_endpoint(payload: dict | None = None) -> dict:
    """Stop a `dsh web` owned by another terminal so ours can bind port 3080.

    Destructive and never automatic: only the user's explicit request reaches
    this route. SIGTERM to the foreign pid(s), wait for the port, then /start.
    """
    if _owned_and_live(_read_state()):
        return {**start_endpoint(None), "stopped": []}

    stopped: list[int] = []
    for pid in _foreign_dsh_pids():
        try:
            os.kill(pid, signal.SIGTERM)
            stopped.append(pid)
        except OSError as exc:
            log.warning("dsh-launcher: cannot stop pid %s: %s", pid, exc)

    deadline = time.time() + 15.0
    while time.time() < deadline and _port_open(DEFAULT_PORT):
        time.sleep(POLL_STEP_S)

    if _port_open(DEFAULT_PORT):
        raise HTTPException(409, f"port {DEFAULT_PORT} is still held after SIGTERM")

    result = start_endpoint(None)
    result["stopped"] = stopped
    return result
