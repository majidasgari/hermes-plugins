/**
 * فارسی‌ساز برای رابط وب DeepSeek Harness (dsh web) — page-script port.
 *
 * Ported from Max's own Firefox add-on `فارسی‌ساز — وزیرمتن و راست‌چین`
 * (repo: /data/Codes/firefox-farsi-helper, extension/content/content.js), which
 * itself ports the Hermes `vazirmatn-font` desktop plugin. Same rules, same
 * attribute names, same three mark tiers:
 *
 *   1. block            p/li/h1-h6/blockquote/label/… with a Persian char
 *   2. table cell       td/th with a Persian char
 *   3. leaf text        div/span/a/button/… that carries Persian AND has no
 *                       block-level descendant (so a layout wrapper never flips
 *                       while the bare span inside it does)
 *   4. form field       text/textarea/contenteditable whose VALUE is Persian
 *
 * Everything else stays LTR (his standing rule: only lines that carry at least
 * one Persian/Arabic letter flip), and `pre/code/kbd/samp` never flip.
 *
 * Differences from the add-on (it is a page script now, not an extension):
 *   • no browser.storage / onMessage wiring — the pass is always on, all four
 *     features enabled, because this file only ever loads inside dsh's own UI;
 *   • the font comes from `./vazirmatn.woff2` next to this file instead of
 *     `browser.runtime.getURL(...)`.
 *
 * Installed by ../tools/apply_dsh_rtl.py into the dsh web frontend dist and
 * referenced from its index.html between the `dsh-rtl` markers. Re-run that
 * script after any dsh upgrade (the dist is overwritten by `npm i -g`).
 */
