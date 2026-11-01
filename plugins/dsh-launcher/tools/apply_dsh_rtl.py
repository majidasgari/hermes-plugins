#!/usr/bin/env python3
"""Install / verify / remove the «فارسی‌ساز» RTL+font pass in the dsh web UI.

Max's Firefox add-on (`فارسی‌ساز — وزیرمتن و راست‌چین`) fixes RTL/LTR and the
font on ordinary web pages. This script gives the DeepSeek Harness browser UI
the same treatment by installing that pass into the frontend dist `dsh web`
serves:

    <dsh-web-frontend>/dist/
    ├── index.html            ← two tags injected between the dsh-rtl markers
    └── dsh-rtl/
        ├── farsi-web.js      ← copy of ../rtl/farsi-web.js  (the canonical source)
        ├── farsi-web.css     ← copy of ../rtl/farsi-web.css
        └── vazirmatn.woff2   ← copy of ../rtl/vazirmatn.woff2

The canonical files live in this plugin (`rtl/`), so re-applying after a dsh
upgrade is one command. `npm i -g @deepseek-ai/dsh` REPLACES the package (and so
the dist) — re-run this script afterwards; `--check` reports drift.

Usage:
    python3 apply_dsh_rtl.py            # install / refresh (idempotent)
    python3 apply_dsh_rtl.py --check    # verify only; exit 1 when not applied
    python3 apply_dsh_rtl.py --remove   # take it back out
    python3 apply_dsh_rtl.py --dist /path/to/dist
"""

from __future__ import annotations

import argparse
import filecmp
import glob
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_ROOT = os.path.dirname(HERE)
SRC_DIR = os.path.join(PLUGIN_ROOT, "rtl")

ASSETS = ("farsi-web.js", "farsi-web.css", "vazirmatn.woff2")
ASSET_DIR = "dsh-rtl"
START = "<!-- dsh-rtl:start -->"
END = "<!-- dsh-rtl:end -->"

INDEX_SNIPPET = f"""  {START}
    <!-- فارسی‌ساز (RTL + وزیرمتن) — installed by ~/.hermes/plugins/dsh-launcher/tools/apply_dsh_rtl.py -->
    <link rel="stylesheet" href="./{ASSET_DIR}/farsi-web.css" />
    <script defer src="./{ASSET_DIR}/farsi-web.js"></script>
    {END}
"""

# Fallback roots when the package cannot be located through the `dsh` binary
# (an upgrade can move the global node_modules root — npm, pnpm store, /usr).
SEARCH_ROOTS = (
    "~/.local/lib/node_modules/@deepseek-ai/dsh",
    "~/.local/share/pnpm/global/*/node_modules/@deepseek-ai/dsh",
    "~/.npm-global/lib/node_modules/@deepseek-ai/dsh",
    "/usr/lib/node_modules/@deepseek-ai/dsh",
    "/usr/local/lib/node_modules/@deepseek-ai/dsh",
)


def _package_root_from_binary() -> list[str]:
    """Walk up from the `dsh` executable to the package.json named @deepseek-ai/dsh."""
    exe = shutil.which("dsh")
    if not exe:
        return []
    directory = os.path.dirname(os.path.realpath(exe))
    for _ in range(6):
        manifest = os.path.join(directory, "package.json")
        if os.path.isfile(manifest):
            try:
                with open(manifest, encoding="utf-8") as handle:
                    if json.load(handle).get("name") == "@deepseek-ai/dsh":
                        return [directory]
            except (OSError, ValueError):
                pass
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent
    return []


def candidate_dists() -> list[str]:
    """Every plausible `dsh-web-frontend/dist` on this machine, best first.

    Best first = one that already carries our patch (so a refresh lands where the
    running harness actually serves from), then any other.
    """
    roots = _package_root_from_binary()
    for pattern in SEARCH_ROOTS:
        roots += glob.glob(os.path.expanduser(pattern))

    found: list[str] = []
    for root in roots:
        for hit in [
            os.path.join(root, "node_modules/@deepseek-ai/dsh-web-frontend/dist"),
            *glob.glob(os.path.join(root, "**/dsh-web-frontend/dist"), recursive=True),
        ]:
            if hit not in found and os.path.isfile(os.path.join(hit, "index.html")):
                found.append(hit)

    def rank(dist: str) -> int:
        try:
            with open(os.path.join(dist, "index.html"), encoding="utf-8") as handle:
                if START in handle.read():
                    return 0
        except OSError:
            pass
        return 1 if os.path.isdir(os.path.join(dist, ASSET_DIR)) else 2

    return sorted(found, key=rank)


