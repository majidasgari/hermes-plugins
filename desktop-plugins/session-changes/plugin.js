/**
 * session-changes — "what did this session change?", with no git involved.
 *
 * WHY THIS EXISTS: the app's Review pane reads `git status` of the chat's
 * workspace folder. In a folder that is not a repository (a scratch dir, a
 * container that only holds repos) or for a file edited somewhere else, that
 * query legitimately returns nothing — and the pane says "No diffs", which reads
 * like a bug. The changes ARE known though: the tools that made them returned
 * their unified diffs, and those results are part of the session transcript.
 *
 * So this plugin folds the transcript itself:
 *   - source: the SAME rows the transcript is paged from — the Electron REST
 *     route `/api/sessions/<stored id>/messages` (paged, compacted rows
 *     included) — with the gateway's `session.history` (live runtime id) as the
 *     fallback when that door is absent. Preferring REST matters: the gateway's
 *     history is the ACTIVE conversation, so a compaction silently drops the
 *     tool rows behind it and the older edits would vanish from the list. Tool
 *     rows for the file editors ship their raw result, which carries the diff
 *     (`patch`) or the written byte count + resolved path (`write_file`).
 *   - fold: one row per file, diffs concatenated in call order, ± line counts
 *     counted exactly like the transcript's own diff rows.
 *   - UI: a right-rail pane ("Changes") with the file list, the diff per file,
 *     and the file's current content on demand (read through the Electron
 *     bridge's local file read; hidden when unavailable). Content is colored by
 *     the app's own markdown/shiki pipeline (`MessageTextContent`), so a file
 *     looks exactly like a code fence in the chat.
 *   - presence: the pane is registered ONLY while the focused session has file
 *     edits — with nothing changed there is no column to look at.
 *
 * Nothing here touches app source: it is a disk plugin, loaded uncompiled and
 * hot-reloaded on save. Refresh is automatic — `tool.complete` re-reads the
 * transcript — plus a manual refresh button.
 *
 * Install: ~/.hermes/desktop-plugins/session-changes/plugin.js (folder name ==
 * plugin id). Reach it from ⌘K → "Changes: this session's file edits".
 */

