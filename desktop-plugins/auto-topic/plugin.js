/**
 * Auto Topic — desktop half of the auto-topic plugin.
 *
 * TWO jobs:
 *
 * 1) TITLE BUTTON — injects an "✨ Auto-topic" button into the session Rename
 *    dialog (RenameSessionDialog, session-actions-menu.tsx). Clicking it asks the
 *    plugin's Python backend (ctx.rest → /api/plugins/auto-topic/auto-topic) to
 *    read the session transcript and produce an AI topic prefixed with a
 *    relevant emoji. The result fills the dialog input (React-safe native
 *    setter + input event); pressing Save/Enter runs the app's own rename flow
 *    — provenance, store sync, and error toasts all stay app-native.
 *
 * 2) TOPIC COLOURS — the app already paints a per-session colour (the sidebar
 *    dot, and the session-color-tint plugin's bubbles/composer). The colour list
 *    is FIXED: the app's own 12 session-palette hues, one row each. What the
 *    user edits is the TOPIC written next to a colour — the words a session
 *    title must contain to get that colour (comma-separated synonyms allowed).
 *    On top of that, the leading emoji of the title (auto-topic titles always
 *    start with one) is matched against a built-in emoji set per colour.
 *
 *    The colour is written through `host.sessions.setColor` — the exact store
 *    the app's own swatch picker writes, so a hand-picked colour and an assigned
 *    one are one value. A colour the user picked BY HAND is never overwritten:
 *    we remember the ones we assigned (plugin storage `assigned`) and skip any
 *    session whose stored colour is neither ours nor absent.
 *
 *    The UI lives in a status-bar chip because Settings ▸ Appearance's plugin
 *    slot never renders in this build (`APPEARANCE_AREAS.extra` is mounted
 *    behind a subpage guard that is always taken).
 *
 * Requires (both halves gated on purpose):
 *   1. Python backend enabled: `plugins.enabled` in config.yaml must include
 *      "auto-topic", then the app backend must be restarted so plugin_api.py
 *      imports. (hermes plugins enable auto-topic)
 *   2. This desktop half toggled ON in Settings → Plugins. Since the
 *      app-level-copies change (Sep 2026), a folder carrying
 *      `.hermes-package.json` — i.e. every unified agent+desktop package, this
 *      one included — is OPT-IN regardless of `defaultEnabled` below: the
 *      marker caps it to false until the user makes an explicit choice
 *      (localStorage `hermes.desktop.pluginDecisions.v2`). One toggle, once.
 *
 * Save as: ~/.hermes/plugins/auto-topic/desktop/plugin.js (package source — the
 * app copies it to ~/.hermes/desktop-plugins/auto-topic/, which is the copy that
 * actually loads).
 */

import { createElement as h, useCallback, useState } from 'react'

import {
  host,
  Input,
  PALETTE_AREA,
  Popover,
  PopoverContent,
  PopoverTrigger,
  PROFILE_SWATCHES,
  STATUSBAR_AREAS,
  Switch
} from '@hermes/plugin-sdk'

const ID = 'auto-topic'
const PLACEHOLDER = 'Untitled session'
const BTN_CLS = 'hermes-auto-topic-btn'
const STORAGE_KEY = 'settings'
const ASSIGNED_KEY = 'assigned'
const SLOT = '__autoTopicLifecycle'
const ASSIGN_INTERVAL_MS = 120_000

/** The app's session palette, by index (store/session-color.ts). The COLOURS are
 *  the fixed list; only the topic text beside them is editable. */
const SWATCH_NAMES = [
  'قرمز',
  'نارنجی',
  'زرد',
  'لیمویی',
  'سبز',
  'سبز بهاره',
  'فیروزه‌ای',
  'آبی',
  'نیلی',
  'بنفش',
  'سرخابی',
  'صورتی'
]

const swatch = index => PROFILE_SWATCHES[index] ?? PROFILE_SWATCHES[0]

