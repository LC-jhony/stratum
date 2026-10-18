/**
 * Ranking for SQL completion candidates (DataGrip-style), pure and UI-free.
 *
 * DataGrip scores candidates with a gradient-boosted model (`sql_model/model.bin` inside
 * `intellij.database.completionMlRanking.jar`) over signals listed in
 * `sql_features/features_order.txt`: `prefix_greedy_score`, `middleMatching`, `liftShorter`,
 * `priority`, `grouping`, `stats` / `session_query_number`, `ml_recent_places_contains`,
 * `ml_ctx_sql_dialect`, `templates`, … This module does not port that model: it
 * re-implements the same *signals* as a small deterministic heuristic over our own list.
 *
 * The coarse kind priority stays in `Completion.bucket` (it dominates the score, so the
 * ranking only orders candidates that share a bucket):
 *  - match quality of the typed word: exact > prefix (shorter labels first, `liftShorter`)
 *    > middle matching > greedy subsequence,
 *  - usage frequency in the current document/session (`stats` / `session_query_number`).
 *
 * A usage lift is capped, so it can reorder equal-kind candidates but never escape a bucket.
 */

/** Minimal shape the ranker needs; `Completion` satisfies it. */
export interface RankItem {
  label: string
  bucket: number
}

export interface RankContext {
  /** Word being typed at the caret (empty when completing right after `.`). */
  word: string
  /** Occurrences of each lowercased label in the current document/session. */
  usage?: ReadonlyMap<string, number>
}

/** How well `label` matches the typed `word`; higher is better, 0 = no match. */
export function matchScore(label: string, word: string): number {
  if (!word) return 0
  const l = label.toLowerCase()
  const w = word.toLowerCase()
  if (l === w) return 400
  if (l.startsWith(w)) return 300 - Math.min(100, l.length - w.length) // prefix; shorter first
  const at = l.indexOf(w)
  if (at > 0) return 150 - Math.min(50, at) // middleMatching
  let i = 0
  for (const ch of l) if (i < w.length && ch === w[i]) i++ // prefix_greedy_score
  return i === w.length ? 100 : 0
}

/** Usage lift; capped well below the bucket weight so kind priority always wins. */
const usageLift = (n: number) => Math.min(20, n) * 5

/** Stable, bucket-dominant ordering: best score first, ties keep the engine order. */
export function rankCompletions<T extends RankItem>(items: T[], ctx: RankContext): T[] {
  if (items.length < 2) return items
  return items
    .map((item, index) => ({
      item,
      index,
      score:
        -item.bucket * 10000 +
        matchScore(item.label, ctx.word) +
        (ctx.usage ? usageLift(ctx.usage.get(item.label.toLowerCase()) ?? 0) : 0),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((scored) => scored.item)
}
