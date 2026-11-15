import type { PlanNode, QueryPlan } from '../../../../shared/types'
import { Icon } from '../../ui/Icon'

const fmt = (n: number | undefined): string | undefined => {
  if (n === undefined || !Number.isFinite(n)) return undefined
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n * 100) / 100)
}

function PlanRow({ node, depth }: { node: PlanNode; depth: number }) {
  return (
    <div className="plan-node" style={{ marginLeft: depth * 18 }}>
      <div className="plan-node-head">
        <span className="plan-dot" aria-hidden="true" />
        <span className="plan-label">{node.label}</span>
        {node.rows !== undefined && <span className="plan-metric" title="Estimated rows">~{fmt(node.rows)} rows</span>}
        {node.actualRows !== undefined && <span className="plan-metric" title="Actual rows">→ {fmt(node.actualRows)}</span>}
        {node.cost !== undefined && <span className="plan-metric" title="Estimated cost">cost {fmt(node.cost)}</span>}
        {node.actualTimeMs !== undefined && <span className="plan-metric" title="Actual time">{fmt(node.actualTimeMs)} ms</span>}
      </div>
      {node.detail && <div className="plan-detail">{node.detail}</div>}
      {node.warning && <div className="plan-warning"><Icon id="triangle-alert" />{node.warning}</div>}
      {node.children?.map((child, i) => <PlanRow key={`${child.label}-${i}`} node={child} depth={depth + 1} />)}
    </div>
  )
}

/** Visual EXPLAIN: normalized tree for JSON plans, verbatim rows for textual plans. */
export function PlanView({ plan, onClose }: { plan: QueryPlan; onClose(): void }) {
  return (
    <section className="plan-pane" aria-label="Execution plan">
      <header className="plan-head">
        <Icon id="type-hierarchy" />
        <strong>Execution plan</strong>
        <span className="plan-sql" title={plan.sql}>{plan.sql.replace(/\s+/g, ' ').slice(0, 120)}</span>
        <span className="plan-metric">{plan.durationMs} ms</span>
        <button className="plan-close" type="button" aria-label="Close plan" title="Close" onClick={onClose}><Icon id="close" /></button>
      </header>
      {plan.error ? (
        <div className="plan-error" role="alert"><Icon id="error" />{plan.error}</div>
      ) : plan.format === 'text' && plan.raw ? (
        <pre className="plan-raw">{plan.raw}</pre>
      ) : (
        <div className="plan-tree"><PlanRow node={plan.root} depth={0} /></div>
      )}
    </section>
  )
}