import {
  Button,
  Codicon,
  EmptyState,
  ErrorState,
  MessageTextContent,
  PALETTE_AREA,
  PANES_AREA,
  STATUSBAR_AREAS,
  host,
  useValue
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'session-changes'
const PANE_KEY = `${ID}:changes`

// ---8<--- pure logic — no imports, safe to unit-test in isolation -----------

/** The tools whose results are the file edits of a turn (mirrors core). */
const EDIT_TOOLS = new Set(['edit_file', 'patch', 'write_file'])

/** Files whose content view is laid out LTR (code, configs, markup, data). */
const CODE_EXTENSIONS = new Set([
  '.bash', '.c', '.cpp', '.css', '.csv', '.go', '.h', '.hpp', '.html', '.ini', '.java', '.js', '.json',
  '.jsx', '.kt', '.kts', '.log', '.mjs', '.php', '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.svg',
  '.swift', '.toml', '.ts', '.tsx', '.xml', '.yaml', '.yml', '.zsh'
])

function parseMaybeJson(value) {
  if (value && typeof value === 'object') {
    return value
  }

  if (typeof value !== 'string') {
    return null
  }

  try {
    const parsed = JSON.parse(value)

    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function firstString(record, keys) {
  if (!record || typeof record !== 'object') {
    return ''
  }

  for (const key of keys) {
    const value = record[key]

    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return ''
}

/** ANSI escapes and the CLI's "┊ review diff" banner never belong in the pane. */
function cleanDiff(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return ''
  }

  return value.replace(/\u001b\[[0-9;]*m/g, '').replace(/^\s*┊\s*review diff\s*\n/i, '').trim()
}

function diffFromResult(result) {
  for (const key of ['inline_diff', 'diff']) {
    const cleaned = cleanDiff(result?.[key])

    if (cleaned) {
      return cleaned
    }
  }

  return ''
}

/** ± line counts — the transcript's own rule (ignore the ---/+++ file headers). */
function countDiffLines(diff) {
  let added = 0
  let removed = 0

  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added += 1
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed += 1
    }
  }

  return { added, removed }
}

function pathFromEdit(args, result) {
  const fromArgs = firstString(args, ['path', 'file', 'filepath', 'file_path'])

  if (fromArgs) {
    return fromArgs
  }

  const fromResult = firstString(result, ['path', 'file', 'filepath', 'file_path', 'resolved_path'])

  if (fromResult) {
    return fromResult
  }

  const modified = result?.files_modified

  if (Array.isArray(modified) && typeof modified[0] === 'string' && modified[0].trim()) {
    return modified[0].trim()
  }

  return ''
}

function basename(path) {
  const normalized = String(path || '').replace(/\\/g, '/').trim()

  return normalized.split('/').filter(Boolean).pop() || normalized
}

function extensionOf(path) {
  const name = basename(path).toLowerCase()
  const dot = name.lastIndexOf('.')

  return dot > 0 ? name.slice(dot) : ''
}

/** Content layout: code is LTR, prose (markdown, txt, …) auto-detects per line. */
function isCodePath(path) {
  return CODE_EXTENSIONS.has(extensionOf(path))
}

/** One parsed edit, or null when the row isn't a landed file edit. */
function editFromRow(row) {
  const name = typeof row?.name === 'string' ? row.name : ''

  if (!EDIT_TOOLS.has(name)) {
    return null
  }

  const result = parseMaybeJson(row?.content)

  if (!result) {
    return null
  }

  const args = parseMaybeJson(row?.args) || {}
  const path = pathFromEdit(args, result)

  if (!path) {
    return null
  }

  const diff = diffFromResult(result)
  const { added, removed } = countDiffLines(diff)

  return {
    added,
    at: typeof row?.timestamp === 'number' ? row.timestamp : 0,
    bytes: typeof result.bytes_written === 'number' ? result.bytes_written : 0,
    diff,
    name: basename(path),
    path,
    removed,
    /** The written text, when the call carried it (a fresh snapshot). */
    snapshot: typeof args.content === 'string' ? args.content : '',
    tool: name
  }
}

/**
 * Fold a session transcript into one row per touched file, first-touched order,
 * every edit's diff concatenated. Pure: takes the gateway's own history rows.
 */
function foldSessionEdits(messages) {
  const byPath = new Map()

  for (const row of Array.isArray(messages) ? messages : []) {
    const edit = editFromRow(row)

    if (!edit) {
      continue
    }

    const existing = byPath.get(edit.path)

    if (existing) {
      existing.added += edit.added
      existing.bytes += edit.bytes
      existing.edits += 1
      existing.removed += edit.removed
      existing.snapshot = edit.snapshot || existing.snapshot
      existing.diff = edit.diff ? (existing.diff ? `${existing.diff}\n${edit.diff}` : edit.diff) : existing.diff
      existing.at = edit.at || existing.at
    } else {
      byPath.set(edit.path, { ...edit, edits: 1 })
    }
  }

  return [...byPath.values()]
}

/** Unified diff → typed rows for rendering. Pure. */
function splitDiffLines(diff) {
  return String(diff || '').split('\n').map(line => {
    if (line.startsWith('+++') || line.startsWith('---')) {
      return { kind: 'file', text: line }
    }

    if (line.startsWith('@@')) {
      return { kind: 'hunk', text: line }
    }

    if (line.startsWith('+')) {
      return { kind: 'add', text: line }
    }

    if (line.startsWith('-')) {
      return { kind: 'del', text: line }
    }

    return { kind: 'ctx', text: line }
  })
}

/** `data:<mime>[;base64],<payload>` → text (atob/TextDecoder come from the app). */
function decodeDataUrl(dataUrl) {
  const source = typeof dataUrl === 'string' ? dataUrl : ''
  const comma = source.indexOf(',')

  if (comma < 0) {
    return ''
  }

  const meta = source.slice(0, comma)
  const body = source.slice(comma + 1)

  if (!/;base64/i.test(meta)) {
    try {
      return decodeURIComponent(body)
    } catch {
      return body
    }
  }

  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return new TextDecoder('utf-8').decode(bytes)
}

function relativeTime(seconds, nowSeconds) {
  const at = Number(seconds) || 0

  if (!at) {
    return ''
  }

  const delta = Math.max(0, Math.round(Number(nowSeconds) - at))

  if (delta < 60) {
    return 'just now'
  }

  if (delta < 3600) {
    return `${Math.round(delta / 60)}m ago`
  }

  return `${Math.round(delta / 3600)}h ago`
}

// ---8<--- pane --------------------------------------------------------------

const CONTENT_PREVIEW_MAX_CHARS = 768 * 1024
const CONTENT_PREVIEW_MAX_LINES = 4000

function diffRowClass(kind) {
  if (kind === 'add') {
    return 'bg-emerald-500/12 text-(--ui-green)'
  }

  if (kind === 'del') {
    return 'bg-red-500/12 text-(--ui-red)'
  }

  if (kind === 'hunk') {
    return 'text-(--ui-text-tertiary)'
  }

  if (kind === 'file') {
    return 'text-(--ui-text-quaternary)'
  }

  return 'text-(--ui-text-secondary)'
}

function DiffView({ diff }) {
  return jsx('div', {
    'data-slot': 'sc-diff',
    className: 'flex flex-col py-1 font-mono text-[0.68rem] leading-[1.45]',
    children: splitDiffLines(diff).map((row, index) =>
      jsx(
        'div',
        {
          // Code is LTR by definition, whatever script it mentions.
          // No wrapping: a long line is read by scrolling, never re-flowed.
          className: `w-max min-w-full whitespace-pre px-2 ${diffRowClass(row.kind)}`,
          children: row.text || ' '
        },
        `${index}`
      )
    )
  })
}

/** Path extension → grammar id for the app's markdown pipeline (which only
 *  knows the languages in `lib/markdown-code.ts`; an unknown one stays plain).
 *  Keys carry the dot, as `extensionOf` returns it. */
const HIGHLIGHT_LANGUAGES = {
  '.bash': 'bash',
  '.c': 'c',
  '.cc': 'cpp',
  '.cjs': 'javascript',
  '.cpp': 'cpp',
  '.cs': 'csharp',
  '.css': 'css',
  '.go': 'go',
  '.h': 'c',
  '.hpp': 'cpp',
  '.html': 'html',
  '.java': 'java',
  '.js': 'javascript',
  '.json': 'json',
  '.jsx': 'jsx',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.lua': 'lua',
  '.md': 'markdown',
  '.mjs': 'javascript',
  '.php': 'php',
  '.pl': 'perl',
  '.ps1': 'powershell',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.scss': 'scss',
  '.sh': 'bash',
  '.sql': 'sql',
  '.swift': 'swift',
  '.toml': 'toml',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.vue': 'vue',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.zsh': 'bash'
}

/** Above this the markdown pipeline costs more than the colors are worth; the
 *  plain numbered view takes over. */
const HIGHLIGHT_MAX_CHARS = 256 * 1024

/** Pane-wide CSS. Two jobs:
 *   - SELECTION: the pane shell is chrome and carries `user-select: none`, which
 *     inherits all the way into the bodies — a file viewer whose text cannot be
 *     selected or copied is useless, so both bodies opt back in. An element that
 *     explicitly asks for `select-none` (the diff's line-number gutter) keeps it.
 *   - HEIGHT CAP: the app's code block caps its own scroller (~120px) because it
 *     is built to live inside a scrolling transcript; a file viewer is the
 *     scroller, so the cap is lifted — scoped to this pane, `!important` because
 *     the value is set on the block itself. */
const PANE_CSS = `
[data-slot='sc-diff'], [data-slot='sc-diff'] *:not(.select-none),
[data-slot='sc-content'], [data-slot='sc-content'] *:not(.select-none) {
  -webkit-user-select: text !important;
  user-select: text !important;
}
[data-slot='sc-content'] .scrollbar-overlay { max-height: none !important; }
[data-slot='sc-content'] .group\\/code { overflow: visible !important; }
`

function ContentView({ path, text }) {
  const body = String(text || '')
  const language = HIGHLIGHT_LANGUAGES[extensionOf(path)] || ''

  // The app's own renderer, so the colors are the chat's colors and the block
  // keeps the chat's copy button. Feature-detected: on a build without the
  // export (or a huge/unknown-language file) the plain view is still correct.
  if (language && typeof MessageTextContent === 'function' && body.length <= HIGHLIGHT_MAX_CHARS) {
    const fence = body.includes('```') ? '````' : '```'

    return jsx('div', {
      'data-slot': 'sc-content',
      // `min-h-full`: a short file still paints the whole pane (the block's own
      // surface), a long one grows and the pane scrolls.
      className: 'min-h-full w-full px-1 py-1',
      // The block's own 120px cap is lifted by PANE_CSS (rendered at the pane
      // root, above): a file viewer scrolls, a transcript clamps its code.
      children: jsx(MessageTextContent, { text: `${fence}${language}\n${body}\n${fence}` })
    })
  }

  const all = body.split('\n')
  const lines = all.slice(0, CONTENT_PREVIEW_MAX_LINES)
  const ltr = isCodePath(path)
  const gutter = `${String(lines.length).length + 1}ch`

  return jsxs('div', {
    className: 'flex min-h-full flex-col py-1 font-mono text-[0.68rem] leading-[1.45]',
    children: [
      lines.map((line, index) =>
        jsxs(
          'div',
          {
            className: 'flex w-max min-w-full gap-2 px-2 hover:bg-(--ui-row-hover-background)',
            key: `line-${index}`,
            children: [
              jsx('span', {
                className: 'shrink-0 select-none text-right tabular-nums text-(--ui-text-quaternary)',
                children: `${index + 1}`,
                style: { width: gutter }
              }),
              jsx('span', {
                // Persian prose reads right-to-left; code files stay LTR.
                className: 'whitespace-pre',
                children: line || ' ',
                dir: ltr ? 'ltr' : 'auto'
              })
            ]
          },
          `line-row-${index}`
        )
      ),
      all.length > CONTENT_PREVIEW_MAX_LINES
        ? jsx('div', {
            className: 'px-2 py-1 text-[0.66rem] text-(--ui-text-quaternary)',
            children: `… truncated after ${CONTENT_PREVIEW_MAX_LINES} lines`
          })
        : null
    ]
  })
}

// ── Transcript hand-off ──────────────────────────────────────────────────────
//
// The transcript's "N files changed" card sends a row click to the core Review
// pane (`openReviewForPath`), which is a git reading — the exact thing that has
// nothing to say in a non-repo folder. So this plugin intercepts that click in
// the CAPTURE phase (before React's root handler sees it), cancels it, fronts
// its own pane and asks it to select that file. The card's own "Review changes"
// action is left alone: it is a git-scoped request and keeps its meaning.
//
// The row carries the file's BASENAME (its title attribute is a hover tooltip,
// not a DOM hook), and this plugin's list is folded from the same transcript the
// card reads, so basenames line up.

const requestListeners = new Set()
let pendingName = ''

function requestFileByName(name) {
  const wanted = String(name || '').trim()

  if (!wanted) {
    return
  }

  pendingName = wanted

  for (const listener of requestListeners) {
    listener(wanted)
  }
}

function cardRowFileName(target) {
  const row = target?.closest?.('[data-slot="aui_changed-files"] button')

  if (!row) {
    return ''
  }

  // The change row is icon + name + counts; the card's Review action has none.
  return row.querySelector('span.truncate')?.textContent?.trim() || ''
}

/**
 * One fold, two transports. REST rows carry the DB columns (`tool_name`, raw
 * `content`, the assistant row's `tool_calls`); the gateway projection pre-pairs
 * `args` and renames `name`. Pairing here means `foldSessionEdits` never has to
 * know which door the rows came from. Pure.
 */
function normalizeHistoryRows(messages) {
  const argsById = new Map()

  for (const row of Array.isArray(messages) ? messages : []) {
    const calls = row?.tool_calls

    if (row?.role !== 'assistant' || !Array.isArray(calls)) {
      continue
    }

    for (const call of calls) {
      const fn = call?.function || {}

      if (!call?.id || !fn.name) {
        continue
      }

      let args = {}

      try {
        args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : fn.arguments || {}
      } catch {
        args = {}
      }

      argsById.set(call.id, args && typeof args === 'object' ? args : {})
    }
  }

  const rows = []

  for (const row of Array.isArray(messages) ? messages : []) {
    if (row?.role !== 'tool') {
      continue
    }

    const attached = row.args && typeof row.args === 'object' ? row.args : argsById.get(row.tool_call_id)

    rows.push({
      args: attached || {},
      content: row.content,
      name: typeof row.name === 'string' && row.name ? row.name : String(row.tool_name || ''),
      role: 'tool',
      timestamp: row.timestamp
    })
  }

  return rows
}

const HISTORY_PAGE_LIMIT = 500
const HISTORY_MAX_PAGES = 4

/**
 * The session's transcript, from the widest door that answers:
 *
 *  - the Electron REST route `/api/sessions/<stored>/messages` (paged,
 *    `include_compacted=true`) — the same rows the transcript is PAGED from, so
 *    nothing that survived a compaction is missing. This matters: the gateway's
 *    `session.history` returns the ACTIVE conversation only, and after a
 *    compaction that silently halves the tool rows (measured on a live session:
 *    147 of 271), which would quietly erase the older edits from the list.
 *  - the gateway's `session.history` (live RUNTIME id) when the REST door is
 *    absent — a browser window, or an older desktop build.
 *
 * Resolves `{ messages, source }`; throws when neither door answers.
 */
async function fetchHistoryRows(storedId, runtimeId) {
  const api = window.hermesDesktop?.api

  if (typeof api === 'function' && storedId) {
    const messages = []

    for (let page = 0; page < HISTORY_MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        include_compacted: 'true',
        limit: String(HISTORY_PAGE_LIMIT),
        offset: String(page * HISTORY_PAGE_LIMIT),
        order: 'oldest'
      })
      const result = await api({
        path: `/api/sessions/${encodeURIComponent(storedId)}/messages?${query.toString()}`,
        timeoutMs: 20000
      })
      const rows = Array.isArray(result?.messages) ? result.messages : []

      messages.push(...rows)

      if (rows.length < HISTORY_PAGE_LIMIT) {
        break
      }
    }

    if (messages.length) {
      return { messages, source: 'rest' }
    }
  }

  if (!runtimeId) {
    throw new Error('No live session to read.')
  }

  const result = await host.request('session.history', { session_id: runtimeId })

  return { messages: Array.isArray(result?.messages) ? result.messages : [], source: 'gateway' }
}

