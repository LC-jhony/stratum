import type { ColumnInfo, DatabaseModel, DialectId, ForeignKey, IndexInfo, SchemaInfo, TableInfo } from '../../shared/types'
import { returnsRows, stripLeadingComments } from '../../shared/sql'
import { qualify as q, quote } from '../../shared/quoting'
import type { Dialect, Run } from './types'

type Row = Record<string, unknown>
const toObjects = (r: { columns: { name: string }[]; rows: unknown[][] }): Row[] =>
  r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name.toLowerCase(), row[i]])))
const bool = (v: unknown) => v === true || v === 1 || v === '1' || /^(yes|y|true|t)$/i.test(String(v))
const list = (v: unknown) => (v == null || v === '' ? [] : Array.isArray(v) ? v.map(String) : String(v).split(','))

/** Assemble the flat catalog rows every dialect produces into the nested model. */
function assemble(cols: Row[], pks: Row[], fks: Row[], idx: Row[], views: Set<string>, emptyTables: Row[] = []): SchemaInfo[] {
  const schemas = new Map<string, Map<string, TableInfo>>()
  const key = (s: unknown, t: unknown) => `${s}\u0000${t}`
  const lookup = new Map<string, TableInfo>()
  const ensure = (s: string, t: string): TableInfo => {
    const k = key(s, t)
    let ti = lookup.get(k)
    if (!ti) {
      ti = { name: t, kind: views.has(k) ? 'view' : 'table', columns: [], foreignKeys: [], indexes: [] }
      lookup.set(k, ti)
      if (!schemas.has(s)) schemas.set(s, new Map())
      schemas.get(s)!.set(t, ti)
    }
    return ti
  }
  for (const r of emptyTables) ensure(String(r.schema), String(r.name))
  const pkSet = new Set(pks.map((p) => `${key(p.schema, p.tbl)}\u0000${p.col}`))
  for (const r of cols) {
    const c: ColumnInfo = {
      name: String(r.col), dataType: String(r.type), nullable: bool(r.nullable),
      default: r.dflt == null ? null : String(r.dflt), ordinal: Number(r.pos),
      isPrimaryKey: pkSet.has(`${key(r.schema, r.tbl)}\u0000${r.col}`),
    }
    ensure(String(r.schema), String(r.tbl)).columns.push(c)
  }
  for (const r of fks) {
    const fk: ForeignKey = { name: String(r.name), columns: list(r.cols), refSchema: String(r.ref_schema), refTable: String(r.ref_table), refColumns: list(r.ref_cols) }
    ensure(String(r.schema), String(r.tbl)).foreignKeys.push(fk)
  }
  for (const r of idx) {
    const i: IndexInfo = { name: String(r.name), columns: list(r.cols), unique: bool(r.uniq) }
    ensure(String(r.schema), String(r.tbl)).indexes.push(i)
  }
  return [...schemas].map(([name, t]) => ({ name, tables: [...t.values()].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Build the nested model from flat catalog rows; `t` carries {schema,name,kind} and marks views. */
function modelOf(t: Row[], cols: Row[], pks: Row[], fks: Row[], idx: Row[]): Omit<DatabaseModel, 'dialect' | 'version'> {
  const views = new Set(t.filter((r) => /view/i.test(String(r.kind))).map((r) => `${r.schema}\u0000${r.name}`))
  return { schemas: assemble(cols, pks, fks, idx, views, t) }
}

/** Catalog queries that only decorate the model: a failure degrades to "nothing found". */
const opts = (run: Run, sql: string) => run(sql).then(toObjects).catch((): Row[] => [])

/** Statements that can safely take a trailing LIMIT/OFFSET. */
function appendLimit(sql: string, limit: number, offset: number): string | undefined {
  const body = stripLeadingComments(sql).replace(/;\s*$/, '')
  if (!/^\(?\s*(select|with|values|table)\b/i.test(body)) return undefined
  if (/\b(limit|fetch\s+first|top)\b\s*\(?\s*\d+/i.test(body.slice(-200)) || /\blimit\b/i.test(body)) return undefined
  return `${body}\nLIMIT ${limit} OFFSET ${offset}`
}

const SYSTEM_PG = `('pg_catalog','information_schema','pg_toast')`

export const postgres: Dialect = {
  id: 'postgres',
  quote: (s) => quote('postgres', s),
  qualify: (sc, t) => q('postgres', sc, t),
  paginate: appendLimit,
  async introspect(run: Run) {
    const [tables, cols, pks, fks, idx] = await Promise.all([
      run(`select table_schema as schema, table_name as name, table_type as kind from information_schema.tables where table_schema not in ${SYSTEM_PG} and table_schema not like 'pg_temp%'`),
      run(`select table_schema as schema, table_name as tbl, column_name as col, case when data_type='USER-DEFINED' then udt_name else data_type end as type, is_nullable as nullable, column_default as dflt, ordinal_position as pos from information_schema.columns where table_schema not in ${SYSTEM_PG} order by 1,2,7`),
      run(`select kcu.table_schema as schema, kcu.table_name as tbl, kcu.column_name as col from information_schema.table_constraints tc join information_schema.key_column_usage kcu on kcu.constraint_name=tc.constraint_name and kcu.constraint_schema=tc.constraint_schema where tc.constraint_type='PRIMARY KEY'`),
      run(`select n.nspname as schema, c.relname as tbl, con.conname as name,
             (select string_agg(a.attname, ',' order by k.ord) from unnest(con.conkey) with ordinality k(attnum,ord) join pg_attribute a on a.attrelid=con.conrelid and a.attnum=k.attnum) as cols,
             rn.nspname as ref_schema, rc.relname as ref_table,
             (select string_agg(a.attname, ',' order by k.ord) from unnest(con.confkey) with ordinality k(attnum,ord) join pg_attribute a on a.attrelid=con.confrelid and a.attnum=k.attnum) as ref_cols
           from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace
           join pg_class rc on rc.oid=con.confrelid join pg_namespace rn on rn.oid=rc.relnamespace
           where con.contype='f' and n.nspname not in ${SYSTEM_PG}`),
      run(`select n.nspname as schema, t.relname as tbl, i.relname as name, ix.indisunique as uniq, string_agg(a.attname, ',' order by k.ord) as cols
           from pg_index ix join pg_class t on t.oid=ix.indrelid join pg_class i on i.oid=ix.indexrelid join pg_namespace n on n.oid=t.relnamespace
           cross join lateral unnest(ix.indkey::int2[]) with ordinality k(attnum,ord) join pg_attribute a on a.attrelid=t.oid and a.attnum=k.attnum
           where n.nspname not in ${SYSTEM_PG} and not ix.indisprimary group by 1,2,3,4`),
    ])
    return modelOf(toObjects(tables), toObjects(cols), toObjects(pks), toObjects(fks), toObjects(idx))
  },
}

const SYSTEM_MY = `('mysql','information_schema','performance_schema','sys')`
export const mysql: Dialect = {
  id: 'mysql',
  quote: (s) => quote('mysql', s),
  qualify: (sc, t) => q('mysql', sc, t),
  paginate: appendLimit,
  async introspect(run: Run) {
    const [tables, cols, pks, fks, idx] = await Promise.all([
      run(`select table_schema as \`schema\`, table_name as name, table_type as kind from information_schema.tables where table_schema not in ${SYSTEM_MY}`),
      run(`select table_schema as \`schema\`, table_name as tbl, column_name as col, column_type as type, is_nullable as nullable, column_default as dflt, ordinal_position as pos from information_schema.columns where table_schema not in ${SYSTEM_MY} order by 1,2,7`),
      run(`select table_schema as \`schema\`, table_name as tbl, column_name as col from information_schema.key_column_usage where constraint_name='PRIMARY' and table_schema not in ${SYSTEM_MY}`),
      run(`select table_schema as \`schema\`, table_name as tbl, constraint_name as name, group_concat(column_name order by ordinal_position) as cols, referenced_table_schema as ref_schema, referenced_table_name as ref_table, group_concat(referenced_column_name order by ordinal_position) as ref_cols from information_schema.key_column_usage where referenced_table_name is not null and table_schema not in ${SYSTEM_MY} group by table_schema, table_name, constraint_name, referenced_table_schema, referenced_table_name`),
      run(`select table_schema as \`schema\`, table_name as tbl, index_name as name, (min(non_unique)=0) as uniq, group_concat(column_name order by seq_in_index) as cols from information_schema.statistics where index_name<>'PRIMARY' and table_schema not in ${SYSTEM_MY} group by table_schema, table_name, index_name`),
    ])
    return modelOf(toObjects(tables), toObjects(cols), toObjects(pks), toObjects(fks), toObjects(idx))
  },
}

export const sqlite: Dialect = {
  id: 'sqlite',
  quote: (s) => quote('sqlite', s),
  qualify: (sc, t) => q('sqlite', sc, t),
  paginate: appendLimit,
  async introspect(run: Run) {
    const master = toObjects(await run(`select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name`))
    const S = 'main'
    const cols: Row[] = [], pks: Row[] = [], fks: Row[] = [], idx: Row[] = []
    const views = new Set<string>()
    for (const { name, type } of master) {
      const tbl = String(name), q = `'${tbl.replace(/'/g, "''")}'`
      if (type === 'view') views.add(`${S}\u0000${tbl}`)
      for (const c of toObjects(await run(`pragma table_info(${q})`))) {
        cols.push({ schema: S, tbl, col: c.name, type: c.type || 'ANY', nullable: !bool(c.notnull), dflt: c.dflt_value, pos: Number(c.cid) + 1 })
        if (Number(c.pk) > 0) pks.push({ schema: S, tbl, col: c.name })
      }
      const byId = new Map<number, Row & { c: string[]; r: string[] }>()
      for (const f of toObjects(await run(`pragma foreign_key_list(${q})`))) {
        const id = Number(f.id)
        const e = byId.get(id) ?? { schema: S, tbl, name: `fk_${tbl}_${id}`, ref_schema: S, ref_table: f.table, c: [], r: [] }
        e.c.push(String(f.from)); e.r.push(String(f.to ?? '')); byId.set(id, e)
      }
      for (const e of byId.values()) fks.push({ ...e, cols: e.c, ref_cols: e.r })
      for (const i of toObjects(await run(`pragma index_list(${q})`))) {
        if (i.origin === 'pk') continue
        const ic = toObjects(await run(`pragma index_info('${String(i.name).replace(/'/g, "''")}')`)).map((x) => String(x.name))
        idx.push({ schema: S, tbl, name: i.name, uniq: i.unique, cols: ic })
      }
    }
    return { schemas: assemble(cols, pks, fks, idx, views, master.map((m) => ({ schema: S, name: m.name }))) }
  },
}

/** Fallback for any other JDBC database: ANSI information_schema where available, else no catalog. */
export const generic: Dialect = {
  id: 'generic',
  quote: (s) => quote('generic', s),
  qualify: (sc, t) => q('generic', sc, t),
  paginate: () => undefined,
  async introspect(run: Run) {
    const cols = toObjects(await run(`select table_schema as schema, table_name as tbl, column_name as col, data_type as type, is_nullable as nullable, column_default as dflt, ordinal_position as pos from information_schema.columns order by 1,2,7`))
    return modelOf([], cols, [], [], [])
  },
}

/** `OFFSET … ROWS FETCH NEXT … ROWS ONLY` (Oracle 12c+, Db2 11+, Derby 10.7+). */
function appendOffsetFetch(sql: string, limit: number, offset: number): string | undefined {
  const body = stripLeadingComments(sql).replace(/;\s*$/, '')
  if (!/^\(?\s*(select|with|values|table)\b/i.test(body)) return undefined
  if (/\b(limit|fetch\s+(first|next)|top|offset)\b/i.test(body.slice(-200))) return undefined
  return `${body}\nOFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`
}

/** T-SQL needs an ORDER BY before OFFSET/FETCH; inject one when the query has none. */
function appendLimitMssql(sql: string, limit: number, offset: number): string | undefined {
  const body = stripLeadingComments(sql).replace(/;\s*$/, '')
  if (!/^\(?\s*(select|with|values|table)\b/i.test(body)) return undefined
  const tail = body.slice(-200)
  if (/\b(limit|fetch\s+(first|next)|top|offset)\b/i.test(tail)) return undefined
  const order = /\border\s+by\b/i.test(body) ? '' : 'ORDER BY (SELECT NULL)\n'
  return `${body}\n${order}OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`
}

/**
 * Oracle: the ALL_* dictionary views need no special privileges. `data_default` is LONG, so it is
 * only ever selected, never wrapped in expressions.
 * (Catalog facts cross-checked against DataGrip's OraIntroQueries.sql, facts only.)
 */
const SYSTEM_ORA = `('SYS','SYSTEM','OUTLN','XDB','CTXSYS','MDSYS','ORDSYS','DBSNMP','WMSYS','AUDSYS','LBACSYS','DVSYS','ORDDATA','APPQOSSYS','OJVMSYS','GSMADMIN_INTERNAL','RDSADMIN','SYSBACKUP','SYSDG','SYSKM','SYSRAC','SYS$UMF','DBSFWUSER','GGSYS','REMOTE_SCHEDULER_AGENT','XS$NULL','ANONYMOUS')`
export const oracle: Dialect = {
  id: 'oracle',
  quote: (s) => quote('oracle', s),
  qualify: (sc, t) => q('oracle', sc, t),
  paginate: appendOffsetFetch,
  async introspect(run: Run) {
    const [tables, views, cols, pks, fks, idx] = await Promise.all([
      run(`select owner as schema, table_name as name, 'TABLE' as kind from all_tables where owner not in ${SYSTEM_ORA} and table_name not like 'BIN$%'`),
      run(`select owner as schema, view_name as name, 'VIEW' as kind from all_views where owner not in ${SYSTEM_ORA} and view_name not like 'BIN$%'`),
      run(`select owner as schema, table_name as tbl, column_name as col,
             case when data_type = 'NUMBER' and data_precision is not null
                    then 'NUMBER(' || data_precision || case when nvl(data_scale, 0) > 0 then ',' || data_scale end || ')'
                  when data_type in ('VARCHAR2','NVARCHAR2','CHAR','NCHAR') and char_length is not null
                    then data_type || '(' || char_length || ')'
                  else data_type end as type,
             nullable, data_default as dflt, column_id as pos
           from all_tab_cols
           where hidden_column = 'NO' and owner not in ${SYSTEM_ORA} and table_name not like 'BIN$%'
           order by owner, table_name, column_id`),
      opts(run, `select c.owner as schema, c.table_name as tbl, cc.column_name as col
           from all_constraints c join all_cons_columns cc on cc.owner = c.owner and cc.constraint_name = c.constraint_name
           where c.constraint_type = 'P' and c.owner not in ${SYSTEM_ORA} and c.table_name not like 'BIN$%'`),
      opts(run, `select c.owner as schema, c.table_name as tbl, c.constraint_name as name,
             (select listagg(cc.column_name, ',') within group (order by cc.position)
                from all_cons_columns cc where cc.owner = c.owner and cc.constraint_name = c.constraint_name) as cols,
             rc.owner as ref_schema, rc.table_name as ref_table,
             (select listagg(rc2.column_name, ',') within group (order by rc2.position)
                from all_cons_columns rc2 where rc2.owner = rc.owner and rc2.constraint_name = rc.constraint_name) as ref_cols
           from all_constraints c join all_constraints rc on rc.owner = c.r_owner and rc.constraint_name = c.r_constraint_name
           where c.constraint_type = 'R' and c.owner not in ${SYSTEM_ORA} and c.table_name not like 'BIN$%'`),
      opts(run, `select i.owner as schema, i.table_name as tbl, i.index_name as name,
             case when i.uniqueness = 'UNIQUE' then 1 else 0 end as uniq,
             (select listagg(ic.column_name, ',') within group (order by ic.column_position)
                from all_ind_columns ic where ic.index_owner = i.owner and ic.index_name = i.index_name) as cols
           from all_indexes i
           where i.owner not in ${SYSTEM_ORA} and i.table_name not like 'BIN$%' and i.index_type not like '%LOB%'`),
    ])
    return modelOf([...toObjects(tables), ...toObjects(views)], toObjects(cols), pks, fks, idx)
  },
}

/** Db2 LUW: SYSCAT catalogs (no ANSI information_schema). CHAR columns are trimmed. */
const SYSTEM_DB2 = `('SYSIBM','SYSCAT','SYSSTAT','SYSPUBLIC','SYSIBMADM','NULLID','SQLJ','SYSTOOLS','SYSFUN','SYSPROC','SYSIBMTS','DB2QP')`
export const db2: Dialect = {
  id: 'db2',
  quote: (s) => quote('db2', s),
  qualify: (sc, t) => q('db2', sc, t),
  paginate: appendOffsetFetch,
  async introspect(run: Run) {
    const [tables, cols, pks, fks, idx] = await Promise.all([
      run(`select trim(tabschema) as schema, trim(tabname) as name, case when type = 'V' then 'VIEW' else 'TABLE' end as kind
           from syscat.tables where type in ('T','V','M') and tabschema not in ${SYSTEM_DB2}`),
      run(`select trim(c.tabschema) as schema, trim(c.tabname) as tbl, trim(c.colname) as col,
             case when c.typename in ('VARCHAR','CHARACTER','CHAR','GRAPHIC','VARGRAPHIC') and c.length is not null then c.typename || '(' || c.length || ')'
                  when c.typename in ('DECIMAL','NUMERIC') and c.length is not null then c.typename || '(' || c.length || ',' || c.scale || ')'
                  else trim(c.typename) end as type,
             c.nulls as nullable, c."DEFAULT" as dflt, c.colno as pos
           from syscat.columns c
           where c.tabschema not in ${SYSTEM_DB2}
           order by c.tabschema, c.tabname, c.colno`),
      opts(run, `select trim(i.tabschema) as schema, trim(i.tabname) as tbl, trim(c.colname) as col
           from syscat.indexes i join syscat.indexcoluse c on c.indschema = i.indschema and c.indname = i.indname
           where i.uniquerule = 'P' and i.tabschema not in ${SYSTEM_DB2}`),
      opts(run, `select trim(r.tabschema) as schema, trim(r.tabname) as tbl, trim(r.constname) as name,
             (select listagg(trim(k.colname), ',') within group (order by k.colseq) from syscat.keycoluse k
                where k.tabschema = r.tabschema and k.tabname = r.tabname and k.constname = r.constname) as cols,
             trim(r.reftabschema) as ref_schema, trim(r.reftabname) as ref_table,
             (select listagg(trim(k.colname), ',') within group (order by k.colseq) from syscat.keycoluse k
                where k.tabschema = r.reftabschema and k.tabname = r.reftabname and k.constname = r.refkeyname) as ref_cols
           from syscat.references r where r.tabschema not in ${SYSTEM_DB2}`),
      opts(run, `select trim(i.tabschema) as schema, trim(i.tabname) as tbl, trim(i.indname) as name,
             case when i.uniquerule = 'U' then 1 else 0 end as uniq,
             (select listagg(trim(c.colname), ',') within group (order by c.colseq) from syscat.indexcoluse c
                where c.indschema = i.indschema and c.indname = i.indname) as cols
           from syscat.indexes i where i.uniquerule in ('U','D') and i.tabschema not in ${SYSTEM_DB2}`),
    ])
    return modelOf(toObjects(tables), toObjects(cols), pks, fks, idx)
  },
}

/**
 * SAP ASE: sysobjects/syscolumns. Nullability is bit 8 of syscolumns.status (DataGrip decodes the
 * same mask in AseIntrospectorKt); primary keys come from syskeys (type 1), FKs are not listed.
 */
export const sybase: Dialect = {
  id: 'sybase',
  quote: (s) => quote('sybase', s),
  qualify: (sc, t) => q('sybase', sc, t),
  paginate: () => undefined,
  async introspect(run: Run) {
    const [tables, cols, pks] = await Promise.all([
      run(`select user_name(o.uid) as schema, o.name as name, case when o.type = 'V' then 'VIEW' else 'TABLE' end as kind
           from sysobjects o where o.type in ('U','V') and o.name not like 'sys%' and o.name not like 'rs_%'`),
      run(`select user_name(o.uid) as schema, o.name as tbl, c.name as col, t.name as type,
             case when (c.status & 8) = 8 then 'YES' else 'NO' end as nullable,
             (select sc.text from syscomments sc where sc.id = c.cdefault) as dflt,
             c.colid as pos
           from sysobjects o join syscolumns c on c.id = o.id left join systypes t on t.usertype = c.usertype
           where o.type in ('U','V') and o.name not like 'sys%' and o.name not like 'rs_%'`),
      opts(run, `select user_name(o.uid) as schema, o.name as tbl, c.name as col
           from syskeys k join sysobjects o on o.id = k.id
           join syscolumns c on c.id = k.id and c.colid in (k.key1, k.key2, k.key3, k.key4, k.key5, k.key6, k.key7, k.key8)
           where k.type = 1 and o.type = 'U' and o.name not like 'sys%' and o.name not like 'rs_%'`),
    ])
    return modelOf(toObjects(tables), toObjects(cols), pks, [], [])
  },
}

/** ClickHouse: system.tables/system.columns; primary key columns carry is_in_primary_key (no FKs). */
const SYSTEM_CH = `('system','INFORMATION_SCHEMA','information_schema')`
export const clickhouse: Dialect = {
  id: 'clickhouse',
  quote: (s) => quote('clickhouse', s),
  qualify: (sc, t) => q('clickhouse', sc, t),
  paginate: appendLimit,
  async introspect(run: Run) {
    const [tables, cols] = await Promise.all([
      run(`select database as schema, name as name,
             multiIf(engine in ('View','MaterializedView','LiveView','WindowView'), 'VIEW', 'TABLE') as kind
           from system.tables
           where database not in ${SYSTEM_CH} and is_temporary = 0 and name not like '.inner%'
           order by database, name`),
      run(`select database as schema, table as tbl, name as col, type,
             if(startsWith(type, 'Nullable('), 'YES', 'NO') as nullable,
             nullIf(default_expression, '') as dflt, position as pos, is_in_primary_key as pk
           from system.columns
           where database not in ${SYSTEM_CH} and table not like '.inner%'
           order by database, table, position`),
    ])
    const c = toObjects(cols)
    const pks = c.filter((r) => bool(r.pk)).map((r) => ({ schema: r.schema, tbl: r.tbl, col: r.col }))
    return modelOf(toObjects(tables), c, pks, [], [])
  },
}

/** Cassandra CQL: system_schema catalogs. No ORDER BY (CQL only allows it on restricted partitions). */
const SYSTEM_CASS = `('system','system_schema','system_auth','system_traces','system_distributed','system_views','system_virtual_schema')`
export const cassandra: Dialect = {
  id: 'cassandra',
  quote: (s) => quote('cassandra', s),
  qualify: (sc, t) => q('cassandra', sc, t),
  paginate: () => undefined,
  async introspect(run: Run) {
    const [tables, views, cols] = await Promise.all([
      run(`select keyspace_name as schema, table_name as name, 'TABLE' as kind from system_schema.tables where keyspace_name not in ${SYSTEM_CASS}`),
      opts(run, `select keyspace_name as schema, view_name as name, 'VIEW' as kind from system_schema.views where keyspace_name not in ${SYSTEM_CASS}`),
      run(`select keyspace_name as schema, table_name as tbl, column_name as col, type, kind,
             case when kind in ('partition_key','clustering') then 'NO' else 'YES' end as nullable,
             null as dflt, position as pos
           from system_schema.columns where keyspace_name not in ${SYSTEM_CASS}`),
    ])
    const c = toObjects(cols)
    const pks = c.filter((r) => r.kind === 'partition_key' || r.kind === 'clustering').map((r) => ({ schema: r.schema, tbl: r.tbl, col: r.col }))
    return modelOf([...toObjects(tables), ...views], c, pks, [], [])
  },
}

/**
 * BigQuery: INFORMATION_SCHEMA views are region-scoped, so the common multi-regions are probed in
 * order (`region-us` first). An empty result from one region still allows later regions to answer.
 */
const BQ_REGIONS = ['`region-us`', '`region-eu`', '`region-asia-east1`']
export const bigquery: Dialect = {
  id: 'bigquery',
  quote: (s) => quote('bigquery', s),
  qualify: (sc, t) => q('bigquery', sc, t),
  paginate: appendLimit,
  async introspect(run: Run) {
    let empty: Omit<DatabaseModel, 'dialect' | 'version'> | undefined
    let firstError: unknown
    for (const region of BQ_REGIONS) {
      try {
        const [tables, cols, pks] = await Promise.all([
          run(`select table_schema as schema, table_name as name, table_type as kind from ${region}.INFORMATION_SCHEMA.TABLES`),
          run(`select table_schema as schema, table_name as tbl, column_name as col, data_type as type, is_nullable as nullable, column_default as dflt, ordinal_position as pos from ${region}.INFORMATION_SCHEMA.COLUMNS order by 1,2,7`),
          opts(run, `select kcu.table_schema as schema, kcu.table_name as tbl, kcu.column_name as col
               from ${region}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
               join ${region}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
               where tc.constraint_type = 'PRIMARY KEY'`),
        ])
        const t = toObjects(tables)
        const model = modelOf(t, toObjects(cols), pks, [], [])
        if (t.length > 0) return model
        empty ??= model
      } catch (e) { firstError ??= e }
    }
    if (empty) return empty
    throw firstError instanceof Error ? firstError : new Error('BigQuery INFORMATION_SCHEMA is not reachable from any known region')
  },
}

/** Clone an existing dialect implementation for another DialectId (quoting follows the new id). */
const withId = (base: Dialect, id: DialectId): Dialect => ({
  ...base, id,
  quote: (s) => quote(id, s),
  qualify: (sc, t) => q(id, sc, t),
})

export const dialects: Record<DialectId, Dialect> = {
  postgres,
  mysql,
  sqlite,
  generic,
  // MySQL-compatible: mariadb.
  mariadb: withId(mysql, 'mariadb'),
  // PostgreSQL-compatible: pg_catalog introspection works on all four.
  greenplum: withId(postgres, 'greenplum'),
  cockroach: withId(postgres, 'cockroach'),
  redshift: withId(postgres, 'redshift'),
  vertica: withId(postgres, 'vertica'),
  // ANSI information_schema + LIMIT (or FETCH) pagination.
  mssql: { ...withId(generic, 'mssql'), paginate: appendLimitMssql },
  // Catalog-specific introspection (these engines have no usable ANSI information_schema).
  oracle,
  db2,
  sybase,
  clickhouse,
  cassandra,
  bigquery,
  derby: { ...withId(generic, 'derby'), paginate: appendOffsetFetch },
  h2: { ...withId(generic, 'h2'), paginate: appendLimit },
  hsql: { ...withId(generic, 'hsql'), paginate: appendLimit },
  exasol: { ...withId(generic, 'exasol'), paginate: appendLimit },
  snowflake: { ...withId(generic, 'snowflake'), paginate: appendLimit },
  hive: { ...withId(generic, 'hive'), paginate: appendLimit },
  spark: { ...withId(generic, 'spark'), paginate: appendLimit },
}
export { returnsRows }
