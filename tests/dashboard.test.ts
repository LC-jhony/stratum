import { describe, expect, it } from 'vitest'
import { dashboardQueries, formatBytes, metricValue, modelStats } from '../src/core/dashboard'

describe('dashboardQueries', () => {
  it('offers database size and sessions for PostgreSQL', () => {
    expect(dashboardQueries('postgres').map((q) => q.id)).toEqual(['size', 'sessions'])
    expect(dashboardQueries('mysql')[0].sql).toContain('information_schema.tables')
    expect(dashboardQueries('sqlite')[0].sql).toContain('pragma_page_count')
  })

  it('stays empty for dialects without a known cheap metric', () => {
    expect(dashboardQueries('oracle')).toEqual([])
  })
})

describe('metricValue', () => {
  const columns = [{ name: 'BYTES' }, { name: 'sessions' }]

  it('reads numbers by case-insensitive column name', () => {
    expect(metricValue(columns, [[2048, 3]], 'bytes')).toBe(2048)
  })

  it('accepts bigint returned as text', () => {
    expect(metricValue(columns, [['9007199254740993', '1']], 'bytes')).toBe(9007199254740992)
  })

  it('rejects missing, negative and non-numeric values', () => {
    expect(metricValue(columns, [], 'bytes')).toBeUndefined()
    expect(metricValue(columns, [['-1', 1]], 'bytes')).toBeUndefined()
    expect(metricValue(columns, [['lots', 1]], 'bytes')).toBeUndefined()
    expect(metricValue(columns, [[1, 2]], 'missing')).toBeUndefined()
  })
})

describe('formatBytes', () => {
  it('formats each magnitude with one decimal below 10', () => {
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(15 * 1024 * 1024)).toBe('15 MB')
    expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.5 GB')
  })
})

describe('modelStats', () => {
  it('counts tables, views, columns and foreign keys', () => {
    const model = {
      dialect: 'postgres' as const,
      schemas: [
        {
          name: 'public',
          tables: [
            { name: 'a', kind: 'table' as const, columns: [{ name: 'id' }, { name: 'b' }], foreignKeys: [{ name: 'fk' }], indexes: [] },
            { name: 'v', kind: 'view' as const, columns: [{ name: 'x' }], foreignKeys: [], indexes: [] },
          ],
        },
      ],
    }
    expect(modelStats(model as never)).toEqual({ schemas: 1, tables: 1, views: 1, columns: 3, foreignKeys: 1 })
    expect(modelStats(undefined)).toEqual({ schemas: 0, tables: 0, views: 0, columns: 0, foreignKeys: 0 })
  })
})
