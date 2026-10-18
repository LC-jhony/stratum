import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { themes } from '../theme/themeManager'
import { useWorkbench } from '../store/workbench'
import { Icon } from '../ui/Icon'

interface Item { id: string; label: string; hint?: string; run(): void }

export function CommandPalette({ actions }: { actions: Item[] }) {
  const { palette, set } = useWorkbench()
  const [q, setQ] = useState(''), [i, setI] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useSyncExternalStore(themes.subscribe.bind(themes), () => themes.active)
  useEffect(() => { setQ(''); setI(0); setTimeout(() => input.current?.focus(), 0) }, [palette])

  const items = useMemo<Item[]>(() => {
    if (!palette) return []
    if (palette === 'actions') return actions
    const kind = palette === 'colorTheme' ? 'color' : palette === 'fileIconTheme' ? 'fileIcon' : 'productIcon'
    const current = themes.active[kind]?.entry.id
    const list: Item[] = themes.catalog.filter((e) => e.kind === kind).map((e) => ({ id: e.id, label: e.label, hint: `${e.source === 'vscode-extension' ? 'VS Code extension' : e.source}${e.id === current ? ' · current' : ''}`, run: () => void themes.set(e) }))
    if (kind !== 'color') list.unshift({ id: 'none', label: kind === 'fileIcon' ? 'None (built-in icons)' : 'Default (Codicons)', run: () => void themes.clear(kind) })
    return list
  }, [palette, actions])
  const shown = items.filter((x) => x.label.toLowerCase().includes(q.toLowerCase()))
  if (!palette) return null
  const title = { actions: 'Find Action', colorTheme: 'Select Color Theme', fileIconTheme: 'Select File Icon Theme', productIconTheme: 'Select Product Icon Theme' }[palette]
  const choose = (it?: Item) => { if (!it) return; set({ palette: null }); it.run() }
  return (
    <div className="scrim top" onMouseDown={(e) => e.target === e.currentTarget && set({ palette: null })}>
      <div className="palette">
        <div className="pal-input"><Icon id="search" /><input ref={input} placeholder={title} value={q} onChange={(e) => { setQ(e.target.value); setI(0) }}
          onKeyDown={(e) => { if (e.key === 'ArrowDown') { setI(Math.min(i + 1, shown.length - 1)); e.preventDefault() } else if (e.key === 'ArrowUp') { setI(Math.max(i - 1, 0)); e.preventDefault() } else if (e.key === 'Enter') choose(shown[i]); else if (e.key === 'Escape') set({ palette: null }) }} /></div>
        <ul>{shown.map((it, n) => <li key={it.id} className={n === i ? 'sel' : ''} onMouseEnter={() => setI(n)} onClick={() => choose(it)}><span>{it.label}</span>{it.hint && <em>{it.hint}</em>}</li>)}{!shown.length && <li className="none">No results</li>}</ul>
      </div>
    </div>
  )
}
export type { Item as PaletteItem }
