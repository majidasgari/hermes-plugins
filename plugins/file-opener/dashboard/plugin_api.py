"""file-opener — a backend route that opens a local file in the desktop editor.

WHY THIS EXISTS: a renderer plugin cannot spawn a process (its imports are
limited to `@hermes/plugin-sdk` and react), and the Electron bridge has no
"open a path with its association" door — its `file:` route deliberately
*reveals* the file in the file manager instead of handing it to the OS shell
(the Windows archive download-loop fix, apps/desktop/electron/main.ts). So the
only door left for "open this file in Kate" is a plugin backend route, which
runs inside the desktop's own `hermes serve` process — on the same machine as
the files, in the user's session.

Route: POST /api/plugins/file-opener/open  {path, line?}
Answers which rung of the ladder took the file; never throws.
"""

from __future__ import annotations

import os
import shutil
import subprocess

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

# Ordered ladder: the preferered editor first, then the OS default handler for
# the file's MIME type (xdg-open → the user's own association).
EDITOR_CANDIDATES = ("kate",)


class OpenBody(BaseModel):
    line: int | None = None
    path: str


def _child_env() -> dict:
    """The app spawns this process, so it usually carries the session's display.
    Fall back to the only display a desktop session has when it does not (a
    systemd-started backend), or the editor dies with "cannot connect to
    display" and nothing is visible to the user."""
    env = os.environ.copy()
    env.setdefault("DISPLAY", ":0")
    env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    return env


def _spawn(argv: list[str], cwd: str) -> bool:
    try:
        subprocess.Popen(  # noqa: S603 - fixed binaries from `which`, no shell
            argv,
            cwd=cwd,
            env=_child_env(),
            stdin=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        return False

    return True


@router.post("/open")
def open_in_editor(body: OpenBody) -> dict:
    raw = (body.path or "").strip()

    if not raw:
        return {"opened": False, "reason": "no_path"}

    path = os.path.abspath(os.path.expanduser(raw))

    if not os.path.exists(path):
        return {"opened": False, "path": path, "reason": "missing"}

    cwd = path if os.path.isdir(path) else (os.path.dirname(path) or "/")
    line = body.line if isinstance(body.line, int) and body.line > 0 else None

    for name in EDITOR_CANDIDATES:
        exe = shutil.which(name)

        if exe and _spawn([exe, *(["-l", str(line)] if line else []), path], cwd):
            return {"editor": name, "line": line, "opened": True, "path": path}

    xdg_open = shutil.which("xdg-open")

    if xdg_open and _spawn([xdg_open, path], cwd):
        return {"editor": "xdg-open", "opened": True, "path": path}

    return {"opened": False, "path": path, "reason": "no_editor"}
