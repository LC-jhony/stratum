# Phases 8–9 — Administration and AI assistant

Two vertical slices that reuse the existing session stack: a dashboard for the live server, a
recurring export scheduler, and a schema-aware chat panel.

## Phase 8 — Sessions, dashboard and scheduled tasks

**Dashboard** (`src/renderer/src/features/admin/AdminDialog.tsx`, `menu.dashboard`) shows one card
per data source with counts already present in the introspected model (schemas, tables, views,
columns, foreign keys). For PostgreSQL, MySQL/MariaDB and SQLite it also runs two cheap queries
from `src/core/dashboard.ts`:

| Dialect | Size | Sessions |
| --- | --- | --- |
| PostgreSQL family | `pg_database_size(current_database())` | `pg_stat_activity` for the current database |
| MySQL family | `information_schema.tables` data + index length | `information_schema.processlist` |
| SQLite | `pragma_page_count * pragma_page_size` | — |

Metrics are read only for connections that are already live; opening the dashboard never opens a
connection. Other dialects show model counts only. `formatBytes` and `metricValue` are pure and
tested, including bigints returned as text.

**Scheduled exports** are one SQL statement per task, run every 1–10,080 minutes while Stratum is
open:

- `src/core/tasks.ts` validates the input, plans the first run one interval ahead, keeps a future
  `nextRun` when only the SQL, name or output changed, and restarts the clock when the interval
  changes or the task is re-enabled. Failures keep the schedule and retry at the same interval.
- `src/main/services/taskService.ts` serializes list/save/remove/run/tick in one promise queue.
  Due tasks run oldest first, one at a time. Reads are paged (5,000 rows) through the normal
  session, so SSH, SSL and paging apply; an export over 1,000,000 rows fails instead of exhausting
  memory.
- Output formats: CSV, TSV, JSON, SQL INSERTs and XLSX, all through the existing exporters. The
  file is written to `<output>.<pid>.tmp` and atomically renamed, so a crash or a failed query
  never truncates the previous export.
- The output path is chosen once through a native save dialog (`DesktopService.savePath`). Later
  runs overwrite it without another prompt.
- Tasks live in `<userData>/tasks.json`; the renderer listens on `tasks:changed`. The same dialog
  can run a task immediately without disturbing its plan.

## Phase 9 — AI assistant

The chat is provider-agnostic and never exposes the API key to the renderer.

**Configuration** (`Settings → AI assistant`, `ai.*` in settings.json):

- `ai.provider`: `none`, `openai`, `anthropic`, `ollama` or `custom` (an OpenAI-compatible
  endpoint). Switching provider fills the endpoint/model defaults unless they were customised.
- `ai.endpoint` and `ai.model` default to `src/core/ai.ts`'s provider table; a full URL typed by
  the user wins over the appended path.
- `ai.apiKey` is sealed with the OS keychain (the same `seal`/`unseal` used by connection
  passwords). `settings.get` returns `getPublic()`: the key is blank and `ai.hasKey` says whether
  one is stored. A blank key from the dialog keeps the stored one; **Clear** sends `null`.
- `ai.sendSchema` controls whether the introspected model travels with the question.

**Request flow** (`src/main/services/aiService.ts`):

1. `AiService` reads the settings and unseals the key in main only.
2. When `ai.sendSchema` is on and the data source is already live, it introspects it. No
   connection is opened just for the chat; without a live session the answer is generic.
3. `schemaContext` builds a bounded catalogue (12,000 characters, 80 tables): table, columns with
   types, primary key / `not null`, foreign keys and a `[view]` marker. Excess tables are counted,
   not listed.
4. `buildAiRequest` shapes the provider call: OpenAI-compatible (`/chat/completions`, bearer),
   Anthropic (`/v1/messages`, `x-api-key` + `anthropic-version`, system prompt outside
   `messages`) or Ollama (`/api/chat`, `stream: false`).
5. Requests are non-streaming with a 90-second timeout; provider errors are surfaced as readable
   messages. `parseAiResponse` reads each provider shape.
6. `extractSql` returns fenced SQL blocks (bare statements fall back to the whole answer), and the
   panel offers **Copy** and **Insert into console** for each one. Inserting into a non-console
   tab opens a new console with that connection.

**UI** (`src/renderer/src/features/ai/AiChatDialog.tsx`, `menu.ai`, `Ctrl/⌘+Alt+A`, toolbar sparkle)
shows the bound data source, whether schema context is on, sample prompts, the conversation, and a
composer with `Ctrl/⌘+Enter` to send. With no provider configured it points at Settings instead of
failing.

## Verification

- `src/core/tasks.ts`, `src/core/dashboard.ts`, `src/core/ai.ts` are pure and covered by
  `tests/tasks.test.ts`, `tests/dashboard.test.ts`, `tests/ai.test.ts`.
- `tests/taskService.test.ts` runs the scheduler against a fake session and checks CSV/JSON output,
  atomic replacement after a failed query, deletion and validation.
- `npm run verify`: typecheck, architecture lint, 573 tests passed (42 skipped), production build.
