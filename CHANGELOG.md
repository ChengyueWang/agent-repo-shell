# Changelog

All notable changes to this extension are documented here.

## [0.0.3]

- New command **Agent Repo Shell: Install Session Capture Hook** — copies the Claude Code Stop-hook into `tools/hooks/` and registers it in `.claude/settings.json`. Lets you wire history capture into any existing workspace without cloning the [template](https://github.com/ChengyueWang/agent-repo-shell-template). Idempotent.
- Bundled `save-assistant-response.py` under `resources/hooks/` (ships in the .vsix, ~14 KB).
- **One-click launch**: pet-icon button in the editor title bar (top-right of each editor tab) + a `$(layout-panel) Agent Repo Shell` status bar item (bottom-right) — both run `Open View` so you don't need to go through the command palette.
- New setting `agentRepoShell.showEditorTitleIcon` (default true) to toggle the editor-title icon if it feels cluttered.

## [0.0.2]

- Marketplace polish: `galleryBanner`, `repository` / `bugs` / `homepage` metadata, structured README, separate `DEVELOPMENT.md`.
- Coral-pink Pet03 (pixel orb) icon, NEAREST-upscaled from the in-extension pet renderer.

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
