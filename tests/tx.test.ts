import { describe, expect, it } from 'vitest'
import { endsTransaction, startsTransaction, transactionState } from '../src/main/db/transports/tx'

describe('transaction boundaries', () => {
  it('enters on BEGIN, START TRANSACTION and SAVEPOINT', () => {
    for (const sql of ['begin', '  BEGIN;', 'start transaction', 'SAVEPOINT sp1']) {
      expect(startsTransaction(sql)).toBe(true)
      expect(transactionState(sql, false)).toBe(true)
    }
  })

  it('leaves on COMMIT, END and a full ROLLBACK', () => {
    for (const sql of ['commit', 'END', 'rollback', 'rollback work', 'ROLLBACK TRANSACTION']) {
      expect(endsTransaction(sql)).toBe(true)
      expect(transactionState(sql, true)).toBe(false)
    }
  })

  it('keeps the transaction open when rolling back to a savepoint', () => {
    for (const sql of [
      'rollback to sp1',
      'ROLLBACK TO SAVEPOINT sp1',
      'rollback work to savepoint "sp 1"',
      // SQL Server uses a different spelling: ROLLBACK TRANSACTION savepoint_name.
      'ROLLBACK TRANSACTION sp1',
      'rollback transaction "sp 1"',
    ]) {
      expect(endsTransaction(sql)).toBe(false)
      expect(transactionState(sql, true)).toBe(true)
    }
  })

  it('keeps the current state for ordinary statements and RELEASE', () => {
    for (const sql of ['select 1', 'release savepoint sp1', 'RELEASE sp1', 'insert into t values (1)']) {
      expect(startsTransaction(sql)).toBe(false)
      expect(endsTransaction(sql)).toBe(false)
      expect(transactionState(sql, true)).toBe(true)
      expect(transactionState(sql, false)).toBe(false)
    }
  })
})