// ── Session store + pane presence ───────────────────────────────────────────
//
// The DATA lives out here rather than in the pane, because the pane's very
// existence depends on it: with no edited file the contribution is unregistered
// and the column collapses (an empty Changes rail is noise). The watcher
// therefore has to outlive the pane either way, and one read feeds both.

const store = { edits: [], error: '', source: '', status: 'idle' }
const storeListeners = new Set()

function publish(next) {
  Object.assign(store, next)

  for (const listener of storeListeners) {
    listener()
  }
}

/** Read the shared snapshot from a component (re-render on publish). */
function useSessionStore() {
  const [, bump] = useState(0)

  useEffect(() => {
    const listener = () => bump(value => value + 1)

    storeListeners.add(listener)

    return () => {
      storeListeners.delete(listener)
    }
  }, [])

  return store
}

/** Done with it: hide the pane WITHOUT touching the plugin. The tab menu's own
 *  Close disables a single-pane plugin (Hermes' rule); this door does not, so the
 *  pane can come back from the status-bar chip, a transcript card click, or ⌘K. */
function hidePane() {
  openedFor = ''
  disposePane()
  publish({})
}

/** The status-bar door. Renders nothing in a chat with no edits, so it never
 *  advertises an empty pane. The dot lights up while the pane is on screen. */