/** Emoji → colour. The titler is asked to start every title with a topic emoji,
 *  so it is the strongest signal; it belongs to the COLOUR, not to the typed
 *  topic text (a row renamed to "ادیب" must not start claiming 🤝 titles). */
const EMOJI_BY_INDEX = {
  1: ['🚀', '🐳', '🌐', '🔌', '🛰️', '🧯', '📡', '📤'],
  4: ['💳', '💰', '🧾', '💵', '🏦', '📉'],
  6: ['🔬', '🧪', '🔭', '🎓', '🧠', '📜', '🗞️'],
  7: ['💻', '🖥️', '⌨️', '🧑‍💻', '👨‍💻', '🐍', '🐛', '🧩', '⚙️', '🔧', '🛠️', '🪛'],
  8: ['🗄️', '🧮', '📊', '📈', '🔢', '📋'],
  9: ['✍️', '📝', '📄', '📃', '📚', '📖', '📑', '🗒️', '🖋️', '📓'],
  10: ['🎨', '🎬', '🎵', '🎧', '📷', '🖼️', '🎭'],
  11: ['💬', '🗣️', '📞', '✉️', '📧', '📨', '🤝']
}

/** What a fresh install maps. Four hues start empty on purpose — a colour with
 *  no topic simply never matches. */
const DEFAULT_NAMES = {
  1: 'سرور، انتشار، دیپلوی، استقرار، کانتینر، بکاپ، کرون، deploy, server, docker',
  4: 'مالی، فاکتور، پرداخت، قیمت، هزینه، بودجه، قرارداد، تعرفه, invoice, payment, budget',
  6: 'تحقیق، پژوهش، مقاله علمی، آزمایش، مطالعه، پایان‌نامه, research, paper, arxiv',
  7: 'کدنویسی، کد، برنامه، باگ، ریپو، دیباگ، تست، ریفکتور, code, bug, api, commit',
  8: 'داده، دیتا، دیتابیس، کوئری، تحلیل، آمار، نمودار, data, query, database, sql',
  9: 'نوشتن، متن، مستند، مقاله، داستان، کتاب، یادداشت, writing, doc, article',
  10: 'طراحی، رابط، تم، لوگو، آیکون، ویدیو، تصویر، انیمیشن، فونت, design, ui, ux, theme',
  11: 'گفتگو، چت، پیام، تلگرام، واتساپ، ایمیل، پیامک, chat, email, telegram'
}

const COLOR_ROWS = PROFILE_SWATCHES.map((color, index) => ({
  color,
  name: SWATCH_NAMES[index] ?? color,
  emoji: EMOJI_BY_INDEX[index] ?? [],
  fallback: DEFAULT_NAMES[index] ?? ''
}))

// ============================================================ settings

/** Stored settings → usable settings. `names` is keyed by the palette colour
 *  itself, so a colour can never be invented or dropped. */
function normalize(raw) {
  const names = {}

  for (const row of COLOR_ROWS) {
    const value = raw?.names?.[row.color]

    names[row.color] = typeof value === 'string' ? value : row.fallback
  }

  return { enabled: raw?.enabled !== false, names }
}

function readSettings(storage) {
  try {
    return normalize(storage?.get?.(STORAGE_KEY))
  } catch {
    return normalize(null)
  }
}

function writeSettings(storage, next) {
  try {
    storage?.set?.(STORAGE_KEY, next)
  } catch {
    /* persistence is best-effort */
  }
}

/** What WE assigned, per durable session id — the only way to tell our own
 *  colour from one the user picked. */
function readAssigned(storage) {
  try {
    const raw = storage?.get?.(ASSIGNED_KEY)

    return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {}
  } catch {
    return {}
  }
}

// ============================================================ classification

/** Emoji and Persian letters need a light normalization before comparing:
 *  variation selectors and ZWJ break naive string equality, and Persian text
 *  arrives with ZWNJ and Arabic yeh/kaf variants. */
function normalizeTitle(text) {
  return String(text || '')
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/\u200C/g, ' ')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .toLowerCase()
    .trim()
}

