# ADR 0001 — Declarative extension registry with priority-based conflicts

- **Status:** accepted
- **Date:** 2026-11-14
- **Phase:** 0

## Context

Later phases add drivers, commands, importers and UI contributions. Loading and executing arbitrary
third-party code is a security and lifecycle problem that cannot be solved at the same time as the
data model. We need a stable way to declare contributions now and execute them later.

## Decision

Ship a data-only `ExtensionManifest` and an in-memory `ExtensionRegistry`:

- Manifests are validated on registration (id, semantic version, kind, priority, command ids).
- A duplicate id can only be replaced by a strictly higher priority.
- Ordering is deterministic: priority desc, name, id.
- Enabled/disabled state lives in settings, not in the manifest.
- Mandatory extensions cannot be disabled.
- Bundled capabilities are declared with the same manifest shape as the reference plugin.

## Consequences

- The Extensions dialog and conflict rules can be tested without executing extension code.
- Overlay order is explicit; no silent last-write-wins.
- A future loader can register downloaded manifests and reuse the same validation and conflict
  policy. It must add sandboxing, signatures and lifecycle hooks separately.
- Disabling a driver extension is currently advisory: existing code paths keep working until the
  runtime consults the registry in a later phase.