function ChangesChip({ ctx }) {
  const current = useSessionStore()
  const count = current.edits.length

  if (!count) {
    return null
  }

  const added = current.edits.reduce((total, edit) => total + edit.added, 0)
  const removed = current.edits.reduce((total, edit) => total + edit.removed, 0)
  const open = Boolean(paneDispose)

  return jsxs('button', {
    'aria-label': "Show this session's file changes",
    onClick: () => void showPane(ctx),
    style: {
      alignItems: 'center',
      background: 'transparent',
      border: 'none',
      borderRadius: '4px',
      color: 'var(--ui-text-secondary, #c3c7d1)',
      cursor: 'pointer',
      display: 'inline-flex',
      fontFamily: 'inherit',
      fontSize: '11px',
      fontWeight: 500,
      gap: '5px',
      height: '100%',
      lineHeight: 1,
      padding: '0 8px'
    },
    title: `${count} file${count === 1 ? '' : 's'} changed in this session (+${added} −${removed}) — click to show the Changes pane`,
    type: 'button',
    children: [
      jsx('span', {
        'aria-hidden': true,
        style: {
          background: open ? 'var(--ui-accent, #2f81f7)' : 'var(--ui-text-quaternary, #9aa0aa)',
          borderRadius: '50%',
          flexShrink: 0,
          height: 6,
          opacity: open ? 1 : 0.45,
          width: 6
        }
      }),
      `${count} file${count === 1 ? '' : 's'} (+${added} −${removed})`
    ]
  })
}

