/**
 * Spatial values: parse WKT, GeoJSON and (E)WKB into one geometry tree and project it to SVG.
 *
 * Pure and dependency-free so the cell viewer can recognise a geometry without loading a map
 * library, and so the parser can be tested with the exact strings PostGIS/MySQL/MSSQL return.
 * Coordinates are treated as a plane (no reprojection); the viewer states that when the SRID is
 * geographic, which is enough to recognise shapes without pretending to be a GIS application.
 */

export interface Position { x: number; y: number }

export type Geometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'MultiPoint' | 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString' | 'Polygon'; coordinates: Position[][] }
  | { type: 'MultiPolygon'; coordinates: Position[][][] }
  | { type: 'GeometryCollection'; geometries: Geometry[] }

/** Points accepted from one value; a hostile WKB count cannot exhaust memory. */
export const MAX_POSITIONS = 200_000

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Geometric-ish strings only: avoids running JSON/WKT parsers over every ordinary cell. */
export function looksLikeGeometry(value: unknown): boolean {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^SRID=\d+;\s*[a-z]/i.test(text) || /^(point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\s*(z|m|zm)?\s*\(/i.test(text) || (/^\{/.test(text) && /"(type|coordinates)"/.test(text)) || /^[0-9a-f]{16,}$/i.test(text)
}

/** Geometry for a cell value (WKT, GeoJSON text/object or WKB hex), or undefined when it is not one. */
export function parseGeometry(value: unknown): Geometry | undefined {
  try {
    if (value && typeof value === 'object') return fromGeoJson(value)
    if (typeof value !== 'string') return undefined
    let text = value.trim()
    if (!text) return undefined
    const srid = /^SRID=(\d+);/i.exec(text)
    if (srid) text = text.slice(srid[0].length).trim()
    if (text.startsWith('{') || text.startsWith('[')) {
      const json = JSON.parse(text) as unknown
      return fromGeoJson(json)
    }
    if (/^[0-9a-f]+$/i.test(text) && text.length >= 16 && text.length % 2 === 0) {
      const wkb = parseWkb(hexBytes(text))
      return wkb
    }
    return parseWkt(text)
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ GeoJSON */

const geoPosition = (v: unknown): Position => {
  if (!Array.isArray(v) || v.length < 2 || !isFiniteNumber(v[0]) || !isFiniteNumber(v[1])) {
    throw new Error('Invalid coordinate')
  }
  return { x: v[0], y: v[1] }
}

function fromGeoJson(raw: unknown): Geometry | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  if (o.type === 'Feature') return fromGeoJson(o.geometry)
  if (o.type === 'FeatureCollection') {
    if (!Array.isArray(o.features)) return undefined
    const geometries = o.features.map((f) => fromGeoJson(f)).filter((g): g is Geometry => !!g)
    return geometries.length ? { type: 'GeometryCollection', geometries } : undefined
  }
  if (o.type === 'GeometryCollection') {
    if (!Array.isArray(o.geometries)) return undefined
    const geometries = o.geometries.map((g) => fromGeoJson(g)).filter((g): g is Geometry => !!g)
    return geometries.length ? { type: 'GeometryCollection', geometries } : undefined
  }
  const coordinates = o.coordinates
  switch (o.type) {
    case 'Point': return { type: 'Point', coordinates: geoPosition(coordinates) }
    case 'MultiPoint':
    case 'LineString':
      if (!Array.isArray(coordinates)) return undefined
      return { type: o.type, coordinates: coordinates.map(geoPosition) }
    case 'MultiLineString':
    case 'Polygon':
      if (!Array.isArray(coordinates)) return undefined
      return { type: o.type, coordinates: coordinates.map((ring) => Array.isArray(ring) ? ring.map(geoPosition) : []) }
    case 'MultiPolygon':
      if (!Array.isArray(coordinates)) return undefined
      return { type: 'MultiPolygon', coordinates: coordinates.map((poly) => Array.isArray(poly) ? poly.map((ring) => Array.isArray(ring) ? ring.map(geoPosition) : []) : []) }
    default:
      return undefined
  }
}

/* ------------------------------------------------------------------ WKT */

type WktToken = string | number

function tokenizeWkt(text: string): WktToken[] {
  const out: WktToken[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) { i++; continue }
    if (ch === '(' || ch === ')' || ch === ',') { out.push(ch); i++; continue }
    const rest = text.slice(i)
    const num = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(rest)
    if (num) { out.push(Number(num[0])); i += num[0].length; continue }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)
    if (word) { out.push(word[0].toUpperCase()); i += word[0].length; continue }
    throw new Error('Invalid WKT')
  }
  return out
}

function parseWkt(text: string): Geometry | undefined {
  const tokens = tokenizeWkt(text)
  let at = 0
  let positions = 0

  const peek = (): WktToken | undefined => tokens[at]
  const eat = (expected?: string): WktToken => {
    const token = tokens[at++]
    if (token === undefined) throw new Error('Unexpected end of WKT')
    if (expected !== undefined && token !== expected) throw new Error(`Expected ${expected}`)
    return token
  }
  const word = (): string => {
    const token = eat()
    if (typeof token !== 'string' || token === '(' || token === ')' || token === ',') throw new Error('Expected a geometry type')
    return token
  }
  const pos = (): Position => {
    const x = eat(), y = eat()
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) throw new Error('Expected coordinates')
    positions++
    if (positions > MAX_POSITIONS) throw new Error('Too many positions')
    // Optional Z/M ordinates: read them, keep the planar X/Y pair.
    while (isFiniteNumber(peek())) at++
    return { x, y }
  }
  const posList = (): Position[] => {
    eat('(')
    const out: Position[] = []
    for (;;) {
      out.push(pos())
      if (peek() === ',') { eat(','); continue }
      break
    }
    eat(')')
    return out
  }
  const ringList = (): Position[][] => {
    eat('(')
    const out: Position[][] = []
    for (;;) {
      out.push(posList())
      if (peek() === ',') { eat(','); continue }
      break
    }
    eat(')')
    return out
  }
  const multiPoint = (): Position[] => {
    eat('(')
    const out: Position[] = []
    for (;;) {
      if (peek() === '(') { eat('('); out.push(pos()); eat(')') }
      else out.push(pos())
      if (peek() === ',') { eat(','); continue }
      break
    }
    eat(')')
    return out
  }
  const multiLine = (): Position[][] => {
    eat('(')
    const out: Position[][] = []
    for (;;) {
      out.push(posList())
      if (peek() === ',') { eat(','); continue }
      break
    }
    eat(')')
    return out
  }
  const multiPolygon = (): Position[][][] => {
    eat('(')
    const out: Position[][][] = []
    for (;;) {
      out.push(ringList())
      if (peek() === ',') { eat(','); continue }
      break
    }
    eat(')')
    return out
  }
  const geom = (): Geometry => {
    const type = word()
    // WKT allows the dimension marker before the opening parenthesis: POINT Z (1 2 3).
    if (peek() === 'Z' || peek() === 'M' || peek() === 'ZM') {
      const marker = eat()
      if (marker === undefined) throw new Error('Invalid WKT')
    }
    switch (type) {
      case 'POINT': {
        eat('(')
        const p = pos()
        eat(')')
        return { type: 'Point', coordinates: p }
      }
      case 'LINESTRING': return { type: 'LineString', coordinates: posList() }
      case 'POLYGON': return { type: 'Polygon', coordinates: ringList() }
      case 'MULTIPOINT': return { type: 'MultiPoint', coordinates: multiPoint() }
      case 'MULTILINESTRING': return { type: 'MultiLineString', coordinates: multiLine() }
      case 'MULTIPOLYGON': return { type: 'MultiPolygon', coordinates: multiPolygon() }
      case 'GEOMETRYCOLLECTION': {
        eat('(')
        const geometries: Geometry[] = []
        for (;;) {
          geometries.push(geom())
          if (peek() === ',') { eat(','); continue }
          break
        }
        eat(')')
        return { type: 'GeometryCollection', geometries }
      }
      default:
        throw new Error(`Unknown geometry ${type}`)
    }
  }
  const result = geom()
  if (at !== tokens.length) throw new Error('Trailing WKT')
  return result
}

/* ------------------------------------------------------------------ WKB / EWKB */

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function parseWkb(bytes: Uint8Array): Geometry | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  let positions = 0
  const need = (n: number) => {
    if (offset + n > view.byteLength) throw new Error('Truncated WKB')
  }
  const u8 = () => { need(1); return view.getUint8(offset++) }
  const u32 = (little: boolean) => { need(4); const v = view.getUint32(offset, little); offset += 4; return v }
  const f64 = (little: boolean) => { need(8); const v = view.getFloat64(offset, little); offset += 8; return v }

  const geometry = (): Geometry => {
    const order = u8()
    if (order !== 0 && order !== 1) throw new Error('Invalid WKB byte order')
    const little = order === 1
    const raw = u32(little)
    if (raw & 0x20000000) u32(little) // EWKB SRID
    const hasZ = (raw & 0x80000000) !== 0
    const hasM = (raw & 0x40000000) !== 0
    let type = raw & 0x0fffffff
    let extra = (hasZ ? 1 : 0) + (hasM ? 1 : 0)
    if (type >= 1000) {
      const dim = Math.floor(type / 1000)
      type %= 1000
      if (dim === 1) extra = Math.max(extra, 1)
      else if (dim === 2) extra = Math.max(extra, 1)
      else if (dim === 3) extra = Math.max(extra, 2)
    }
    const dims = 2 + extra
    const position = (): Position => {
      const x = f64(little), y = f64(little)
      for (let i = 2; i < dims; i++) f64(little)
      positions++
      if (positions > MAX_POSITIONS) throw new Error('Too many positions')
      return { x, y }
    }
    const count = (): number => {
      const n = u32(little)
      if (n > MAX_POSITIONS) throw new Error('Unreasonable WKB count')
      return n
    }
    switch (type) {
      case 1: return { type: 'Point', coordinates: position() }
      case 2: {
        const n = count()
        return { type: 'LineString', coordinates: Array.from({ length: n }, position) }
      }
      case 3: {
        const rings = count()
        return { type: 'Polygon', coordinates: Array.from({ length: rings }, () => Array.from({ length: count() }, position)) }
      }
      case 4: return { type: 'MultiPoint', coordinates: Array.from({ length: count() }, () => {
        const g = geometry()
        if (g.type !== 'Point') throw new Error('Invalid MultiPoint member')
        return g.coordinates
      }) }
      case 5: return { type: 'MultiLineString', coordinates: Array.from({ length: count() }, () => {
        const g = geometry()
        if (g.type !== 'LineString') throw new Error('Invalid MultiLineString member')
        return g.coordinates
      }) }
      case 6: return { type: 'MultiPolygon', coordinates: Array.from({ length: count() }, () => {
        const g = geometry()
        if (g.type !== 'Polygon') throw new Error('Invalid MultiPolygon member')
        return g.coordinates
      }) }
      case 7: return { type: 'GeometryCollection', geometries: Array.from({ length: count() }, () => geometry()) }
      default: throw new Error(`Unsupported WKB type ${type}`)
    }
  }
  const result = geometry()
  return result
}