/** The words typed for one colour: split on the Persian comma as well as ASCII. */
function topicWords(text) {
  return String(text || '')
    .split(/[,،]/)
    .map(word => normalizeTitle(word))
    .filter(Boolean)
}

/** The colour a title belongs to: the leading emoji first, then the first colour
 *  (in palette order) whose typed topic appears in the title. */
function classify(settings, title) {
  const normalized = normalizeTitle(title)

  if (!normalized) {
    return null
  }

  for (const row of COLOR_ROWS) {
    if (row.emoji.some(emoji => normalized.startsWith(normalizeTitle(emoji)))) {
      return row
    }
  }

  for (const row of COLOR_ROWS) {
    if (topicWords(settings.names[row.color]).some(word => normalized.includes(word))) {
      return row
    }
  }

  return null
}

// ============================================================ colour assignment

/** Where the app keeps per-session colours (store/session-color.ts). Read
 *  directly: the SDK writes that store but exposes no reader. */
function readAppColors() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem('hermes.desktop.sessionColors') || '{}')

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

let assigning = false

async function assignColors(storage) {
  if (assigning) {
    return
  }

  const settings = readSettings(storage)

  if (!settings.enabled) {
    return
  }

  assigning = true

  try {
    const profile = host?.state?.profile?.get?.() || 'default'
    // Colours matter for the chats in reach, not for the whole archive.
    const page = await host.listPersistedSessions(null, { profile, limit: 60 })
    const colors = readAppColors()
    const assigned = readAssigned(storage)
    let dirty = false

    for (const row of page?.sessions ?? []) {
      const id = row?._lineage_root_id || row?.id
      const target = classify(settings, row?.title)

      if (!id || !target) {
        continue
      }

      const current = colors[id]

      // A colour that is neither absent nor ours was picked by hand — leave it.
      if (current && current !== assigned[id]) {
        continue
      }

      if (current === target.color) {
        if (assigned[id] !== target.color) {
          assigned[id] = target.color
          dirty = true
        }

        continue
      }

      host.sessions.setColor(id, target.color)
      assigned[id] = target.color
      dirty = true
    }

    if (dirty) {
      storage?.set?.(ASSIGNED_KEY, assigned)
    }
  } catch (error) {
    // Backend asleep / no gateway: retry on the next tick, never spam the log.
    console.warn(`[${ID}] colour assignment skipped:`, error)
  } finally {
    assigning = false
  }
}

// ============================================================ rename dialog

// React-controlled input update: native setter + bubbled input event.
function setNativeValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function findRenameInput() {
  return document.querySelector(`[role="dialog"] input[placeholder="${PLACEHOLDER}"]`)
}

function ensureButton(ctx) {
  const input = findRenameInput()
  if (!input) return
  const dialog = input.closest('[role="dialog"]')
  if (!dialog || dialog.dataset.autoTopic) return // one button per dialog instance
  dialog.dataset.autoTopic = '1'

  const bar = document.createElement('div')
  bar.style.cssText =
    'display:flex;justify-content:flex-end;margin-top:-4px;padding:0 2px;'

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = BTN_CLS
  btn.textContent = '✨ Auto-topic'
  btn.title = 'Ask AI to title this chat from its content (emoji included)'
  btn.style.cssText =
    'appearance:none;border:none;background:transparent;cursor:pointer;' +
    'font-size:0.72rem;font-weight:600;letter-spacing:0.02em;color:var(--ui-accent, #0053fd);' +
    'padding:3px 8px;border-radius:6px;transition:background 0.12s ease;'
  btn.addEventListener('mouseenter', () => {
    btn.style.background = 'color-mix(in srgb, var(--ui-accent, #0053fd) 10%, transparent)'
  })
  btn.addEventListener('mouseleave', () => {
    btn.style.background = 'transparent'
  })

  btn.addEventListener('click', async () => {
    const title = (input.value || '').trim()
    btn.disabled = true
    btn.textContent = 'Thinking…'
    try {
      const res = await ctx.rest('/auto-topic', {
        method: 'POST',
        body: { session_id: '', title: title || null, profile: '' },
        timeoutMs: 60_000
      })
      const next = res && res.title
      if (!next) throw new Error('empty response')
      setNativeValue(input, next)
      input.focus()
      input.setSelectionRange(next.length, next.length)
      btn.textContent = '✓ Suggested — press Enter to save'
      // The new title carries a topic: colour it now, not on the next tick.
      assignColors(ctx.storage)
    } catch (err) {
      btn.textContent = '✨ Auto-topic'
      const detail = (err && (err.detail || err.message)) || 'backend unavailable'
      btn.title = `Auto-topic failed: ${detail}`
      // Surface visibly: brief red flash on the label.
      const prev = btn.style.color
      btn.style.color = 'var(--ui-error, #e5484d)'
      window.setTimeout(() => {
        btn.style.color = prev
        btn.title = 'Ask AI to title this chat from its content (emoji included)'
      }, 4000)
    } finally {
      btn.disabled = false
      if (btn.textContent === 'Thinking…') btn.textContent = '✨ Auto-topic'
    }
  })

  bar.appendChild(btn)
  input.after(bar)
}