let paneDispose = null
let queuedRefresh = null
// The chat the user asked for the pane in. Empty = nobody asked ⇒ the pane is
// not registered at all, so no column, no tab, nothing on screen.
let openedFor = ''

function sessionKey() {
  return host.state.focusedStoredSessionId.get() || host.state.focusedSessionId.get() || ''
}

function registerPane(ctx) {
  if (!paneDispose) {
    paneDispose = ctx.register({
      area: PANES_AREA,
      data: { placement: 'right', width: '320px' },
      id: 'changes',
      render: () => jsx(EditsPane, { ctx }),
      title: 'Changes'
    })
  }

  return paneDispose
}

function disposePane() {
  if (paneDispose) {
    paneDispose()
    paneDispose = null
  }
}

/** The pane is on screen only where the user asked for it AND there is
 *  something to show. Nothing here is an automatic reveal: a fresh chat, a
 *  session switch, or an idle refresh never opens a column by itself. */
function setPanePresence(ctx) {
  if (openedFor && openedFor === sessionKey() && store.edits.length) {
    registerPane(ctx)

    return
  }

  disposePane()
}

/** An explicit ask — a file row in the transcript's changed-files card, or the
 *  ⌘K command. Registers the pane (that IS the show) and fronts it. */
async function showPane(ctx) {
  openedFor = sessionKey()

  if (!store.edits.length) {
    await refresh(ctx)
  }

  registerPane(ctx)
  publish({})

  if (typeof host.undismissPane === 'function') {
    host.undismissPane(PANE_KEY)
  }

  host.revealPane(PANE_KEY)
}

/** Read the focused session and republish. Never throws. */
async function refresh(ctx) {
  const stored = host.state.focusedStoredSessionId.get() || ''
  const runtime = host.state.focusedSessionId.get() || host.state.activeSessionId.get() || ''

  if (openedFor && openedFor !== sessionKey()) {
    // Moved to another chat: the pane is hidden there until asked for again.
    openedFor = ''
  }

  if (!stored && !runtime) {
    publish({ edits: [], error: '', source: '', status: 'empty' })
    setPanePresence(ctx)

    return { edits: [], status: 'empty' }
  }

  // Keep the last list on screen while a re-read is in flight — a loading flash
  // would unregister and re-register the pane on every tool call.
  if (store.status !== 'ready') {
    publish({ status: 'loading' })
  }

  try {
    const { messages, source } = await fetchHistoryRows(stored, runtime)
    const edits = foldSessionEdits(normalizeHistoryRows(messages))

    publish({ edits, error: '', source, status: 'ready' })
    setPanePresence(ctx)

    return { edits, source, status: 'ready' }
  } catch (caught) {
    const error = caught?.message ? String(caught.message) : 'Could not read this session.'

    // A brand-new chat has no persisted session yet, and a bot tile's session may
    // live on another backend: both doors answer "not found". That is an EMPTY
    // list, not a failure — an error state would be a lie about this session.
    if (/not found|4001|404/i.test(error)) {
      publish({ edits: [], error: '', status: 'empty' })
      setPanePresence(ctx)

      return { edits: [], status: 'empty' }
    }

    publish({ error, status: 'error' })
    console.error(`[${ID}] read failed: ${error}`)

    return { error, status: 'error' }
  }
}

