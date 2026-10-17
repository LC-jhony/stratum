import { describe, expect, it } from 'vitest'
import { matchScore, rankCompletions } from '../src/shared/sqlRank'

const item = (label: string, bucket = 0) => ({ label, bucket })

describe('matchScore', () => {
  it('orders exact > prefix > middle > greedy', () => {
    const w = 'sel'
    expect(matchScore('sel', w)).toBeGreaterThan(matchScore('select', w))
    expect(matchScore('select', w)).toBeGreaterThan(matchScore('unsel', w)) // middle matching
    expect(matchScore('unsel', w)).toBeGreaterThan(matchScore('set_local', w)) // greedy subsequence
    expect(matchScore('insert', w)).toBe(0)
  })
  it('prefers shorter labels for the same prefix (liftShorter)', () => {
    expect(matchScore('state', 'st')).toBeGreaterThan(matchScore('statement', 'st'))
  })
  it('matches case-insensitively and against multi-word labels', () => {
    expect(matchScore('GROUP BY', 'group')).toBeGreaterThan(0)
    expect(matchScore('select', 'SEL')).toBeGreaterThan(0)
  })
})

describe('rankCompletions', () => {
  it('keeps buckets dominant over match quality', () => {
    const out = rankCompletions([item('aaa', 3), item('aaa', 1)], { word: 'aaa' })
    expect(out[0].bucket).toBe(1)
  })
  it('orders by match quality inside a bucket', () => {
    const out = rankCompletions([item('statement'), item('select'), item('sel')], { word: 'sel' })
    expect(out.map((c) => c.label)).toEqual(['sel', 'select', 'statement'])
  })
  it('lifts frequently used labels within a bucket', () => {
    const usage = new Map([['state', 4]])
    const out = rankCompletions([item('status', 4), item('state', 4)], { word: 'st', usage })
    expect(out.map((c) => c.label)).toEqual(['state', 'status'])
  })
  it('keeps the engine order when there is no typed word', () => {
    const out = rankCompletions([item('b'), item('a')], { word: '' })
    expect(out.map((c) => c.label)).toEqual(['b', 'a'])
  })
})