// ============================================================ settings chip

const CHIP_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  height: '100%',
  padding: '0 8px',
  fontSize: '11px',
  fontWeight: 500,
  lineHeight: 1,
  color: 'var(--ui-text-secondary, #c3c7d1)',
  cursor: 'pointer',
  background: 'transparent',
  border: 'none'
}

const ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px'
}

const HINT_STYLE = {
  color: 'var(--ui-text-tertiary)',
  fontSize: '10px',
  lineHeight: 1.5
}

const COLOR_NAME_STYLE = {
  color: 'var(--ui-text-tertiary)',
  flexShrink: 0,
  fontSize: '10px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  width: '62px'
}

function dot(color) {
  return h('span', {
    'aria-hidden': true,
    style: {
      background: color,
      borderRadius: '50%',
      boxShadow: 'inset 0 0 0 1px rgb(0 0 0 / 0.25)',
      flexShrink: 0,
      height: '7px',
      width: '7px'
    }
  })
}

function TopicColorChip({ ctx }) {
  const [settings, setSettings] = useState(() => readSettings(ctx.storage))
  const [open, setOpen] = useState(false)

  const onOpenChange = useCallback(
    next => {
      setOpen(next)
      if (next) setSettings(readSettings(ctx.storage))
    },
    [ctx]
  )

  /** One write per committed edit (blur / Enter), then the colours are
   *  re-applied so the change shows without waiting for the 2-minute tick. */
  const save = useCallback(
    next => {
      writeSettings(ctx.storage, normalize(next))
      setSettings(readSettings(ctx.storage))
      assignColors(ctx.storage)
    },
    [ctx]
  )

  const setName = useCallback(
    (color, text) => save({ ...settings, names: { ...settings.names, [color]: text } }),
    [save, settings]
  )

  return h(
    Popover,
    { onOpenChange, open },
    h(
      PopoverTrigger,
      { asChild: true },
      h(
        'button',
        { style: CHIP_STYLE, title: 'رنگ تاپیک‌ها — هر رنگ یک تاپیک دارد', type: 'button' },
        dot(swatch(7)),
        h('span', null, 'رنگ تاپیک')
      )
    ),
    h(
      PopoverContent,
      // The app's PopoverContent is `w-72` (288px) with its own padding; a fixed
      // inner width would spill past that box, so the width is set HERE and the
      // panel fills it.
      { align: 'end', className: 'w-[340px] max-w-[calc(100vw-2rem)]', side: 'top', sideOffset: 6 },
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px', width: '100%' } },
        h('div', { style: { fontSize: '12px', fontWeight: 600 } }, 'رنگ خودکار تاپیک‌ها'),
        h(
          'div',
          { style: { ...ROW_STYLE, justifyContent: 'space-between', gap: '10px' } },
          h('span', { style: { color: 'var(--ui-text-tertiary)', fontSize: '11px' } }, 'رنگ سشن از تاپیک'),
          h(Switch, {
            checked: settings.enabled,
            onCheckedChange: value => save({ ...settings, enabled: value }),
            size: 'xs'
          })
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '5px',
              maxHeight: '55vh',
              opacity: settings.enabled ? 1 : 0.5,
              overflowY: 'auto'
            }
          },
          COLOR_ROWS.map(row =>
            h(
              'div',
              { key: row.color, style: ROW_STYLE },
              dot(row.color),
              h('span', { style: COLOR_NAME_STYLE }, row.name),
              h(Input, {
                'aria-label': `تاپیک رنگ ${row.name}`,
                // Uncontrolled while typing; the key remounts it when the stored
                // text changes elsewhere (another window).
                className: 'h-6 min-w-0 flex-1 text-[11px]',
                defaultValue: settings.names[row.color],
                dir: 'auto',
                key: `${row.color}:${settings.names[row.color]}`,
                onBlur: event => {
                  const text = event.target.value.trim()

                  if (text !== settings.names[row.color]) {
                    setName(row.color, text)
                  }
                },
                onKeyDown: event => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur()
                  }
                },
                placeholder: 'تاپیک این رنگ…'
              })
            )
          )
        ),
        h(
          'div',
          { style: HINT_STYLE },
          'با ویرگول چند کلمه بنویس؛ عنوان سشنی که یکی از آن‌ها را داشته باشد این رنگ را می‌گیرد. ایموجی اول عنوان هم خودش رنگ مربوط به خودش را دارد.'
        )
      )
    )
  )
}

