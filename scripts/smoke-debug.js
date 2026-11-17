// Opt-in debugger smoke. Requires a disposable PostgreSQL with pldbgapi and the demo routines
// described in docs/architecture/phase-12.md, plus STRATUM_PG_DEBUG=1 in the environment:
//
//   electron-vite build
//   STRATUM_PG_DEBUG=1 STRATUM_SMOKE=$PWD/scripts/smoke-debug.js \
//     STRATUM_PG_SOCKET=/tmp/opencode/pgsock STRATUM_PG_PORT=55432 \
//     npx electron . --no-sandbox --ozone-platform=wayland
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), api = window.stratum, wb = window.__wb
  const id = 'pg-debug-smoke'
  const host = '/tmp/opencode/pgsock'
  await api.connections.save({
    id, name: 'debug pg', kind: 'postgres', host,
    port: 55432, user: 'postgres', database: 'postgres',
  })
  await wb.getState().load()
  wb.getState().openDebugPicker(id)
  await sleep(1800)
  const dlg = document.querySelector('.dialog[aria-label="Debug stored routine"]')
  const routines = [...(dlg?.querySelectorAll('.debug-routine') ?? [])]
  return {
    dialog: !!dlg,
    probe: dlg?.querySelector('.debug-probe.ok')?.textContent?.trim() ?? null,
    routines: routines.map((b) => b.querySelector('.name')?.textContent).slice(0, 10),
    hasAdd: routines.some((b) => b.querySelector('.name')?.textContent === 'debug_add'),
    hasTouch: routines.some((b) => b.querySelector('.name')?.textContent === 'debug_touch'),
  }
})()
//---
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), wb = window.__wb
  const setInput = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const dlg = () => document.querySelector('.dialog[aria-label="Debug stored routine"]')
  const row = (name) => [...dlg().querySelectorAll('.debug-routine')].find((b) => b.querySelector('.name')?.textContent === name)
  const start = () => [...dlg().querySelectorAll('footer button')].find((b) => b.textContent.includes('Start debugging'))
  row('debug_touch').click(); await sleep(200)
  const optional = dlg().querySelector('.debug-optional')?.textContent ?? null
  const inputs = [...dlg().querySelectorAll('.debug-args input')]
  const disabledBefore = start().disabled
  setInput(inputs[0], '1'); await sleep(200)
  const enabledAfter = !start().disabled
  row('debug_add').click(); await sleep(200)
  const addInputs = [...dlg().querySelectorAll('.debug-args input')]
  setInput(addInputs[0], '1'); setInput(addInputs[1], '5'); await sleep(250)
  const call = dlg().querySelector('.debug-call code')?.textContent ?? ''
  start().click()
  await sleep(2600)
  const tabs = wb.getState().tabs.filter((t) => t.type === 'debug')
  const tab = tabs[tabs.length - 1]
  return {
    optional, disabledBefore, enabledAfter,
    call: call.slice(0, 120),
    tab: !!tab,
    status: tab?.status,
    state: document.querySelector('.debug-state')?.textContent?.trim() ?? null,
    source: document.querySelector('.debug-source-head strong')?.textContent ?? null,
    lines: document.querySelectorAll('.debug-view .view-line').length,
    frames: document.querySelectorAll('.debug-frame').length,
    variables: document.querySelectorAll('.debug-var').length,
    toolbar: [...document.querySelectorAll('.debug-toolbar button')].map((b) => b.textContent.trim()),
  }
})()
//---
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), wb = window.__wb
  const tab = wb.getState().tabs.find((t) => t.type === 'debug')
  if (!tab) return { fail: 'no debug tab' }
  const lines = tab.snapshot.source.text.split('\n')
  const line = lines.findIndex((l) => l.includes('v_total := v_total + p_amount')) + 1
  wb.getState().debugToggleBreakpoint(tab.id, line)
  await sleep(600)
  const withBp = wb.getState().tabs.find((t) => t.id === tab.id)
  await wb.getState().debugResume(tab.id)
  await sleep(400)
  const paused = wb.getState().tabs.find((t) => t.id === tab.id)
  const total = paused.snapshot.variables.find((v) => v.name === 'v_total')
  const gutter = document.querySelectorAll('.monaco-editor .debug-bp').length
  const currentLine = document.querySelectorAll('.monaco-editor .debug-current-line').length
  return {
    targetLine: line,
    registered: withBp.snapshot.breakpoints.some((b) => b.oid === withBp.snapshot.source.oid && b.line === line),
    gutter, currentLine,
    pausedAt: paused.snapshot.breakpoint?.line,
    status: paused.status,
    total: total?.value ?? null,
  }
})()
//---
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), wb = window.__wb, api = window.stratum
  const tab = wb.getState().tabs.find((t) => t.type === 'debug')
  if (!tab) return { fail: 'no debug tab' }
  await wb.getState().debugStop(tab.id)
  await sleep(400)
  const stopped = wb.getState().tabs.find((t) => t.id === tab.id)
  const rollbackNote = document.querySelector('.debug-state')?.textContent?.trim() ?? null
  wb.getState().closeTab(tab.id)
  await sleep(300)
  const closed = !wb.getState().tabs.some((t) => t.id === tab.id)

  // Console entry point: the bug button appears for PostgreSQL consoles and opens the picker.
  wb.getState().openConsole('pg-debug-smoke')
  await sleep(1800)
  const bug = document.querySelector('.console .editor-toolbar button[title="Debug a stored routine…"]')
  const consoleTab = wb.getState().tabs.find((t) => t.type === 'console' && t.connectionId === 'pg-debug-smoke')
  bug?.click(); await sleep(900)
  const picker = !!document.querySelector('.dialog[aria-label="Debug stored routine"]')
  wb.getState().set({ debugPicker: undefined })
  if (consoleTab) wb.getState().closeTab(consoleTab.id)
  await wb.getState().disconnect('pg-debug-smoke').catch(() => {})
  await api.connections.remove('pg-debug-smoke')
  await wb.getState().load()
  await sleep(300)
  return {
    stopped: stopped?.status,
    rollbackNote,
    closed,
    bugButton: !!bug,
    picker,
    removed: !wb.getState().connections.some((c) => c.id === 'pg-debug-smoke'),
  }
})()
