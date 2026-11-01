# session-changes

A **Changes** pane that answers "what did this session change?" without git.

## Why

Hermes' built-in Review pane reads `git status` of the chat's workspace folder.
When that folder is not a repository (a scratch directory, or a folder that only
*contains* repos) or when the edited file lives somewhere else entirely, the
query correctly returns nothing — and the pane says **No diffs**, which reads
like a bug. The edits are not unknown, though: the tools that made them returned
their unified diffs, and every one of those results is part of the session
transcript.

## How it works

- **Source: two doors, widest first.** The primary is the Electron REST route
  `GET /api/sessions/<stored id>/messages?limit=500&order=oldest&include_compacted=true`
  (paged) — the very rows the transcript is paged from. The fallback is the
  gateway's `host.request('session.history', { session_id })` with the live
  **runtime** id (a stored id there is rejected with 4001).
  Why REST first: the gateway serves the *active* conversation, so once a
  session has been compacted, the tool rows behind the summary are gone from it
  (measured on a live session: 147 of 271 tool rows survived) and the older
  edits would silently vanish from the list.
- Tool rows for `patch` / `write_file` / `edit_file` ship their raw result, which
  carries the diff (`diff` / `inline_diff`) and the resolved path. The plugin
  folds them into one row per file, concatenates every edit's diff in call order,
  and counts `+` / `−` lines exactly like the transcript's own diff rows.
- `tool.complete` refreshes the list automatically; the ↻ button refreshes by
  hand.
- **Diff** shows the changes, never wrapped (a long line scrolls sideways).
  **Content** shows the file as it is now, **colored by the app's own markdown /
  shiki pipeline** (`MessageTextContent` from the plugin SDK) so it looks exactly
  like a code fence in the chat; the app's code block caps its own scroller at
  ~120px because it is built to live inside a scrolling transcript, and this
  plugin lifts that cap inside its pane. Files with an unknown language, or
  larger than 256 KB, fall back to a plain line-numbered view (768 KB / 4000
  lines).
- **Text in both tabs is selectable.** Pane chrome is `user-select: none` in the
  app and that value *inherits*, so both bodies opt back in through one scoped
  `<style>` rule (`[data-slot='sc-content'], … * { user-select: text !important }`).
  The diff's line-number gutter keeps `select-none` (a `:not(.select-none)`
  guard), so copying a selection never drags line numbers along.
- **Open in the editor** (the `go-to-file` button) calls the backend route of the
  separate `file-opener` plugin — `POST /api/plugins/file-opener/open` — which
  spawns `kate <file>` (then `xdg-open`), because a renderer plugin cannot spawn
  a process and Electron's own `file:` route *reveals in the file manager* on
  purpose (the Windows download-loop fix). Until that backend has been restarted
  once, the route is absent and the button says so instead of failing silently.
  Copy and reveal-in-file-manager sit beside it.

## When the pane is on screen

- The pane is **hidden by default in every chat** and shows up only when asked for:

- **Three doors in, one door out.** In:
  (a) a file row in the transcript's "N files changed" card,
  (b) **⌘K → "Changes: this session's file edits"**,
  (c) the **status-bar chip** — a plugin statusbar item
  (`area: STATUSBAR_AREAS.right`) that reads `<n> files (+a −b)` and opens the
  pane on click; its dot goes accent-colored while the pane is on screen. It
  renders **nothing** in a chat with no edits, so it never advertises an empty
  pane. Out: a **close icon in the pane's own toolbar** — `hidePane()` clears
  `openedFor` and disposes the registration, which is safe (a *programmatic*
  dispose does not disable the plugin, unlike the tab menu's Close, which is
  Hermes' single-pane rule).
- Registration *is* the show (`ctx.register` for a pane area returns a disposer),
  and `openedFor` remembers which chat was asked for, so switching to another
  chat disposes it again; coming back does not re-open it by itself.
- A chat with no edits unregisters it too, so there is never an empty column.
- Closing the pane from its tab menu disables the plugin (Hermes' rule, so
  Capabilities → Plugins is always the way back). Re-enable it there.

## Clicking a file in the transcript

The transcript's "N files changed" card sends a row click to the core Review
pane (a *git* reading). This plugin intercepts that click in the **capture**
phase — so React's root handler never sees it, the Review pane never opens — and
instead fronts its own pane with that file selected. The card's row carries only
the file's **basename**, and this plugin's list is folded from the same
transcript, so basenames line up. The card's separate "Review changes" action is
left alone: it is a git-scoped request and keeps its meaning.

## Install / use

- The pane half is a disk plugin at
  `~/.hermes/desktop-plugins/session-changes/plugin.js` (folder name must equal
  the plugin id). It loads live — no restart, no rebuild — and every save
  hot-reloads it.
- The editor half is the backend plugin `~/.hermes/plugins/file-opener/`
  (`plugin.yaml` + `dashboard/plugin_api.py`, id listed in `plugins.enabled`).
  Plugin API routes mount when the desktop's own `hermes serve` boots, so this
  one needs **one app restart** after being enabled — the pane half does not.

## Limits

- The REST door needs the stored session id (a brand-new chat has none until it
  is persisted) and a desktop window; the gateway fallback covers the rest, at
  the cost of the compaction caveat above.
- Transcript rows for a chat whose turns ran on another profile's backend (a bot
  tile) may be unavailable; the pane says so rather than showing an empty list.
- Diffs come from the transcript, so they cover edits made by tools in this
  session — changes made outside it (another process, by hand) are not part of
  the story; the Content tab is what shows the current file.
- The editor route opens the file in Kate (falling back to the OS default
  handler) — it does not jump to a line yet, though the route accepts `line`.
- One log line per load: `[session-changes] ready (rest|gateway): N file(s), …`
  (or the failure) in `~/.hermes/logs/desktop.log` — the breadcrumb that proves
  the history door, the fold and the pane registration on the running build.