// ============================================================ plugin

export default {
  id: ID,
  name: 'Auto Topic',
  // NOTE: the app's marker-driven opt-in caps this (see the header): for a
  // package folder carrying `.hermes-package.json` the user's Settings →
  // Plugins choice wins, and absence of a choice means OFF.
  defaultEnabled: true,
  register(ctx) {
    if (typeof document === 'undefined') return

    // Latest version wins on hot-reload: tear the previous incarnation down
    // through the host's own hook, never through a closure we kept around.
    try {
      globalThis[SLOT]?.dispose?.()
    } catch {
      /* a stale teardown must never wedge this one */
    }
    globalThis[SLOT] = null

    const observer = new MutationObserver(() => ensureButton(ctx))
    observer.observe(document.body, { childList: true, subtree: true })

    const timer = window.setInterval(() => assignColors(ctx.storage), ASSIGN_INTERVAL_MS)
    const onFocus = () => assignColors(ctx.storage)
    window.addEventListener('focus', onFocus)

    const disposers = []

    try {
      disposers.push(
        ctx.register({
          area: STATUSBAR_AREAS.right,
          id: 'color-chip',
          order: 74,
          render: () => h(TopicColorChip, { ctx }),
          title: 'رنگ تاپیک‌ها'
        })
      )
    } catch (error) {
      console.error(`[${ID}] colour chip failed`, error)
    }

    try {
      disposers.push(
        ctx.register({
          area: PALETTE_AREA,
          data: {
            id: `${ID}.assignColors`,
            keywords: ['topic', 'color', 'رنگ', 'تاپیک', 'auto-topic'],
            label: 'Auto-topic: رنگ سشن‌ها را از نو ست کن',
            run: () => assignColors(ctx.storage)
          },
          id: 'assign-colors',
          order: 60
        })
      )
    } catch (error) {
      console.error(`[${ID}] palette entry failed`, error)
    }

    const dispose = () => {
      observer.disconnect()
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      for (const off of disposers) {
        try {
          off()
        } catch {
          /* never fatal */
        }
      }
    }

    globalThis[SLOT] = { dispose }
    ctx?.onDispose?.(dispose)

    ensureButton(ctx) // dialog may already be open when the plugin loads
    assignColors(ctx.storage)
  }
}