/** The editor door. A renderer plugin cannot spawn a process (its imports are
 *  limited to the SDK and react) and the Electron bridge has no "open a path
 *  with its association" method — its `file:` route reveals in the file manager
 *  on purpose. So this calls the `file-opener` plugin's backend route, which
 *  runs inside the desktop's own serve process on this machine and spawns Kate
 *  (then xdg-open). Before that backend is restarted the route is absent, so the
 *  last rung is still the app's own reveal. */
const OPEN_FILE_ROUTE = '/api/plugins/file-opener/open'

function fileUrl(path) {
  return `file://${String(path || '').split('/').map(encodeURIComponent).join('/')}`
}

function toast(message) {
  if (typeof host.notify === 'function') {
    host.notify({ kind: 'error', message })
  } else {
    console.error(`[${ID}] ${message}`)
  }
}

async function openInEditor(ctx, targetPath) {
  const api = window.hermesDesktop?.api

  if (typeof api === 'function') {
    try {
      const result = await api({
        body: { path: targetPath },
        method: 'POST',
        path: OPEN_FILE_ROUTE,
        timeoutMs: 15000
      })

      if (result?.opened) {
        return
      }

      toast(`Could not open the editor (${result?.reason || 'unknown'}).`)
    } catch {
      toast('The file-opener plugin is not loaded yet — restart Hermes once.')
    }

    return
  }

  await ctx.os.openExternal(fileUrl(targetPath))
}

/** Coalesce a burst of triggers (session switch + tool completion). */
function queueRefresh(ctx) {
  if (queuedRefresh) {
    return
  }

  queuedRefresh = ctx.setTimeout(() => {
    queuedRefresh = null
    void refresh(ctx)
  }, 150)
}

