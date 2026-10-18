import { describe, expect, it } from 'vitest'
import { isRedisRead, paginateRedisStatement, parseRedisCommand, replyToResult } from '../src/main/db/transports/redis'
import { KINDS, isSqlKind } from '../src/core/kinds'
import { redisStatementAt, splitRedisStatements } from '../src/core/redis'

/**
 * The Redis console is only as safe as this allowlist and only as useful as these mappings, so both
 * are pinned here: which commands run, how replies become grid rows (verified against Redis 8 over
 * RESP3), and how the explorer's INSPECT reader gets its page size.
 */

const cmd = (text: string) => parseRedisCommand(text)!

describe('redis command tokenizer', () => {
  it('splits words, honoring quotes and escapes', () => {
    expect(parseRedisCommand('get key')).toEqual({ name: 'GET', args: ['key'] })
    expect(parseRedisCommand('  SET greeting "hola, mundo"  ')).toEqual({ name: 'SET', args: ['greeting', 'hola, mundo'] })
    expect(parseRedisCommand(`SET k 'con espacios'`)).toEqual({ name: 'SET', args: ['k', 'con espacios'] })
    expect(parseRedisCommand(`ECHO "line\\n\\"quoted\\""`)).toEqual({ name: 'ECHO', args: ['line\n"quoted"'] })
    expect(parseRedisCommand('   ')).toBeUndefined()
  })
})

describe('redis console statements', () => {
  it('splits on newlines and semicolons outside quotes', () => {
    const text = 'GET a\nSET b 1\nSET c "x;y"\nDEL d; EXPIRE e 10\n'
    expect(splitRedisStatements(text).map((s) => s.text)).toEqual(['GET a', 'SET b 1', 'SET c "x;y"', 'DEL d', 'EXPIRE e 10'])
  })
  it('finds the statement under the caret', () => {
    const text = 'GET a\nHGETALL h\n'
    expect(redisStatementAt(text, text.indexOf('HGETALL'))?.text).toBe('HGETALL h')
    expect(redisStatementAt(text, text.indexOf('GET'))?.text).toBe('GET a')
  })
})

describe('read-only allowlist', () => {
  it('accepts reads, including subcommand families and modules', () => {
    for (const s of ['GET k', 'HGETALL h', 'LRANGE l 0 -1', 'SMEMBERS s', 'ZRANGE z 0 -1 WITHSCORES', 'SCAN 0 COUNT 10',
      'TYPE k', 'TTL k', 'INFO keyspace', 'DBSIZE', 'SELECT 2', 'CLIENT LIST', 'OBJECT ENCODING h', 'XINFO STREAM st',
      'JSON.GET doc $', 'INSPECT "a:b"']) {
      expect(isRedisRead(s), s).toBe(true)
    }
  })
  it('rejects writes, admin and stateful commands', () => {
    for (const s of ['SET k 1', 'DEL k', 'FLUSHALL', 'RENAME a b', 'EXPIRE k 10', 'EVAL "return 1" 0', 'MULTI', 'SUBSCRIBE ch',
      'CONFIG GET databases', 'CONFIG SET maxmemory 0', 'CLIENT SETNAME x', 'JSON.SET doc $ 1', 'SORT l STORE dst', 'XREAD COUNT 1 STREAMS st $']) {
      expect(isRedisRead(s), s).toBe(false)
    }
  })
  it('pages only the INSPECT reader', () => {
    expect(paginateRedisStatement('INSPECT "user:1"', 501, 0)).toBe('INSPECT "user:1" 0 501')
    expect(paginateRedisStatement('GET k', 501, 0)).toBeUndefined()
    expect(paginateRedisStatement('HGETALL h', 501, 10)).toBeUndefined()
  })
})

describe('replies as grid results', () => {
  it('wraps scalars and nulls', () => {
    expect(replyToResult(cmd('GET k'), 'hola')).toEqual({ columns: [{ name: 'value' }], rows: [['hola']] })
    expect(replyToResult(cmd('GET k'), null)).toEqual({ columns: [{ name: 'value' }], rows: [[null]] })
    expect(replyToResult(cmd('TTL k'), 42)).toEqual({ columns: [{ name: 'value' }], rows: [[42]] })
  })
  it('maps flat maps, scan pairs and score pairs', () => {
    expect(replyToResult(cmd('HGETALL h'), ['a', '1', 'b', '2'])).toEqual({ columns: [{ name: 'field' }, { name: 'value' }], rows: [['a', '1'], ['b', '2']] })
    expect(replyToResult(cmd('SCAN 0'), ['17', ['k1', 'k2']])).toEqual({ columns: [{ name: 'cursor' }, { name: 'key' }], rows: [['17', 'k1'], ['17', 'k2']] })
    expect(replyToResult(cmd('SCAN 0'), ['0', []])).toEqual({ columns: [{ name: 'cursor' }, { name: 'key' }], rows: [['0', null]] })
    expect(replyToResult(cmd('HSCAN h 0'), ['0', ['a', '1']])).toEqual({ columns: [{ name: 'cursor' }, { name: 'field' }, { name: 'value' }], rows: [['0', 'a', '1']] })
    expect(replyToResult(cmd('ZRANGE z 0 -1 WITHSCORES'), [['a', '1'], ['b', '2']])).toEqual({ columns: [{ name: 'member' }, { name: 'score' }], rows: [['a', '1'], ['b', '2']] })
  })
  it('maps collections and streams with their own column names', () => {
    expect(replyToResult(cmd('KEYS *'), ['a', 'b'])).toEqual({ columns: [{ name: 'key' }], rows: [['a'], ['b']] })
    expect(replyToResult(cmd('SMEMBERS s'), ['m'])).toEqual({ columns: [{ name: 'member' }], rows: [['m']] })
    expect(replyToResult(cmd('HKEYS h'), ['f'])).toEqual({ columns: [{ name: 'field' }], rows: [['f']] })
    expect(replyToResult(cmd('XRANGE st - +'), [['1-0', ['f', 'v']]])).toEqual({ columns: [{ name: 'id' }, { name: 'fields' }], rows: [['1-0', { f: 'v' }]] })
  })
})

describe('provider capabilities', () => {
  it('marks redis as non-SQL with its default port', () => {
    expect(KINDS.redis).toEqual({ label: 'Redis', sql: false, defaultPort: 6379 })
    expect(isSqlKind('redis')).toBe(false)
  })
})
