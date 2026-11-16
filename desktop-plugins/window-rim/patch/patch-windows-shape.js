#!/usr/bin/env node
/**
 * hermes-window-shape — give the Hermes desktop app REALLY rounded window
 * corners on Windows.
 *
 * Why a patch and not a plugin: corner radius is a property of the native
 * window, and a renderer plugin cannot create one. On Linux the app is patched
 * to be born with an alpha surface + clipped shell CSS; on Windows that route
 * is closed (`transparent: true` breaks RESIZABLE windows — electron#48421,
 * which is exactly why electron/main.ts refuses it on win32). Windows does
 * have a first-class answer instead: `BaseWindow.setShape(rects)` (Windows,
 * experimental) shapes the window with a native region, so the four corners
 * simply do not exist — the desktop shows through them with no transparency.
 *
 * This script appends a small bootstrap to the BUILT main bundle
 * (resources/app.asar.unpacked/dist/electron-main.mjs) and exposes one
 * preload call (`window.hermesDesktop.setWindowShape(px)`), which the
 * `window-rim` desktop plugin drives from its radius control. Radius 0
 * removes the region, i.e. the stock rectangle.
 *
 * Usage:
 *   node patch-windows-shape.js status
 *   node patch-windows-shape.js apply
 *   node patch-windows-shape.js revert
 *   [--app <path to resources/app.asar.unpacked/dist>]
 *
 * A MAIN-process change needs the app CLOSED and REOPENED; a renderer reload
 * is not enough. `apply` keeps `<file>.stock` backups and `revert` restores
 * them byte-for-byte. Re-run `apply` after any app rebuild/update.
 */

const fs = require('node:fs')
const path = require('node:path')

const BEGIN = '/* hermes-window-shape:begin */'
const END = '/* hermes-window-shape:end */'
const PRELOAD_ANCHOR = '  getConnection: (profile, opts) => import_electron.ipcRenderer.invoke("hermes:connection", profile, opts),'
const PRELOAD_LINE = '  setWindowShape: (radius) => import_electron.ipcRenderer.send("hermes:window:shape", radius),'

const PAYLOAD = `${BEGIN}
;(function () {
  // Shapes every Hermes window with a native rounded region, driven by the
  // window-rim desktop plugin. Injected by hermes-window-shape.
  if (process.platform !== 'win32') return
  var electron, pathMod, fsMod
  try {
    electron = require('electron')
    pathMod = require('node:path')
    fsMod = require('node:fs')
  } catch (error) {
    console.error('[hermes-window-shape] unavailable:', error && error.message)
    return
  }
  var SKIP = { hud: 1, overlay: 1, quick: 1, wake: 1, intro: 1 }
  var FILE = pathMod.join(electron.app.getPath('userData'), 'window-shape.json')
  var shaped = new WeakMap()
  var watched = new WeakSet()
  var timers = new WeakMap()

  function readRadius() {
    try {
      var raw = JSON.parse(fsMod.readFileSync(FILE, 'utf8'))
      var n = Number(raw && raw.radius)
      if (!isFinite(n)) return 0
      return Math.max(0, Math.min(64, Math.round(n)))
    } catch (error) {
      return 0
    }
  }

  var radius = readRadius()

  function cornerRects(w, h, r) {
    r = Math.max(0, Math.min(Math.round(r), Math.floor(Math.min(w, h) / 2)))
    var list = []
    if (!r) return list
    for (var y = 0; y < r; y++) {
      var dy = r - y - 0.5
      var inset = Math.round(r - Math.sqrt(Math.max(0, r * r - dy * dy)))
      var width = Math.max(0, w - inset * 2)
      // NEVER skip a row whose inset rounds to 0: those are the rows closest to
      // the straight edge, and the middle rect only starts at y=r — skipping
      // them leaves a ~5 px TRANSPARENT BAND across the window, just inside the
      // top and bottom edges. An inset of 0 is simply a full-width row.
      list.push({ x: inset, y: y, width: width, height: 1 })
      list.push({ x: inset, y: h - 1 - y, width: width, height: 1 })
    }
    list.push({ x: 0, y: r, width: w, height: Math.max(0, h - r * 2) })
    return list
  }

  // true = skip (transparent overlay window), false = shape it, null = the
  // window has not loaded yet, so we do not know what it is.
  function skipWindow(win) {
    try {
      var url = win.webContents.getURL()
      if (!url) return null
      var kind = new URL(url).searchParams.get('win')
      return !!(kind && SKIP[kind])
    } catch (error) {
      return null
    }
  }

  function paint(win) {
    if (!win || win.isDestroyed() || typeof win.setShape !== 'function') return
    var wasShaped = shaped.get(win) === true
    var skip = skipWindow(win)
    if (skip === null) return
    var want = radius > 0 && !skip && !win.isMaximized() && !win.isFullScreen() && !win.isMinimized()
    try {
      if (!want) {
        if (wasShaped) {
          win.setShape([])
          shaped.set(win, false)
        }
        return
      }
      var b = win.getBounds()
      if (b.width < radius * 2 + 4 || b.height < radius * 2 + 4) return
      win.setShape(cornerRects(b.width, b.height, radius))
      shaped.set(win, true)
    } catch (error) {
      console.error('[hermes-window-shape] paint failed:', error && error.message)
    }
  }

  function schedule(win) {
    var timer = timers.get(win)
    if (timer) clearTimeout(timer)
    timers.set(win, setTimeout(function () { paint(win) }, 80))
  }

  function watch(win) {
    if (!win || watched.has(win)) return
    watched.add(win)
    paint(win)
    // Geometry events repaint SYNCHRONOUSLY: a region is in window coordinates,
    // so a stale one clips the new area until it is replaced — during a resize
    // drag that reads as a chopped window edge.
    var geometry = ['resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']
    geometry.forEach(function (name) {
      win.on(name, function () { paint(win) })
    })
    win.on('show', function () { schedule(win) })
    try {
      win.webContents.on('did-finish-load', function () { schedule(win) })
    } catch (error) {}
  }

  electron.app.on('browser-window-created', function (_event, win) { watch(win) })
  electron.app.whenReady().then(function () {
    electron.BrowserWindow.getAllWindows().forEach(watch)
  })

  electron.ipcMain.on('hermes:window:shape', function (event, value) {
    var n = Number(value)
    n = isFinite(n) ? Math.max(0, Math.min(64, Math.round(n))) : 0
    if (n === radius) return
    radius = n
    try {
      fsMod.writeFileSync(FILE, JSON.stringify({ radius: radius }, null, 2))
    } catch (error) {}
    electron.BrowserWindow.getAllWindows().forEach(function (win) {
      shaped.set(win, false)
      paint(win)
    })
  })

  console.error('[hermes-window-shape] active (radius=' + radius + ')')
})()
${END}`