(function () {
  'use strict'

  var ATTR_BLOCK = 'data-fh-rtl-block'
  var ATTR_CELL = 'data-fh-rtl-cell'
  var ATTR_FIELD = 'data-fh-rtl-field'
  var ATTR_TEXT = 'data-fh-rtl-text'
  var ATTR_ROOT = 'data-fh-font'

  var RTL_BLOCK_SELECTOR =
    'p, li, dt, dd, h1, h2, h3, h4, h5, h6, blockquote, figcaption, caption, summary, legend, label, address, cite'
  var RTL_CELL_SELECTOR = 'td, th'
  var FIELD_SELECTOR =
    "input[type='text'], input[type='search'], input[type='email'], input[type='url'], input[type='tel'], input:not([type]), textarea, [contenteditable=''], [contenteditable='true']"
  var TEXT_SELECTOR =
    'div, span, a, label, button, strong, em, b, i, small, u, s, mark, time, dt, dd, figcaption, summary'
  var BLOCKY_SELECTOR =
    'div, p, ul, ol, li, h1, h2, h3, h4, h5, h6, table, thead, tbody, tr, td, th, section, article, header, footer, nav, aside, main, form, fieldset, pre, blockquote, figure, figcaption, details, summary, dl, dt, dd, hr'
  var EXCLUDED_SELECTOR =
    'pre, code, kbd, samp, svg, math, script, style, noscript, textarea, select, option'

  var FONT_STYLE_ID = 'fh-font-css'

  var NON_TEXT_INPUT_TYPES = {
    password: true,
    number: true,
    checkbox: true,
    radio: true,
    file: true,
    range: true,
    date: true,
    time: true,
    color: true,
    hidden: true,
    submit: true,
    button: true,
    reset: true,
    image: true
  }

  /* ── Persian/Arabic detection (verbatim from the add-on) ────────────────── */

  var ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/
  var ARABIC_PUNCT = /[\u060C\u061B\u061F\u066A-\u066D]/
  var INVISIBLE = /[\u0300-\u036F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/

  /** True when `text` carries at least one VISIBLE Persian/Arabic character. */
  function needsRtl(text) {
    if (typeof text !== 'string' || !text) {
      return false
    }

    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i)

      if (INVISIBLE.test(ch)) {
        continue
      }

      if (ARABIC.test(ch) || ARABIC_PUNCT.test(ch)) {
        return true
      }
    }

    return false
  }

  /* ── Guards ────────────────────────────────────────────────────────────── */

  function isExcluded(el) {
    if (!el || el.nodeType !== 1) {
      return true
    }

    if (el.tagName === 'TEXTAREA') {
      return !!(el.parentElement && el.parentElement.closest(EXCLUDED_SELECTOR))
    }

    return !!el.closest(EXCLUDED_SELECTOR)
  }

  function isTextField(el) {
    if (!el || el.nodeType !== 1) {
      return false
    }

    var tag = el.tagName

    if (tag === 'TEXTAREA') {
      return true
    }

    if (tag === 'INPUT') {
      var type = (el.getAttribute('type') || 'text').toLowerCase()
      return !NON_TEXT_INPUT_TYPES[type]
    }

    var editable = el.getAttribute('contenteditable')
    return editable === '' || editable === 'true' || el.isContentEditable === true
  }

  function alreadyRtl(el) {
    try {
      var view = (el.ownerDocument && el.ownerDocument.defaultView) || globalThis
      return view.getComputedStyle(el).direction === 'rtl'
    } catch (error) {
      return false
    }
  }

  /* ── Apply functions ───────────────────────────────────────────────────── */

  function mark(el, attr, extraGuard) {
    if (!el || el.nodeType !== 1 || isExcluded(el)) {
      if (el && el.removeAttribute) {
        el.removeAttribute(attr)
      }
      return
    }

    if (!needsRtl(el.textContent)) {
      el.removeAttribute(attr)
      return
    }

    if (extraGuard && !extraGuard(el)) {
      el.removeAttribute(attr)
      return
    }

    if (el.hasAttribute(attr)) {
      return
    }

    if (alreadyRtl(el)) {
      el.removeAttribute(attr)
      return
    }

    el.setAttribute(attr, '1')
  }

  function leafGuard(el) {
    return typeof el.querySelector !== 'function' || el.querySelector(BLOCKY_SELECTOR) === null
  }

  function applyBlock(el) {
    mark(el, ATTR_BLOCK)
  }

  function applyCell(el) {
    mark(el, ATTR_CELL)
  }

  function applyText(el) {
    mark(el, ATTR_TEXT, leafGuard)
  }

  function applyField(el) {
    if (!el || el.nodeType !== 1 || isExcluded(el) || !isTextField(el)) {
      if (el && el.removeAttribute) {
        el.removeAttribute(ATTR_FIELD)
      }
      return
    }

    var value = 'value' in el ? el.value : el.textContent

    if (needsRtl(value)) {
      el.setAttribute(ATTR_FIELD, '1')
    } else {
      el.removeAttribute(ATTR_FIELD)
    }
  }

  /* ── Font ──────────────────────────────────────────────────────────────── */

  var FONT_URL = (function () {
    try {
      if (document.currentScript && document.currentScript.src) {
        return new URL('./vazirmatn.woff2', document.currentScript.src).href
      }
    } catch (error) {
      /* fall through */
    }
    return './dsh-rtl/vazirmatn.woff2'
  })()

  function buildFontCss(url) {
    return [
      '@font-face {',
      "  font-family: 'Vazirmatn FH';",
      '  src: url("' + url + '") format(\'woff2-variations\'),',
      '       url("' + url + '") format(\'woff2\');',
      '  font-weight: 100 900;',
      '  font-style: normal;',
      '  font-display: swap;',
      '}',
      'html[data-fh-font="1"],',
      'html[data-fh-font="1"] body,',
      'html[data-fh-font="1"] body :not(pre):not(code):not(kbd):not(samp):not(tt):not(svg):not(svg *):not(math):not(.fa):not(.fas):not(.far):not(.fab):not(.fad):not([class*="fa-"]):not([class*="-icon"]):not([class*="icon-"]):not([class*="iconfont"]):not([class*="material-icons"]):not([class*="material-symbols"]):not([class*="glyphicon"]):not([class*="mdi"]):not([class*="codicon"]):not([class*="monaco"]):not([class*="CodeMirror"]):not([class*="cm-"]):not([class*="octicon"]):not([class*="bi-"]) {',
      "  font-family: 'Vazirmatn FH', Vazirmatn, 'Vazirmatn UI', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif !important;",
      '}',
      'html[data-fh-font="1"] pre,',
      'html[data-fh-font="1"] pre *,',
      'html[data-fh-font="1"] code,',
      'html[data-fh-font="1"] code *,',
      'html[data-fh-font="1"] kbd,',
      'html[data-fh-font="1"] samp,',
      'html[data-fh-font="1"] [class*="monaco"],',
      'html[data-fh-font="1"] [class*="CodeMirror"] {',
      "  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace !important;",
      '}'
    ].join('\n')
  }

  function injectFont(doc) {
    var style = doc.getElementById(FONT_STYLE_ID)

    if (!style) {
      style = doc.createElement('style')
      style.id = FONT_STYLE_ID
      ;(doc.head || doc.documentElement).appendChild(style)
    }

    style.textContent = buildFontCss(FONT_URL)
    doc.documentElement.setAttribute(ATTR_ROOT, '1')
  }

  function removeFont(doc) {
    var style = doc.getElementById(FONT_STYLE_ID)

    if (style) {
      style.remove()
    }

    doc.documentElement.removeAttribute(ATTR_ROOT)
  }

  /* ── Live state ────────────────────────────────────────────────────────── */

  var live = {
    doc: null,
    observer: null,
    scheduled: false,
    frameId: 0,
    full: false,
    blocks: new Set(),
    cells: new Set(),
    fields: new Set(),
    texts: new Set(),
    inputHandler: null,
    inputBound: false
  }

  function raf(fn) {
    return typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame(fn)
      : globalThis.setTimeout(fn, 16)
  }

  function caf(id) {
    if (typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(id)
    } else {
      globalThis.clearTimeout(id)
    }
  }

  function scheduleFrame() {
    if (live.scheduled) {
      return
    }
    live.scheduled = true
    live.frameId = raf(flush)
  }

  function flush() {
    live.scheduled = false
    live.frameId = 0

    var doc = live.doc || document
    var sweepEverything = live.full
    var cells = Array.from(live.cells)
    var blocks = Array.from(live.blocks)
    var fields = Array.from(live.fields)
    var texts = Array.from(live.texts)

    live.cells.clear()
    live.blocks.clear()
    live.fields.clear()
    live.texts.clear()
    live.full = false

    if (sweepEverything) {
      doc.querySelectorAll(RTL_CELL_SELECTOR).forEach(applyCell)
      doc.querySelectorAll(RTL_BLOCK_SELECTOR).forEach(applyBlock)
      doc.querySelectorAll(TEXT_SELECTOR).forEach(applyText)
      doc.querySelectorAll(FIELD_SELECTOR).forEach(applyField)
      return
    }

    cells.forEach(function (el) {
      if (el.isConnected) applyCell(el)
    })
    blocks.forEach(function (el) {
      if (el.isConnected) applyBlock(el)
    })
    texts.forEach(function (el) {
      if (el.isConnected) applyText(el)
    })
    fields.forEach(function (el) {
      if (el.isConnected) applyField(el)
    })
  }

  function collect(el, selector, target, sweepDescendants) {
    var found = false

    if (typeof el.closest === 'function') {
      var owner = el.closest(selector)

      if (owner) {
        target.add(owner)
        found = true
      }
    }

    if (sweepDescendants && typeof el.querySelectorAll === 'function') {
      el.querySelectorAll(selector).forEach(function (node) {
        target.add(node)
        found = true
      })
    }

    return found
  }

  /** rAF-batched, targeted mutation handling (same design as the add-on). */
  function schedule(node, addedSubtrees) {
    var el = !node ? null : node.nodeType === 1 ? node : node.parentElement

    if (!el || typeof el.querySelector !== 'function') {
      return
    }

    var needsFrame = false

    if (collect(el, RTL_BLOCK_SELECTOR, live.blocks, addedSubtrees)) {
      needsFrame = true
    }

    var cell = el.closest(RTL_CELL_SELECTOR)

    if (cell) {
      live.cells.add(cell)
      needsFrame = true
    } else if (el.closest('table') || el.querySelector('table, td, th')) {
      live.full = true
      needsFrame = true
    }

    if (collect(el, FIELD_SELECTOR, live.fields, addedSubtrees)) {
      needsFrame = true
    }

    if (collect(el, TEXT_SELECTOR, live.texts, addedSubtrees)) {
      needsFrame = true
    }

    if (needsFrame) {
      scheduleFrame()
    }
  }

  function startObserver(doc) {
    if (live.observer || !doc.body) {
      return
    }

    live.observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var record = records[i]
        schedule(record.target, record.type === 'childList' && record.addedNodes.length > 0)
      }
    })

    live.observer.observe(doc.body, { childList: true, characterData: true, subtree: true })
  }

  function bindFieldEvents(doc) {
    if (live.inputBound) {
      return
    }

    live.inputBound = true
    live.inputHandler = function (event) {
      var el = event.target

      if (!el || el.nodeType !== 1) {
        return
      }

      var matches = false

      try {
        matches = el.matches(FIELD_SELECTOR) && isTextField(el)
      } catch (error) {
        matches = false
      }

      if (!matches) {
        return
      }

      live.fields.add(el)
      scheduleFrame()
    }

    doc.addEventListener('input', live.inputHandler, true)
    doc.addEventListener('focusin', live.inputHandler, true)
  }

  /* ── Apply / clear ─────────────────────────────────────────────────────── */

  function clearMarkers(doc, attrs) {
    attrs.forEach(function (attr) {
      doc.querySelectorAll('[' + attr + ']').forEach(function (el) {
        el.removeAttribute(attr)
      })
    })
  }

  function applyAll(doc) {
    doc = doc || document
    live.doc = doc

    injectFont(doc)
    doc.querySelectorAll(RTL_CELL_SELECTOR).forEach(applyCell)
    doc.querySelectorAll(RTL_BLOCK_SELECTOR).forEach(applyBlock)
    doc.querySelectorAll(TEXT_SELECTOR).forEach(applyText)
    doc.querySelectorAll(FIELD_SELECTOR).forEach(applyField)
    bindFieldEvents(doc)
    startObserver(doc)

    return true
  }

  function clearAll(doc) {
    doc = doc || document

    if (live.observer) {
      live.observer.disconnect()
      live.observer = null
    }

    if (live.inputBound && live.inputHandler) {
      doc.removeEventListener('input', live.inputHandler, true)
      doc.removeEventListener('focusin', live.inputHandler, true)
      live.inputBound = false
      live.inputHandler = null
    }

    removeFont(doc)
    clearMarkers(doc, [ATTR_BLOCK, ATTR_CELL, ATTR_FIELD, ATTR_TEXT, ATTR_ROOT])
  }

  /* ── Boot ──────────────────────────────────────────────────────────────── */

  function whenBodyReady(callback) {
    var done = false

    var run = function () {
      if (done) {
        return
      }
      done = true
      callback()
    }

    if (document.body) {
      run()
      return
    }

    document.addEventListener('DOMContentLoaded', run, { once: true })

    var tick = function () {
      if (done) {
        return
      }
      if (document.body) {
        run()
        return
      }
      globalThis.setTimeout(tick, 30)
    }

    globalThis.setTimeout(tick, 30)
  }

  function init() {
    if (typeof document === 'undefined') {
      return
    }

    whenBodyReady(function () {
      applyAll(document)
    })
  }

  globalThis.FarsiHarnessWeb = {
    needsRtl: needsRtl,
    applyAll: applyAll,
    clearAll: clearAll,
    fontUrl: FONT_URL,
    RTL_BLOCK_SELECTOR: RTL_BLOCK_SELECTOR,
    TEXT_SELECTOR: TEXT_SELECTOR,
    FIELD_SELECTOR: FIELD_SELECTOR
  }

  init()
})()
