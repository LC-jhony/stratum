import { describe, expect, it } from 'vitest'
import { collectRows, rowChars, type ExportPage } from '../src/core/exportBudget'

/** Fake server: `total` rows, served in blocks of `block`, echoing [index]. */
function pager(total: number, block = 10): { fetchPage: (offset: number, limit: number) => Promise<ExportPage>; calls: number[] } {
  const calls: number[] = []
  return {
    calls,
    fetchPage: async (offset, limit) => {
      calls.push(offset)
      const size = Math.min(limit, block, Math.max(0, total - offset))
      return { rows: Array.from({ length: size }, (_v, i) => [offset + i]), hasMore: offset + size < total }
    },
  }
}

describe('export paging', () => {
  it('appends the remaining server rows to the loaded page, in blocks', async () => {
    const p = pager(25, 10)
    const rows = await collectRows({ head: [[0], [1]], offset: 0, hasMore: true, fetchPage: p.fetchPage, block: 10 })
    expect(rows.map((r) => r[0])).toEqual(Array.from({ length: 25 }, (_v, i) => i))
    expect(p.calls).toEqual([2, 12, 22])
  })

  it('does not fetch when the grid already holds every row', async () => {
    const p = pager(3)
    const rows = await collectRows({ head: [[0], [1], [2]], offset: 0, hasMore: false, fetchPage: p.fetchPage })
    expect(rows).toHaveLength(3)
    expect(p.calls).toEqual([])
  })

  it('keeps the server offset of a paged grid', async () => {
    const p = pager(30, 5)
    const rows = await collectRows({ head: [[10], [11]], offset: 10, hasMore: true, fetchPage: p.fetchPage, block: 5 })
    expect(rows.map((r) => r[0])).toEqual(Array.from({ length: 20 }, (_v, i) => i + 10))
    expect(p.calls).toEqual([12, 17, 22, 27])
  })

  it('reports the offset when a page fails instead of returning partial data', async () => {
    const fetchPage = async (offset: number): Promise<ExportPage> => (offset === 0 ? { rows: [[0]], hasMore: true } : { rows: [], hasMore: false, error: 'connection lost' })
    await expect(collectRows({ head: [], offset: 0, hasMore: true, fetchPage, block: 1 })).rejects.toThrow(/offset 1 failed: connection lost/)
  })

  it('stops on the row budget with an actionable message', async () => {
    const p = pager(100, 10)
    await expect(collectRows({ head: [], offset: 0, hasMore: true, fetchPage: p.fetchPage, block: 10, maxRows: 25 })).rejects.toThrow(/more than 25 rows/)
  })

  it('stops on the memory budget instead of exhausting the renderer', async () => {
    const fetchPage = async (offset: number): Promise<ExportPage> => ({ rows: [[offset, 'x'.repeat(1000)]], hasMore: true })
    await expect(collectRows({ head: [], offset: 0, hasMore: true, fetchPage, block: 1, maxChars: 5000 })).rejects.toThrow(/memory/)
  })

  it('estimates row size from the values that matter', () => {
    expect(rowChars([null, 1, true])).toBe(16 + 4 + 16 + 16)
    expect(rowChars(['abcd'])).toBe(16 + 8)
    expect(rowChars([{ a: 1 }])).toBe(16 + JSON.stringify({ a: 1 }).length * 2)
  })

  it('reports progress so the UI can show what is happening', async () => {
    const p = pager(15, 5)
    const seen: number[] = []
    await collectRows({ head: [[0]], offset: 0, hasMore: true, fetchPage: p.fetchPage, block: 5, onProgress: (loaded) => seen.push(loaded) })
    expect(seen).toEqual([1, 6, 11, 15])
  })
})