function targetDir(argv) {
  const flag = argv.indexOf('--app')
  if (flag !== -1) {
    return path.resolve(argv[flag + 1])
  }
  const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local')
  return path.join(local, 'hermes', 'hermes-agent', 'apps', 'desktop', 'release', 'win-unpacked', 'resources', 'app.asar.unpacked', 'dist')
}

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function backup(file) {
  const stock = `${file}.stock`
  if (!fs.existsSync(stock)) {
    fs.copyFileSync(file, stock)
  }
  return stock
}

function stripPayload(source) {
  const start = source.indexOf(BEGIN)
  if (start === -1) {
    return source
  }
  const end = source.indexOf(END, start)
  if (end === -1) {
    throw new Error('found the begin marker without its end marker — restore the .stock copy')
  }
  let after = end + END.length
  if (source[after] === '\r') after += 1
  if (source[after] === '\n') after += 1
  let before = start
  if (source[before - 1] === '\n') before -= 1
  if (source[before - 1] === '\r') before -= 1
  return source.slice(0, before) + source.slice(after ? after : end + END.length)
}

function patchMain(source) {
  const clean = stripPayload(source)
  const eol = clean.includes('\r\n') ? '\r\n' : '\n'
  const block = PAYLOAD.replace(/\n/g, eol)
  const separator = clean.endsWith(eol) ? '' : eol
  return `${clean}${separator}${block}${eol}`
}

function patchPreload(source, undo) {
  const lines = source.split(/\r?\n/)
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const without = lines.filter(line => line.trim() !== PRELOAD_LINE.trim())
  if (undo) {
    return without.join(eol)
  }
  const anchor = without.findIndex(line => line.trim() === PRELOAD_ANCHOR.trim())
  if (anchor === -1) {
    throw new Error('preload anchor not found (the bundled preload changed) — nothing was written')
  }
  without.splice(anchor, 0, PRELOAD_LINE)
  return without.join(eol)
}

function main() {
  const argv = process.argv.slice(2)
  const command = argv[0] || 'status'
  const dir = targetDir(argv)
  const mainFile = path.join(dir, 'electron-main.mjs')
  const preloadFile = path.join(dir, 'electron-preload.js')

  if (!fs.existsSync(mainFile) || !fs.existsSync(preloadFile)) {
    console.error(`not a Hermes desktop bundle: ${dir}`)
    process.exit(1)
  }

  const mainSrc = read(mainFile)
  const preloadSrc = read(preloadFile)
  const patched = mainSrc.includes(BEGIN) && preloadSrc.includes(PRELOAD_LINE.trim())
  const radiusFile = path.join(process.env.APPDATA || '', 'Hermes', 'window-shape.json')
  let radius = 'unset'
  try {
    radius = String(JSON.parse(read(radiusFile)).radius)
  } catch (error) {}

  if (command === 'status') {
    console.log(`bundle   ${dir}`)
    console.log(`patch    ${patched ? 'APPLIED' : 'NOT APPLIED'}`)
    console.log(`backups  main=${fs.existsSync(`${mainFile}.stock`) ? 'yes' : 'no'} preload=${fs.existsSync(`${preloadFile}.stock`) ? 'yes' : 'no'}`)
    console.log(`radius   ${radius}`)
    return
  }

  if (command === 'apply') {
    backup(mainFile)
    backup(preloadFile)
    fs.writeFileSync(mainFile, patchMain(mainSrc))
    fs.writeFileSync(preloadFile, patchPreload(preloadSrc, false))
    console.log('applied — close and reopen Hermes for the main process to pick it up')
    return
  }

  if (command === 'revert') {
    let restored = 0
    for (const file of [mainFile, preloadFile]) {
      const stock = `${file}.stock`
      if (fs.existsSync(stock)) {
        fs.copyFileSync(stock, file)
        restored += 1
      }
    }
    if (!restored) {
      fs.writeFileSync(mainFile, stripPayload(mainSrc))
      fs.writeFileSync(preloadFile, patchPreload(preloadSrc, true))
      restored = 2
    }
    console.log(`reverted ${restored} file(s) — close and reopen Hermes`)
    return
  }

  console.error(`unknown command: ${command} (use status | apply | revert)`)
  process.exit(1)
}

main()