function EditsPane({ ctx }) {
  const cwd = useValue(host.state.cwd)
  const { edits, error, source, status } = useSessionStore()
  const [pickedPath, setPickedPath] = useState('')
  const [wantedName, setWantedName] = useState('')
  const [tab, setTab] = useState('diff')
  const [content, setContent] = useState({ note: '', path: '', state: 'idle', text: '' })

  // Transcript hand-off: a card click lands here as a basename.
  useEffect(() => {
    const listener = name => {
      setWantedName(name)
      setTab('diff')
    }

    requestListeners.add(listener)

    if (pendingName) {
      listener(pendingName)
    }

    return () => {
      requestListeners.delete(listener)
    }
  }, [])

  const active = useMemo(() => {
    // Selection order: an explicitly picked row, else the file a transcript
    // click asked for (matched by basename), else the newest edit.
    const asked = wantedName ? edits.find(edit => edit.name === wantedName)?.path : ''
    const wanted = pickedPath || asked || edits[edits.length - 1]?.path || ''

    return edits.find(edit => edit.path === wanted) || edits[edits.length - 1] || null
  }, [edits, pickedPath, wantedName])

  const activePath = active?.path || ''

  // Content is read on demand, never with the list: the diff answers most
  // questions, and files can be large.
  useEffect(() => {
    if (tab !== 'content' || !activePath) {
      return
    }

    let cancelled = false
    const read = window.hermesDesktop?.readFileDataUrl

    const finish = next => {
      if (!cancelled) {
        setContent({ path: activePath, ...next })
      }
    }

    setContent({ note: '', path: activePath, state: 'loading', text: '' })

    if (typeof read !== 'function') {
      finish({ note: 'Reading local files is unavailable in this window.', state: 'error', text: '' })

      return () => {
        cancelled = true
      }
    }

    Promise.resolve(read(activePath))
      .then(dataUrl => {
        const text = decodeDataUrl(dataUrl)

        if (text.length > CONTENT_PREVIEW_MAX_CHARS) {
          finish({
            note: `File is larger than ${Math.round(CONTENT_PREVIEW_MAX_CHARS / 1024)} KB.`,
            state: 'error',
            text: ''
          })

          return
        }

        finish({ note: '', state: 'ready', text })
      })
      .catch(caught => {
        finish({
          note: caught?.message ? String(caught.message) : 'Could not read that file.',
          state: 'error',
          text: ''
        })
      })

    return () => {
      cancelled = true
    }
  }, [activePath, tab])

  if (status === 'empty') {
    return jsx(EmptyState, {
      description: 'Start a chat and the files it edits land here — no repository needed.',
      title: 'No session yet'
    })
  }

  if (status === 'error') {
    return jsx(ErrorState, { className: 'p-3', description: error, title: 'Could not read the session' })
  }

  if (status !== 'ready') {
    return jsx('div', {
      className: 'flex h-full items-center justify-center text-[0.7rem] text-(--ui-text-tertiary)',
      children: 'Reading the session…'
    })
  }

  const header = jsxs('div', {
    className: 'flex shrink-0 items-center gap-1 border-b border-(--ui-stroke-secondary) px-2 py-1.5',
    children: [
      jsx('span', {
        className: 'min-w-0 flex-1 truncate text-[0.68rem] text-(--ui-text-tertiary)',
        children: edits.length
          ? `${edits.length} file${edits.length === 1 ? '' : 's'} edited in this session`
          : 'No file edit in this session',
        // `live view` = the gateway's active-only transcript (the REST history
        // route was unavailable), where a compaction can hide older edits.
        title: `${source === 'gateway' ? 'live view · ' : ''}${cwd || ''}`
      }),
      jsx(
        Button,
        {
          'aria-label': 'Refresh',
          children: jsx(Codicon, { name: 'refresh', size: '0.75rem' }),
          onClick: () => void refresh(ctx),
          size: 'icon-xs',
          variant: 'ghost'
        },
        'refresh'
      )
    ]
  })

  if (edits.length === 0) {
    return jsxs('div', {
      className: 'flex h-full min-h-0 flex-col',
      children: [
        header,
        jsx('div', {
          className: 'flex min-h-0 flex-1 items-center justify-center px-4 text-center text-[0.7rem] text-(--ui-text-tertiary)',
          children: 'Nothing landed yet — this list fills as tools write files.'
        })
      ]
    })
  }

  const now = Date.now() / 1000

  const row = edit =>
    jsxs(
      'div',
      {
        className: `flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 ${
          active?.path === edit.path ? 'bg-(--ui-row-hover-background)' : 'hover:bg-(--ui-row-hover-background)'
        }`,
        children: [
          jsxs(
            'button',
            {
              className: 'flex min-w-0 flex-1 items-center gap-1.5 text-left',
              onClick: () => {
                setPickedPath(edit.path)
                setTab('diff')
              },
              title: edit.path,
              type: 'button',
              children: [
                jsx(Codicon, { className: 'shrink-0 text-(--ui-text-tertiary)', name: 'diff-modified', size: '0.8rem' }),
                jsx('span', {
                  className: 'min-w-0 flex-1 truncate text-[0.72rem] text-(--ui-text-secondary)',
                  children: edit.name
                })
              ]
            },
            'label'
          ),
          edit.added || edit.removed
            ? jsxs(
                'span',
                {
                  className: 'flex shrink-0 items-center gap-1 tabular-nums text-[0.64rem]',
                  children: [
                    edit.added ? jsx('span', { className: 'text-(--ui-green)', children: `+${edit.added}` }) : null,
                    edit.removed ? jsx('span', { className: 'text-(--ui-red)', children: `−${edit.removed}` }) : null
                  ]
                },
                'counts'
              )
            : jsx(
                'span',
                {
                  className: 'shrink-0 text-[0.62rem] text-(--ui-text-quaternary)',
                  children: edit.bytes ? `${Math.max(1, Math.round(edit.bytes / 1024))} KB` : 'written'
                },
                'bytes'
              ),
          relativeTime(edit.at, now)
            ? jsx(
                'span',
                {
                  className: 'shrink-0 text-[0.62rem] text-(--ui-text-quaternary)',
                  children: relativeTime(edit.at, now)
                },
                'at'
              )
            : null
        ]
      },
      edit.path
    )

  const detailBody =
    tab === 'diff'
      ? active.diff
        ? jsx(DiffView, { diff: active.diff })
        : jsx('div', {
            className: 'px-3 py-4 text-center text-[0.66rem] text-(--ui-text-tertiary)',
            children: `This file was written whole (${active.bytes ? `${active.bytes} bytes` : active.tool}) — no line diff to show.`
          })
      : content.path === activePath && content.state === 'ready'
        ? jsx(ContentView, { path: activePath, text: content.text })
        : content.path === activePath && content.state === 'error'
          ? jsx('div', {
              className: 'px-3 py-4 text-center text-[0.66rem] text-(--ui-text-tertiary)',
              children: content.note
            })
          : jsx('div', {
              className: 'px-3 py-4 text-center text-[0.66rem] text-(--ui-text-tertiary)',
              children: 'Reading the file…'
            })

  const detail = jsxs('div', {
    className: 'flex min-h-0 flex-1 flex-col border-t border-(--ui-stroke-secondary)',
    children: [
      jsxs('div', {
        className: 'flex shrink-0 items-center gap-1 px-2 py-1',
        children: [
          jsx('span', {
            className: 'min-w-0 flex-1 truncate font-mono text-[0.64rem] text-(--ui-text-tertiary)',
            children: active.path,
            title: active.path
          }),
          jsxs(
            'div',
            {
              className: 'flex shrink-0 items-center gap-0.5',
              children: [
                jsx(
                  Button,
                  {
                    children: 'Diff',
                    onClick: () => setTab('diff'),
                    size: 'xs',
                    variant: tab === 'diff' ? 'secondary' : 'ghost'
                  },
                  'tab-diff'
                ),
                jsx(
                  Button,
                  {
                    children: 'Content',
                    onClick: () => setTab('content'),
                    size: 'xs',
                    variant: tab === 'content' ? 'secondary' : 'ghost'
                  },
                  'tab-content'
                ),
                jsx(
                  Button,
                  {
                    'aria-label': 'Open the file in the editor (Kate)',
                    children: jsx(Codicon, { name: 'go-to-file', size: '0.72rem' }),
                    onClick: () => void openInEditor(ctx, active.path),
                    size: 'icon-xs',
                    variant: 'ghost'
                  },
                  'editor'
                ),
                jsx(
                  Button,
                  {
                    'aria-label': 'Copy the diff',
                    children: jsx(Codicon, { name: 'copy', size: '0.72rem' }),
                    onClick: () => void ctx.os.writeClipboard(active.diff || active.snapshot || active.path),
                    size: 'icon-xs',
                    variant: 'ghost'
                  },
                  'copy'
                ),
                jsx(
                  Button,
                  {
                    'aria-label': 'Hide the Changes pane',
                    children: jsx(Codicon, { name: 'close', size: '0.72rem' }),
                    onClick: hidePane,
                    size: 'icon-xs',
                    variant: 'ghost'
                  },
                  'hide'
                ),
                jsx(
                  Button,
                  {
                    'aria-label': 'Reveal in the file manager',
                    children: jsx(Codicon, { name: 'folder-opened', size: '0.72rem' }),
                    onClick: () => void ctx.os.revealPath(active.path),
                    size: 'icon-xs',
                    variant: 'ghost'
                  },
                  'reveal'
                )
              ]
            },
            'actions'
          )
        ]
      }),
      jsx('div', {
        className: 'min-h-0 flex-1 overflow-auto border-t border-(--ui-stroke-secondary)',
        children: detailBody
      })
    ]
  })

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col',
    children: [
      jsx('style', { children: PANE_CSS }, 'pane-css'),
      header,
      // The file list owns a bounded block at the top and scrolls itself, so the
      // diff below can never push it out of the pane.
      jsx('div', {
        className: 'max-h-[50%] min-h-6 shrink-0 overflow-auto px-1 py-1',
        children: edits.map(row)
      }),
      detail
    ]
  })
}

