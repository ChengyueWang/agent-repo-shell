# Development

Internal docs for hacking on Agent Repo Shell. End-user docs live in [README.md](README.md).

## Layout

```
agent-repo-shell/
├── extension.js          # single-file implementation — all logic + the
│                         # webview HTML template (String.raw`...`)
├── package.json          # extension manifest + npm deps + marketplace meta
├── icon.png              # 128x128 marketplace icon (NEAREST upscale of Pet03 idle)
├── images/               # GIFs/screenshots referenced by README
├── .vscode/launch.json   # F5 → Extension Development Host
└── .vscodeignore         # what stays out of the .vsix
```

`extension.js` is intentionally a single file. The bottom half is a giant
template literal containing the webview's HTML/CSS/JS — when you edit
sidebar styling or webview behaviour, you're editing strings inside that
template.

## Setup

Requires Node 18+ (vsce / packaging deps; extension runtime is whatever
Electron VSCode bundles, which is much newer).

```bash
git clone https://github.com/ChengyueWang/agent-repo-shell.git
cd agent-repo-shell
npm install
```

## Run from source (F5 dev loop)

```
Open the folder in VSCode → press F5
```

A new "Extension Development Host" window launches with the extension
loaded. In that window:

1. Open any folder as the test workspace (any repo will do — try opening
   this very repo for a meta-demo).
2. `Cmd/Ctrl+Shift+P` → **Agent Repo Shell: Open View**.

Edits to `extension.js` require pressing the green ↻ reload button in the
Dev Host window (or restart with F5). Reload picks up text/style changes
in the webview template; structural changes to the extension API surface
may need a full host restart.

## Package a .vsix

```bash
npx --yes @vscode/vsce package
# → agent-repo-shell-X.Y.Z.vsix
```

To install your local build into your normal VSCode (alongside any
marketplace version):

```bash
code --install-extension agent-repo-shell-X.Y.Z.vsix
```

## Bundle size

The current `.vsix` is ~18 MB, dominated by `node_modules/` (mermaid is
~25 MB unpacked, highlight.js ~9 MB). For a smaller package, bundle with
esbuild/webpack and tree-shake — typical reduction to ~3-5 MB. Not done
yet; tracked as a future optimisation.

## Publish to the marketplace

Two paths:

### Web UI (no PAT needed)
1. Build the .vsix (`npx --yes @vscode/vsce package`).
2. Go to https://marketplace.visualstudio.com/manage/publishers/ChengyueWang
3. Click **+ New extension** (or **Update** for an existing one) → **Visual Studio Code**.
4. Drag the `.vsix` in.

### CLI (needs a PAT)
1. Create a PAT at https://dev.azure.com/ → User Settings → Personal Access
   Tokens, scope **Marketplace → Manage**, organization **All accessible**.
2. ```bash
   npx --yes @vscode/vsce login ChengyueWang   # paste PAT
   npx --yes @vscode/vsce publish              # builds + uploads
   ```

Either path bumps the version on marketplace within ~1-2 minutes.

## Bump rules

- **Patch (`0.0.X`)** — bug fixes, README polish, asset changes
- **Minor (`0.X.0`)** — new features, UI tweaks
- **Major (`X.0.0`)** — breaking config changes, command renames, file-format changes

Also bump the entry in `CHANGELOG.md` before publishing.

## Code style

- No bundler; `extension.js` is hand-edited and shipped as-is.
- No TypeScript build; the file is plain ES2020+ JavaScript.
- Webview state via `vscode.setState` / `acquireVsCodeApi`.
- Sidebar state (favorites, hidden, collapsed sections) persists in
  `localStorage` inside the webview.
- File overview sidecars at `.code-render/<path>.json` — committed across
  machines, so paths inside are stored as workspace-relative.