/* ------------------------------------------------------------------ SVG projection */

export interface SvgPoint { x: number; y: number }
export type SvgShape =
  | { kind: 'point'; x: number; y: number }
  | { kind: 'line'; points: SvgPoint[] }
  | { kind: 'polygon'; rings: SvgPoint[][] }

export interface SvgGeometry {
  width: number
  height: number
  shapes: SvgShape[]
  /** Data-space bounds before projection (useful for the footer). */
  bounds?: { minX: number; minY: number; maxX: number; maxY: number }
  positions: number
}

function walk(geometry: Geometry, visit: (p: Position) => void): void {
  switch (geometry.type) {
    case 'Point': visit(geometry.coordinates); break
    case 'MultiPoint':
    case 'LineString': geometry.coordinates.forEach(visit); break
    case 'MultiLineString':
    case 'Polygon': geometry.coordinates.forEach((line) => line.forEach(visit)); break
    case 'MultiPolygon': geometry.coordinates.forEach((poly) => poly.forEach((ring) => ring.forEach(visit))); break
    case 'GeometryCollection': geometry.geometries.forEach((g) => walk(g, visit)); break
  }
}

/** Project a geometry into a width × height SVG viewport, keeping the aspect ratio (equirectangular). */
export function projectGeometry(geometry: Geometry, width = 560, height = 320, pad = 14): SvgGeometry {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, positions = 0
  walk(geometry, (p) => {
    positions++
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  })
  if (!positions) return { width, height, shapes: [], positions }
  const bounds = { minX, minY, maxX, maxY }
  const spanX = maxX - minX, spanY = maxY - minY
  const innerW = Math.max(1, width - pad * 2), innerH = Math.max(1, height - pad * 2)
  // Uniform scale keeps a diagonal road diagonal; a single point or a vertical line still centers.
  const scale = spanX > 0 && spanY > 0 ? Math.min(innerW / spanX, innerH / spanY) : spanX > 0 ? innerW / spanX : spanY > 0 ? innerH / spanY : 1
  const usedW = spanX * scale, usedH = spanY * scale
  const offsetX = pad + (innerW - usedW) / 2, offsetY = pad + (innerH - usedH) / 2
  const project = (p: Position): SvgPoint => ({ x: offsetX + (p.x - minX) * scale, y: height - offsetY - (p.y - minY) * scale })

  const shapes: SvgShape[] = []
  const add = (g: Geometry): void => {
    switch (g.type) {
      case 'Point': { const p = project(g.coordinates); shapes.push({ kind: 'point', x: p.x, y: p.y }); break }
      case 'MultiPoint':
      case 'LineString': {
        const points = g.coordinates.map(project)
        if (g.type === 'LineString') shapes.push({ kind: 'line', points })
        else for (const p of points) shapes.push({ kind: 'point', x: p.x, y: p.y })
        break
      }
      case 'Polygon': shapes.push({ kind: 'polygon', rings: g.coordinates.map((ring) => ring.map(project)) }); break
      case 'MultiLineString': for (const line of g.coordinates) shapes.push({ kind: 'line', points: line.map(project) }); break
      case 'MultiPolygon': for (const poly of g.coordinates) shapes.push({ kind: 'polygon', rings: poly.map((ring) => ring.map(project)) }); break
      case 'GeometryCollection': g.geometries.forEach(add); break
    }
  }
  add(geometry)
  return { width, height, shapes, bounds, positions }
}

/** One-line description for the viewer footer. */
export function geometrySummary(geometry: Geometry): string {
  if (geometry.type === 'GeometryCollection') return `GeometryCollection · ${geometry.geometries.length} part(s)`
  return `${geometry.type} · ${countPositions(geometry).toLocaleString()} point(s)`
}

function countPositions(g: Geometry): number {
  let n = 0
  walk(g, () => { n++ })
  return n
}

/** SVG path for a polygon (all rings in one path, holes are even-odd). */
export const polygonPath = (rings: readonly (readonly SvgPoint[])[]): string =>
  rings.map((ring) => ring.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') + 'Z').join(' ')