def find_dist(explicit: str | None) -> str:
    if explicit:
        return os.path.abspath(os.path.expanduser(explicit))
    candidates = candidate_dists()
    if candidates:
        return candidates[0]
    raise SystemExit(
        "dsh-web-frontend/dist not found — pass --dist /path/to/dist "
        "(the directory holding index.html that `dsh web` serves)"
    )


def read(path: str) -> str:
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def write(path: str, text: str) -> None:
    """Temp file + os.replace: never truncate the served file before encoding."""
    tmp = path + ".dsh-rtl.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.replace(tmp, path)


def installed(index_html: str) -> bool:
    return START in index_html and END in index_html


def strip_block(index_html: str) -> str:
    start = index_html.find(START)
    end = index_html.find(END)
    if start == -1 or end == -1:
        return index_html
    # Take the whole commented line too (from the line start to the line end).
    head = index_html.rfind("\n", 0, start)
    head = 0 if head == -1 else head + 1
    tail = index_html.find("\n", end)
    tail = len(index_html) if tail == -1 else tail + 1
    return index_html[:head] + index_html[tail:]


def install_assets(dist: str) -> list[str]:
    target = os.path.join(dist, ASSET_DIR)
    os.makedirs(target, exist_ok=True)
    copied = []
    for name in ASSETS:
        src = os.path.join(SRC_DIR, name)
        if not os.path.isfile(src):
            raise SystemExit(f"missing canonical asset: {src}")
        dst = os.path.join(target, name)
        if not (os.path.isfile(dst) and filecmp.cmp(src, dst, shallow=False)):
            shutil.copyfile(src, dst)
            copied.append(name)
    return copied


def diff_assets(dist: str) -> list[str]:
    target = os.path.join(dist, ASSET_DIR)
    return [
        name
        for name in ASSETS
        if not (os.path.isfile(os.path.join(target, name)) and filecmp.cmp(os.path.join(SRC_DIR, name), os.path.join(target, name), shallow=False))
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="verify only (exit 1 when not applied)")
    parser.add_argument("--remove", action="store_true", help="remove the injected block and assets")
    parser.add_argument("--dist", default=None, help="override the frontend dist directory")
    args = parser.parse_args()

    dist = find_dist(args.dist)
    index = os.path.join(dist, "index.html")
    html = read(index)
    stale = diff_assets(dist)

    if args.check:
        ok = installed(html) and not stale
        print(f"dist:       {dist}")
        print(f"installed:  {installed(html)}")
        print(f"assets:     {ASSETS}")
        print(f"drift:      {stale or 'none'}")
        print("OK" if ok else "NOT APPLIED (or stale) — run apply_dsh_rtl.py")
        return 0 if ok else 1

    if args.remove:
        backup = index + ".bak-dsh-rtl"
        if installed(html):
            write(index, strip_block(html))
        shutil.rmtree(os.path.join(dist, ASSET_DIR), ignore_errors=True)
        print(f"removed from {index}")
        if os.path.isfile(backup):
            print(f"pristine backup still at {backup}")
        return 0

    backup = index + ".bak-dsh-rtl"
    if not os.path.isfile(backup):
        shutil.copyfile(index, backup)
        print(f"backup:     {backup}")

    copied = install_assets(dist)

    if installed(html):
        # Refresh in place: replace whatever sits between the markers.
        start = html.find(START)
        end = html.find(END) + len(END)
        head = html.rfind("\n", 0, start)
        head = 0 if head == -1 else head + 1
        new_html = html[:head] + INDEX_SNIPPET.rstrip("\n") + html[end:]
    else:
        if "</head>" not in html:
            raise SystemExit("index.html has no </head> — refusing to guess where to inject")
        new_html = html.replace("</head>", INDEX_SNIPPET + "  </head>", 1)

    if new_html != html:
        write(index, new_html)

    print(f"dist:       {dist}")
    print(f"assets:     {'copied ' + ', '.join(copied) if copied else 'already current'}")
    print(f"index.html: {'refreshed' if installed(html) else 'patched'}")
    print("Reload the dsh web page (preview pane) to see it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