export default {
  id: ID,
  name: 'Session changes',
  register(ctx) {
    // The pane is registered CONDITIONALLY — only while the focused session has
    // file edits — so the reads and the session subscriptions live here rather
    // than in the pane. Everything below is ctx-tracked and dies with the
    // plugin: a reload, or the app's rule that closing a plugin's SOLE pane
    // disables that plugin (Capabilities ▸ Plugins brings it back).
    const poke = () => queueRefresh(ctx)

    ctx.onEvent('tool.complete', poke)
    ctx.onDispose(host.state.focusedStoredSessionId.subscribe(poke))
    ctx.onDispose(host.state.activeSessionId.subscribe(poke))

    // First read, and the breadcrumb that proves the whole chain on THIS build
    // (history door → fold → pane registration) without anyone opening a pane.
    // Only failures are worth a line in the log once it works.
    void refresh(ctx).then(result => {
      if (result.status === 'ready') {
        const added = result.edits.reduce((total, edit) => total + edit.added, 0)
        const removed = result.edits.reduce((total, edit) => total + edit.removed, 0)

        console.error(`[${ID}] ready (${result.source}): ${result.edits.length} file(s), +${added} −${removed}`)
      } else if (result.status !== 'empty') {
        console.error(`[${ID}] not ready: ${result.error || result.status}`)
      }
    })

    // Transcript hand-off (see the note above): capture phase, so a card row
    // click never reaches the core Review pane, which is a git reading.
    ctx.addEventListener(
      document,
      'click',
      event => {
        const target = event.target instanceof Element ? event.target : null
        const name = cardRowFileName(target)

        if (!name) {
          return
        }

        event.preventDefault()
        event.stopPropagation()
        requestFileByName(name)
        showPane(ctx)
      },
      true
    )

    ctx.register({
      area: STATUSBAR_AREAS.right,
      id: 'chip',
      order: 60,
      render: () => jsx(ChangesChip, { ctx })
    })
    ctx.register({
      area: PALETTE_AREA,
      data: {
        id: `${ID}.open`,
        keywords: ['changes', 'diff', 'edits', 'review', 'git'],
        label: "Changes: this session's file edits",
        run: () => showPane(ctx)
      },
      id: 'open'
    })
  }

}

export { foldSessionEdits, splitDiffLines, decodeDataUrl, countDiffLines, editFromRow }
