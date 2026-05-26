# Agent Repo Shell

A VSCode webview that turns your workspace into a navigable "shell" — sidebar file tree, per-file overviews powered by the LSP, session history, favorites, hide, and in-content find. Designed for agentic / Claude Code style repos where you want a fast bird's-eye view of the whole project without endless folder clicking.

## What it does

- **Sidebar file tree** — folders, sub-folders, nested arbitrarily deep. Press `/` anywhere to filter by name.
- **One-click open** — clicking a `.md` file renders it inline (with syntax-highlighted code blocks, GFM tables, Mermaid diagrams). Clicking any other file opens it in the editor AND renders a file overview in the panel.
- **File overviews from the LSP** — for any code file the panel shows: title + module summary (from the leading doc), a Mermaid call-graph of intra-file functions, an accordion of every top-level function/class (signature, doc, call tree, "jump to definition"), cross-file "used by" references, and a TODO/FIXME scan. All sourced from `executeHoverProvider`, `executeDocumentSymbolProvider`, `prepareCallHierarchy`/`provideOutgoingCalls`, `executeReferenceProvider` — no markers in source, works on any language with an installed LSP.
- **Favorites & Hide** — right-click any file or folder. Favorited items get a top section in the sidebar with parent-dir hints; hidden items drop out of the tree (toggle "show N hidden" in the eyebrow to unhide).
- **Find in content** — `Ctrl/Cmd+F` opens a custom find widget (the native webview find widget is unreliable). Highlights matches, navigates with Enter / Shift+Enter, auto-opens parent `<details>` so matches inside collapsed sections are still reachable.
- **Session history** — if your repo has a `history/` folder with session subdirectories containing `prompts.md` / `responses.md`, they're grouped into a single "history" sidebar section with each session rendered as a chat-style transcript.
- **Auto-refresh** — when files change on disk, the panel rebuilds.

## Install

### From the marketplace
Search for "Agent Repo Shell" in the VSCode Extensions view, or install from the marketplace page.

### From a .vsix (local install)
```bash
git clone https://github.com/ChengyueWang/agent-repo-shell.git
cd agent-repo-shell
npm install
npm install -g @vscode/vsce
vsce package
code --install-extension agent-repo-shell-*.vsix
```

## Usage

1. Open any folder in VSCode.
2. `Cmd/Ctrl+Shift+P` → **Agent Repo Shell: Open View**.
3. The webview opens in the active editor column with your workspace tree on the left.

### Keyboard shortcuts (inside the panel)

| Key | Action |
|-----|--------|
| `/` | Focus the sidebar filter |
| `Ctrl/Cmd+F` | Open find-in-content |
| `Enter` / `Shift+Enter` | Next / previous match (in find) |
| `Esc` | Close find / clear filter |

### Right-click menu

Right-click any sidebar entry to:

- **★ Add to Favorites** / **☆ Remove from Favorites**
- **Hide** / **Unhide**
- **Copy Path** / **Copy Relative Path**
- **Rename** / **Delete** (greyed out for the workspace root)

## Conventions the extension expects

Most of these are opinionated defaults useful for "agent repo" style workspaces but the extension works on any repo:

- `specs/`, `tasks/`, `skills/`, `references/`, `targets/` — top-level folders that show as sidebar sections even when empty.
- `history/<session-id>/{prompts,responses}.md` — session transcripts auto-grouped under a "history" section.
- `tasks/{todo,doing,done}/<file>.md` — when viewing a task file, a state chip appears at the top-right; clicking it moves the file between subfolders.
- `.code-render/<path>.json` — optional sidecar JSONs cache the LSP overview so clicks render the overview instantly without re-running analysis. The Sync button on each overview rewrites them.

## Development

```bash
git clone https://github.com/ChengyueWang/agent-repo-shell.git
cd agent-repo-shell
npm install
```

Open the folder in VSCode and press **F5**. A new "Extension Development Host" window launches with the extension loaded. Open any folder as the test workspace and run **Agent Repo Shell: Open View**.

Edits to `extension.js` require pressing the green reload button in the Dev Host window (or restart with F5).

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgements

- Markdown rendering via [marked](https://github.com/markedjs/marked) + [highlight.js](https://github.com/highlightjs/highlight.js).
- Diagrams via [Mermaid](https://github.com/mermaid-js/mermaid).
- Star icon path adapted from [Heroicons](https://heroicons.com/) (MIT).
