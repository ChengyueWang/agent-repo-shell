# Changelog

All notable changes to this extension are documented here.

## [0.0.1] - Initial release

First public version. Features:

- Sidebar file tree with arbitrary-depth folder nesting.
- Sidebar filter (`/` to focus) — substring match on file path / name.
- One-click open: markdown files render inline; other files open in the editor + render a file overview in the panel.
- File overviews from the LSP: title + summary, Mermaid call-graph, function accordion (signature, doc, call tree), used-by references, TODO/FIXME scan.
- Favorites and Hide (right-click menu) — persisted per workspace.
- Find-in-content (Ctrl/Cmd+F) with match navigation and auto-expand of collapsed sections.
- Session history grouped from `history/<id>/{prompts,responses}.md` files.
- Task state chip for `tasks/{todo,doing,done}/<file>.md`.
- `.code-render/<path>.json` sidecar cache for instant overview rendering.
- Auto-refresh on file changes.
