import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'

interface Row { id: string; key: string; value: string }

const toRows = (values: Record<string, string>): Row[] => Object.entries(values).map(([key, value]) => ({ id: crypto.randomUUID(), key, value }))

/**
 * Editable name/value list for SQL variables. Rows keep their identity while typing, and duplicate
 * or empty names are ignored when the object is emitted; the last value of a duplicate wins.
 */
export function VariableEditor({ values, onChange, keyPlaceholder = 'name', valuePlaceholder = 'value', addLabel = 'Add variable' }: {
  values: Record<string, string>
  onChange(values: Record<string, string>): void
  keyPlaceholder?: string
  valuePlaceholder?: string
  addLabel?: string
}) {
  const [rows, setRows] = useState<Row[]>(() => toRows(values))
  const signature = JSON.stringify(values)
  const last = useRef(signature)
  useEffect(() => {
    if (signature === last.current) return
    last.current = signature
    setRows(toRows(values))
  }, [signature, values])

  const emit = (next: Row[]) => {
    setRows(next)
    const out: Record<string, string> = {}
    for (const row of next) if (row.key.trim()) out[row.key.trim()] = row.value
    last.current = JSON.stringify(out)
    onChange(out)
  }
  const patch = (id: string, p: Partial<Row>) => emit(rows.map((row) => (row.id === id ? { ...row, ...p } : row)))

  return (
    <div className="var-editor">
      {rows.map((row) => (
        <div className="var-row" key={row.id}>
          <input value={row.key} placeholder={keyPlaceholder} aria-label={keyPlaceholder} onChange={(e) => patch(row.id, { key: e.target.value })} />
          <input value={row.value} placeholder={valuePlaceholder} aria-label={valuePlaceholder} onChange={(e) => patch(row.id, { value: e.target.value })} />
          <button type="button" title="Remove variable" aria-label="Remove variable" onClick={() => emit(rows.filter((r) => r.id !== row.id))}><Icon id="close" /></button>
        </div>
      ))}
      <button type="button" className="var-add" onClick={() => emit([...rows, { id: crypto.randomUUID(), key: '', value: '' }])}><Icon id="add" /> {addLabel}</button>
    </div>
  )
}
