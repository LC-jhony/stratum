(async () => { // welcome logo: bundled SVG loads and follows the color theme
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), t = window.__themes
  await sleep(400)
  const img = () => document.querySelector('.welcome .logo'), src = () => img()?.getAttribute('src') ?? ''
  const first = src(), loaded = !!img() && img().naturalWidth > 0
  const wanted = first.includes('on-light') ? 'builtin:carbon-dark.json' : 'builtin:carbon-light.json'
  await t.set(t.catalog.find((e) => e.id === wanted)); await sleep(300)
  const second = src()
  return { loaded, switched: second !== first && second !== '', loadedAfterSwitch: !!img() && img().naturalWidth > 0, variant: second.split('/').pop(), light: document.documentElement.dataset.theme }
})()
//---
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), api = window.stratum, wb = window.__wb
  await sleep(1200)
  const id = 'shop'
  await api.connections.save({ id, name: 'shop.db', kind: 'sqlite', filePath: ':memory:' })
  await wb.getState().load(); await wb.getState().connect(id)
  const ex = (q) => api.db.execute(id, q, {})
  for (const q of [
    'create table customers (id integer primary key, name text not null, email text unique, country_id integer)',
    'create table countries (id integer primary key, code text not null, name text)',
    'create table products (id integer primary key, title text not null, price real, category_id integer)',
    'create table categories (id integer primary key, name text, parent_id integer references categories(id))',
    'create table orders (id integer primary key, customer_id integer not null references customers(id), placed_at text, status text)',
    'create table order_items (order_id integer references orders(id), product_id integer references products(id), qty integer not null, primary key (order_id, product_id))',
    'create table payments (id integer primary key, order_id integer references orders(id), amount real)',
    "insert into countries values (1,'PE','Peru'),(2,'US','United States')",
    "insert into customers values (1,'Ana Torres','ana@x.io',1),(2,'Bob Lee','bob@x.io',2),(3,'Carla Díaz',null,1)",
    "insert into orders values (1,1,'2026-10-01','paid'),(2,2,'2026-10-05','pending')",
  ]) { const r = await ex(q); if (r.error) return { fail: r.error, q } }
  await wb.getState().refresh(id); await sleep(300)
  wb.getState().openConsole(id, "select c.name, c.email, o.status\nfrom customers c\n  left join orders o on o.customer_id = c.id\norder by c.id;\n")
  await sleep(600)
  const tab = wb.getState().tabs[0]
  await wb.getState().run(tab.id, ["select c.name, c.email, o.status from customers c left join orders o on o.customer_id = c.id order by c.id"])
  wb.getState().openTable(id, 'customers', 'main')
  await sleep(800)
  return { tabs: wb.getState().tabs.length, rows: wb.getState().tabs[0].results[0].result.rows.length }
})()
//--- diagram
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), wb = window.__wb
  wb.getState().openDiagram('shop'); await sleep(1500)
  // Type through the native setter so React sees the finder input like a real keystroke.
  const input = document.querySelector('.erd-search input')
  if (input) { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, 'cust'); input.dispatchEvent(new Event('input', { bubbles: true })) }
  await sleep(400)
  return {
    nodes: document.querySelectorAll('.erd-svg .node').length,
    edges: document.querySelectorAll('.erd-svg .edge').length,
    zoom: document.querySelector('.zoom-pct')?.textContent,
    search: document.querySelector('.erd-search-count')?.textContent,
    hits: [...document.querySelectorAll('.erd-svg .node.on')].map((n) => n.dataset.id),
    exportMenu: !!document.querySelector('.editor-toolbar button[title="Export diagram"]'),
  }
})()
//--- dark
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), t = window.__themes
  await t.set(t.catalog.find((e) => e.id === 'builtin:carbon-dark.json')); await sleep(600)
  const wb = window.__wb; wb.getState().setActive(wb.getState().tabs[0].id); await sleep(500)
  return document.documentElement.dataset.theme
})()
//--- dark table
(async () => { const wb = window.__wb; wb.getState().setActive(wb.getState().tabs[1].id); await new Promise((r) => setTimeout(r, 600)); return document.querySelectorAll('.grid-row').length })()
//--- dark erd
(async () => { const wb = window.__wb; wb.getState().setActive(wb.getState().tabs[2].id); await new Promise((r) => setTimeout(r, 700)); return 1 })()
//--- completion
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), wb = window.__wb
  wb.getState().setActive(wb.getState().tabs[0].id); await sleep(700)
  const e = window.__editor
  const sql = 'select * from customers c where c.'
  e.setValue(sql); e.setPosition({ lineNumber: 1, column: sql.length + 1 }); e.focus(); await sleep(300)
  e.trigger('smoke', 'editor.action.triggerSuggest', {}); await sleep(900)
  const widget = document.querySelector('.suggest-widget')
  const rowEls = [...document.querySelectorAll('.suggest-widget .monaco-list-row')]
  const rows = rowEls.map((r) => r.textContent || '')
  const visible = !!widget && !widget.classList.contains('hidden') && rows.length > 0
  // Labels must sit inside their row rect: catches global CSS that stacks/clips suggest rows (icons-only bug).
  const inRow = (r) => {
    const lab = r.querySelector('.label-name'); if (!lab) return false
    const a = lab.getBoundingClientRect(), b = r.getBoundingClientRect()
    return a.width > 1 && a.height > 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1 && a.left >= b.left - 1 && a.right <= b.right + 1
  }
  const labelsVisible = rowEls.length > 0 && rowEls.every(inRow)
  try { e.trigger('smoke', 'hideSuggestWidget', {}) } catch { }
  await sleep(200)
  return { visible, rows: rows.length, hasEmail: rows.some((t) => t.includes('email')), labelsVisible, sample: rows.slice(0, 4) }
})()
//--- settings
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), wb = window.__wb
  wb.getState().openSettings(); await sleep(500)
  const dlg = document.querySelector('.dialog[aria-label="Settings"]')
  const open = !!dlg, fields = dlg ? dlg.querySelectorAll('.field, .check').length : 0
  const prev = wb.getState().prefs['editor.fontSize']
  await wb.getState().savePrefs({ 'editor.fontSize': 15 })
  const persisted = (await window.stratum.settings.get())['editor.fontSize']
  await wb.getState().savePrefs({ 'editor.fontSize': prev })
  wb.getState().closeSettings(); await sleep(200)
  return { open, fields, persisted, closed: !document.querySelector('.dialog[aria-label="Settings"]') }
})()
//--- params
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), wb = window.__wb
  const tab = wb.getState().tabs[0]
  wb.getState().setActive(tab.id); await sleep(500)
  const e = window.__editor
  const sql = 'select * from customers c where c.email = :email'
  e.setValue(sql); e.setPosition({ lineNumber: 1, column: sql.length + 1 }); await sleep(250)
  const runP = wb.getState().run(tab.id, [sql])
  await sleep(700)
  const dlg = document.querySelector('.dialog[aria-label="SQL parameters"]')
  const open = !!dlg
  const input = dlg && dlg.querySelector('input')
  if (input) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'ana@x.io')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  await sleep(150)
  const btn = dlg ? [...dlg.querySelectorAll('footer button')].find((b) => b.textContent.includes('Execute')) : undefined
  if (btn) btn.click()
  await runP; await sleep(400)
  const rows = wb.getState().tabs[0].results.at(-1)?.result.rows ?? []
  const saved = (await window.stratum.settings.get())['query.parameters.values']
  return { open, clicked: !!btn, rows: rows.length, first: rows[0] && rows[0][0], remembered: saved && saved.email === 'ana@x.io', exportBtn: !!document.querySelector('.result-tabs button[title="Export data"]') }
})()
//--- history
(async () => {
  const wb = window.__wb
  const tab = wb.getState().tabs[0]
  const hist = wb.getState().history[tab.connectionId] || []
  const persisted = (await window.stratum.history.get()) || {}
  return { entries: hist.length, hasParamSql: hist.some((h) => h.indexOf(':email') >= 0), persisted: Object.values(persisted).some((a) => Array.isArray(a) && a.length > 0), button: !!document.querySelector('button[title="Query history"]') }
})()
//--- rename-findusages
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), wb = window.__wb
  wb.getState().setActive(wb.getState().tabs[0].id); await sleep(300)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  const filter = document.querySelector('.explorer .filter input')
  setter.call(filter, 'customers'); filter.dispatchEvent(new Event('input', { bubbles: true })); await sleep(300)
  const rows = () => [...document.querySelectorAll('.explorer .row')]
  const byLabel = (t) => rows().find((el) => { const l = el.querySelector('.label'); return l && l.textContent === t })
  byLabel('shop.db').click(); await sleep(700)
  if (byLabel('main')) { byLabel('main').click(); await sleep(300) } // expand the sqlite schema when collapsed
  const findRow = () => byLabel('customers')
  const rowEl = findRow()
  if (!rowEl) return { fail: 'no customers row', visible: rows().map((el) => (el.querySelector('.label') || {}).textContent).slice(0, 12) }
  const menuItems = () => [...document.querySelectorAll('.explorer .menu li')]
  rowEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 140, clientY: 140 })); await sleep(300)
  const hasRename = menuItems().some((li) => li.textContent.includes('Rename'))
  const hasUsages = menuItems().some((li) => li.textContent.includes('Find Usages'))
  const tabsBefore = wb.getState().tabs.length
  menuItems().find((li) => li.textContent.includes('Rename')).click(); await sleep(400)
  const rdlg = document.querySelector('.dialog[aria-label="Rename object"]')
  const open = !!rdlg
  if (rdlg) {
    const input = rdlg.querySelector('input')
    setter.call(input, 'clients'); input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(150)
    ;[...rdlg.querySelectorAll('footer button')].find((b) => b.textContent.includes('Generate')).click()
  }
  await sleep(500)
  const tabs = wb.getState().tabs
  const newTab = tabs[tabs.length - 1]
  const renamed = tabs.length === tabsBefore + 1 && /rename/i.test(newTab.sql) && newTab.sql.includes('clients')
  findRow().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 140, clientY: 140 })); await sleep(300)
  menuItems().find((li) => li.textContent.includes('Find Usages')).click(); await sleep(400)
  const udlg = document.querySelector('.dialog[aria-label="Find usages"]')
  const usageDialog = !!udlg, hits = udlg ? udlg.querySelectorAll('.usage').length : -1
  udlg?.querySelector('footer button')?.click(); await sleep(300) // a lingering dialog leaves its scrim over the workbench
  return { open, hasRename, hasUsages, renamed, usageDialog, hits, closed: !document.querySelector('.scrim') }
})()
//--- icons
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), wb = window.__wb, t = window.__themes
  wb.getState().setActive(wb.getState().tabs[0].id); await sleep(400)
  // Without a product icon theme every app icon must render as the vendored SVG set, not the codicon font.
  const svg = document.querySelectorAll('svg.stratum-icon').length
  const codicon = document.querySelectorAll('i.codicon').length
  const themed = !!t.active.productIcon
  return { svg, codicon, themed, ok: themed || (svg > 20 && codicon === 0) }
})()
//--- color themes: a VS Code extension copy of a bundled theme collapses into one picker entry
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), wb = window.__wb, t = window.__themes
  wb.setState({ palette: 'colorTheme' }); await sleep(400)
  const entries = [...document.querySelectorAll('.palette ul li')].map((li) => li.textContent)
  wb.setState({ palette: null }); await sleep(150)
  const colors = t.catalog.filter((e) => e.kind === 'color')
  return { entries: entries.length, unique: new Set(colors.map((e) => e.label.trim().toLowerCase())).size === colors.length, hasCarbon: entries.some((l) => l.startsWith('Carbon Dark')), hasMin: entries.some((l) => l.startsWith('Min Light')) }
})()
//--- layout & grid: wide results scroll inside the editor, sort/filter/paging work
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), wb = window.__wb
  wb.getState().setActive(wb.getState().tabs[0].id); await sleep(400)
  const tab = wb.getState().tabs[0]
  await wb.getState().run(tab.id, ['select c.id, c.name, c.email, c.country_id, o.id, o.customer_id, o.placed_at, o.status, co.id, co.code, co.name, c2.id, c2.name, c2.email, c2.country_id from customers c, orders o, countries co, customers c2'])
  await sleep(700)
  const vis = (sel) => [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().width > 0)
  const box = (sel) => { const e = vis(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right) } }
  const split = vis('.split'), grid = vis('.grid')
  const ed = box('.editor-area'), res = box('.results')
  const layout = {
    gridScrolls: !!grid && grid.scrollWidth > grid.clientWidth,
    splitOverflow: split ? split.scrollWidth - split.clientWidth : -1,
    insideEditor: !!ed && !!res && res.l >= ed.l - 1 && res.r <= ed.r + 1,
  }
  const head = [...document.querySelectorAll('.grid-head .cell.head')][1]
  head.click(); await sleep(200)
  const sorted = !!document.querySelector('.grid-head .sort-asc')
  const input = vis('.grid-filter input'), setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, 'Ana'); input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(250)
  const filterMeta = document.querySelector('.grid-filter .result-meta')?.textContent ?? ''
  setter.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(200)
  await wb.getState().run(tab.id, ['select c.id, c.name, c.email, o.id, o.status, co.code, c2.name, o2.id, c3.email from customers c, orders o, countries co, customers c2, orders o2, customers c3'])
  await sleep(600)
  const count = () => wb.getState().tabs[0].results.at(-1).result.rows.length
  const before = count()
  const next = [...document.querySelectorAll('.grid-foot button')].find((b) => b.textContent.includes('Fetch next'))
  if (next) next.click()
  await sleep(700)
  const onePage = count()
  const all = [...document.querySelectorAll('.grid-foot button')].find((b) => b.textContent.includes('Fetch all'))
  if (all) all.click()
  await sleep(900)
  // Export menu: portal over the tab strip, so opening it must be visible (hit-test inside the menu), not clipped.
  const expBtn = document.querySelector('.result-tabs button[title="Export data"]')
  if (expBtn) expBtn.click()
  await sleep(250)
  const menu = document.querySelector('body > .popmenu')
  const first = menu?.querySelector('button'), fr = first?.getBoundingClientRect()
  const hit = fr ? document.elementFromPoint(fr.left + fr.width / 2, fr.top + fr.height / 2) : null
  const exportMenu = { button: !!expBtn, opened: !!menu, items: menu ? menu.querySelectorAll('button').length : 0, hitTest: hit ? `${hit.tagName.toLowerCase()}.${typeof hit.className === 'string' ? hit.className.split(' ')[0] : ''}` : null, visible: !!(menu && fr && fr.bottom <= window.innerHeight && hit && menu.contains(hit)) }
  if (menu) { expBtn.click(); await sleep(250) } // close again (React flushes after the handler)
  // Activity bar: hover label per position, no accent line on the active entry.
  const on = document.querySelector('.stripe button.on')
  const activityBar = { boxShadow: getComputedStyle(on).boxShadow, label: on.dataset.label, tooltip: getComputedStyle(on, '::after').content, count: document.querySelectorAll('.stripe [data-label]').length }
  return { ...layout, sorted, filterMeta, fetch: { before, onePage, all: count(), nextButton: !!next, allButton: !!all, hasMore: wb.getState().tabs[0].results.at(-1).result.hasMore }, exportMenu, activityBar }
})()
