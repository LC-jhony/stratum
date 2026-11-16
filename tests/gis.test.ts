import { describe, expect, it } from 'vitest'
import { geometrySummary, looksLikeGeometry, parseGeometry, polygonPath, projectGeometry } from '../src/core/gis'

describe('parseGeometry — WKT', () => {
  it('parses points, lines and polygons', () => {
    expect(parseGeometry('POINT (1 2)')).toEqual({ type: 'Point', coordinates: { x: 1, y: 2 } })
    expect(parseGeometry('LINESTRING (0 0, 1 1, 2 0)')).toMatchObject({ type: 'LineString', coordinates: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }] })
    expect(parseGeometry('POLYGON ((0 0, 0 1, 1 1, 1 0, 0 0))')).toMatchObject({ type: 'Polygon' })
  })

  it('parses multi geometries with and without inner parentheses', () => {
    expect(parseGeometry('MULTIPOINT ((1 2), (3 4))')).toEqual({ type: 'MultiPoint', coordinates: [{ x: 1, y: 2 }, { x: 3, y: 4 }] })
    expect(parseGeometry('MULTIPOINT (1 2, 3 4)')).toEqual({ type: 'MultiPoint', coordinates: [{ x: 1, y: 2 }, { x: 3, y: 4 }] })
    expect(parseGeometry('MULTILINESTRING ((0 0, 1 1), (2 2, 3 3))')).toMatchObject({ type: 'MultiLineString' })
    expect(parseGeometry('MULTIPOLYGON (((0 0, 0 1, 1 1, 0 0)), ((2 2, 2 3, 3 3, 2 2)))')).toMatchObject({ type: 'MultiPolygon' })
  })

  it('parses collections, SRID prefixes and Z/M ordinates', () => {
    expect(parseGeometry('GEOMETRYCOLLECTION (POINT (1 2), LINESTRING (0 0, 1 1))')).toMatchObject({ type: 'GeometryCollection', geometries: [{ type: 'Point' }, { type: 'LineString' }] })
    expect(parseGeometry('SRID=4326;POINT (1 2)')).toEqual({ type: 'Point', coordinates: { x: 1, y: 2 } })
    expect(parseGeometry('POINT Z (1 2 30)')).toEqual({ type: 'Point', coordinates: { x: 1, y: 2 } })
    expect(parseGeometry('POINT ZM (1 2 30 4)')).toEqual({ type: 'Point', coordinates: { x: 1, y: 2 } })
  })

  it('rejects unknown or truncated WKT', () => {
    expect(parseGeometry('POINT (1)')).toBeUndefined()
    expect(parseGeometry('CIRCLE (1 2)')).toBeUndefined()
    expect(parseGeometry('POINT (1 2) trailing')).toBeUndefined()
  })
})

describe('parseGeometry — GeoJSON', () => {
  it('parses objects, features and feature collections', () => {
    expect(parseGeometry({ type: 'Point', coordinates: [1, 2] })).toEqual({ type: 'Point', coordinates: { x: 1, y: 2 } })
    expect(parseGeometry({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } })).toMatchObject({ type: 'LineString' })
    const collection = parseGeometry({ type: 'FeatureCollection', features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [3, 4] } },
    ] })
    expect(collection).toMatchObject({ type: 'GeometryCollection', geometries: [{ type: 'Point' }, { type: 'Point' }] })
  })

  it('parses JSON text and rejects broken coordinates', () => {
    expect(parseGeometry('{"type":"Point","coordinates":[5,6]}')).toEqual({ type: 'Point', coordinates: { x: 5, y: 6 } })
    expect(parseGeometry({ type: 'Point', coordinates: [1] })).toBeUndefined()
    expect(parseGeometry({ type: 'Polygon', coordinates: 'nope' })).toBeUndefined()
  })
})

describe('parseGeometry — WKB', () => {
  it('parses little-endian points and line strings', () => {
    expect(parseGeometry('0101000000000000000000F03F0000000000000040')).toEqual({ type: 'Point', coordinates: { x: 1, y: 2 } })
    const line = '01020000000200000000000000000000000000000000000000000000000000F03F000000000000F03F'
    expect(parseGeometry(line)).toMatchObject({ type: 'LineString', coordinates: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })
  })

  it('parses EWKB with an SRID and ISO Z types', () => {
    expect(parseGeometry('0101000020E6100000000000000000F03F0000000000000040')).toEqual({ type: 'Point', coordinates: { x: 1, y: 2 } })
    // ISO WKB 1001 = Point Z (1 2 3), little endian.
    expect(parseGeometry('01E9030000000000000000F03F00000000000000400000000000000840')).toEqual({ type: 'Point', coordinates: { x: 1, y: 2 } })
  })
})

describe('looksLikeGeometry', () => {
  it('recognises geometry text without flagging ordinary values', () => {
    expect(looksLikeGeometry('POINT (1 2)')).toBe(true)
    expect(looksLikeGeometry('{"type":"Point","coordinates":[1,2]}')).toBe(true)
    expect(looksLikeGeometry('0101000000000000000000F03F0000000000000040')).toBe(true)
    expect(looksLikeGeometry('hello')).toBe(false)
    expect(looksLikeGeometry('SRID=4326;')).toBe(false)
    expect(looksLikeGeometry(null)).toBe(false)
  })
})

describe('projectGeometry', () => {
  it('centers a single point', () => {
    const view = projectGeometry({ type: 'Point', coordinates: { x: 10, y: 20 } }, 100, 100, 10)
    expect(view.shapes).toEqual([{ kind: 'point', x: 50, y: 50 }])
    expect(view.positions).toBe(1)
  })

  it('keeps the aspect ratio and inverts the Y axis', () => {
    const view = projectGeometry({ type: 'LineString', coordinates: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }, 100, 100, 10)
    expect(view.shapes[0]).toEqual({ kind: 'line', points: [{ x: 10, y: 90 }, { x: 90, y: 10 }] })
  })

  it('projects polygons and describes the value', () => {
    const polygon = parseGeometry('POLYGON ((0 0, 0 1, 1 1, 1 0, 0 0))')!
    const view = projectGeometry(polygon, 120, 80)
    expect(view.shapes[0].kind).toBe('polygon')
    expect(geometrySummary(polygon)).toContain('Polygon')
    const shape = view.shapes[0]
    if (shape.kind === 'polygon') {
      expect(polygonPath(shape.rings)).toMatch(/^M[\d.]+ [\d.]+ L/)
      expect(polygonPath(shape.rings).endsWith('Z')).toBe(true)
    }
  })

  it('handles a geometry collection and empty input', () => {
    const collection = parseGeometry('GEOMETRYCOLLECTION (POINT (0 0), POINT (1 1))')!
    expect(projectGeometry(collection).shapes).toHaveLength(2)
    expect(geometrySummary(collection)).toBe('GeometryCollection · 2 part(s)')
  })
})
