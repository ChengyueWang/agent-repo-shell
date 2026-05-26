# Changelog

All notable changes to this extension are documented here.

## [0.0.5]

- Drop `preview: true` flag so the extension appears in default marketplace search (preview extensions can be filtered by some clients).

## [0.0.4]

- Gallery banner: coral → cream (#FBF8F2) for a softer marketplace header.
- README: final wording pass on tagline + section captions + caption-above-image layout + centered images (`<div align="center">`) + hero image at the top of the 📦 section.
- `package.json` description rewritten to match the new tagline ("Bootstrap your agentic multi-repos project. Minimum distractions to iterate on specs. A VSCode panel to code like taking notes.")

## [0.0.3]

- **One-click launch**: pet-icon button in the editor title bar (top-right of each editor tab) + a `$(layout-panel) Agent Repo Shell` status bar item (bottom-right) — both run `Open View` so you don't need to go through the command palette. Toggle the title-bar icon via `agentRepoShell.showEditorTitleIcon` (default true).
- **Not-an-agent-shell banner**: if the workspace is missing all of `tasks/`, `history/`, and `targets/`, the sidebar shows a coral notice pointing at the [template repo](https://github.com/ChengyueWang/agent-repo-shell-template) instead of silently rendering a near-empty sidebar.
- **Faster lazy-folder expansion**: `marked.parse` and sidecar JSON reads are now deferred to the first click on each file (instead of running synchronously for every file in the folder being expanded). Folders with many files used to take hundreds of ms; now expansion is essentially instant.

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
