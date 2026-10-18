import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ColumnMeta } from '../../../shared/types'
import type { GridSort } from '../../../shared/gridView'
import { Icon } from '../ui/Icon'

const ROW_H = 24, OVERSCAN = 8, GUTTER = 48

export interface GridProps {
  columns: ColumnMeta[]
  rows: unknown[][]
  /** Cell values changed but not yet submitted: `${row}:${col}` -> value */
  edits?: Map<string, unknown>
  deleted?: Set<number>
  /** Rows from index `rows.length` onward are newly inserted (highlighted). */
  insertedFrom?: number
  readOnlyColumns?: Set<number>
  /** Active column sort (header click cycles asc → desc → none); omit to disable sorting. */
  sort?: GridSort | null
  onSort?(col: number): void
  /** Read-only value viewer hook for rows with no inline editing (console results). */
  onOpenValue?(row: number, col: number): void
  onEdit?(row: number, col: number, value: unknown): void
  onSelectRow?(row: number): void
}

const isNum = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && v !== '' && /^-?\d+(\.\d+)?$/.test(v))
function show(v: unknown) { return v === null || v === undefined ? null : typeof v === 'boolean' ? String(v) : String(v) }

/** DataGrip-style result grid: windowed rows, resizable columns, cell cursor, inline editing, TSV copy. */
export function DataGrid({ columns, rows, edits, deleted, insertedFrom, readOnlyColumns, sort, onSort, onOpenValue, onEdit, onSelectRow }: GridProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ top: 0, h: 400 })
  const [cur, setCur] = useState<{ r: number; c: number } | null>(null)
  const [editing, setEditing] = useState<{ r: number; c: number; v: string } | null>(null)
  const [widths, setWidths] = useState<number[]>([])

  const auto = useMemo(() => columns.map((c, i) => {
    let m = c.name.length + 3
    for (let r = 0; r < Math.min(rows.length, 60); r++) m = Math.max(m, String(rows[r][i] ?? 'null').length)
    return Math.min(Math.max(m * 7.4 + 22, 70), 380)
  }), [columns, rows])
  useEffect(() => setWidths([]), [columns])
  const w = (i: number) => widths[i] ?? auto[i] ?? 120
  const total = GUTTER + columns.reduce((a, _c, i) => a + w(i), 0)

  useEffect(() => { const el = ref.current; if (!el) return; const ro = new ResizeObserver(() => setScroll((s) => ({ ...s, h: el.clientHeight }))); ro.observe(el); return () => ro.disconnect() }, [])
  const first = Math.max(0, Math.floor(scroll.top / ROW_H) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((scroll.top + scroll.h) / ROW_H) + OVERSCAN)

  const value = useCallback((r: number, c: number) => (edits?.has(`${r}:${c}`) ? edits.get(`${r}:${c}`) : rows[r]?.[c]), [edits, rows])
  const commit = () => { if (editing) { const raw = editing.v; onEdit?.(editing.r, editing.c, raw === '' ? null : raw); setEditing(null) } }
  const select = (r: number, c: number) => { setCur({ r, c }); onSelectRow?.(r) }

  const onKey = (e: React.KeyboardEvent) => {
    if (editing || !cur) return
    const mv = (dr: number, dc: number) => { e.preventDefault(); const r = Math.min(Math.max(cur.r + dr, 0), rows.length - 1), c = Math.min(Math.max(cur.c + dc, 0), columns.length - 1); select(r, c); const el = ref.current!; if (r * ROW_H < el.scrollTop) el.scrollTop = r * ROW_H; else if ((r + 2) * ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = (r + 2) * ROW_H - el.clientHeight }
    if (e.key === 'ArrowDown') mv(1, 0); else if (e.key === 'ArrowUp') mv(-1, 0); else if (e.key === 'ArrowLeft') mv(0, -1); else if (e.key === 'ArrowRight' || e.key === 'Tab') mv(0, 1)
    else if (e.key === 'F2' || e.key === 'Enter') { e.preventDefault(); if (onEdit && !readOnlyColumns?.has(cur.c)) setEditing({ ...cur, v: show(value(cur.r, cur.c)) ?? '' }); else onOpenValue?.(cur.r, cur.c) }
    else if ((e.metaKey || e.ctrlKey) && e.key === 'c') { e.preventDefault(); void navigator.clipboard.writeText(e.shiftKey ? columns.map((c) => c.name).join('\t') + '\n' + rows.map((_, r) => columns.map((_c, c) => show(value(r, c)) ?? '').join('\t')).join('\n') : show(value(cur.r, cur.c)) ?? '') }
  }

  return (
    <div className="grid" ref={ref} tabIndex={0} onKeyDown={onKey} onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })}>
      <div style={{ width: total, height: ROW_H * (rows.length + 1) }}>
        <div className="grid-head" style={{ width: total }}>
          <div className="cell gutter" style={{ width: GUTTER }} />
          {columns.map((c, i) => (
            <div key={i} className={`cell head${onSort ? ' sortable' : ''}`} style={{ width: w(i) }} title={c.type ? `${c.name}: ${c.type}` : c.name}
              onClick={onSort ? (e) => { if (!(e.target as HTMLElement).closest('.resize')) onSort(i) } : undefined}>
              <span>{c.name}</span>{c.type && <em>{c.type}</em>}
              {sort?.col === i && <Icon id="chevron-down" className={sort.dir === 1 ? 'sort-asc' : ''} />}
              <i className="resize" onMouseDown={(e) => { e.preventDefault(); const x0 = e.clientX, w0 = w(i); const mm = (m: MouseEvent) => setWidths((p) => { const n = [...(p.length ? p : auto)]; n[i] = Math.max(48, w0 + m.clientX - x0); return n }); const up = () => { removeEventListener('mousemove', mm); removeEventListener('mouseup', up) }; addEventListener('mousemove', mm); addEventListener('mouseup', up) }} />
            </div>
          ))}
        </div>
        {Array.from({ length: last - first }, (_, k) => {
          const r = first + k, isNew = insertedFrom !== undefined && r >= insertedFrom
          return (
            <div key={r} className={`grid-row ${r % 2 ? 'odd' : ''} ${deleted?.has(r) ? 'deleted' : ''} ${isNew ? 'inserted' : ''} ${cur?.r === r ? 'cur-row' : ''}`} style={{ top: (r + 1) * ROW_H, width: total }}>
              <div className="cell gutter" style={{ width: GUTTER }} onClick={() => select(r, cur?.c ?? 0)}>{r + 1}</div>
              {columns.map((_c, c) => {
                const v = value(r, c), dirty = edits?.has(`${r}:${c}`), isCur = cur?.r === r && cur.c === c
                const s = show(v)
                return (
                  <div key={c} className={`cell ${isNum(v) && typeof v !== 'string' ? 'num' : ''} ${s === null ? 'null' : ''} ${dirty ? 'dirty' : ''} ${isCur ? 'cur' : ''}`} style={{ width: w(c) }}
                    onMouseDown={() => select(r, c)} onDoubleClick={() => { if (onEdit && !readOnlyColumns?.has(c)) setEditing({ r, c, v: s ?? '' }); else onOpenValue?.(r, c) }} title={s ?? undefined}>
                    {editing?.r === r && editing.c === c
                      ? <input autoFocus value={editing.v} onChange={(e) => setEditing({ ...editing, v: e.target.value })} onBlur={commit} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(null) }} />
                      : s === null ? '<null>' : s}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
