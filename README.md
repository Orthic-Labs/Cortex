# Blueprint

> **TL;DR:** Blueprint turns a software repository into an evidence-backed map so AI agents can understand what exists before they change it.

Large codebases are difficult for both people & agents to understand quickly. Important behavior may
be split across source files, tests, configuration, old plans & architecture docs. Blueprint reads
those sources together, maps their relationships & points every important conclusion back to real
files.

Blueprint works in two layers:

1. A deterministic mapper parses code & documents into a local SQLite graph of files, symbols,
   imports, calls, claims, tests & other relationships.
2. Evidence-bound verification checks what docs say against current code, then summarizes
   architecture, interfaces, security, health & incomplete product flows.

Outputs include machine-readable artifacts for agents plus `docs/product.md` &
`docs/architecture.md` for people. Blueprint also surfaces stale docs, unsupported claims &
code-versus-plan gaps instead of quietly guessing.

Blueprint is a comprehension tool. It reads application code; it does not rewrite it.

## Core entry points

```sh
blueprint
blueprint "<task>"
blueprint doctor --full --json
```

Full agent workflow: [`SKILL.md`](SKILL.md).
