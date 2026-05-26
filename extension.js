// Agent Repo Shell View — minimal VSCode extension that renders the repo as a
// webview panel and opens any file in the editor on one click.
//
// Markdown is rendered server-side via `marked` with `highlight.js` for code
// blocks. The webview itself contains no rendering JS — it just shows the
// pre-rendered HTML when a sidebar item is clicked, and posts a message back
// to the extension when a non-md file is clicked so we can open it in the
// editor.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js');

const CODE_EXTS = {
  '.sh': 'bash', '.py': 'python', '.json': 'json', '.toml': 'toml',
  '.yaml': 'yaml', '.yml': 'yaml', '.txt': '', '.js': 'javascript',
  '.ts': 'typescript', '.css': 'css',
};
const SPECIAL_FILES = {
  '.gitignore': '', '.gitmodules': '', 'Makefile': 'makefile',
  'Dockerfile': 'dockerfile', 'LICENSE': '',
};
const IGNORED_DIRS = new Set([
  '.git', '__pycache__', 'node_modules', '.pytest_cache',
  '.vscode', '.idea',
  // `history` is handled separately by collectSessions so each session
  // becomes a single sidebar entry instead of N raw .md files.
  'history',
]);
const IGNORED_FRAGMENTS = [];

// Sentinel prefix for synthetic session keys in the FILES map.
const SESSIONS_PREFIX = '[sessions]/';

// markdown-it gives us the same GFM-ish output as marked but with one big
// win: every block token has a `map: [startLine, endLine]` pointing back
// into the raw source. We inject those line numbers as `data-source-line`
// attributes on the rendered HTML so the webview can read them off the DOM
// when a selection is made — no more fuzzy-matching the quote back to the
// source. See the line-injection plugin just below.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  langPrefix: 'hljs language-',
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return '<pre class="hljs"><code class="hljs language-' + lang + '">'
          + hljs.highlight(code, { language: lang }).value
          + '</code></pre>';
      } catch (_) { /* fall through */ }
    }
    return '<pre class="hljs"><code>'
      + hljs.highlightAuto(code).value
      + '</code></pre>';
  },
});

// Inject `data-source-line` onto every block-level opening tag whose token
// has a `map`. Tokens with maps: paragraph_open, heading_open, list_item_open,
// blockquote_open, table_open, code_block, fence, hr, html_block, ...
// We patch markdown-it's `renderToken` to add the attribute uniformly.
(function patchSourceLine() {
  const origRender = md.renderer.renderToken.bind(md.renderer);
  md.renderer.renderToken = function (tokens, idx, options) {
    const t = tokens[idx];
    if (t && t.map && t.nesting !== -1) {
      t.attrSet('data-source-line', String(t.map[0] + 1));
      if (t.map[1] > t.map[0] + 1) {
        t.attrSet('data-source-line-end', String(t.map[1]));
      }
    }
    return origRender(tokens, idx, options);
  };
  // Self-closing block tokens (hr, code_block, fence, html_block) go through
  // their own render fns; wrap those too.
  ['code_block', 'fence', 'hr', 'html_block'].forEach((rule) => {
    const orig = md.renderer.rules[rule];
    if (!orig) return;
    md.renderer.rules[rule] = function (tokens, idx, opts, env, self) {
      const t = tokens[idx];
      if (t && t.map) {
        t.attrSet('data-source-line', String(t.map[0] + 1));
        if (t.map[1] > t.map[0] + 1) {
          t.attrSet('data-source-line-end', String(t.map[1]));
        }
      }
      return orig(tokens, idx, opts, env, self);
    };
  });
})();

// Thin shim — keep the `marked.parse(text)` call sites working with no
// other code changes. (Renaming everywhere is a churn we don't need.)
const marked = { parse: (text) => md.render(text || '') };

function classify(filename) {
  if (filename === '.gitkeep' || filename === '.DS_Store') return null;
  if (filename in SPECIAL_FILES) return { kind: 'code', lang: SPECIAL_FILES[filename] };
  const ext = path.extname(filename);
  if (ext === '.md') return { kind: 'md', lang: '' };
  if (ext in CODE_EXTS) return { kind: 'code', lang: CODE_EXTS[ext] };
  // Unknown extension: still list it (no inline syntax highlighting); clicking
  // delegates to VSCode's default open behaviour.
  return { kind: 'code', lang: '' };
}

function shouldSkip(rel) {
  const parts = rel.split(path.sep);
  if (parts.some(p => IGNORED_DIRS.has(p))) return true;
  const norm = parts.join('/');
  return IGNORED_FRAGMENTS.some(f => norm.includes(f));
}

// Parse a prompts.md / responses.md file into [{time, content}] entries.
// Both files use `## HH:MM:SS\n\n<content>` blocks, with a leading header.
function parseTimestampedBlocks(text) {
  const entries = [];
  const re = /^## (\d{1,2}:\d{2}:\d{2})\s*\n([\s\S]*?)(?=^## \d{1,2}:\d{2}:\d{2}|$(?![\s\S]))/gm;
  let m;
  while ((m = re.exec(text))) {
    entries.push({ time: m[1], content: m[2].trim() });
  }
  return entries;
}

function renderSession(sessionId, started, combined, title) {
  const heading = title || `session ${sessionId}`;
  let html = `<h1>${escapeAttr(heading)}</h1>`;
  html += `<p class="session-started">Session ${escapeAttr(sessionId)}</p>`;
  if (started) html += `<p class="session-started">Started ${escapeAttr(started)}</p>`;
  if (combined.length === 0) return html + '<p>(no entries)</p>';
  html += '<div class="chat">';
  for (const e of combined) {
    const cls = e.role === 'user' ? 'user' : 'claude';
    html += `<div class="bubble ${cls}">`;
    html += `<div class="anchor">${e.time}</div>`;
    html += marked.parse(e.content);
    html += `</div>`;
  }
  html += '</div>';
  return html;
}

function collectSessions(root) {
  const sessions = {};
  const historyDir = path.join(root, 'history');
  let dirs;
  try { dirs = fs.readdirSync(historyDir, { withFileTypes: true }); }
  catch (_) { return sessions; }

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const sessionId = dir.name;
    const sessionPath = path.join(historyDir, sessionId);

    let promptsText = '', responsesText = '';
    try { promptsText = fs.readFileSync(path.join(sessionPath, 'prompts.md'), 'utf8'); } catch (_) {}
    try { responsesText = fs.readFileSync(path.join(sessionPath, 'responses.md'), 'utf8'); } catch (_) {}
    if (!promptsText && !responsesText) continue;

    // Extract "Started ..." line from prompts.md if present.
    const startedMatch = promptsText.match(/\*Started ([^*]+)\*/);
    const started = startedMatch ? startedMatch[1].trim() : '';

    // Extract the heading. If reconcile wrote an ai-title, it's the heading;
    // otherwise it's "session-<uuid>" which we fall back to a short UUID.
    const headingMatch = promptsText.match(/^# (.+)$/m);
    const heading = headingMatch ? headingMatch[1].trim() : '';
    const isUuidHeading = heading.startsWith('session-');
    const shortUuid = sessionId.slice(0, 8) + '…' + sessionId.slice(-4);
    const label = (heading && !isUuidHeading) ? heading : shortUuid;

    const user = parseTimestampedBlocks(promptsText).map(e => ({ ...e, role: 'user' }));
    const claude = parseTimestampedBlocks(responsesText).map(e => ({ ...e, role: 'claude' }));
    const combined = [...user, ...claude].sort((a, b) => a.time.localeCompare(b.time));

    const titleForRender = (heading && !isUuidHeading) ? heading : null;
    const html = renderSession(sessionId, started, combined, titleForRender);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(sessionPath).mtimeMs; } catch (_) {}

    sessions[SESSIONS_PREFIX + sessionId] = {
      kind: 'md',
      lang: '',
      html,
      mtime: mtimeMs,
      label,
    };
  }
  return sessions;
}

// How many directory levels deep we walk eagerly at startup. Subdirectories
// at or below this depth get a `{kind:'folder', lazy:true}` placeholder
// entry in FILES; their contents load on demand when the user expands them
// (see the `requestFolderContents` message handler).
const LAZY_DEPTH = 2;

// Build a FILES entry for a single source file: classifies, pre-renders md
// via marked, and preloads the .agent-repo-shell/code-render/<rel>.json
// sidecar for code files. Returns null if the file should be skipped
// (unsupported extension or unreadable). Shared between collectFiles and
// collectFolderContents.
function processFileEntry(root, full, rel) {
  const name = path.basename(full);
  const meta = classify(name);
  if (!meta) return null;
  const key = rel.split(path.sep).join('/');
  const obj = { kind: meta.kind, lang: meta.lang };
  if (meta.kind === 'md') {
    try {
      const text = fs.readFileSync(full, 'utf8');
      obj.html = marked.parse(text);
    } catch (_) { return null; }
    // Pre-count past reviews so the webview can show a "📝 N reviews" badge
    // without an extra round-trip. Now scans the per-file folder layout
    // (REVIEW_ROOT/<path-without-ext>/<ts>/) so this works for ANY file,
    // not just specs/.
    const srcNoExt = key.replace(/\.[^.]+$/, '');
    const reviewDir = path.join(root, REVIEW_ROOT, srcNoExt);
    try {
      const past = fs.readdirSync(reviewDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && /^\d{8}-\d{6}/.test(e.name));
      if (past.length) obj.reviewCount = past.length;
    } catch (_) { /* no reviews yet */ }
  } else {
    obj.abs = full;
    // Preload the .agent-repo-shell/code-render/<rel>.json sidecar so a click
    // can render the overview synchronously, no extension round-trip.
    const sidecar = path.join(root, CODE_RENDER_DIR, rel + '.json');
    try {
      const text = fs.readFileSync(sidecar, 'utf8');
      const overview = JSON.parse(text);
      overview.file = full;
      overview.path = key;
      if (Array.isArray(overview.usedBy)) {
        for (const u of overview.usedBy) {
          if (u && typeof u.file === 'string') {
            u.absPath = path.join(root, u.file);
          }
        }
      }
      obj.overview = overview;
    } catch (_) { /* no sidecar — code file is "not initialized" */ }
  }
  return { key, obj };
}

function collectFiles(root) {
  const files = {};
  function walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (shouldSkip(rel)) continue;
      const key = rel.split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (depth < LAZY_DEPTH) {
          walk(full, depth + 1);
        } else {
          // Depth cap hit — leave as a lazy folder, content fetched on expand.
          files[key] = { kind: 'folder', lazy: true, abs: full };
        }
      } else if (entry.isFile()) {
        const r = processFileEntry(root, full, rel);
        if (r) files[r.key] = r.obj;
      }
    }
  }
  walk(root, 0);
  return files;
}

// Walk a single folder one level deep — used to resolve a lazy folder when
// the webview expands it. Subdirs in the result are themselves lazy so the
// tree stays incrementally loaded.
function collectFolderContents(root, folderRel) {
  const items = {};
  const folderAbs = path.join(root, folderRel);
  let entries;
  try { entries = fs.readdirSync(folderAbs, { withFileTypes: true }); }
  catch (_) { return items; }
  for (const entry of entries) {
    const full = path.join(folderAbs, entry.name);
    const rel = path.relative(root, full);
    if (shouldSkip(rel)) continue;
    const key = rel.split(path.sep).join('/');
    if (entry.isDirectory()) {
      items[key] = { kind: 'folder', lazy: true, abs: full };
    } else if (entry.isFile()) {
      const r = processFileEntry(root, full, rel);
      if (r) items[r.key] = r.obj;
    }
  }
  return items;
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function getHtml(webview, hljsCssUri, mermaidJsUri, recogitoJsUri, recogitoCssUri, turndownJsUri, html2canvasJsUri, title, files) {
  const data = JSON.stringify(files).replace(/<\//g, '<\\/');
  return TEMPLATE
    .replaceAll('__TITLE__', escapeAttr(title))
    .replace('__HLJS_CSS__', hljsCssUri.toString())
    .replace('__MERMAID_JS__', mermaidJsUri.toString())
    .replace('__RECOGITO_JS__', recogitoJsUri.toString())
    .replace('__RECOGITO_CSS__', recogitoCssUri.toString())
    .replace('__TURNDOWN_JS__', turndownJsUri.toString())
    .replace('__HTML2CANVAS_JS__', html2canvasJsUri.toString())
    .replace('__DATA__', data);
}

// Tracks the most recent open panel so module-level commands (e.g. the
// "Show Native Find (test)" command) can target it.
let lastPanel = null;

function openView(context) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('Agent Repo Shell: no workspace folder open.');
    return;
  }
  const root = folders[0].uri.fsPath;
  const title = path.basename(root);

  const hljsCssPath = path.join(
    context.extensionPath,
    'node_modules', 'highlight.js', 'styles', 'github.css'
  );
  const mermaidJsPath = path.join(
    context.extensionPath,
    'node_modules', 'mermaid', 'dist', 'mermaid.min.js'
  );
  // Recogito Text Annotator (BSD-3, https://github.com/recogito/text-annotator-js)
  // — owns text selection, range serialization, highlight rendering, and
  // drift-resilient re-attachment across re-renders. We bring our own popup UI.
  const recogitoJsPath = path.join(
    context.extensionPath,
    'node_modules', '@recogito', 'text-annotator', 'dist', 'text-annotator.umd.js'
  );
  const recogitoCssPath = path.join(
    context.extensionPath,
    'node_modules', '@recogito', 'text-annotator', 'dist', 'text-annotator.css'
  );
  // Turndown (MIT, https://github.com/mixmark-io/turndown) — converts the
  // edited HTML back to markdown when the user saves. Browser-friendly UMD
  // build at dist/turndown.js, exposes a global `TurndownService`.
  const turndownJsPath = path.join(
    context.extensionPath,
    'node_modules', 'turndown', 'dist', 'turndown.js'
  );
  // html2canvas (MIT, https://github.com/niklasvh/html2canvas) — DOM →
  // canvas → PNG, used at submit time to snapshot each drawing into a
  // drawN.png so vision-capable agents can actually see what was drawn.
  const html2canvasJsPath = path.join(
    context.extensionPath,
    'node_modules', 'html2canvas', 'dist', 'html2canvas.min.js'
  );

  const panel = vscode.window.createWebviewPanel(
    'agentRepoShellView',
    `Agent Repo Shell: ${title}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      // Disabled: VSCode's native webview find widget calls Electron's
      // WebFrameMain.findInFrame() under the hood, which returns 0 matches
      // for our content in this VSCode build (confirmed with an A/B test
      // searching "agent" — present 100+ times on screen, native reports
      // none). We ship our own widget (Ctrl/Cmd-F → custom UI).
      enableFindWidget: false,
      localResourceRoots: [
        vscode.Uri.file(path.dirname(hljsCssPath)),
        vscode.Uri.file(path.dirname(mermaidJsPath)),
        vscode.Uri.file(path.dirname(recogitoJsPath)),
        vscode.Uri.file(path.dirname(turndownJsPath)),
        vscode.Uri.file(path.dirname(html2canvasJsPath)),
        vscode.Uri.file(root),
      ],
    }
  );
  lastPanel = panel;

  const refresh = () => {
    const files = collectFiles(root);
    Object.assign(files, collectSessions(root));
    const hljsCssUri = panel.webview.asWebviewUri(vscode.Uri.file(hljsCssPath));
    const mermaidJsUri = panel.webview.asWebviewUri(vscode.Uri.file(mermaidJsPath));
    const recogitoJsUri = panel.webview.asWebviewUri(vscode.Uri.file(recogitoJsPath));
    const recogitoCssUri = panel.webview.asWebviewUri(vscode.Uri.file(recogitoCssPath));
    const turndownJsUri = panel.webview.asWebviewUri(vscode.Uri.file(turndownJsPath));
    const html2canvasJsUri = panel.webview.asWebviewUri(vscode.Uri.file(html2canvasJsPath));
    panel.webview.html = getHtml(
      panel.webview, hljsCssUri, mermaidJsUri,
      recogitoJsUri, recogitoCssUri, turndownJsUri, html2canvasJsUri,
      title, files,
    );
  };
  refresh();

  // TEMP debug-log sink for the Recogito wiring. The webview can't write
  // files, so it ships every dbg() line over postMessage and we append here.
  // Tail with `tail -f /tmp/agent-shell-dbg.log`. Remove once stable.
  const DBG_LOG = '/tmp/agent-shell-dbg.log';
  try { fs.writeFileSync(DBG_LOG, '--- session ' + new Date().toISOString() + ' ---\n', { flag: 'a' }); } catch (_) {}

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'dbgLog') {
      try { fs.appendFileSync(DBG_LOG, String(msg.line || '') + '\n'); } catch (_) {}
      return;
    }
    if (msg.type === 'openFile' || msg.type === 'openLine') {
      try {
        const uri = vscode.Uri.file(msg.path);
        const doc = await vscode.workspace.openTextDocument(uri);
        // Always open in the column immediately right of the Agent Repo Shell
        // view, regardless of which column is currently active. VSCode
        // reuses that column if it already exists, so clicks don't keep
        // spawning new columns.
        const panelCol = panel.viewColumn ?? vscode.ViewColumn.One;
        const targetCol = panelCol + 1;
        const opts = { preview: false, viewColumn: targetCol };
        if (msg.type === 'openLine' && Number.isInteger(msg.line)) {
          const pos = new vscode.Position(msg.line, 0);
          opts.selection = new vscode.Range(pos, pos);
        }
        await vscode.window.showTextDocument(doc, opts);
      } catch (e) {
        vscode.window.showErrorMessage(`Could not open ${msg.path}: ${e.message}`);
      }
    } else if (msg.type === 'requestFolderContents') {
      // Resolve a lazy folder. Returns one level of contents (files +
      // nested lazy folders) for the webview to render on expand.
      try {
        const items = collectFolderContents(root, msg.path);
        panel.webview.postMessage({ type: 'folderContents', path: msg.path, items });
      } catch (e) {
        panel.webview.postMessage({
          type: 'folderContentsError', path: msg.path, error: String(e.message || e),
        });
      }
    } else if (msg.type === 'requestSync') {
      // Run LSP analysis, write sidecar, return overview. The webview reads
      // the sidecar on its own (via the FILES map, populated at build time);
      // we only need a message round-trip when the user explicitly Syncs.
      const uri = vscode.Uri.file(msg.path);
      panel.webview.postMessage({ type: 'syncStarted', path: msg.path });
      try {
        const overview = await getFileOverview(uri);
        overview.syncedAt = new Date().toISOString();
        await writeSidecar(root, uri, overview);
        panel.webview.postMessage({ type: 'syncDone', path: msg.path, overview });
      } catch (e) {
        panel.webview.postMessage({
          type: 'syncError', path: msg.path, error: String(e.message || e),
        });
      }
    } else if (msg.type === 'taskMove') {
      try {
        const fromAbs = path.resolve(root, msg.from);
        const toAbs = path.resolve(root, msg.to);
        const toDir = path.dirname(toAbs);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(toDir));
        await vscode.workspace.fs.rename(
          vscode.Uri.file(fromAbs), vscode.Uri.file(toAbs), { overwrite: false }
        );
      } catch (e) {
        vscode.window.showErrorMessage(`Move task failed: ${e.message}`);
      }
    } else if (msg.type === 'ctx') {
      const abs = path.resolve(root, msg.path);
      const uri = vscode.Uri.file(abs);
      try {
        if (msg.action === 'copyPath') {
          await vscode.env.clipboard.writeText(abs);
        } else if (msg.action === 'copyRelPath') {
          await vscode.env.clipboard.writeText(msg.path);
        } else if (msg.action === 'rename') {
          const oldName = path.basename(abs);
          const newName = await vscode.window.showInputBox({
            prompt: `Rename ${oldName}`,
            value: oldName,
            valueSelection: [0, oldName.lastIndexOf('.') > 0 ? oldName.lastIndexOf('.') : oldName.length],
          });
          if (!newName || newName === oldName) return;
          const newUri = vscode.Uri.file(path.join(path.dirname(abs), newName));
          await vscode.workspace.fs.rename(uri, newUri, { overwrite: false });
        } else if (msg.action === 'delete') {
          const name = path.basename(abs);
          const confirm = await vscode.window.showWarningMessage(
            `Delete '${name}'?`, { modal: true }, 'Move to Trash'
          );
          if (confirm !== 'Move to Trash') return;
          try {
            await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
          } catch (e) {
            // SSH remote / some filesystems don't support trash. Offer a
            // second confirmation for permanent delete.
            if (!/trash/i.test(e.message || '')) throw e;
            const force = await vscode.window.showWarningMessage(
              `Trash not supported on this filesystem. Delete '${name}' permanently?`,
              { modal: true }, 'Delete Permanently'
            );
            if (force !== 'Delete Permanently') return;
            await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
          }
        }
      } catch (e) {
        vscode.window.showErrorMessage(`${msg.action} failed: ${e.message}`);
      }
    } else if (msg.type === 'submitReview') {
      try {
        const payload = msg.payload || {};
        const result = await writeReviewFile(root, payload);
        // Single-button "Submit and Copy" flow — every submit also copies
        // a one-line prompt to the clipboard. A bare "@path" alone reads
        // as a mention and doesn't tell the agent what to do with it, so
        // we prepend a short instruction.
        const clipboardText = 'Please read and follow @' + result.rel
          + ' (Workflow + Comments are inside).';
        try { await vscode.env.clipboard.writeText(clipboardText); } catch (_) {}
        panel.webview.postMessage({
          type: 'reviewSubmitted',
          path: result.abs,
          relPath: result.rel,
          clipboard: clipboardText,
          reused: !!result.reused,
        });
        // VSCode's createFileSystemWatcher('**/*') doesn't fire for files
        // inside dot-prefixed dirs (like .agent-repo-shell/). Writes we just
        // made there would otherwise leave FILES (and the reviewCount badge)
        // stale until the next non-dotdir change triggers refresh. Force one
        // here so the "📝 N reviews" badge shows up immediately.
        try { refresh(); } catch (_) {}
      } catch (e) {
        panel.webview.postMessage({ type: 'reviewError', error: String(e.message || e) });
      }
    } else if (msg.type === 'openDiff') {
      try {
        const leftAbs = path.isAbsolute(msg.leftPath) ? msg.leftPath : path.resolve(root, msg.leftPath);
        const rightAbs = path.isAbsolute(msg.rightRelPath) ? msg.rightRelPath : path.resolve(root, msg.rightRelPath);
        const leftUri = vscode.Uri.file(leftAbs);
        const rightUri = vscode.Uri.file(rightAbs);
        const title = `${path.basename(leftAbs)} ↔ ${path.basename(rightAbs)} (current)`;
        await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
      } catch (e) {
        vscode.window.showErrorMessage(`Could not open diff: ${e.message}`);
      }
    } else if (msg.type === 'editStart') {
      // Lock out the file watcher's refresh until editEnd — refreshing the
      // webview mid-edit would replace the user's contenteditable content.
      panel._setEditLock(true);
      return;
    } else if (msg.type === 'editEnd') {
      panel._setEditLock(false);
      return;
    } else if (msg.type === 'requestSaveFile') {
      // Save edited markdown back to the source file. The file watcher
      // will then fire a refresh and the webview will pick up the new
      // content automatically.
      try {
        const rel = String(msg.path || '');
        if (!rel || rel.includes('..')) throw new Error('invalid path');
        const abs = path.resolve(root, rel);
        // Sanity: must live inside the workspace.
        if (abs !== root && !abs.startsWith(root + path.sep)) {
          throw new Error('path escapes workspace');
        }
        await fs.promises.writeFile(abs, String(msg.content || ''), 'utf8');
        panel.webview.postMessage({ type: 'saveFileDone', path: rel });
      } catch (e) {
        panel.webview.postMessage({
          type: 'saveFileError', path: msg.path, error: String(e.message || e),
        });
      }
    } else if (msg.type === 'requestReviewSnapshot') {
      // Load source.md + the comments/drawings JSON for the snapshot view.
      // Layout: comments.json + draws.json sit beside source.md.
      try {
        const sourceMd = fs.readFileSync(msg.sourcePath, 'utf8');
        const sourceHtml = marked.parse(sourceMd);
        let commentsArr = [];
        let strokesArr = [];
        const dir = path.dirname(msg.sourcePath);
        try {
          commentsArr = JSON.parse(fs.readFileSync(path.join(dir, 'comments.json'), 'utf8'));
        } catch (_) {}
        try {
          strokesArr = JSON.parse(fs.readFileSync(path.join(dir, 'draws.json'), 'utf8'));
        } catch (_) {}
        panel.webview.postMessage({
          type: 'reviewSnapshot',
          targetPath: msg.targetPath,
          ts: msg.ts,
          sourceHtml,
          comments: commentsArr,
          strokes: strokesArr,
        });
      } catch (e) {
        panel.webview.postMessage({
          type: 'reviewSnapshot', targetPath: msg.targetPath, ts: msg.ts,
          error: String(e.message || e),
        });
      }
    } else if (msg.type === 'requestReviewHistory') {
      try {
        const entries = listReviewsForFile(root,msg.path);
        panel.webview.postMessage({
          type: 'reviewHistoryList', specPath: msg.path, entries,
        });
      } catch (e) {
        panel.webview.postMessage({
          type: 'reviewHistoryList', specPath: msg.path, entries: [], error: String(e.message || e),
        });
      }
    } else if (msg.type === 'getReviewState') {
      // Webview polls for the latest review folder's .state so it can drop
      // submitted comments once the agent flips it to `done`. Cheap read —
      // we just stat the latest TS subfolder for the requested source path.
      let state = null;
      let ts = null;
      try {
        const srcPath = String(msg.path || '');
        if (srcPath) {
          const srcNoExt = srcPath.replace(/\.[^./\\]+$/, '');
          const parentDir = path.join(root, REVIEW_ROOT, srcNoExt);
          const latest = fs.readdirSync(parentDir, { withFileTypes: true })
            .filter(e => e.isDirectory() && TS_RE.test(e.name))
            .map(e => e.name).sort().reverse()[0];
          if (latest) {
            ts = latest;
            state = readReviewState(path.join(parentDir, latest));
          }
        }
      } catch (_) { /* no folder yet */ }
      panel.webview.postMessage({
        type: 'reviewStateUpdate', path: msg.path, state, ts,
      });
    }
  });

  // Auto-refresh when files change in the workspace. Debounced because
  // single user actions often fire multiple events (a rename is a delete +
  // create) and the full refresh is heavy (rewalk workspace, re-parse all
  // md, rebuild the entire webview HTML including reloading mermaid).
  //
  // While the webview is in edit mode, refreshes would wipe the user's
  // in-progress edits — `editLock` defers any refreshes until they save
  // or cancel (the editEnd message clears the lock and flushes a
  // single refresh if any was pending).
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  let refreshTimer = 0;
  let editLock = false;
  let refreshPending = false;
  const onChange = () => {
    if (editLock) { refreshPending = true; return; }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 250);
  };
  watcher.onDidCreate(onChange);
  watcher.onDidChange(onChange);
  watcher.onDidDelete(onChange);
  // Bind the lock helpers onto the panel-scoped message handler below.
  panel._setEditLock = (locked) => {
    editLock = locked;
    if (!locked && refreshPending) {
      refreshPending = false;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 250);
    }
  };

  panel.onDidDispose(() => {
    clearTimeout(refreshTimer);
    watcher.dispose();
    if (lastPanel === panel) lastPanel = null;
  });
}

// =============================================================================
// Review-submit + spec-history helpers
// =============================================================================

function slugify(s) {
  return String(s || 'note')
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'note';
}

function tsStamp() {
  const d = new Date();
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  return d.getFullYear()
    + pad(d.getMonth() + 1) + pad(d.getDate())
    + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
    + '-' + pad(d.getMilliseconds(), 3);
}

function tsIso() {
  return new Date().toISOString();
}

// Materialize a review payload into files the agent can read.
//
// Layout per submit (route = spec / comment / anything except task):
//   .agent-repo-shell/review/<src-path-without-ext>/<ts>/
//     ├── prompt.md      ← copy-paste this to the agent; tells it what to do
//     ├── source.md      ← snapshot of the source at submit time
//     ├── comments.json  ← machine data — anchored comments + quote + text
//     ├── draws.json     ← machine data — stroke geometry for re-rendering
//     └── draw1.png ...  ← visual snapshots for vision-capable agents
//
// @task gets its own path because it's not a review of an existing file —
// it creates new task files:
//   tasks/todo/<ts>-<slug>.md
//
// Each file has ONE job:
//   - prompt.md = human-paste-able instruction, route-aware
//   - source.md = exact source snapshot (diffable against current)
//   - comments.json = the comments (quote + text), without surrounding markdown
//   - draws.json = the drawings (stroke points), for Agent Repo Shell to re-render
//   - drawN.png = the same drawings rasterized so any vision agent can see them
const REVIEW_ROOT = path.join('.agent-repo-shell', 'review');
const TS_RE = /^\d{8}-\d{6}(-\d{3})?$/;

// .state file lives next to prompt.md and is the single source of truth for
// "what should the next submit do." Possible values:
//   todo  — submitted, agent hasn't started yet
//   doing — agent picked it up (writes this as its first action per prompt.md)
//   done  — agent finished
// Every new folder is born as `todo` (single-button Submit-and-Copy flow has
// no separate draft step). Next submit on the SAME source file MERGES into
// a todo folder; submits while latest is doing/done create a fresh folder.
// Absent .state = legacy folder (predates this system) — migration stamps
// it as `done` on activation so it doesn't get treated as todo.
function readReviewState(absDir) {
  try {
    const s = fs.readFileSync(path.join(absDir, '.state'), 'utf8').trim();
    if (s === 'todo' || s === 'doing' || s === 'done') return s;
  } catch (_) {}
  return null;
}

// One-time migration: stamp pre-existing review folders (created before the
// .state system) as `done` so a future submit doesn't accidentally merge
// into them as if they were drafts. Runs on extension activation.
function migrateReviewStates(root) {
  const reviewRoot = path.join(root, REVIEW_ROOT);
  let count = 0;
  function walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (TS_RE.test(e.name)) {
        // Leaf timestamp folder — check for .state, stamp `done` if missing.
        const stateFile = path.join(full, '.state');
        if (!fs.existsSync(stateFile)) {
          try { fs.writeFileSync(stateFile, 'done\n', 'utf8'); count++; }
          catch (_) {}
        }
      } else if (depth < 8) {
        walk(full, depth + 1);
      }
    }
  }
  walk(reviewRoot, 0);
  return count;
}

// Build the JSON shape for comments.json — strip the heavyweight Recogito
// `annotation` object that we only need for in-app re-revival, since the
// quote + text + position is what the agent actually wants.
function buildCommentsJson(cmts) {
  if (!Array.isArray(cmts)) return [];
  return cmts.map(c => ({
    num: c.num,
    quote: c.anchorText || '',
    text: c.text || '',
    orphan: !!c.orphan,
    ts: c.ts,
    // Source line range captured at selection time from the rendered DOM
    // (markdown-it injects `data-source-line` on every block). null when
    // the selection couldn't be mapped (e.g. predates this feature).
    lineStart: c.lineStart || null,
    lineEnd: c.lineEnd || null,
    // Keep the raw annotation so reviveAnnotation can re-attach highlights
    // when opening the snapshot inside Agent Repo Shell.
    annotation: c.annotation || null,
  }));
}

async function writeReviewFile(root, payload) {
  const srcPath = (payload && payload.path) || 'unknown';

  // State-machine folder selection: look at the LATEST folder for this src.
  // - state === 'todo'             → reuse that folder (clean & rewrite)
  // - state ∈ {'doing', 'done'}    → start a fresh folder
  // - state === null (legacy)      → start a fresh folder (migration should
  //                                   have stamped these, so this is a
  //                                   defensive path for folders created
  //                                   between activation and migration)
  // - no prior folder               → start a fresh folder
  // Reused folders keep their original timestamp name; the contents are
  // wiped first so deleted comments/drawings don't linger as orphan files.
  const srcNoExt = srcPath.replace(/\.[^./\\]+$/, '');
  const parentDir = path.join(root, REVIEW_ROOT, srcNoExt);
  let reuseTs = null;
  try {
    const latest = fs.readdirSync(parentDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && TS_RE.test(e.name))
      .map(e => e.name)
      .sort()
      .reverse()[0];
    if (latest && readReviewState(path.join(parentDir, latest)) === 'todo') {
      reuseTs = latest;
    }
  } catch (_) { /* no prior folder */ }

  const stamp = reuseTs || tsStamp();
  const relDir = path.join(REVIEW_ROOT, srcNoExt, stamp);
  const absDir = path.join(root, relDir);
  await fs.promises.mkdir(absDir, { recursive: true });

  // If reusing, wipe the folder so deleted comments / drawings don't leave
  // orphan files behind. We rewrite everything from the current payload.
  if (reuseTs) {
    try {
      for (const name of fs.readdirSync(absDir)) {
        try { fs.unlinkSync(path.join(absDir, name)); } catch (_) {}
      }
    } catch (_) {}
  }
  const promptAbs   = path.join(absDir, 'prompt.md');
  const sourceAbs   = path.join(absDir, 'source.md');
  const commentsAbs = path.join(absDir, 'comments.json');
  const drawsAbs    = path.join(absDir, 'draws.json');

  // source.md — exact copy of the source at submit time, so a future diff
  // against the current file shows what got applied vs. what's still pending.
  const srcAbs = payload.absPath || path.join(root, srcPath);
  try {
    await fs.promises.copyFile(srcAbs, sourceAbs);
  } catch (e) {
    await fs.promises.writeFile(sourceAbs,
      `(source '${srcPath}' could not be copied: ${e.message})\n`, 'utf8');
  }

  // comments.json — pure data, no markdown chrome. Each entry has the quote
  // (selected text from source), the user's comment text, and enough
  // metadata to revive into Agent Repo Shell.
  const commentsArr = buildCommentsJson(payload.comments);
  await fs.promises.writeFile(commentsAbs,
    JSON.stringify(commentsArr, null, 2) + '\n', 'utf8');

  // draws.json — pure data, stroke geometry. Used by Agent Repo Shell to re-render
  // the drawings on top of source.md when you open this folder later.
  let drawingList = Array.isArray(payload.drawings) ? payload.drawings : null;
  if (!drawingList && Array.isArray(payload.strokes) && payload.strokes.length) {
    drawingList = [{ label: 'draw1', strokes: payload.strokes }];
  }
  if (!drawingList) drawingList = [];
  await fs.promises.writeFile(drawsAbs,
    JSON.stringify(drawingList, null, 2) + '\n', 'utf8');

  // drawN.png — vision-friendly raster of each drawing. The agent can Read
  // these directly; the JSON is for Agent Repo Shell's own renderer.
  const drawingImages = Array.isArray(payload.drawingImages) ? payload.drawingImages : [];
  const savedImageNames = [];
  for (const img of drawingImages) {
    if (!img || !img.label || typeof img.dataUrl !== 'string') continue;
    const m = img.dataUrl.match(/^data:image\/png;base64,(.*)$/);
    if (!m) continue;
    const buf = Buffer.from(m[1], 'base64');
    const name = img.label + '.png';
    try {
      await fs.promises.writeFile(path.join(absDir, name), buf);
      savedImageNames.push(name);
    } catch (_) { /* non-fatal — geometry still in draws.json */ }
  }

  // prompt.md uses workspace-relative paths (no leading `./`, no absolute)
  // so the user can copy-paste into any agent that runs with cwd at the
  // repo root. Workspace-relative is portable across machines (unlike
  // absolute, which bakes in `/home/cy/...`) and short to read.
  const toRel = (abs) => path.relative(root, abs).split(path.sep).join('/');
  const sourceFileRel = srcPath;                     // already workspace-rel
  const sourceSnapRel = toRel(sourceAbs);            // .agent-repo-shell/review/.../source.md
  const commentsRel   = toRel(commentsAbs);
  const drawsRel      = toRel(drawsAbs);
  const tasksTodoRel  = 'tasks/todo';
  const drawListMd = savedImageNames.length
    ? savedImageNames.map(n => '- `' + toRel(path.join(absDir, n)) + '`').join('\n')
    : '_(none)_';
  // Build a label → workspace-relative-path map so any "@drawN" tokens in
  // user-typed text (comments or the Background message) get rewritten to
  // full @-paths the agent can resolve directly.
  const drawPathByLabel = {};
  savedImageNames.forEach(name => {
    const label = name.replace(/\.png$/, '');
    drawPathByLabel[label] = toRel(path.join(absDir, name));
  });
  const expandDrawRefs = (text) =>
    (text || '').replace(/@(draw\d+)\b/g, (m, label) =>
      drawPathByLabel[label] ? '@' + drawPathByLabel[label] : m);

  const userMsg = (payload.message || '').trim();
  // Always include Background so structure is predictable. Default is a
  // one-liner; reviewer's free-text message (if any) is appended verbatim.
  let userMsgSection = '\n## Background\n\n'
    + `Review \`${srcPath}\` and update it based on the comments below.\n`;
  if (userMsg) {
    userMsgSection += '\n> ' + expandDrawRefs(userMsg).replace(/\n/g, '\n> ') + '\n';
  }
  // Inline the comments so the agent doesn't have to open comments.json
  // just to see what was said. The JSON file is still there for tooling
  // and for re-importing into Agent Repo Shell.
  let sourceText = '';
  try { sourceText = await fs.promises.readFile(sourceAbs, 'utf8'); } catch (_) {}
  // Find the 1-based line number in `text` (the raw markdown source)
  // where `quote` (text scraped from the rendered DOM) first appears.
  //
  // Why this is tricky: the rendered quote drops markdown chrome that the
  // source still has — list prefixes ("4.  "), escapes ("\======"), bold
  // markers, etc. So exact `indexOf` almost never matches.
  //
  // Strategy: normalize both sides into a stream of only "content" chars
  // (skip whitespace, backslashes, and per-line list prefixes), search the
  // quote's fingerprint inside the normalized source, then map the matched
  // index back to the original line via a parallel positions array.
  function lineNumberOf(text, quote) {
    if (!text || !quote) return null;
    // Fast path: exact match. Cheap when source hasn't drifted from render.
    let idx = text.indexOf(quote);
    if (idx >= 0) return text.slice(0, idx).split('\n').length;
    // Slow path: fingerprint search.
    const fp = quote.replace(/\\/g, '').replace(/\s+/g, '').slice(0, 40);
    if (!fp || fp.length < 4) return null;
    let normalized = '';
    const lineOfNormChar = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // Strip a single leading list prefix per line ("1.  ", "- ", "* ").
      const stripped = lines[i].replace(/^\s*(?:\d+\.\s+|[-*+]\s+)/, '');
      for (let j = 0; j < stripped.length; j++) {
        const ch = stripped[j];
        if (ch === '\\') continue;
        if (/\s/.test(ch)) continue;
        normalized += ch;
        lineOfNormChar.push(i + 1);
      }
    }
    const ni = normalized.indexOf(fp);
    if (ni < 0) return null;
    return lineOfNormChar[ni];
  }
  let commentsSection = '';
  if (commentsArr.length) {
    commentsSection = '\n## Comments\n\n';
    commentsArr.forEach(c => {
      const quote = (c.quote || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const orphanFlag = c.orphan ? ' ⚠ (drifted)' : '';
      // Prefer the line numbers captured at selection time (from the
      // markdown-it `data-source-line` injection — accurate, no guessing).
      // Fall back to the fuzzy quote→source search for legacy comments
      // that predate the line capture.
      let startLn = c.lineStart || null;
      let endLn   = c.lineEnd   || null;
      if (!startLn) {
        startLn = lineNumberOf(sourceText, c.quote);
        if (startLn) {
          const newlines = ((c.quote || '').match(/\n/g) || []).length;
          endLn = startLn + newlines;
        }
      }
      let selectedLine;
      if (startLn) {
        const frag = (endLn && endLn > startLn) ? `#L${startLn}-L${endLn}` : `#L${startLn}`;
        const ref = sourceFileRel + frag;
        selectedLine = `[${ref}](${ref}) — "${quote}"`;
      } else {
        selectedLine = `"${quote}" _(not located in source)_`;
      }
      commentsSection += `### ${c.num}${orphanFlag}\n`;
      commentsSection += `- **selected**: ${selectedLine}\n`;
      commentsSection += `- **comment**: ${expandDrawRefs(c.text)}\n\n`;
    });
  }
  const promptRel = toRel(promptAbs);
  const reviewFolderRel = toRel(absDir);
  const stateRel = toRel(path.join(absDir, '.state'));
  const promptBody =
    `# Review on \`${sourceFileRel}\`\n\n`
    + `_Paths are workspace-relative._\n`
    + `\n## Workflow (do this first/last)\n\n`
    + `1. **First action**: write \`doing\` to \`${stateRel}\` (overwrite). This claims the review.\n`
    + `2. Do the work in **Steps** below.\n`
    + `3. **Last action**: write \`done\` to \`${stateRel}\` (overwrite).\n`
    + userMsgSection
    + commentsSection
    + `\n## Rules\n\n`
    + `- Don't modify anything under \`.agent-repo-shell/\` (tool state) **except** \`${stateRel}\` per the Workflow above. Anything else is fair game.\n`
    + `\n## Steps\n\n`
    + `1. Read \`${sourceFileRel}\`.\n`
    + `2. For each comment, find the quoted block and address it. Drawings referenced via \`@<path>\` in a comment are visual context — read them. If a comment is vague, propose; if unclear, ask.\n`
    + `3. **Verify**: re-read every comment + the Background. If any aren't fully addressed, **go back and finish them** — unless skipping was intentional (then state why). Final report per comment: \`done\` / \`skipped on purpose (reason)\` / \`question (...)\`. Don't claim done unless the edit really lands.\n`
    + `\n_If a quote can't be found, diff against \`${sourceSnapRel}\` for the snapshot version._\n`
    + `\n## Files (read-only)\n\n`
    + `- ${tsIso()} · ${commentsArr.length} comment(s) · ${savedImageNames.length} drawing(s)\n`
    + `- folder: \`${reviewFolderRel}\`\n`
    + `- this file: \`${promptRel}\`\n`
    + `- \`${sourceSnapRel}\` — source snapshot\n`
    + `- \`${commentsRel}\` — comments JSON\n`
    + `- \`${drawsRel}\` — strokes JSON\n`
    + drawListMd + '\n';
  await fs.promises.writeFile(promptAbs, promptBody, 'utf8');

  // .state lifecycle: every new/reused folder is born/stays as `todo`.
  // Agent flips it to doing/done per Workflow at the top of prompt.md.
  try {
    await fs.promises.writeFile(path.join(absDir, '.state'), 'todo\n', 'utf8');
  } catch (_) { /* non-fatal */ }

  return {
    abs: promptAbs,
    rel: path.join(relDir, 'prompt.md').split(path.sep).join('/'),
    reused: !!reuseTs,
  };
}

// List past reviews submitted on a given file. Each entry is one subfolder
// of REVIEW_ROOT/<src-no-ext>/ whose name matches the timestamp pattern.
// Returns newest-first; each entry exposes prompt + source paths so the
// history table can offer "Open prompt / Open source / Diff source vs current".
function listReviewsForFile(root, relPath) {
  if (!relPath) return [];
  const srcNoExt = relPath.replace(/\.[^./\\]+$/, '');
  const reviewDir = path.join(root, REVIEW_ROOT, srcNoExt);
  let entries;
  try { entries = fs.readdirSync(reviewDir, { withFileTypes: true }); }
  catch (_) { return []; }
  return entries
    .filter(e => e.isDirectory() && TS_RE.test(e.name))
    .map(e => e.name)
    .sort()
    .reverse()
    .map(ts => {
      const dir = path.join(reviewDir, ts);
      const promptPath = path.join(dir, 'prompt.md');
      const sourcePath = path.join(dir, 'source.md');
      let preview = '';
      try {
        const text = fs.readFileSync(promptPath, 'utf8');
        // Reviewer's free-form message lives as a `> ...` blockquote under
        // `## Background`; the line above it is boilerplate ("Review `<path>`
        // ...") which isn't useful as a preview.
        const m = text.match(/## Background\s*\n[\s\S]*?\n>\s?([^\n]+)/);
        if (m) preview = m[1].trim().slice(0, 120);
      } catch (_) {}
      const state = readReviewState(dir);
      return { ts, dir, promptPath, sourcePath, preview, state };
    });
}

// Strip the leading comment/docstring block off the top of a file. Used as
// fallback when the LSP doesn't return module-level hover content (e.g.
// Pylance returning nothing for the very first cursor position).
function extractLeadingDoc(text, lang) {
  if (!text) return '';
  const lines = text.split('\n');
  let i = 0;
  // Skip shebang.
  if (lines[i] && /^#!/.test(lines[i])) i++;
  // Skip blank lines.
  while (i < lines.length && lines[i].trim() === '') i++;

  if (lang === 'python') {
    const m = lines[i] && lines[i].match(/^\s*(?:r|R|b|B|u|U)?("""|''')/);
    if (m) {
      const quote = m[1];
      const startIdx = lines[i].indexOf(quote) + 3;
      const tail = lines[i].slice(startIdx);
      const endOnSame = tail.indexOf(quote);
      if (endOnSame >= 0) return tail.slice(0, endOnSame).trim();
      const out = [tail];
      i++;
      while (i < lines.length) {
        const idx = lines[i].indexOf(quote);
        if (idx >= 0) { out.push(lines[i].slice(0, idx)); break; }
        out.push(lines[i]);
        i++;
      }
      return out.join('\n').trim();
    }
    // Python with leading `#` comments instead.
    const out = [];
    while (i < lines.length && /^\s*#/.test(lines[i])) {
      out.push(lines[i].replace(/^\s*#\s?/, ''));
      i++;
    }
    return out.join('\n').trim();
  }

  // C-family / JS / TS / Rust / Go: leading block or line comments.
  if (lines[i] && lines[i].includes('/*')) {
    const out = [];
    let first = true;
    while (i < lines.length) {
      let l = lines[i];
      if (first) { l = l.slice(l.indexOf('/*') + 2); first = false; }
      const endIdx = l.indexOf('*/');
      if (endIdx >= 0) { out.push(l.slice(0, endIdx).replace(/^\s*\*\s?/, '')); break; }
      l = l.replace(/^\s*\*\s?/, '');
      out.push(l);
      i++;
    }
    return out.join('\n').trim();
  }
  const out = [];
  while (i < lines.length && /^\s*(\/\/|#)/.test(lines[i])) {
    out.push(lines[i].replace(/^\s*(\/\/|#)\s?/, ''));
    i++;
  }
  return out.join('\n').trim();
}

function splitTitleBody(text) {
  if (!text) return { title: '', body: '' };
  // Strip ```fence``` wrappers (hover often wraps a sig in one).
  const cleaned = text
    .replace(/```[\w]*\n([\s\S]*?)\n```/g, (_, c) => c)
    .replace(/^\s*---\s*$/gm, '')
    .trim();
  const lines = cleaned.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  const title = (lines[i] || '').trim();
  const body = lines.slice(i + 1).join('\n').trim();
  return { title, body };
}

function parseSymbolHover(md) {
  if (!md) return { sig: '', summary: '', doc: '' };
  let sig = '';
  let rest = md;
  const codeBlockMatch = md.match(/```[\w]*\n([\s\S]*?)\n```/);
  if (codeBlockMatch) {
    sig = (codeBlockMatch[1].split('\n').find(l => l.trim()) || '').trim();
    // Pylance prefixes the line with "(function) " / "(method) " / etc.
    sig = sig.replace(/^\((?:function|method|class|constructor|property)\)\s*/, '');
    rest = md.replace(codeBlockMatch[0], '');
  }
  rest = rest.replace(/^\s*---\s*$/gm, '').trim();
  const firstPara = (rest.split(/\n\s*\n/)[0] || '').trim();
  const summary = firstPara.replace(/\s+/g, ' ').slice(0, 200);
  return { sig, summary, doc: rest };
}

function surroundingFn(functions, line) {
  let best = null;
  for (const f of functions) {
    if (f.line <= line && (!best || f.line > best.line)) best = f;
  }
  return best ? best.name + '()' : '';
}

// =============================================================================
// .agent-repo-shell/code-render/<rel-path>.json — sidecar cache of the LSP
// overview. The webview reads these on file-click (instant). A Sync button
// writes them by re-running the LSP analysis and overwriting the file.
// See specs/file-overview-sync.md.
// =============================================================================

const CODE_RENDER_DIR = path.join('.agent-repo-shell', 'code-render');

function sidecarPath(workspaceRoot, uri) {
  const rel = path.relative(workspaceRoot, uri.fsPath);
  return path.join(workspaceRoot, CODE_RENDER_DIR, rel + '.json');
}

async function readSidecar(workspaceRoot, uri) {
  try {
    const text = await fs.promises.readFile(sidecarPath(workspaceRoot, uri), 'utf8');
    const overview = JSON.parse(text);
    // Sidecars are committed across machines; the absolute `file` path baked
    // in by the original author won't match here. Rewrite to the local path
    // so clicks in this overview open the local file.
    overview.file = uri.fsPath;
    overview.path = vscode.workspace.asRelativePath(uri);
    // usedBy[].absPath is also a machine-specific path; recompute from
    // the (relative) `file` field which is portable.
    if (Array.isArray(overview.usedBy)) {
      for (const u of overview.usedBy) {
        if (u && typeof u.file === 'string') {
          u.absPath = path.join(workspaceRoot, u.file);
        }
      }
    }
    return overview;
  } catch (_) {
    return null;
  }
}

async function writeSidecar(workspaceRoot, uri, overview) {
  const target = sidecarPath(workspaceRoot, uri);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, JSON.stringify(overview, null, 2));
}

// Build the full "what is this file about" payload from VSCode LSP commands.
// All numbers/names returned are exactly what the editor knows; no parsing of
// the source beyond the leading-doc fallback and a TODO/FIXME regex.
async function getFileOverview(uri) {
  const rel = vscode.workspace.asRelativePath(uri);
  const out = {
    file: uri.fsPath, path: rel,
    language: '', lineCount: 0,
    title: '', summary: '',
    functions: [], edges: [],
    usedBy: [], todos: [],
  };

  let text = '';
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    text = doc.getText();
    out.language = doc.languageId;
    out.lineCount = doc.lineCount;
  } catch (_) { /* unreadable; everything else stays empty */ }

  // 1. Module-level title + summary (hover at top, fallback to file head).
  let modHover = '';
  try {
    const hovers = await vscode.commands.executeCommand(
      'vscode.executeHoverProvider', uri, new vscode.Position(0, 0)
    );
    if (Array.isArray(hovers) && hovers.length) {
      modHover = hovers.flatMap(h => h.contents || [])
        .map(c => (typeof c === 'string' ? c : (c.value || '')))
        .filter(Boolean).join('\n\n');
    }
  } catch (_) {}
  const docText = modHover || extractLeadingDoc(text, out.language);
  if (docText) {
    const { title, body } = splitTitleBody(docText);
    out.title = title;
    out.summary = body;
  }
  if (!out.title) {
    // Fall back to filename stem so the header is never blank.
    out.title = path.basename(uri.fsPath).replace(/\.[^.]+$/, '');
  }

  // 2. Top-level callables (functions/methods/classes only).
  let symbols = [];
  try {
    symbols = await vscode.commands.executeCommand(
      'vscode.executeDocumentSymbolProvider', uri
    ) || [];
  } catch (_) {}
  const callableKinds = new Set([
    vscode.SymbolKind.Function, vscode.SymbolKind.Method,
    vscode.SymbolKind.Constructor, vscode.SymbolKind.Class,
  ]);
  const KIND_NAMES = Object.fromEntries(
    Object.entries(vscode.SymbolKind)
      .filter(([, v]) => typeof v === 'number').map(([k, v]) => [v, k])
  );
  const topCallables = symbols.filter(s => callableKinds.has(s.kind));
  const callableNames = new Set(topCallables.map(s => s.name));
  const lineByName = Object.fromEntries(
    topCallables.map(s => [s.name, s.selectionRange.start.line])
  );

  // 3. Per-callable hover (sig + doc + summary) + outgoing calls.
  for (const s of topCallables) {
    const f = {
      name: s.name,
      line: s.selectionRange.start.line,
      kind: KIND_NAMES[s.kind] || String(s.kind),
      sig: '', summary: '', doc: '',
      calls: [], calledBy: [],
      tier: 'mid',
    };
    try {
      const hovers = await vscode.commands.executeCommand(
        'vscode.executeHoverProvider', uri, s.selectionRange.start
      );
      if (Array.isArray(hovers) && hovers.length) {
        const md = hovers.flatMap(h => h.contents || [])
          .map(c => (typeof c === 'string' ? c : (c.value || '')))
          .filter(Boolean).join('\n\n');
        const parsed = parseSymbolHover(md);
        f.sig = parsed.sig;
        f.summary = parsed.summary;
        f.doc = parsed.doc;
      }
    } catch (_) {}

    try {
      const items = await vscode.commands.executeCommand(
        'vscode.prepareCallHierarchy', uri, s.selectionRange.start
      );
      if (items && items.length) {
        const outgoing = await vscode.commands.executeCommand(
          'vscode.provideOutgoingCalls', items[0]
        ) || [];
        const seen = new Set();
        for (const c of outgoing) {
          const tgtName = c.to.name;
          const tgtUri = c.to.uri;
          const sameFile = tgtUri && tgtUri.fsPath === uri.fsPath;
          if (sameFile && callableNames.has(tgtName) && !seen.has(tgtName)) {
            f.calls.push(tgtName);
            seen.add(tgtName);
            out.edges.push([s.name, tgtName]);
          }
        }
      }
    } catch (_) {}
    out.functions.push(f);
  }

  // 4. Reverse the edges to populate calledBy on each function.
  const incomingByName = new Map();
  for (const [from, to] of out.edges) {
    if (!incomingByName.has(to)) incomingByName.set(to, []);
    incomingByName.get(to).push(from);
  }
  for (const f of out.functions) {
    f.calledBy = incomingByName.get(f.name) || [];
  }

  // 5. Tier classification — colors the diagram nodes.
  for (const f of out.functions) {
    const incoming = f.calledBy.length > 0;
    const outgoing = f.calls.length > 0;
    if (!incoming && outgoing) f.tier = 'entry';
    else if (incoming && !outgoing) f.tier = 'helper';
    else if (!incoming && !outgoing) f.tier = 'entry';   // standalone fn
    else f.tier = 'mid';
  }

  // 6. Used by — references in OTHER files. Limit per symbol so very popular
  //    helpers don't dominate the time budget.
  try {
    const refMap = new Map();
    for (const s of topCallables) {
      let refs = [];
      try {
        refs = await vscode.commands.executeCommand(
          'vscode.executeReferenceProvider', uri, s.selectionRange.start
        ) || [];
      } catch (_) {}
      for (const r of refs) {
        if (!r.uri || r.uri.fsPath === uri.fsPath) continue;
        const key = r.uri.fsPath;
        if (!refMap.has(key)) refMap.set(key, []);
        refMap.get(key).push({ line: r.range.start.line, fnName: s.name });
      }
    }
    for (const [filePath, refs] of refMap) {
      const fnNames = [...new Set(refs.map(r => r.fnName))];
      const minLine = Math.min(...refs.map(r => r.line));
      out.usedBy.push({
        file: vscode.workspace.asRelativePath(filePath),
        absPath: filePath,
        line: minLine,
        desc: 'references ' + fnNames.join(', '),
      });
    }
    out.usedBy.sort((a, b) => a.file.localeCompare(b.file));
  } catch (_) {}

  // 7. TODO / FIXME scan over the source text.
  try {
    const lines = text.split('\n');
    const todoRe = /(?:^|[^A-Za-z_])(TODO|FIXME|HACK|XXX)\b[:\s\-]*([^\n]*)/;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(todoRe);
      if (!m) continue;
      const body = (m[2] || '').replace(/\*\/\s*$/, '').replace(/-->/g, '').trim()
        || '(no message)';
      out.todos.push({
        tag: m[1].toUpperCase(),
        text: body,
        where: surroundingFn(out.functions, i),
        line: i,
      });
    }
  } catch (_) {}

  return out;
}

async function previewOverview() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('Agent Repo Shell: open a code file first.');
    return;
  }
  const overview = await getFileOverview(editor.document.uri);
  const doc = await vscode.workspace.openTextDocument({
    content: JSON.stringify(overview, null, 2),
    language: 'json',
  });
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: false,
  });
}

// Install the Claude Code Stop-hook that captures sessions into
// history/<id>/{prompts,responses}.md (which the webview renders as chat).
// Copies the bundled save-assistant-response.py into the workspace's
// tools/hooks/ and registers it in .claude/settings.json. Idempotent —
// if the hook is already registered, doesn't add a duplicate.
async function installSessionHook(context) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage(
      'Agent Repo Shell: open a workspace folder first.'
    );
    return;
  }
  const root = folders[0].uri.fsPath;
  const hookRel = 'tools/hooks/save-assistant-response.py';
  const hookCmd = 'python3 $CLAUDE_PROJECT_DIR/' + hookRel;

  const confirm = await vscode.window.showInformationMessage(
    `Install Claude Code session capture hook?\n\n` +
    `Will copy:\n  → ${hookRel}\n` +
    `And register a Stop hook in:\n  → .claude/settings.json\n\n` +
    `Next time you use Claude Code in this workspace, every turn will ` +
    `be captured to history/<session-id>/ and rendered in the panel.`,
    { modal: true },
    'Install'
  );
  if (confirm !== 'Install') return;

  const hookSrc = path.join(context.extensionPath, 'resources', 'hooks', 'save-assistant-response.py');
  const hookDest = path.join(root, hookRel);
  try {
    await fs.promises.mkdir(path.dirname(hookDest), { recursive: true });
    await fs.promises.copyFile(hookSrc, hookDest);
    await fs.promises.chmod(hookDest, 0o755);  // not strictly needed for `python3 …` invocation
  } catch (e) {
    vscode.window.showErrorMessage('Hook copy failed: ' + e.message);
    return;
  }

  const settingsPath = path.join(root, '.claude', 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8'));
  } catch (_) { /* missing or invalid — we'll create */ }
  settings.hooks = settings.hooks || {};
  settings.hooks.Stop = settings.hooks.Stop || [];
  const alreadyRegistered = settings.hooks.Stop.some(group =>
    (group.hooks || []).some(h => h.command === hookCmd)
  );
  if (!alreadyRegistered) {
    settings.hooks.Stop.push({
      hooks: [{ type: 'command', command: hookCmd }],
    });
    try {
      await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.promises.writeFile(
        settingsPath,
        JSON.stringify(settings, null, 2) + '\n'
      );
    } catch (e) {
      vscode.window.showErrorMessage('settings.json write failed: ' + e.message);
      return;
    }
  }

  vscode.window.showInformationMessage(
    alreadyRegistered
      ? 'Hook installed. (settings.json already had the registration.)'
      : 'Hook installed. Restart Claude Code to activate.'
  );
}

function activate(context) {
  // Stamp `done` on legacy review folders that pre-date the .state system
  // so subsequent submits don't merge into them as if they were drafts.
  const ws = vscode.workspace.workspaceFolders;
  if (ws && ws.length) {
    try { migrateReviewStates(ws[0].uri.fsPath); } catch (_) {}
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('agentRepoShell.openView', () => openView(context)),
    vscode.commands.registerCommand('agentRepoShell.previewOverview', previewOverview),
    vscode.commands.registerCommand('agentRepoShell.installSessionHook', () => installSessionHook(context)),
  );

  // Status bar quick-launch: always visible (even with no editor open),
  // complements the editor/title icon contribution in package.json.
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 100
  );
  statusItem.text = '$(layout-panel) Agent Repo Shell';
  statusItem.tooltip = 'Open Agent Repo Shell view';
  statusItem.command = 'agentRepoShell.openView';
  statusItem.show();
  context.subscriptions.push(statusItem);
}

function deactivate() { }

module.exports = { activate, deactivate };

// =============================================================================
// Webview HTML template
// =============================================================================
const TEMPLATE = String.raw`<!DOCTYPE html>
<!-- Theme adapted from https://github.com/ThariqS/html-effectiveness (Apache-2.0) -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<link rel="stylesheet" href="__HLJS_CSS__">
<link rel="stylesheet" href="__RECOGITO_CSS__">
<script src="__MERMAID_JS__"></script>
<!-- Recogito's UMD references process.env.NODE_ENV (a leftover Node check
     that wasn't tree-shaken). Browsers don't have process; without this
     shim, createTextAnnotator throws ReferenceError on first call. -->
<script>window.process = window.process || { env: { NODE_ENV: 'production' } };</script>
<script src="__RECOGITO_JS__"></script>
<script src="__TURNDOWN_JS__"></script>
<script src="__HTML2CANVAS_JS__"></script>
<style>
  :root {
    --ivory: #FAF9F5;
    --paper: #FFFFFF;
    --slate: #141413;
    --clay:  #D97757;
    --oat:   #E3DACC;
    --g100:  #F0EEE6;
    --g300:  #D1CFC5;
    --g500:  #87867F;
    --g700:  #3D3D3A;
    --serif: ui-serif, Georgia, "Times New Roman", Times, serif;
    --sans:  system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono:  ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace;

    /* Sidebar 02a-2 (lowercase coral-big) palette */
    --sb-bg:        #F4EFE7;
    --sb-fg:        #2A2520;
    --sb-fg-soft:   #5C544C;
    --sb-muted:     #A89C90;
    --sb-coral:     #CC6B4F;
    --sb-coral-pale:#F6E6DC;
    --sb-line:      #E2D9CB;
    --sb-active-fg: #1B1714;
    --sb-mono: "JetBrains Mono", "Berkeley Mono", "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    min-height: 100%;
  }
  html {
    /* Fills any edge the body doesn't cover — keep it same shade as
       our in-webview sidebar so the panel feels seamless. */
    background: var(--vscode-sideBar-background, var(--sb-bg));
  }
  body {
    margin: 0;
    /* Main pane matches the VSCode editor background (light/clean); the
       in-webview sidebar matches the VSCode sideBar background (warm
       gray). Fallbacks preserve the editorial cream palette when the
       variables aren't injected (e.g. previewed outside a webview). */
    background: var(--vscode-editor-background, var(--ivory));
    color: var(--slate);
    font-family: var(--sans);
    line-height: 1.55;
    display: flex;
    -webkit-font-smoothing: antialiased;
  }
  /* ---------- Sidebar 02a-2 (lowercase coral-big) ---------- */
  nav.sidebar {
    width: 320px;
    padding: 32px 28px 40px 16px;
    height: 100vh;
    overflow-y: auto;
    position: sticky;
    top: 0;
    flex-shrink: 0;
    background: var(--vscode-sideBar-background, var(--sb-bg));
    color: var(--sb-fg);
    font-family: var(--sb-mono);
    font-size: 14px;
    line-height: 1.55;
    scrollbar-width: none;
  }
  nav.sidebar::-webkit-scrollbar { display: none; }
  .divider {
    width: 2.5px;
    flex-shrink: 0;
    /* Invisible by default so the panel feels edge-to-edge (matches the
       seamless look of native VSCode panels like Claude Code). Still
       grabbable for resize — cursor hint + coral on hover. */
    background: transparent;
    cursor: col-resize;
    position: sticky;
    top: 0;
    height: 100vh;
    transition: background 120ms;
  }
  .divider:hover { background: var(--sb-coral); }
  body.dragging { user-select: none; cursor: col-resize; }
  body.dragging * { cursor: col-resize !important; }
  .eyebrow {
    font-family: var(--sb-mono);
    font-size: 12px;
    letter-spacing: 1.4px;
    text-transform: uppercase;
    color: var(--sb-muted);
    margin-bottom: 24px;
    font-weight: 500;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .hidden-toggle {
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: none;
    font-weight: 400;
    color: var(--sb-muted);
    cursor: pointer;
    user-select: none;
  }
  .hidden-toggle:hover { color: var(--sb-coral); }
  .hidden-toggle:empty { display: none; }
  /* Sidebar filter input — fast in-tree name search. Replaces VSCode's
     native find widget for navigation (which gets flaky when the webview
     re-renders). Press '/' anywhere in the panel to focus. */
  .sb-filter-wrap {
    position: relative;
    margin-bottom: 18px;
  }
  .sb-filter {
    width: 100%;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--sb-line);
    color: var(--sb-fg);
    font-family: var(--sb-mono);
    font-size: 13px;
    padding: 4px 0 6px;
    outline: none;
  }
  .sb-filter::placeholder { color: var(--sb-muted); font-style: normal; }
  .sb-filter:focus { border-bottom-color: var(--sb-coral); }
  /* Custom tooltip — native title="…" gets dropped/delayed inside VSCode
     webviews, so we render our own. Shows on input hover/focus. */
  .sb-filter-tip {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 6px;
    background: var(--vscode-editorWidget-background, #2d2d2d);
    color: var(--vscode-editorWidget-foreground, #f0f0f0);
    border: 1px solid var(--vscode-editorWidget-border, #454545);
    border-radius: 4px;
    padding: 7px 10px;
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: 11px;
    line-height: 1.55;
    white-space: nowrap;
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.2));
    z-index: 50;
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms;
  }
  .sb-filter-tip code {
    background: rgba(127, 127, 127, 0.2);
    padding: 1px 5px;
    border-radius: 3px;
    font-family: var(--sb-mono);
    font-size: 11px;
  }
  .sb-filter-tip kbd {
    background: rgba(127, 127, 127, 0.2);
    padding: 0 5px;
    border-radius: 3px;
    font-family: var(--sb-mono);
    font-size: 11px;
    border: 1px solid rgba(127, 127, 127, 0.3);
  }
  .sb-filter-wrap:hover .sb-filter-tip,
  .sb-filter:focus ~ .sb-filter-tip {
    opacity: 1;
  }
  /* Filter-hide marker — wins over the various display:flex/block defaults
     on anchors and details elements. */
  .filter-hide { display: none !important; }
  /* Rounded-outline star icon (cartoon style). The path is from Heroicons
     (MIT). currentColor lets it pick up text color; per-use overrides set
     coral for favorites. */
  .star-icon {
    width: 13px;
    height: 13px;
    display: inline-block;
    vertical-align: -2px;
    flex-shrink: 0;
    margin-right: 6px;
    fill: none;
    stroke: var(--sb-coral);
    stroke-width: 1.8;
    stroke-linejoin: round;
    stroke-linecap: round;
    overflow: visible;
  }
  .star-icon.filled {
    fill: var(--sb-coral);
  }
  .star-icon.big {
    width: 17px;
    height: 17px;
    vertical-align: -3px;
    margin-right: 9px;
    stroke-width: 1.6;
  }
  /* Dim parent-dir suffix shown next to a favorite's filename, so two
     same-named files (e.g. tasks/pending/ideas.md vs tasks/done/ideas.md)
     can be told apart at a glance. */
  .fav-dir {
    color: var(--sb-muted);
    font-size: 11px;
    font-weight: 400;
  }
  /* Dimmed rows when "show hidden" is toggled on. */
  nav.sidebar a.is-hidden,
  nav.sidebar details.is-hidden > summary {
    opacity: 0.42;
  }
  details.section {
    margin-top: 22px;
    padding-top: 22px;
    /* Section divider — same neutral gray VSCode uses between its own
       sidebar sections (Outline / Timeline / etc.). Falls back to our
       warm tan if the variable isn't injected. */
    border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--sb-line));
  }
  details.section:first-of-type {
    margin-top: 0;
    padding-top: 0;
    border-top: none;
  }
  details.section > summary {
    list-style: none;
    cursor: pointer;
    user-select: none;
  }
  details.section > summary::-webkit-details-marker { display: none; }
  .dir-header.top {
    color: var(--sb-coral);
    font-size: 17px;
    letter-spacing: -0.2px;
    font-weight: 600;
    text-transform: none;
    display: flex; align-items: center; gap: 10px;
  }
  .dir-header.top .chevron {
    color: var(--sb-coral);
    font-size: 14px;
    font-weight: 600;
    transition: transform 0.15s;
    display: inline-block;
  }
  details.section:not([open]) .chevron { transform: rotate(-90deg); }
  .dir-header.top .label { flex: 0 1 auto; }
  .dir-header.top .count {
    margin-left: auto;
    font-size: 11px;
    color: var(--sb-muted);
    font-weight: 400;
  }
  .section-body {
    padding-left: 14px;
    margin-left: 6px;
    margin-top: 6px;
  }

  /* nested sub-section: smaller coral, sits inside the parent tree guide */
  details.sub-section { margin-top: 4px; }
  details.sub-section > summary {
    list-style: none;
    cursor: pointer;
    user-select: none;
    padding: 2px 0;
  }
  details.sub-section > summary::-webkit-details-marker { display: none; }
  .dir-header.nested {
    color: var(--sb-coral);
    font-size: 13px;
    font-weight: 500;
    text-transform: none;
    letter-spacing: 0;
    padding-left: 0;
    display: flex; align-items: center; gap: 8px;
  }
  .dir-header.nested .chevron {
    color: var(--sb-coral);
    font-size: 11px;
    transition: transform 0.15s;
    display: inline-block;
  }
  details.sub-section:not([open]) .dir-header.nested .chevron { transform: rotate(-90deg); }

  /* file rows */
  nav.sidebar a {
    position: relative;
    display: flex;
    align-items: center;
    text-decoration: none;
    font-family: var(--sb-mono);
    font-size: 14px;
    color: var(--sb-fg);
    padding: 3px 8px 3px 16px;
    margin-left: -8px;
    border-radius: 4px;
    word-break: break-all;
    cursor: pointer;
    transition: background 0.12s;
  }
  nav.sidebar a:hover { background: rgba(0,0,0,0.025); }
  nav.sidebar a.active {
    background: var(--sb-coral-pale);
    color: var(--sb-active-fg);
    font-weight: 600;
  }
  nav.sidebar a.active::before {
    content: "";
    position: absolute;
    left: -1px;
    top: 6px;
    bottom: 6px;
    width: 2px;
    background: var(--sb-coral);
    border-radius: 2px;
  }
  nav.sidebar a > .name { flex: 1; min-width: 0; word-break: break-all; }
  nav.sidebar a.external::after {
    content: "↗";
    color: var(--sb-muted);
    font-size: 11px;
    margin-left: 6px;
  }
  nav.sidebar a.external:hover::after { color: var(--sb-coral); }
  nav.sidebar details.sub-section a { padding-left: 28px; }
  /* Nested sub-section (sub-section inside sub-section) — each extra level
     pushes 14px further right so the tree hierarchy is readable. Compounds
     naturally through descendant selector. */
  nav.sidebar details.sub-section details.sub-section { margin-left: 14px; }
  /* ===== Level 3+ tree (anything inside .lazy-body) =====
     Visual style adapted from VSCode Explorer (microsoft/vscode, MIT):
       - src/vs/base/browser/ui/tree/media/tree.css     (.monaco-tl-row,
         .monaco-tl-twistie, .monaco-tl-indent)
       - src/vs/base/browser/ui/list/list.css           (.monaco-list-row)
       - src/vs/workbench/contrib/files/browser/media/  (Explorer-specific)
     Theme follows VSCode at runtime via --vscode-list-* / --vscode-foreground
     / --vscode-icon-foreground variables. Levels 1-2 keep our editorial mono
     palette; only nested lazy folders + their children adopt this look.
     ====================================================== */
  .lazy-body {
    display: flex;
    flex-direction: column;
    /* Geometry:
         margin-left: 5  → lazy-body.left = lazy-folder.left + 5 = chevron
                            center (chevron at +0, width 10, center +5).
                            The border-left sits exactly here → line drops
                            directly under the chevron tip.
         border-left: 1  → the line itself.
         padding-left: 1 → children offset another 1px past the line, so
                            total per-level step = 5 + 1 + 1 = 7px. */
    margin-left: 5px;
    padding-left: 1px;
    border-left: 1px solid transparent;
    transition: border-left-color 100ms linear;
    font-family: var(--vscode-font-family, var(--sans));
  }
  .lazy-body:hover {
    border-left-color: color-mix(in srgb,
      var(--vscode-tree-indentGuidesStroke, currentColor) 30%, transparent);
  }
  .lazy-body .lazy-loading {
    font-size: 12px;
    color: var(--vscode-descriptionForeground, var(--sb-muted));
    padding: 4px 8px 4px 16px;
    font-style: italic;
    font-family: var(--vscode-font-family, var(--sans));
  }
  /* File anchors — flat row, VSCode hover + selection colors. */
  /* High-specificity selector — adding .lazy-folder beats the level-1/2
     rule that puts padding-left:28px on file anchors inside sub-sections.
     Without this fix the file text was sitting 28px from the indent line
     even though we set padding-left:0. */
  nav.sidebar details.sub-section.lazy-folder .lazy-body a {
    display: flex;
    align-items: center;
    height: 22px;
    line-height: 22px;
    /* Aligned with folder text column: text at lazy-body.left + 6 + 13 = 19,
       which is 7px right of the indent line at +12. */
    padding: 0 6px 0 13px;
    margin: 0;
    border-radius: 0;
    font-family: var(--vscode-font-family, var(--sans));
    font-size: 13px;
    font-weight: normal;
    color: var(--vscode-foreground);
    background: transparent;
    word-break: normal;
    white-space: nowrap;
    overflow: hidden;
    cursor: pointer;
    transition: none;                       /* VSCode list rows snap, no easing */
  }
  nav.sidebar .lazy-body a:hover {
    background: var(--vscode-list-hoverBackground);
    color: var(--vscode-list-hoverForeground, var(--vscode-foreground));
  }
  nav.sidebar .lazy-body a.active {
    background: var(--vscode-list-inactiveSelectionBackground,
                     var(--vscode-list-hoverBackground));
    color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground));
    font-weight: normal;
  }
  /* Pure VSCode-native at level 3+ — drop our level-1/2 visual accents
     so the look is indistinguishable from the Explorer pane next door. */
  nav.sidebar .lazy-body a.active::before { display: none; }
  nav.sidebar .lazy-body a.active {
    /* Already overridden above to use --vscode-list-inactiveSelectionBackground;
       this just defends against the global font-weight:600 leaking in. */
    font-weight: normal;
  }
  nav.sidebar .lazy-body a.external::after { display: none; }
  nav.sidebar .lazy-body a > .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    word-break: normal;
  }
  /* Lazy folder summary rows — applies to ALL lazy folders regardless of
     parent (so outermost ones inside a regular sub-section also flip to
     VSCode native style, not just nested ones inside another .lazy-body).
     Selectors specify three classes (details.sub-section.lazy-folder) so
     they beat .dir-header.nested .chevron specificity. */
  details.sub-section.lazy-folder { border: none; padding: 0; }
  /* When a lazy folder sits DIRECTLY inside a regular sub-section (the
     boundary between level-1/2 tree and level-3+ lazy tree, e.g.
     references/repos/<sub>/), give it one indent step so it doesn't sit
     flush with its parent. Nested lazy folders inside a .lazy-body
     don't need this — the parent .lazy-body's padding-left already steps
     them in. */
  nav.sidebar details.sub-section:not(.lazy-folder)
    > details.sub-section.lazy-folder {
    margin-left: 6px;
  }
  /* Override the 14px-per-level rule lazy folders inherit from the
     level-1/2 nested-sub-section rule (line 1138). Without this, every
     nested lazy folder gets 14px stacked on top of the .lazy-body
     padding, blowing up the indent. We want pure lazy-body padding-left
     to control per-level step. */
  nav.sidebar details.sub-section details.sub-section.lazy-folder {
    margin-left: 0;
  }
  details.sub-section.lazy-folder > summary {
    height: 22px;
    line-height: 22px;
    /* Text starts at +13 from summary.left = +19 from lazy-body.left
       (lazy-body padding 6 + summary padding 13). Indent line at +12 from
       lazy-body, so line→text gap = 7px. */
    padding: 0 6px 0 13px;
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0;
    position: relative;
    font-family: var(--vscode-font-family, var(--sans));
    font-size: 13px;
    font-weight: normal;
    color: var(--vscode-foreground);
    background: transparent;
    cursor: pointer;
    text-transform: none;
    letter-spacing: normal;
    list-style: none;
  }
  details.sub-section.lazy-folder > summary:hover {
    background: var(--vscode-list-hoverBackground);
    color: var(--vscode-list-hoverForeground, var(--vscode-foreground));
  }
  details.sub-section.lazy-folder > summary::-webkit-details-marker { display: none; }
  /* Chevron — inline SVG codicon-style chevron-right (set by JS), rotated
     90deg when the folder is open. Color follows the VSCode icon-foreground
     theme variable via currentColor inheritance into the SVG. */
  details.sub-section.lazy-folder > summary .chevron {
    width: 10px;
    height: 10px;
    color: var(--vscode-icon-foreground, var(--vscode-foreground));
    transform: none !important;            /* defeat the level-1/2 rotation rule */
    font-size: 0;                          /* the .chevron contains an SVG, no text */
    /* Pulled out of normal flow so chevron sits LEFT of the indent line
       and the line ends up to the right of the chevron tip. left:0 places
       it at the summary's padding-box edge — which is lazy-body content
       edge since summary has no margin. */
    position: absolute;
    left: 0;
    top: 6px;                              /* vertical center for 22px row, 10px chevron */
    margin: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  details.sub-section.lazy-folder > summary .chevron svg {
    transition: transform 0.1s linear;     /* matches monaco-tl-twistie */
  }
  details.sub-section.lazy-folder[open] > summary .chevron svg {
    transform: rotate(90deg);
  }
  main {
    flex: 1;
    padding: 64px 56px 120px;
    max-width: 880px;
    min-width: 0;
    background: var(--vscode-editor-background, var(--ivory));
  }
  /* History (session) renders use the full panel width so long chat
     turns don't get squeezed into the 880px markdown column. */
  main.session { max-width: none; }
  .filename {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--g500);
    margin: 0 0 28px;
    display: flex; align-items: center; gap: 12px;
  }
  .filename::before {
    content: ""; width: 20px; height: 1.5px; background: var(--clay);
  }
  .hist-badge {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.06em;
    color: var(--clay);
    text-decoration: none;
    border: 1px solid var(--oat);
    border-radius: 999px;
    padding: 2px 9px;
    margin-left: 6px;
  }
  .hist-badge:hover {
    background: rgba(217, 119, 87, 0.08);
    border-color: var(--clay);
  }
  main h1 {
    font-family: var(--serif);
    font-weight: 500;
    font-size: 38px;
    line-height: 1.1;
    letter-spacing: -0.018em;
    margin: 0 0 24px;
  }
  main h1 em { font-style: italic; color: var(--clay); }
  main h2 {
    font-family: var(--serif);
    font-weight: 500;
    font-size: 26px;
    margin: 48px 0 16px;
    letter-spacing: -0.015em;
  }
  main h3 {
    font-family: var(--sans);
    font-weight: 600;
    font-size: 17px;
    margin: 32px 0 12px;
  }
  main p { margin: 0 0 16px; color: var(--g700); font-size: 16px; }
  main ul, main ol { margin: 0 0 16px; padding-left: 24px; color: var(--g700); }
  main li { margin: 6px 0; }
  pre {
    background: var(--paper);
    border: 1.5px solid var(--g300);
    padding: 14px 18px;
    border-radius: 6px;
    overflow-x: auto;
    font-size: 13px;
    line-height: 1.55;
    margin: 16px 0;
  }
  code { font-family: var(--mono); }
  pre code { background: none; padding: 0; }
  :not(pre) > code {
    background: var(--g100);
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 0.9em;
  }
  table { border-collapse: collapse; margin: 16px 0; font-size: 14px; width: 100%; }
  th, td { border-bottom: 1.5px solid var(--g300); padding: 10px 14px; text-align: left; }
  th {
    font-family: var(--mono); font-weight: 600; font-size: 11.5px;
    letter-spacing: 0.06em; text-transform: uppercase; color: var(--g500);
    border-bottom-color: var(--slate);
  }
  blockquote {
    border-left: 2px solid var(--clay); margin: 16px 0;
    padding: 4px 16px; color: var(--g700); font-style: italic;
  }
  main a {
    color: var(--clay); text-decoration: underline;
    text-decoration-color: var(--oat); text-underline-offset: 3px;
  }
  main a:hover { text-decoration-color: var(--clay); }
  hr { border: none; border-top: 1.5px solid var(--g300); margin: 32px 0; }
  strong { font-weight: 600; color: var(--slate); }
  .session-started {
    font-family: var(--mono); font-size: 12px; color: var(--g500);
    margin: -16px 0 32px;
  }
  .chat {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-top: 28px;
  }
  .bubble {
    background: var(--paper);
    border: 1.5px solid var(--g300);
    border-left-width: 4px;
    border-radius: 8px;
    padding: 12px 16px 4px;
    max-width: 78%;
    min-width: 0;
  }
  .bubble.user   { border-left-color: var(--clay);  align-self: flex-end; }
  .bubble.claude { border-left-color: var(--slate); align-self: flex-start; }
  .bubble .anchor {
    font-family: var(--mono); font-size: 11px;
    letter-spacing: 0.08em; color: var(--g500);
    margin-bottom: 6px;
  }
  .bubble.user   .anchor::before { content: "USER · ";   color: var(--clay);  font-weight: 600; }
  .bubble.claude .anchor::before { content: "CLAUDE · "; color: var(--slate); font-weight: 600; }
  .bubble :last-child { margin-bottom: 0; }
  .bubble p, .bubble li { font-size: 14px; line-height: 1.55; }
  .bubble pre { font-size: 12.5px; }
  /* ---------- Task state segmented control (top-right, like old refresh) ---- */
  #taskbar {
    position: fixed; top: 12px; right: 16px;
    z-index: 50;
    display: none;
  }
  #taskbar.show { display: block; }
  /* Segmented task-state control — "glyph + label" style.
     Each state has its own glyph (dashed-circle / half-fill / check-circle)
     and its own hue. Selected state shows in that hue + 600 weight + a
     softly-tinted pill background; unselected stays muted gray.
     References: references/notes/04 _ Colored states.html,
                 references/notes/06 _ Glyph _ label.html */
  .seg {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 5px 7px;
    background: #FCFAF3;
    border: 1px solid rgba(168, 156, 144, 0.15);
    border-radius: 999px;
    font-family: var(--sb-mono);
    font-size: 13px;
    letter-spacing: normal;
    box-shadow: 0 1px 2px rgba(0,0,0,0.025);
  }
  .seg button {
    border: none;
    background: transparent;
    padding: 5px 12px;
    color: #A89C90;
    font: inherit;
    font-weight: 400;
    line-height: 1;
    cursor: pointer;
    letter-spacing: inherit;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    transition: color 220ms ease, background 220ms ease, font-weight 220ms ease;
  }
  .seg-icon {
    width: 13px;
    height: 13px;
    flex-shrink: 0;
    display: block;
    overflow: visible;
  }
  .seg-label { line-height: 1; }
  .seg button:hover:not(.on) { color: #5C544C; }
  .seg button.on { font-weight: 600; }
  /* Selected hue per state — text color, glyph color (via currentColor),
     and a faint matching pill background. */
  .seg button.on.todo {
    color: #5C544C;
    background: rgba(92, 84, 76, 0.10);
  }
  .seg button.on.doing {
    color: #CC6B4F;
    background: rgba(204, 107, 79, 0.13);
  }
  .seg button.on.done {
    color: #56725A;
    background: rgba(86, 114, 90, 0.15);
  }
  /* Dynamism on the doing state — the half-fill arc gently breathes,
     the surrounding pill softly pulses. Only when 'doing' is the selected
     state; muted doing stays still. */
  .seg button.on.doing .seg-icon-half {
    animation: seg-doing-fill 1.8s ease-in-out infinite;
    transform-origin: 6px 6px;
  }
  .seg button.on.doing {
    animation: seg-doing-bg 1.8s ease-in-out infinite;
  }
  @keyframes seg-doing-fill {
    0%, 100% { opacity: 1;   transform: scale(1); }
    50%      { opacity: 0.55; transform: scale(0.86); }
  }
  @keyframes seg-doing-bg {
    0%, 100% { background: rgba(204, 107, 79, 0.13); }
    50%      { background: rgba(204, 107, 79, 0.22); }
  }
  #toast {
    position: fixed; bottom: 24px; right: 24px;
    padding: 9px 15px; border-radius: 6px;
    font-family: var(--mono); font-size: 12px;
    background: var(--paper); border: 1.5px solid var(--g300);
    color: var(--g700); opacity: 0;
    transition: opacity 200ms; pointer-events: none; z-index: 100;
  }
  #toast.show { opacity: 1; }
  /* ---------- Find-in-content widget ---------- */
  /* Styled to match VSCode's native find widget — uses the same CSS vars
     VSCode injects into the webview, so it follows the user's theme
     (light/dark/high-contrast). Fallbacks keep it presentable outside a
     webview context (preview-in-browser etc.). */
  .find-bar {
    position: fixed;
    top: 8px;
    right: 16px;
    z-index: 150;
    display: flex;
    align-items: center;
    gap: 2px;
    background: var(--vscode-editorWidget-background, #f3f3f3);
    color: var(--vscode-editorWidget-foreground, #333);
    border: 1px solid var(--vscode-editorWidget-border, #c8c8c8);
    border-radius: 5px;
    padding: 4px 6px;
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.16));
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: 12px;
  }
  .find-bar[hidden] { display: none; }
  .find-bar input {
    border: 1px solid var(--vscode-input-border, transparent);
    outline: none;
    background: var(--vscode-input-background, #fff);
    color: var(--vscode-input-foreground, #000);
    font: inherit;
    font-size: 12px;
    width: 200px;
    height: 22px;
    padding: 0 6px;
    box-sizing: border-box;
    border-radius: 2px;
  }
  .find-bar input:focus {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: -1px;
    border-color: transparent;
  }
  .find-count {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
    min-width: 56px;
    padding: 0 6px;
    text-align: right;
    user-select: none;
    white-space: nowrap;
  }
  .find-count.empty {
    color: var(--vscode-errorForeground, #cc3333);
  }
  .find-btn {
    border: none;
    background: transparent;
    color: var(--vscode-icon-foreground, #424242);
    cursor: pointer;
    width: 22px;
    height: 22px;
    padding: 0;
    font-size: 14px;
    line-height: 1;
    border-radius: 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .find-btn:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.18));
  }
  .find-btn:disabled { opacity: 0.4; cursor: default; }
  /* Match highlights — use VSCode's own find-match colors so highlights
     match the editor's find appearance pixel-for-pixel. */
  mark.find-hit {
    background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
    color: inherit;
    border-radius: 0;
    padding: 0;
  }
  mark.find-hit.current {
    background: var(--vscode-editor-findMatchBackground, rgba(165, 102, 11, 0.55));
    color: inherit;
    outline: 1px solid var(--vscode-editor-findMatchBorder, transparent);
  }
  #ctxmenu {
    position: fixed;
    z-index: 200;
    background: var(--paper);
    border: 1.5px solid var(--g300);
    border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0,0,0,0.08);
    padding: 4px 0;
    min-width: 180px;
    font-family: var(--sans);
    font-size: 13px;
    display: none;
  }
  #ctxmenu.show { display: block; }
  #ctxmenu .item {
    padding: 6px 14px;
    cursor: pointer;
    color: var(--g700);
    user-select: none;
  }
  #ctxmenu .item:hover { background: var(--g100); color: var(--slate); }
  #ctxmenu .item.danger:hover { background: color-mix(in srgb, var(--clay) 18%, transparent); color: var(--clay); }
  /* Greyed-out items — used for ops that don't apply to the current target
     (e.g. Rename/Delete on the workspace root). Click handler skips these. */
  #ctxmenu .item.disabled,
  #ctxmenu .item.disabled:hover {
    color: var(--g300);
    background: transparent;
    cursor: not-allowed;
  }
  #ctxmenu .sep { height: 1px; background: var(--g300); margin: 4px 0; }
  #toolbar {
    position: fixed; top: 12px; right: 16px;
    display: flex; gap: 6px;
  }
  #toolbar button {
    font-family: var(--mono); font-size: 11px;
    background: var(--paper); border: 1.5px solid var(--g300);
    color: var(--g700); padding: 6px 10px; border-radius: 4px;
    cursor: pointer;
  }
  #toolbar button:hover { color: var(--slate); border-color: var(--slate); }
  /* ============================================================
     File overview (rendered when a code file is clicked).
     Style adapted from tools/extension/mockup-overview.html.
     ============================================================ */
  .ov main, main.ov {
    font-family: var(--mono);
    max-width: 1080px;
  }
  .hd-line {
    display: flex; align-items: baseline; gap: 16px;
    margin: 0 0 18px;
    flex-wrap: wrap;
  }
  .ov h1 {
    font-family: var(--mono);
    font-weight: 700;
    font-size: 30px;
    letter-spacing: -0.01em;
    line-height: 1.15;
    margin: 0;
    color: var(--slate);
  }
  .hd-file {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--g500);
  }
  .meta-strip {
    display: flex; flex-wrap: wrap; gap: 8px 26px;
    font-family: var(--mono); font-size: 12px;
    margin: 0 0 44px;
  }
  .m-kv { color: var(--g500); }
  .m-kv b { color: var(--slate); font-weight: 700; margin-left: 6px; }
  .sec-hd {
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.16em;
    color: var(--slate);
    font-weight: 600;
    border-bottom: 1px solid var(--g300);
    padding-bottom: 12px;
    margin: 56px 0 24px;
    display: flex; align-items: baseline; gap: 16px;
    text-transform: uppercase;
  }
  .sec-num {
    color: var(--clay);
    font-weight: 700;
    letter-spacing: 0.08em;
  }
  .sec-aside {
    margin-left: auto;
    color: var(--g500);
    font-weight: 400;
    letter-spacing: 0.08em;
    text-transform: none;
  }
  .ov p, .ov ol, .ov ul { font-family: var(--mono); }
  .ov p { margin: 0 0 16px; color: var(--g700); font-size: 14px; line-height: 1.65; }
  .ov ol, .ov ul { margin: 0 0 16px; padding-left: 24px; color: var(--g700); }
  .ov li { margin: 10px 0; font-size: 14px; line-height: 1.65; }
  .ov li b, .ov li strong { color: var(--slate); font-weight: 700; }
  .mermaid-wrap {
    background: transparent;
    border: none;
    padding: 24px 0 8px;
    margin: 0 0 32px;
    min-height: 320px;
    display: flex; justify-content: center; align-items: center;
    overflow-x: auto;
  }
  .mermaid-wrap .mermaid { width: 100%; }
  .mermaid-wrap svg .edgePath path,
  .mermaid-wrap svg path.flowchart-link {
    stroke-width: 1px !important;
    stroke: #C7BDB0 !important;
  }
  .mermaid-wrap svg defs marker,
  .mermaid-wrap svg marker { display: none !important; }
  .mermaid-wrap svg path,
  .mermaid-wrap svg .edgePath path,
  .mermaid-wrap svg .flowchart-link {
    marker-end: none !important;
    marker-start: none !important;
  }
  .mermaid-wrap svg g.node rect,
  .mermaid-wrap svg g.node polygon {
    rx: 4px !important;
    ry: 4px !important;
  }
  .mermaid-wrap .nodeLabel {
    padding: 0 11px !important;
    text-align: center !important;
  }
  .mermaid-wrap g.node { cursor: pointer; }
  .mermaid-wrap g.node rect,
  .mermaid-wrap g.node polygon { transition: stroke 120ms; }
  .mermaid-wrap g.node:hover rect,
  .mermaid-wrap g.node:hover polygon {
    stroke: var(--clay) !important;
    stroke-width: 1.2px !important;
  }
  .fn-list { margin: 12px 0 32px; }
  details.fn {
    border-top: 1px solid var(--g300);
    padding: 12px 0;
  }
  details.fn:first-of-type { border-top: none; }
  details.fn > summary {
    list-style: none;
    cursor: pointer;
    user-select: none;
    display: grid;
    grid-template-columns: 220px 80px 1fr;
    gap: 18px;
    align-items: baseline;
  }
  details.fn > summary::-webkit-details-marker { display: none; }
  .fn-name {
    font-family: var(--mono); font-size: 14px; font-weight: 600;
    color: var(--slate);
    position: relative;
    padding-left: 18px;
  }
  .fn-name::before {
    content: "▸";
    color: var(--g500);
    font-size: 11px;
    position: absolute;
    left: 2px;
    top: 50%;
    transform: translateY(-50%);
    transition: transform 0.15s;
  }
  details.fn[open] .fn-name::before { transform: translateY(-50%) rotate(90deg); }
  .fn-name:hover { color: var(--clay); }
  .fn-line {
    font-family: var(--mono); font-size: 11px; color: var(--g500);
    letter-spacing: 0.06em;
  }
  .fn-summary {
    font-family: var(--mono); font-size: 13px;
    color: var(--g700);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .fn-detail {
    margin: 14px 0 6px;
    padding: 16px 20px;
    background: var(--paper);
    border-left: 3px solid var(--oat);
    border-radius: 0 6px 6px 0;
  }
  .fn-detail .sig {
    font-family: var(--mono); font-size: 12.5px;
    background: var(--g100);
    padding: 6px 10px; border-radius: 4px;
    color: var(--g700);
    margin: 0 0 12px;
    display: inline-block;
    white-space: pre-wrap;
  }
  .fn-detail p { font-size: 14.5px; margin: 0 0 8px; }
  .fn-detail p:last-child { margin-bottom: 0; }
  .fn-jump {
    display: inline-block;
    margin-top: 14px;
    font-family: var(--mono); font-size: 12px;
    color: var(--clay); text-decoration: none;
    border-bottom: 1px dashed var(--oat);
    cursor: pointer;
  }
  .fn-jump:hover { border-bottom-color: var(--clay); color: var(--slate); }
  .fn-rels {
    display: grid;
    grid-template-columns: 96px 1fr;
    gap: 8px 16px;
    margin-top: 14px;
    font-family: var(--mono); font-size: 13px;
  }
  .fn-rel-label {
    color: var(--g500);
    align-self: start;
    padding-top: 2px;
  }
  .fn-tree {
    list-style: none;
    padding: 0; margin: 0;
    color: var(--g700);
  }
  .fn-tree li {
    padding: 0; margin: 2px 0;
    white-space: nowrap;
  }
  .fn-tree .branch { color: var(--g300); margin-right: 8px; }
  .fn-tree .nm { color: var(--slate); font-weight: 600; }
  .fn-tree .nm.callable { cursor: pointer; }
  .fn-tree .nm.callable:hover { color: var(--clay); }
  .fn-tree .ln { color: var(--g500); margin-left: 6px; font-size: 12px; }
  .fn-tree .empty { color: var(--g500); font-style: italic; }
  .used-list, .todo-list {
    list-style: none; padding: 0; margin: 0;
    font-family: var(--mono); font-size: 13px;
  }
  .used-list li {
    display: grid;
    grid-template-columns: 10px 1fr 18px;
    column-gap: 14px;
    padding: 16px 0;
    border-top: 1px solid var(--g300);
    align-items: start;
    cursor: pointer;
  }
  .used-list li:first-child { border-top: none; padding-top: 6px; }
  .used-list li:hover .file { color: var(--clay); }
  .used-list .dot {
    width: 8px; height: 8px; border-radius: 50%;
    margin-top: 6px;
    background: var(--clay);
  }
  .used-list .file { color: var(--slate); font-weight: 600; }
  .used-list .ln   { color: var(--g500); font-size: 12px; margin-left: 6px; }
  .used-list .desc { color: var(--g500); font-size: 12px; margin-top: 4px; }
  .used-list .arrow { color: var(--g500); font-size: 13px; text-align: right; }
  .todo-list li {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 14px;
    padding: 14px 0;
    border-top: 1px solid var(--g300);
    align-items: start;
    cursor: pointer;
  }
  .todo-list li:first-child { border-top: none; padding-top: 6px; }
  .todo-list li:hover .todo-text { color: var(--clay); }
  .tag {
    display: inline-block;
    padding: 3px 9px 4px;
    border-radius: 4px;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    font-weight: 600;
    margin-top: 1px;
  }
  .tag.todo  { background: var(--g100); color: var(--g700); }
  .tag.fixme { background: #F6E6DC; color: var(--clay); }
  .tag.hack, .tag.xxx { background: var(--g100); color: var(--clay); }
  .todo-text  { color: var(--slate); font-size: 13.5px; }
  .todo-where { color: var(--g500); font-size: 12px; margin-top: 4px; }
  .ov-empty {
    color: var(--g500); font-family: var(--mono); font-size: 13px;
    padding: 60px 0;
  }
  .ov-empty code {
    background: var(--g100);
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 12.5px;
    color: var(--g700);
  }
  /* Sync button — visually echoes the todo/doing/done seg-chip palette
     (cream pill + state hue + matching SVG glyph) but is a standalone
     single-button pill, not segmented. Pinned to the right of .hd-line. */
  .hd-line { justify-content: flex-start; }
  .hd-line .sync-btn { margin-left: auto; }
  .sync-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 5px 12px;
    background: #FCFAF3;
    border: 1px solid rgba(168, 156, 144, 0.20);
    border-radius: 999px;
    font-family: var(--sb-mono);
    font-size: 12px;
    line-height: 1;
    letter-spacing: normal;
    font-weight: 500;
    cursor: pointer;
    color: #5C544C;
    transition: color 220ms ease, background 220ms ease, border-color 220ms ease;
  }
  .sync-btn .seg-icon { width: 13px; height: 13px; flex-shrink: 0; display: block; overflow: visible; }
  .sync-btn:hover:not(:disabled) {
    color: var(--slate);
    background: rgba(255, 255, 255, 0.55);
  }
  /* "Synced X ago" — done hue (forest green with check glyph). */
  .sync-btn.done {
    color: #56725A;
    background: rgba(86, 114, 90, 0.10);
  }
  .sync-btn.done:hover:not(:disabled) {
    background: rgba(86, 114, 90, 0.18);
  }
  /* "Sync now" call-to-action on uninitialized files — doing-hue clay. */
  .sync-btn.primary {
    color: #CC6B4F;
    font-weight: 600;
    background: rgba(204, 107, 79, 0.13);
    border-color: rgba(204, 107, 79, 0.30);
  }
  .sync-btn.primary:hover:not(:disabled) {
    background: rgba(204, 107, 79, 0.22);
  }
  /* "syncing…" — reuse the seg doing animation so it breathes identically. */
  .sync-btn.syncing,
  .sync-btn:disabled {
    color: #CC6B4F;
    background: rgba(204, 107, 79, 0.13);
    cursor: progress;
    animation: seg-doing-bg 1.8s ease-in-out infinite;
  }
  .sync-btn.syncing .seg-icon-half {
    animation: seg-doing-fill 1.8s ease-in-out infinite;
    transform-origin: 6px 6px;
  }
  /* Failed — clay text, no animation. */
  .sync-btn.failed {
    color: var(--clay);
    background: rgba(204, 107, 79, 0.08);
    border-color: rgba(204, 107, 79, 0.30);
    cursor: pointer;
    animation: none;
  }
  .sync-error {
    font-family: var(--mono); font-size: 12.5px;
    background: #F6E6DC;
    border-left: 3px solid var(--clay);
    padding: 10px 14px;
    border-radius: 0 6px 6px 0;
    color: var(--g700);
    margin: 16px 0;
  }

  /* ============================================================
     ANCHORED COMMENTS — select any text in a doc, click the
     floating Comment button, leave a comment. Recogito Text
     Annotator (BSD-3, github.com/recogito/text-annotator-js)
     owns the selection→range→highlight pipeline; we own the
     popup UI and the per-file localStorage persistence.
     ============================================================ */
  /* Make our main container the annotatable surface. Recogito tags
     it with .r6o-annotatable on init, but adding the same class
     up-front avoids a flash on first render. */
  .md-body { position: relative; }
  /* Edit-mode visuals — soft coral border + slight padding shift so the
     user immediately sees the doc is now a live text field. */
  .md-body[contenteditable="true"] {
    outline: none;
    border: 1.5px dashed var(--clay);
    border-radius: 6px;
    padding: 6px 10px;
    margin: -7.5px -11px;
    background: rgba(255, 255, 255, 0.4);
  }
  .md-body[contenteditable="true"] :focus { outline: none; }
  /* Small toolbar tucked into the filename header. */
  .edit-controls {
    margin-left: 14px;
    display: inline-flex;
    gap: 6px;
    vertical-align: middle;
  }
  .edit-controls button {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    background: transparent;
    border: 1px solid var(--g300);
    color: var(--g700);
    padding: 1px 8px;
    border-radius: 3px;
    line-height: 1.4;
    cursor: pointer;
    transition: border-color 120ms, color 120ms, background 120ms;
  }
  .edit-controls button:hover {
    border-color: var(--clay);
    color: var(--clay);
  }
  .edit-controls button.primary {
    background: var(--clay);
    color: #FFFFFF;
    border-color: var(--clay);
  }
  .edit-controls button.primary:hover { background: #b9583c; border-color: #b9583c; }
  /* Active mode (Edit / Review / Draw): pale coral fill so it reads as
     "currently selected" without competing with the brighter .primary
     buttons used for action verbs (Save, Done). */
  .edit-controls button.active {
    background: rgba(217, 119, 87, 0.12);
    border-color: rgba(217, 119, 87, 0.50);
    color: var(--clay);
  }
  .edit-controls button.active:hover {
    background: rgba(217, 119, 87, 0.20);
    color: var(--clay);
  }

  /* Drawing overlay — an SVG layer pinned to the .md-body content area.
     pointer-events:none by default so it doesn't block text selection or
     bubble clicks; flipped to all + crosshair cursor while draw mode is
     on. Strokes are <path> children, drawn in coral. */
  .md-strokes {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    pointer-events: none;
    overflow: visible;
    z-index: 4;
  }
  .md-strokes path {
    fill: none;
    stroke: var(--clay);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    /* visiblePainted = hover/click only on the actual painted stroke
       pixels (not the whitespace around). Lets drawings be hoverable +
       draggable without absorbing text-selection clicks. */
    pointer-events: visiblePainted;
    cursor: grab;
  }
  /* While the user is actively dragging a drawing. */
  .md-body.drag-active .md-strokes path { cursor: grabbing; }
  /* Floating label that shows the drawing's name (draw1/draw2/…) when
     the user hovers a stroke. Positioned absolutely against the document. */
  #draw-label {
    position: absolute;
    z-index: 245;
    display: none;
    background: var(--slate);
    color: #FFFFFF;
    font-family: var(--mono);
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 4px;
    pointer-events: none;
    user-select: none;
    white-space: nowrap;
  }
  #draw-label.show { display: inline-block; }
  /* Invisible wider sibling on each stroke — fat hit-target so thin 2px
     strokes are easy to click for delete. pointer-events:none outside
     draw mode so it doesn't block text selection / bubble clicks. */
  .md-strokes path.md-stroke-hit {
    stroke: transparent;
    stroke-width: 14;
    pointer-events: none;
  }
  .md-body.draw-mode .md-strokes {
    pointer-events: all;
    cursor: crosshair;
  }
  .md-body.draw-mode .md-strokes path.md-stroke-hit {
    pointer-events: stroke;
    cursor: pointer;
  }
  /* Hover feedback on the visible sibling when the hit path is hovered. */
  .md-body.draw-mode .md-strokes path.md-stroke-hit:hover + path {
    stroke: #b9583c;
    stroke-width: 3;
  }
  /* Selected stroke (clicked once in draw mode → chip is up) shows a
     bolder coral so the user knows which one the × refers to. */
  .md-strokes path.selected {
    stroke: #8a3a26 !important;
    stroke-width: 3.5 !important;
  }
  /* Small floating "×" chip — appears next to a clicked stroke, click
     it to commit the delete. Positioned absolutely against the document. */
  #stroke-chip {
    position: absolute;
    z-index: 250;
    display: none;
    background: var(--slate);
    color: #FFFFFF;
    border-radius: 14px;
    width: 24px; height: 24px;
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    box-shadow: 0 2px 6px rgba(0,0,0,0.22);
    align-items: center;
    justify-content: center;
    border: none;
    padding: 0;
    user-select: none;
  }
  #stroke-chip.show { display: inline-flex; }
  #stroke-chip:hover { background: var(--clay); }
  .md-body.draw-mode {
    /* Mute body interactions while drawing so text selection doesn't fight
       the pointer events. */
    user-select: none;
  }
  /* Coral-tinted highlight for our saved comments (overrides
     Recogito's default blue). Applied via setStyle() in JS. */
  main .r6o-annotation {
    background-color: rgba(217, 119, 87, 0.20);
    border-bottom: 1.5px solid rgba(217, 119, 87, 0.55);
  }
  /* Preview highlight shown while the comment popover is open. The browser
     drops the native ::selection blue the moment focus moves to the
     popover's textarea, so we re-paint the same blue ourselves via the CSS
     Custom Highlight API. Set/cleared in JS via CSS.highlights. */
  ::highlight(cmt-preview) {
    background-color: rgba(0, 128, 255, 0.22);
  }
  /* Blue anchor highlight in the read-only snapshot view — paints every
     saved comment's quoted range so the reader sees which text each
     bubble is attached to. */
  ::highlight(snapshot-anchor) {
    background-color: rgba(0, 128, 255, 0.22);
  }
  /* Inline comment bubble — sits directly after the highlight span so the
     reader can see + edit each comment in place without opening the pet
     panel. Click to re-open the popover in edit mode. */
  .cmt-inline {
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
    margin: 0 2px 0 4px;
    padding: 1px 8px 2px;
    background: var(--sb-coral-pale);
    border-radius: 4px;
    border-left: 2px solid var(--clay);
    font-family: var(--sans);
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--g700);
    cursor: pointer;
    vertical-align: baseline;
    max-width: 420px;
    transition: background 120ms, color 120ms;
  }
  .cmt-inline:hover { background: var(--clay); color: #FFFFFF; }
  .cmt-inline .cmt-inline-icon { font-size: 10.5px; opacity: 0.8; flex-shrink: 0; }
  .cmt-inline .cmt-inline-text {
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* Floating "💬 Comment" toolbar shown right above a selection
     (Notion-style). Positioned absolutely against the document. */
  #sel-toolbar {
    position: absolute;
    z-index: 240;
    display: none;
    background: var(--slate);
    color: #FFFFFF;
    border-radius: 6px;
    padding: 4px;
    box-shadow: 0 4px 14px rgba(0,0,0,0.18);
    font-family: var(--sans);
    font-size: 12.5px;
    user-select: none;
  }
  #sel-toolbar.show { display: inline-flex; gap: 2px; }
  #sel-toolbar button {
    background: transparent;
    color: #FFFFFF;
    border: none;
    padding: 5px 9px;
    border-radius: 4px;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  #sel-toolbar button:hover { background: rgba(255,255,255,0.14); }
  /* Popover for typing a comment. */
  #cmt-popover {
    position: absolute;
    z-index: 250;
    width: 340px;
    background: var(--paper);
    border: 1.5px solid var(--g300);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.10);
    padding: 12px;
    display: none;
    font-family: var(--sans);
  }
  #cmt-popover.show { display: block; }
  #cmt-popover .anchor-preview {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--g500);
    background: var(--g100);
    padding: 6px 8px;
    border-radius: 4px;
    margin-bottom: 8px;
    max-height: 60px; overflow: hidden;
    white-space: nowrap; text-overflow: ellipsis;
  }
  /* Drawing-attach chips above the textarea. Coral when the comment has
     @drawN in it (= that drawing is attached), neutral otherwise. Click
     toggles the @drawN mention in the textarea. */
  #cmt-popover .draw-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 8px;
  }
  #cmt-popover .draw-chip {
    font-family: var(--mono);
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    border: 1px solid var(--g300);
    background: var(--paper);
    color: var(--g700);
    cursor: pointer;
    user-select: none;
  }
  #cmt-popover .draw-chip:hover { border-color: var(--clay); color: var(--clay); }
  #cmt-popover .draw-chip.attached {
    background: var(--clay);
    color: #FFFFFF;
    border-color: var(--clay);
  }
  #cmt-popover textarea {
    width: 100%;
    min-height: 80px;
    resize: vertical;
    border: 1px solid var(--g300);
    border-radius: 4px;
    padding: 8px;
    font-family: var(--sans);
    font-size: 13.5px;
    color: var(--slate);
    background: var(--paper);
    box-sizing: border-box;
  }
  #cmt-popover textarea:focus { outline: none; border-color: var(--clay); }
  #cmt-popover .row {
    display: flex; gap: 8px; justify-content: flex-end;
    margin-top: 8px;
  }
  #cmt-popover button {
    font-family: var(--sans);
    font-size: 12.5px;
    padding: 5px 12px;
    border-radius: 4px;
    border: 1px solid var(--g300);
    background: var(--paper);
    color: var(--g700);
    cursor: pointer;
  }
  #cmt-popover button.primary {
    background: var(--clay); color: #FFFFFF; border-color: var(--clay);
  }
  #cmt-popover button:hover { border-color: var(--clay); }

  /* ============================================================
     AGENT PET — draggable bottom-right floating UI. Pixel/ASCII
     bodies + 7 moods, ported from references/notes/pet-pack/.
     ============================================================ */
  /* Pet color tokens (lifted from pet-pack/Pets-inline.jsx PT block). */
  :root {
    --pt-coral:        #F08A65;
    --pt-coralLight:   #FFB596;
    --pt-coralDeep:    #C76B4A;
    --pt-coralDark:    #9C4831;
    --pt-coralBlush:   #FFD9C6;
    --pt-blush:        #F5A48A;
    --pt-ink:          #2A1F18;
    --pt-inkSoft:      #5C4A3C;
    --pt-paperSoft:    #FBF8F2;
    --pt-line:         #E2D9CB;
    --pt-mutedSoft:    #C7BDB0;
    --pt-thinkBlue:    #5B7AA3;
    --pt-successGreen: #6B8A6F;
    --pt-errorRed:     #B8513A;
    --pt-party1:       #E2B14B;
    --pt-party2:       #8DA86C;
    --pt-party3:       #C19BD4;
    --pt-sleepBlue:    #8FA8C2;
    --pt-badgeRed:     #D44438;
  }
  #pet {
    position: fixed;
    bottom: 22px; right: 22px;
    width: 64px; height: 70px;
    z-index: 200;
    cursor: grab;
    user-select: none;
    touch-action: none;
  }
  #pet.dragging { cursor: grabbing; transition: none; }
  /* Bottom-align the body so the pet's "feet" sit just above the shadow —
     critical for ASCII pets where the <pre> face is shorter than the
     container; without this the face floats near the top of the box and
     looks disconnected from the shadow. */
  #pet .pet-body {
    position: absolute; top: 0; left: 4px;
    width: 56px; height: 56px;
    display: flex; align-items: flex-end; justify-content: center;
    transform-origin: center bottom;
    animation: pet_breathe 3.4s ease-in-out infinite;
    pointer-events: none;
  }
  #pet .pet-body svg { width: 100%; height: 100%; display: block; }
  /* Override the global pre style (meant for markdown code blocks) so the
     ASCII pet face doesn't inherit a background / border / padding that
     draws an unwanted frame around it. */
  #pet .pet-body pre {
    margin: 0; padding: 0;
    background: none; border: none; border-radius: 0;
    overflow: visible; line-height: 1.0; text-align: center;
    text-shadow: 0 1px 0 var(--pt-paperSoft);
    letter-spacing: 0; font-family: var(--mono);
    color: var(--pt-coral);
  }
  #pet .pet-shadow {
    position: absolute; bottom: 2px; left: 50%;
    width: 40px; height: 6px; border-radius: 50%;
    background: radial-gradient(ellipse, rgba(43,32,20,.25), transparent 70%);
    transform: translateX(-50%);
    filter: blur(1px);
    pointer-events: none;
  }
  #pet .pet-overlay { position: absolute; inset: 0; pointer-events: none; }
  /* Badge — unsubmitted comment count. */
  #pet .pet-badge {
    position: absolute; top: 0; right: -2px;
    min-width: 18px; height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background: var(--pt-badgeRed); color: #FFFFFF;
    font-family: var(--mono); font-size: 11px; font-weight: 700;
    display: none; align-items: center; justify-content: center;
    box-shadow: 0 1px 2px rgba(0,0,0,0.20);
    z-index: 10;
  }
  #pet .pet-badge.show { display: inline-flex; }
  #pet .pet-badge.pulse { animation: badge-pulse 360ms; }
  @keyframes badge-pulse {
    0%   { transform: scale(1); }
    50%  { transform: scale(1.35); }
    100% { transform: scale(1); }
  }
  /* Pet-pack animations (verbatim from Pets-inline.jsx PET_CSS). */
  @keyframes pet_breathe { 0%, 100% { transform: scale(1) translateY(0); } 50% { transform: scale(1.04) translateY(-1px); } }
  @keyframes pet_breatheSlow { 0%, 100% { transform: scale(1) translateY(0); } 50% { transform: scale(1.06) translateY(-1.5px); } }
  @keyframes pet_sway { 0%, 100% { transform: rotate(-2deg) translateY(0); } 50% { transform: rotate(2deg) translateY(-1px); } }
  @keyframes pet_typeBob { 0%, 50%, 100% { transform: translateY(0); } 25%, 75% { transform: translateY(-1px); } }
  @keyframes pet_bounce { 0%, 100% { transform: translateY(0) scaleY(1); } 40%, 60% { transform: translateY(-7px) scaleY(1.03); } 80% { transform: translateY(0) scaleY(0.96); } }
  @keyframes pet_party { 0%, 100% { transform: translateY(0) rotate(-4deg); } 25% { transform: translateY(-8px) rotate(0deg); } 50% { transform: translateY(-2px) rotate(4deg); } 75% { transform: translateY(-6px) rotate(-2deg); } }
  @keyframes pet_shake { 0%, 100% { transform: translateX(0); } 20% { transform: translateX(-2px) rotate(-3deg); } 40% { transform: translateX(2px) rotate(3deg); } 60% { transform: translateX(-1.5px) rotate(-2deg); } 80% { transform: translateX(1.5px) rotate(2deg); } }
  @keyframes pet_shadowPulse { 0%, 100% { transform: translateX(-50%) scaleX(1); opacity: .25; } 50% { transform: translateX(-50%) scaleX(.7); opacity: .15; } }
  @keyframes pet_dotPulse { 0%, 100% { transform: translateY(0) scale(1); opacity: .35; } 50% { transform: translateY(-3px) scale(1.2); opacity: 1; } }
  @keyframes pet_zzz { 0% { opacity: 0; transform: translate(0, 0) scale(0.7); } 20% { opacity: 1; } 100% { opacity: 0; transform: translate(7px, -10px) scale(1.1); } }
  @keyframes pet_confetti { 0% { transform: translate(0, 0) rotate(0); opacity: 1; } 100% { transform: translate(var(--cdx, 8px), var(--cdy, 18px)) rotate(360deg); opacity: 0; } }
  @keyframes pet_keyBlink { 0%, 70%, 100% { opacity: 0.4; } 35% { opacity: 1; } }
  @keyframes pet_blinkDouble { 0%, 50%, 55%, 60%, 100% { opacity: 0; } 52%, 58% { opacity: 1; } }
  /* Style-toggle chip in panel header — sits between title and × close. */
  .pet-style-toggle {
    cursor: pointer;
    font-family: var(--mono); font-size: 11.5px;
    color: var(--clay);
    border: 1px solid var(--clay);
    border-radius: 999px;
    padding: 3px 10px;
    margin-right: 4px;
    background: var(--paper);
    user-select: none;
    transition: background 120ms, color 120ms;
  }
  .pet-style-toggle:hover { background: var(--clay); color: #FFFFFF; }
  .pet-style-toggle .arrow { opacity: 0.6; margin-right: 4px; }

  /* ============================================================
     REVIEW PANEL — anchored comments list + @ chat input.
     Slides up from bottom-right when pet is clicked.
     ============================================================ */
  #pet-panel {
    position: fixed;
    bottom: 90px; right: 22px;
    width: 380px;
    max-height: calc(100vh - 130px);
    z-index: 199;
    background: var(--paper);
    border: 1.5px solid var(--g300);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0,0,0,0.12);
    display: none;
    flex-direction: column;
    font-family: var(--sans);
    overflow: hidden;
  }
  #pet-panel.show { display: flex; }
  .pet-header {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--g300);
    background: var(--g100);
  }
  .pet-header .pet-title {
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.10em;
    color: var(--slate);
    font-weight: 600;
    text-transform: uppercase;
    flex: 1;
  }
  .pet-header .pet-close {
    cursor: pointer;
    color: var(--g500);
    font-size: 18px;
    line-height: 1;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .pet-header .pet-close:hover { background: var(--g300); color: var(--slate); }
  .pet-cmts {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 8px 0;
    min-height: 80px;
    /* No max-height — pet-panel itself is capped at calc(100vh - 130px),
       so this list grows to fill the rest of the panel after header +
       chat input, scrolling inside its share. */
  }
  .pet-cmts .empty {
    color: var(--g500);
    font-size: 12.5px;
    text-align: center;
    padding: 24px 16px;
    font-style: italic;
  }
  .pet-cmt {
    padding: 10px 14px;
    border-bottom: 1px solid var(--g100);
    display: flex; gap: 10px;
    align-items: flex-start;
  }
  .pet-cmt:last-child { border-bottom: none; }
  .pet-cmt .num {
    flex-shrink: 0;
    width: 20px; height: 20px;
    border-radius: 50%;
    background: var(--clay); color: #FFFFFF;
    font-size: 10.5px; font-weight: 700;
    display: inline-flex; align-items: center; justify-content: center;
    margin-top: 1px;
  }
  .pet-cmt.orphan .num { background: var(--g500); }
  .pet-cmt .body { flex: 1; min-width: 0; }
  .pet-cmt .preview {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--g500);
    margin-bottom: 4px;
    white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
    cursor: pointer;
  }
  .pet-cmt .preview:hover { color: var(--clay); }
  .pet-cmt .text {
    font-size: 13px;
    color: var(--slate);
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .pet-cmt .del {
    flex-shrink: 0;
    color: var(--g500);
    cursor: pointer;
    font-size: 14px;
    padding: 0 4px;
  }
  .pet-cmt .del:hover { color: var(--clay); }
  /* Submitted comments dim so the user can tell at a glance which ones
     have been handed off to the agent (vs new/edited ones still pending
     in the next Submit-and-Copy). Editing or adding restores full opacity. */
  .pet-cmt.submitted { opacity: 0.45; }
  .pet-cmt.submitted .num { background: var(--g500); }
  .cmt-inline.submitted { opacity: 0.45; }
  .pet-chat {
    border-top: 1px solid var(--g300);
    padding: 10px 12px;
    display: flex; flex-direction: column; gap: 8px;
    background: var(--g100);
    position: relative;
  }
  .pet-chat textarea {
    width: 100%;
    min-height: 52px;
    max-height: 140px;
    resize: vertical;
    border: 1px solid var(--g300);
    border-radius: 6px;
    padding: 8px 10px;
    font-family: var(--sans);
    font-size: 13px;
    color: var(--slate);
    background: var(--paper);
    box-sizing: border-box;
  }
  .pet-chat textarea:focus { outline: none; border-color: var(--clay); }
  .pet-chat .actions {
    display: flex; gap: 8px; align-items: center;
  }
  .pet-chat .hint {
    flex: 1;
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--g500);
  }
  .pet-chat button {
    font-family: var(--sans);
    font-size: 12.5px;
    padding: 6px 14px;
    border-radius: 4px;
    border: 1px solid var(--g300);
    background: var(--paper);
    color: var(--g700);
    cursor: pointer;
  }
  .pet-chat button.primary {
    background: var(--clay); color: #FFFFFF; border-color: var(--clay);
    font-weight: 600;
  }
  .pet-chat button:hover { border-color: var(--clay); }
  .pet-chat button:disabled {
    opacity: 0.5; cursor: not-allowed;
  }
</style>
</head>
<body>
<nav class="sidebar">
<div class="eyebrow">
  <span class="eyebrow-title">__TITLE__</span>
  <span id="hidden-toggle" class="hidden-toggle"></span>
</div>
<div class="sb-filter-wrap">
  <input id="sidebar-filter" class="sb-filter" type="text" placeholder="search files…" autocomplete="off" spellcheck="false">
  <div class="sb-filter-tip" role="tooltip">
    Eg. Type <code>.md</code> to filter Markdown files<br>
    Press <kbd>/</kbd> anywhere to search
  </div>
</div>
<div id="filelist"></div>
</nav>
<div class="divider" id="divider"></div>
<main id="content"><p style="color:var(--g500)">Loading…</p></main>
<div id="find-bar" class="find-bar" hidden>
  <input id="find-input" type="text" placeholder="Find" spellcheck="false" autocomplete="off">
  <span id="find-count" class="find-count"></span>
  <button class="find-btn" data-act="prev" title="Previous match (Shift+Enter)" aria-label="Previous match">↑</button>
  <button class="find-btn" data-act="next" title="Next match (Enter)" aria-label="Next match">↓</button>
  <button class="find-btn" data-act="close" title="Close (Esc)" aria-label="Close">×</button>
</div>
<div id="taskbar"></div>
<div id="toast"></div>
<div id="ctxmenu">
  <div class="item" data-act="favorite">★ Add to Favorites</div>
  <div class="item" data-act="hide">Hide</div>
  <div class="sep"></div>
  <div class="item" data-act="copyPath">Copy Path</div>
  <div class="item" data-act="copyRelPath">Copy Relative Path</div>
  <div class="sep"></div>
  <div class="item" data-act="rename">Rename</div>
  <div class="item danger" data-act="delete">Delete</div>
</div>

<!-- Stroke-delete chip — pops next to a stroke clicked in draw mode. -->
<button id="stroke-chip" title="Delete this stroke">×</button>

<!-- Floating "drawN" label shown while the cursor hovers any stroke. -->
<div id="draw-label"></div>

<!-- Floating selection toolbar — appears above any non-empty
     selection inside main, Notion-style. -->
<div id="sel-toolbar">
  <button id="sel-comment-btn" title="Comment on selection">💬 Comment</button>
</div>

<!-- Anchored-comment popover (positioned dynamically next to a selection). -->
<div id="cmt-popover">
  <div class="anchor-preview"></div>
  <!-- Drawing-attach chips. Populated by populateDrawingChips() each time
       the popover opens — one chip per saved drawing on this file. Click
       toggles @drawN in the textarea text. Hidden when no drawings exist. -->
  <div class="draw-chips" style="display:none;"></div>
  <textarea placeholder="Leave a comment for the agent…" spellcheck="false"></textarea>
  <div class="row">
    <button data-act="delete" style="margin-right:auto; color:var(--g500);">Delete</button>
    <button data-act="cancel">Cancel</button>
    <button class="primary" data-act="save">Save (⌘↵)</button>
  </div>
</div>

<!-- Agent pet — drag anywhere; click toggles the review panel. Body is rendered by JS. -->
<div id="pet" title="Drag to move (mood changes on drop) · click to open review panel">
  <div class="pet-shadow"></div>
  <div class="pet-body" id="pet-body"></div>
  <div class="pet-overlay" id="pet-overlay"></div>
  <span class="pet-badge" id="pet-badge">0</span>
</div>

<!-- Review/chat panel (anchored to pet on open). -->
<div id="pet-panel">
  <div class="pet-header">
    <span class="pet-title">Review</span>
    <span class="pet-style-toggle" id="pet-style-toggle" title="Switch pet icon (pixel ↔ ascii)"><span class="arrow">⇄</span>icon</span>
    <span class="pet-close" id="pet-close" title="Close">×</span>
  </div>
  <div class="pet-cmts" id="pet-cmts">
    <div class="empty">Select any text in the md and submit comment.</div>
  </div>
  <div class="pet-chat">
    <textarea id="pet-input" placeholder="Optional message for the agent…" spellcheck="false"></textarea>
    <div class="actions">
      <span class="hint">⌘↵ to send</span>
      <button class="primary" id="pet-send">Submit and Copy</button>
    </div>
  </div>
</div>
<script>
const vscode = acquireVsCodeApi();
const FILES = __DATA__;
const list = document.getElementById('filelist');
const main = document.getElementById('content');
const toastEl = document.getElementById('toast');
// links[path] is an ARRAY of anchor elements (a path can appear in both the
// Favorites section and its regular tree location).
const links = {};
let toastTimer = 0;
// Mode flags — declared early so render() (called synchronously at script
// load via the start-file restore below) can safely read them via
// modeToolbarHtml() without hitting the let-TDZ. The actual mode plumbing
// (enter/exit/switch) lives further down.
let editMode = false;
let drawMode = false;
let reviewMode = false;

// Favorites / hidden state — persisted per-workspace via localStorage. These
// are pure webview state; no extension round-trip on toggle.
const favoritesKey = 'sidebarFavorites';
const hiddenKey = 'sidebarHidden';
const favorites = new Set(JSON.parse(localStorage.getItem(favoritesKey) || '[]'));
const hidden = new Set(JSON.parse(localStorage.getItem(hiddenKey) || '[]'));
let showHidden = false;
function saveFavorites() { localStorage.setItem(favoritesKey, JSON.stringify([...favorites])); }
function saveHidden() { localStorage.setItem(hiddenKey, JSON.stringify([...hidden])); }
// Hidden state is inherited from any ancestor folder, e.g. hiding "tasks/done"
// hides every file under it.
function isPathHidden(path) {
  if (hidden.has(path)) return true;
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    if (hidden.has(parts.slice(0, i).join('/'))) return true;
  }
  return false;
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2500);
}

// Toast with a clickable action chip. Use sparingly — meant for "Wrote
// .agent-repo-shell/review/<path>/<ts>/prompt.md [Open]" style follow-ups.
function toastWithAction(msg, label, onClick) {
  toastEl.textContent = '';
  toastEl.appendChild(document.createTextNode(msg + ' '));
  const a = document.createElement('a');
  a.href = '#';
  a.textContent = label;
  a.style.cssText = 'color:var(--clay); text-decoration:underline; margin-left:6px;';
  a.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
    toastEl.classList.remove('show');
  });
  toastEl.appendChild(a);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 5000);
}

const TASK_STATES = ['todo', 'doing', 'done'];
const taskbar = document.getElementById('taskbar');

function taskStateFromPath(p) {
  const m = p.match(/^tasks\/(todo|doing|done)\/(.+)$/);
  return m ? { state: m[1], slug: m[2] } : null;
}

// State glyphs lifted verbatim from references/notes/06 _ Glyph _ label.html
// (12x12 viewBox, currentColor stroke/fill so they pick up the button's text
// color). The 'done' check is hard-coded white to stay legible on the filled
// disc. Active gets a pulsing half-fill via the CSS rule on .seg-icon-half.
const SEG_ICONS = {
  todo:  '<svg class="seg-icon" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 1.6"/></svg>',
  doing: '<svg class="seg-icon" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path class="seg-icon-half" d="M 6 1.5 A 4.5 4.5 0 0 1 6 10.5 Z" fill="currentColor"/></svg>',
  done:  '<svg class="seg-icon" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5.2" fill="currentColor"/><path d="M3.6 6.2 L5.3 7.8 L8.4 4.4" stroke="#FFFFFF" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
};

function updateTaskbar(path) {
  const t = taskStateFromPath(path);
  if (!t) { taskbar.classList.remove('show'); taskbar.innerHTML = ''; return; }
  taskbar.dataset.path = path;
  taskbar.innerHTML = '<div class="seg">' + TASK_STATES.map(s =>
    '<button data-state="' + s + '" class="' + (s === t.state ? 'on ' + s : '') + '">' +
      SEG_ICONS[s] + '<span class="seg-label">' + s + '</span>' +
    '</button>'
  ).join('') + '</div>';
  taskbar.classList.add('show');
}

function render(path) {
  const f = FILES[path];
  if (!f || f.kind !== 'md') return;
  let header = '<div class="filename">' + path;
  if (f.reviewCount) {
    header += ' <a href="#" class="hist-badge" data-history-spec="' + path + '" title="View past reviews of this spec">📝 ' + f.reviewCount + ' review' + (f.reviewCount === 1 ? '' : 's') + '</a>';
  }
  // Mode toolbar — Edit / Review / Draw are mutually exclusive. Whichever
  // mode is active gets a pale-coral fill via the .active class. While in
  // edit / draw mode, the controls swap to action verbs (Save / Done).
  header += ' <span class="edit-controls">' + modeToolbarHtml() + '</span>';
  header += '</div>';
  // .md-body is the stable offset reference for rangeToSelector /
  // reviveAnnotation. The header above it can change between views (live
  // vs snapshot) without invalidating saved comment positions.
  main.innerHTML = header + '<div class="md-body">' + f.html + '</div>';
  // Wire the review-history badge.
  const hb = main.querySelector('a.hist-badge');
  if (hb) {
    hb.addEventListener('click', (ev) => {
      ev.preventDefault();
      vscode.postMessage({ type: 'requestReviewHistory', path: hb.dataset.historySpec });
    });
  }
  updateTaskbar(path);
  Object.values(links).forEach(arr => arr.forEach(a => a.classList.remove('active')));
  if (links[path]) {
    links[path].forEach(a => a.classList.add('active'));
    links[path][0].scrollIntoView({ block: 'nearest' });
  }
  window.scrollTo(0, 0);
  // Persist so the next refresh (e.g. after a file rename triggered by the
  // task-state chip, or any external file change) restores this view instead
  // of falling back to README.md.
  vscode.setState({ path });
}

// Task state-chip click: move the file to the matching subfolder.
taskbar.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg button');
  if (!btn) return;
  const from = taskbar.dataset.path;
  const t = from && taskStateFromPath(from);
  if (!t || t.state === btn.dataset.state) return;
  const to = 'tasks/' + btn.dataset.state + '/' + t.slug;
  // Immediate visual feedback — flip the chip's 'on' class right away so the
  // user doesn't wait for the (slow) fs-watcher-driven webview rebuild.
  const TASK_STATES_LOCAL = ['todo', 'doing', 'done'];
  taskbar.querySelectorAll('.seg button').forEach(b => {
    TASK_STATES_LOCAL.forEach(s => b.classList.remove('on', s));
    if (b.dataset.state === btn.dataset.state) {
      b.classList.add('on', btn.dataset.state);
    }
  });
  taskbar.dataset.path = to;
  // Pre-save the NEW path so the rename-triggered refresh restores this file
  // (rather than falling back to README.md).
  vscode.setState({ path: to });
  vscode.postMessage({ type: 'taskMove', from, to });
});

// Split FILES into sessions (synthetic entries with [sessions]/ prefix) and
// regular files. Sessions get their own group at the very top of the sidebar.
const SESSIONS_PREFIX = '[sessions]/';
const sessions = [];
const groups = {};
Object.keys(FILES).forEach(p => {
  if (p.startsWith(SESSIONS_PREFIX)) {
    sessions.push({ path: p, file: FILES[p] });
    return;
  }
  const slash = p.lastIndexOf('/');
  const dir = slash === -1 ? '' : p.substring(0, slash);
  const name = slash === -1 ? p : p.substring(slash + 1);
  (groups[dir] = groups[dir] || []).push({ name, path: p });
});

// Always-shown top-level dirs (placeholder sections even when empty so the
// project's structure is always visible, ready for new files).
const ALWAYS_SHOW = ['specs', 'tasks', 'skills', 'references', 'targets'];
ALWAYS_SHOW.forEach(d => {
  const hasContent = Object.keys(groups).some(k => k === d || k.startsWith(d + '/'));
  if (!hasContent) groups[d] = [];
});

// Collapsed-state persistence keyed by section name.
const collapsedKey = 'collapsedSections';
const collapsed = new Set(JSON.parse(localStorage.getItem(collapsedKey) || '[]'));
function makeSection(name, dataPath, dataKind) {
  const det = document.createElement('details');
  det.className = 'section';
  det.open = !collapsed.has(name);
  det.addEventListener('toggle', () => {
    if (det.open) collapsed.delete(name); else collapsed.add(name);
    localStorage.setItem(collapsedKey, JSON.stringify([...collapsed]));
  });
  const sum = document.createElement('summary');
  sum.className = 'dir-header top';
  if (dataPath) {
    sum.dataset.path = dataPath;
    sum.dataset.kind = dataKind || 'folder';
  }
  const chev = document.createElement('span');
  chev.className = 'chevron';
  chev.textContent = '▾';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = name;
  const count = document.createElement('span');
  count.className = 'count';
  sum.appendChild(chev);
  sum.appendChild(label);
  sum.appendChild(count);
  det.appendChild(sum);
  const body = document.createElement('div');
  body.className = 'section-body';
  det.appendChild(body);
  // Attach helpers as properties so callers can append to body / update count.
  det._body = body;
  det._count = count;
  return det;
}

// ---- Static computations done once (sidebar rebuilds reuse these) ----
if (sessions.length) {
  sessions.sort((a, b) => (b.file.mtime || 0) - (a.file.mtime || 0));
}
const TOP_ORDER = ['', '.claude', 'skills', 'tools', 'knowledge', 'references', 'specs', 'tasks', 'targets'];
const orderIndex = (dir) => {
  const top = dir.split('/')[0];
  const i = TOP_ORDER.indexOf(top);
  return i === -1 ? TOP_ORDER.length : i;
};
const sortedDirs = Object.keys(groups).sort((a, b) => {
  const ai = orderIndex(a), bi = orderIndex(b);
  if (ai !== bi) return ai - bi;
  return a.localeCompare(b);
});
// VSCode-style: folders sort before files; within each group, alphabetical.
sortedDirs.forEach(dir => groups[dir].sort((a, b) => {
  const fa = FILES[a.path] && FILES[a.path].kind === 'folder' ? 0 : 1;
  const fb = FILES[b.path] && FILES[b.path].kind === 'folder' ? 0 : 1;
  if (fa !== fb) return fa - fb;
  return a.name.localeCompare(b.name);
}));

// Inline SVG star — replaces the bare ★ unicode character (which renders as
// a flat emoji on some platforms) with a clean rounded-outline icon.
const STAR_PATH = 'M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z';
function starIcon(variant) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'star-icon' + (variant ? ' ' + variant : ''));
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', STAR_PATH);
  svg.appendChild(path);
  return svg;
}

// Build a session row anchor.
function makeSessionAnchor(s) {
  const a = document.createElement('a');
  const text = s.file.label || s.path.replace(SESSIONS_PREFIX, '');
  const nameSpan = document.createElement('span');
  nameSpan.className = 'name';
  nameSpan.textContent = text;
  a.appendChild(nameSpan);
  a.title = s.path;
  a.dataset.path = s.path;
  a.dataset.kind = 'session';
  if (favorites.has(s.path)) a.classList.add('favorited');
  if (showHidden && isPathHidden(s.path)) a.classList.add('is-hidden');
  a.onclick = (e) => { e.preventDefault(); render(s.path); };
  (links[s.path] = links[s.path] || []).push(a);
  return a;
}

// Build a per-file anchor element. opts.inFavorites switches off the star
// (whole section is the indicator) and appends a dim parent-dir hint so two
// files with the same name can be told apart.
function makeAnchor(f, opts) {
  opts = opts || {};
  const file = FILES[f.path];
  // Lazy folders use a different DOM shape (expandable <details>). Branch
  // out early so the rest of the function only deals with file anchors.
  if (file && file.kind === 'folder' && file.lazy) {
    return makeLazyFolder(f);
  }
  const a = document.createElement('a');
  const nameSpan = document.createElement('span');
  nameSpan.className = 'name';
  nameSpan.textContent = f.name;
  if (opts.inFavorites) {
    const slash = f.path.lastIndexOf('/');
    if (slash !== -1) {
      const dirSpan = document.createElement('span');
      dirSpan.className = 'fav-dir';
      dirSpan.textContent = ' · ' + f.path.substring(0, slash);
      nameSpan.appendChild(dirSpan);
    }
  }
  if (favorites.has(f.path) && !opts.inFavorites) {
    a.classList.add('favorited');
    a.appendChild(starIcon('filled'));
  }
  a.appendChild(nameSpan);
  a.title = f.path;
  a.dataset.path = f.path;
  a.dataset.kind = 'file';
  if (showHidden && isPathHidden(f.path)) a.classList.add('is-hidden');
  if (file && file.kind === 'md') {
    a.onclick = (e) => { e.preventDefault(); render(f.path); };
  } else if (file) {
    a.classList.add('external');
    a.onclick = (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'openFile', path: file.abs });
      requestOverview(f.path, file.abs, f.name);
    };
  }
  (links[f.path] = links[f.path] || []).push(a);
  return a;
}

// Build a collapsible sub-section for a nested folder. Smaller styling than
// the top-level section, but with the same toggle behaviour.
function makeSubSection(dir, label) {
  const det = document.createElement('details');
  det.className = 'sub-section';
  det.open = !collapsed.has(dir);
  det.addEventListener('toggle', () => {
    if (det.open) collapsed.delete(dir); else collapsed.add(dir);
    localStorage.setItem(collapsedKey, JSON.stringify([...collapsed]));
  });
  const sum = document.createElement('summary');
  sum.className = 'dir-header nested';
  sum.dataset.path = dir;
  sum.dataset.kind = 'folder';
  const chev = document.createElement('span');
  chev.className = 'chevron';
  chev.textContent = '▾';
  sum.appendChild(chev);
  sum.appendChild(document.createTextNode(label));
  det.appendChild(sum);
  return det;
}

// Build a lazy folder entry — appears collapsed by default; on first
// expand the webview asks the extension for that folder's contents.
function makeLazyFolder(f) {
  const det = document.createElement('details');
  det.className = 'sub-section lazy-folder';
  det.open = !collapsed.has(f.path);
  det.dataset.path = f.path;
  det.dataset.kind = 'folder';

  const sum = document.createElement('summary');
  sum.className = 'dir-header nested';
  sum.dataset.path = f.path;
  sum.dataset.kind = 'folder';
  const chev = document.createElement('span');
  chev.className = 'chevron';
  // Inline SVG chevron — codicon-style chevron-right (1.5px stroke), uses
  // currentColor so the icon picks up the theme's icon foreground. CSS
  // rotates it 90deg when the folder is open.
  chev.innerHTML = '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">' +
    '<path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
  sum.appendChild(chev);
  sum.appendChild(document.createTextNode(f.name + '/'));
  det.appendChild(sum);

  // The body is filled in lazily on first expand by the folderContents
  // message handler. We still create the container so re-rendering
  // (e.g. after a refresh) can find it.
  const body = document.createElement('div');
  body.className = 'lazy-body';
  det.appendChild(body);

  const requestLoad = () => {
    if (det.dataset.loadState) return;       // already loaded or loading
    det.dataset.loadState = 'loading';
    body.innerHTML = '<span class="lazy-loading">loading…</span>';
    vscode.postMessage({ type: 'requestFolderContents', path: f.path });
  };

  det.addEventListener('toggle', () => {
    if (det.open) {
      collapsed.delete(f.path);
      requestLoad();
    } else {
      collapsed.add(f.path);
    }
    localStorage.setItem(collapsedKey, JSON.stringify([...collapsed]));
  });

  // If the folder was already open per persisted state, eagerly kick off
  // the load so the user doesn't see an empty body.
  if (det.open) requestLoad();
  return det;
}

function updateHiddenToggle() {
  const el = document.getElementById('hidden-toggle');
  if (!el) return;
  if (hidden.size === 0) { el.textContent = ''; return; }
  el.textContent = (showHidden ? 'hide ' : 'show ') + hidden.size + ' hidden';
}

// As-you-type sidebar filter. Hides non-matching anchors via a class, and
// hides any <details> section that ends up with no visible children. Called
// from buildSidebar() so a sidebar rebuild (favorite/hide toggle) preserves
// the active filter.
const FILTER_HIDE_CLS = 'filter-hide';
function applyFilter(rawQuery) {
  const query = (rawQuery || '').trim().toLowerCase();
  const anchors = list.querySelectorAll('a');
  if (!query) {
    anchors.forEach(a => a.classList.remove(FILTER_HIDE_CLS));
    list.querySelectorAll('details').forEach(d => d.classList.remove(FILTER_HIDE_CLS));
    return;
  }
  anchors.forEach(a => {
    const haystack = ((a.title || '') + ' ' + a.textContent).toLowerCase();
    a.classList.toggle(FILTER_HIDE_CLS, !haystack.includes(query));
  });
  list.querySelectorAll('details').forEach(d => {
    const anyVisible = [...d.querySelectorAll('a')]
      .some(a => !a.classList.contains(FILTER_HIDE_CLS));
    d.classList.toggle(FILTER_HIDE_CLS, !anyVisible);
    // Auto-open matching sections so results are immediately visible without
    // an extra click. The user can manually re-collapse after.
    if (anyVisible) d.open = true;
  });
}

function restoreActive() {
  const saved = (vscode.getState() || {}).path;
  if (saved && links[saved]) {
    links[saved].forEach(a => a.classList.add('active'));
  }
}

// (Re)build the entire sidebar tree from current state. Cheap enough — we
// recompute on every favorite/hide toggle so the UI matches the source of
// truth (localStorage) without trying to surgically mutate the DOM.
function buildSidebar() {
  const sidebarEl = document.querySelector('nav.sidebar');
  const scrollTop = sidebarEl ? sidebarEl.scrollTop : 0;
  list.innerHTML = '';
  for (const k of Object.keys(links)) delete links[k];

  updateHiddenToggle();

  // FAVORITES section (top). Stale entries (file deleted) are dropped.
  // Synthetic data-path "[favorites]" lets the user right-click the title
  // and Hide the whole section. When hidden, the section drops out entirely
  // unless showHidden is on (then it appears dimmed for unhide).
  const validFavorites = [...favorites].filter(p => FILES[p]).sort();
  const favHidden = hidden.has('[favorites]');
  if (validFavorites.length && (showHidden || !favHidden)) {
    const det = makeSection('favorites', '[favorites]', 'section');
    if (favHidden) det.classList.add('is-hidden');
    // Prepend the star icon to the section's label so the title reads
    // "<star> favorites" — visually consistent with row-level favorites.
    const lbl = det.querySelector('.label');
    if (lbl) lbl.insertBefore(starIcon('filled big'), lbl.firstChild);
    validFavorites.forEach(p => {
      if (p.startsWith(SESSIONS_PREFIX)) {
        const s = sessions.find(x => x.path === p);
        if (s) det._body.appendChild(makeSessionAnchor(s));
        return;
      }
      const slash = p.lastIndexOf('/');
      const name = slash === -1 ? p : p.substring(slash + 1);
      det._body.appendChild(makeAnchor({ name, path: p }, { inFavorites: true }));
    });
    det._count.textContent = String(validFavorites.length);
    list.appendChild(det);
  }

  // HISTORY section — uses the real folder path "history" so the right-click
  // menu matches every other top-level folder (Rename / Delete / Copy Path
  // all act on the actual history/ directory).
  const historyHidden = isPathHidden('history');
  if (sessions.length && (showHidden || !historyHidden)) {
    const visible = sessions.filter(s => showHidden || !isPathHidden(s.path));
    if (visible.length) {
      const det = makeSection('history', 'history', 'folder');
      if (historyHidden) det.classList.add('is-hidden');
      visible.forEach(s => det._body.appendChild(makeSessionAnchor(s)));
      det._count.textContent = String(visible.length);
      list.appendChild(det);
    }
  }

  // Regular folder groups: top-level dir = one <details> section; each
  // intermediate folder level becomes a nested <details> sub-section, so a
  // path like references/repos/codetour shows as 3 nested levels (not a
  // single flat row labeled "repos/codetour/").
  // The root "/" section uses path "." so its right-click menu matches others.
  const sectionByTop = {};
  const subByPath = {};
  const countsByTop = {};
  for (const dir of sortedDirs) {
    const isRoot = dir === '';
    const dirHideKey = isRoot ? '.' : dir;
    if (!showHidden && isPathHidden(dirHideKey)) continue;
    const visibleFiles = showHidden
      ? groups[dir]
      : groups[dir].filter(f => !isPathHidden(f.path));
    // Skip a dir that became empty due to hidden filtering, BUT keep dirs
    // that were always empty (ALWAYS_SHOW placeholder sections).
    if (visibleFiles.length === 0 && groups[dir].length > 0) continue;

    const parts = isRoot ? [] : dir.split('/');
    const topName = isRoot ? '/' : parts[0] + '/';

    let container = sectionByTop[topName];
    if (!container) {
      const topPath = isRoot ? '.' : parts[0];
      container = makeSection(topName, topPath, 'folder');
      if (showHidden && isPathHidden(topPath)) container.classList.add('is-hidden');
      list.appendChild(container);
      sectionByTop[topName] = container;
      countsByTop[topName] = 0;
    }

    // Walk down each intermediate path component, creating sub-sections that
    // don't exist yet, reusing the ones that do.
    let target = container._body;
    let pathSoFar = parts[0] || '';
    for (let i = 1; i < parts.length; i++) {
      pathSoFar += '/' + parts[i];
      let sub = subByPath[pathSoFar];
      if (!sub) {
        sub = makeSubSection(pathSoFar, parts[i] + '/');
        if (showHidden && isPathHidden(pathSoFar)) sub.classList.add('is-hidden');
        target.appendChild(sub);
        subByPath[pathSoFar] = sub;
      }
      target = sub;
    }

    visibleFiles.forEach(f => target.appendChild(makeAnchor(f)));
    countsByTop[topName] += visibleFiles.length;
  }
  Object.keys(countsByTop).forEach(topName => {
    sectionByTop[topName]._count.textContent = String(countsByTop[topName]);
  });

  const filterEl = document.getElementById('sidebar-filter');
  if (filterEl && filterEl.value) applyFilter(filterEl.value);

  if (sidebarEl) sidebarEl.scrollTop = scrollTop;
}

buildSidebar();

document.getElementById('hidden-toggle').addEventListener('click', () => {
  if (hidden.size === 0) return;
  showHidden = !showHidden;
  buildSidebar();
  restoreActive();
});

// Sidebar filter wiring. '/' focuses the input from anywhere; Escape clears
// and blurs it. Input events drive the visible-row filtering live.
const filterInput = document.getElementById('sidebar-filter');
filterInput.addEventListener('input', () => applyFilter(filterInput.value));
filterInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    filterInput.value = '';
    applyFilter('');
    filterInput.blur();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== '/') return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  e.preventDefault();
  filterInput.focus();
  filterInput.select();
});

// Initial render: restore last-viewed file from webview state if still valid.
// For md files, render the cached HTML directly. For code files, ask the
// extension for an overview (deferred so the message handler exists first).
const mdFiles = Object.keys(FILES).filter(p => FILES[p].kind === 'md');
const saved = (vscode.getState() || {}).path;
const savedFile = saved && FILES[saved];

function pickStart() {
  if (savedFile && savedFile.kind === 'md') return saved;
  if (savedFile && savedFile.kind === 'code' && savedFile.abs) {
    // Defer so the message listener registered below is in place first.
    setTimeout(() => {
      requestOverview(saved, savedFile.abs, saved.split('/').pop());
    }, 0);
    return null;
  }
  // Task-move recovery: if the saved path is tasks/<state>/<slug> but that
  // exact file isn't in FILES yet (race: a refresh fired before the fs.rename
  // settled, OR another file change kicked refresh early), check the other
  // state folders for the same slug — it's still in one of them.
  const m = saved && saved.match(/^tasks\/(todo|doing|done)\/(.+)$/);
  if (m) {
    const slug = m[2];
    for (const state of ['doing', 'done', 'todo']) {
      const candidate = 'tasks/' + state + '/' + slug;
      if (FILES[candidate] && FILES[candidate].kind === 'md') {
        // Update the saved state so next click resolves correctly.
        vscode.setState({ path: candidate });
        return candidate;
      }
    }
  }
  return mdFiles.includes('README.md') ? 'README.md' : mdFiles[0];
}

// NOTE: defer the initial render to the bottom of the script (after the
// render wrappers that set currentPath / load comments / init Recogito are
// installed). Triggering render() here would call the un-wrapped version,
// leaving currentPath null even though the page looks rendered — that's
// the "Open a file first" toast bug.
const start = pickStart();

// Context menu: right-click on any sidebar item with data-path opens our
// custom menu. Items send a message to the extension which dispatches to
// VSCode commands or workspace.fs operations.
const ctxmenu = document.getElementById('ctxmenu');
let ctxTarget = null;  // { path, kind }
document.querySelector('nav.sidebar').addEventListener('contextmenu', (e) => {
  const el = e.target.closest('[data-path]');
  if (!el) return;
  e.preventDefault();
  ctxTarget = { path: el.dataset.path, kind: el.dataset.kind };
  // Adapt the favorite/hide labels to current state, so a single menu item
  // toggles in both directions.
  const favItem = ctxmenu.querySelector('[data-act="favorite"]');
  favItem.textContent = favorites.has(ctxTarget.path)
    ? '☆ Remove from Favorites' : '★ Add to Favorites';
  const hideItem = ctxmenu.querySelector('[data-act="hide"]');
  hideItem.textContent = hidden.has(ctxTarget.path) ? 'Unhide' : 'Hide';
  // Synthetic section titles (e.g. favorites) only support Hide — they aren't
  // real filesystem entries, so Rename/Delete/Copy-Path would fail or be
  // meaningless. Collapse the menu to just the Hide item.
  const isSection = ctxTarget.kind === 'section';
  // Workspace root: full menu, but destructive ops are greyed out — deleting
  // or renaming "." would act on the whole workspace.
  const isRoot = ctxTarget.path === '.';
  ctxmenu.querySelectorAll('.item, .sep').forEach(node => {
    node.classList.remove('disabled');
    if (isSection) {
      node.style.display = (node.dataset.act === 'hide') ? '' : 'none';
    } else {
      node.style.display = '';
    }
  });
  if (isRoot) {
    ctxmenu.querySelectorAll('[data-act="rename"], [data-act="delete"]')
      .forEach(node => node.classList.add('disabled'));
  }
  // Position within the viewport; nudge left/up if it would overflow.
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = 200, h = isSection ? 40 : 180;
  const x = Math.min(e.clientX, vw - w - 8);
  const y = Math.min(e.clientY, vh - h - 8);
  ctxmenu.style.left = x + 'px';
  ctxmenu.style.top = y + 'px';
  ctxmenu.classList.add('show');
});
document.addEventListener('click', (e) => {
  if (!ctxmenu.classList.contains('show')) return;
  if (e.target.closest('#ctxmenu')) return;  // click inside menu handled below
  ctxmenu.classList.remove('show');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') ctxmenu.classList.remove('show');
});
ctxmenu.addEventListener('click', (e) => {
  const item = e.target.closest('.item');
  if (!item || !ctxTarget) return;
  if (item.classList.contains('disabled')) {
    ctxmenu.classList.remove('show');
    return;
  }
  const act = item.dataset.act;
  if (act === 'favorite') {
    if (favorites.has(ctxTarget.path)) favorites.delete(ctxTarget.path);
    else favorites.add(ctxTarget.path);
    saveFavorites();
    buildSidebar();
    restoreActive();
  } else if (act === 'hide') {
    if (hidden.has(ctxTarget.path)) hidden.delete(ctxTarget.path);
    else hidden.add(ctxTarget.path);
    saveHidden();
    buildSidebar();
    restoreActive();
  } else {
    vscode.postMessage({ type: 'ctx', action: act, path: ctxTarget.path, kind: ctxTarget.kind });
  }
  ctxmenu.classList.remove('show');
});

// Sidebar resize via drag on the divider. Width persists in localStorage.
const sidebar = document.querySelector('nav.sidebar');
const divider = document.getElementById('divider');
const savedWidth = parseInt(localStorage.getItem('sidebarWidth') || '', 10);
if (savedWidth >= 80) sidebar.style.width = savedWidth + 'px';
let dragging = false;
divider.addEventListener('mousedown', (e) => {
  dragging = true;
  document.body.classList.add('dragging');
  e.preventDefault();
});
document.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  // Allow the sidebar to grow up to (panel width − 80px) so the main pane
  // always keeps a sliver. Min 80px so the sidebar can shrink to almost nothing.
  const max = Math.max(80, window.innerWidth - 80);
  const w = Math.max(80, Math.min(max, e.clientX));
  sidebar.style.width = w + 'px';
});
document.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('dragging');
  localStorage.setItem('sidebarWidth', parseInt(sidebar.style.width));
});

// =============================================================================
// File overview rendering
//   - On code-file click we postMessage('openFile') AND ('requestOverview').
//   - The extension fetches LSP data and posts back 'overviewData'.
//   - We render it inline in <main>, matching the mockup style.
// =============================================================================

// Single mermaid init for the lifetime of the webview.
if (window.mermaid) {
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: 'base',
    themeVariables: {
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: '15px',
      primaryColor: '#FFFFFF',
      primaryTextColor: '#3D3D3A',
      primaryBorderColor: '#D1CFC5',
      lineColor: '#C8BFB1',
      secondaryColor: '#F0EEE6',
      tertiaryColor: '#FFFFFF',
    },
    flowchart: { curve: 'basis', nodeSpacing: 70, rankSpacing: 90, htmlLabels: true, padding: 11 },
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function escForMermaidLabel(s) {
  // Quote inside ["..."] needs to be HTML-escaped; backslashes and quotes
  // would break Mermaid's parser. Keep it conservative.
  return String(s).replace(/"/g, '&quot;').replace(/\\/g, '\\\\');
}

function sanitizeId(name) {
  // Mermaid node IDs must be alphanumeric-ish; convert underscores fine but
  // strip anything else and avoid a leading underscore (parser quirk).
  const safe = String(name).replace(/[^A-Za-z0-9_]/g, '_');
  return 'fn_' + safe;
}

// Backtick character — declared via fromCharCode so the regex below doesn't
// terminate this whole HTML template (the template uses String.raw\`...\`).
const __BT = String.fromCharCode(96);
const __CODE_RE = new RegExp(__BT + '([^' + __BT + ']+)' + __BT, 'g');
function inlineMd(escaped) {
  // Operates on an already HTML-escaped string. Backticks/asterisks are not
  // affected by escape, so simple regex passes are safe here.
  return escaped
    .replace(__CODE_RE, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
}

function paraToHtml(text) {
  if (!text) return '';
  // Lightweight markdown rendering: blank-line paragraph splits, inline
  // monospace/em/strong. No list or heading support; the full marked()
  // pipeline isn't available inside this webview.
  const paras = String(text).split(/\n\s*\n/);
  return paras.map(p => '<p>' + inlineMd(esc(p.trim())).replace(/\n/g, '<br>') + '</p>').join('');
}

function formatRelativeTime(date) {
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60)   return Math.max(1, Math.round(diff)) + 's ago';
  if (diff < 3600) return Math.round(diff / 60) + 'm ago';
  if (diff < 86400)return Math.round(diff / 3600) + 'h ago';
  return Math.round(diff / 86400) + 'd ago';
}

function showOverviewLoading(relPath, label) {
  main.classList.add('ov');
  main.innerHTML =
    '<div class="hd-line">' +
      '<h1>' + esc(label || relPath) + '</h1>' +
      '<span class="hd-file">' + esc(relPath) + '</span>' +
    '</div>' +
    '<p class="ov-empty">reading overview…</p>';
  window.scrollTo(0, 0);
}

// "Not initialized" view — shown when .agent-repo-shell/code-render/<rel>.json
// doesn't exist. The Sync button is the only action; it kicks off the LSP
// analysis on the extension side. Button styled with the seg "doing" glyph
// + clay-hued pill to read as a call-to-action.
function renderOverviewNotInit(relPath, absPath, label) {
  main.classList.add('ov');
  main.innerHTML =
    '<div class="hd-line">' +
      '<h1>' + esc(label || relPath) + '</h1>' +
      '<span class="hd-file">' + esc(relPath) + '</span>' +
      '<button class="sync-btn primary" data-path="' + esc(absPath) + '">' +
        SEG_ICONS.doing + '<span>Sync now</span>' +
      '</button>' +
    '</div>' +
    '<p class="ov-empty">' +
      'This file hasn&rsquo;t been rendered yet. Click <b>Sync now</b> to ' +
      'analyse it with the language server and cache the result in ' +
      '<code>.agent-repo-shell/code-render/' + esc(relPath) + '.json</code>.' +
    '</p>';
  main.querySelector('.sync-btn').addEventListener('click', (e) => {
    triggerSync(absPath, e.currentTarget);
  });
  window.scrollTo(0, 0);
}

function triggerSync(absPath, btnEl) {
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.dataset.startedAt = String(Date.now());
    // Swap to syncing visual: doing-glyph + breathing pill animation.
    // Both .syncing class and the doing icon are needed so the
    // .seg-icon-half rule animates.
    btnEl.classList.remove('primary', 'done', 'failed');
    btnEl.classList.add('syncing');
    btnEl.innerHTML = SEG_ICONS.doing + '<span>syncing… 0s</span>';
    const labelSpan = btnEl.querySelector('span');
    const tick = () => {
      if (!btnEl.classList.contains('syncing')) return;
      const elapsed = Math.round((Date.now() - parseInt(btnEl.dataset.startedAt, 10)) / 1000);
      labelSpan.textContent = 'syncing… ' + elapsed + 's';
      btnEl.dataset.tickHandle = String(setTimeout(tick, 1000));
    };
    tick();
  }
  pendingOverviewPath = absPath;
  vscode.postMessage({ type: 'requestSync', path: absPath });
}

// Show the overview for a code file. All sidecars are preloaded into FILES
// at build time (see collectFiles), so this is purely synchronous — no
// extension round-trip, no loading placeholder. The Sync button (slow path)
// is the only thing that talks to the extension.
function requestOverview(relPath, absPath, label) {
  Object.values(links).forEach(arr => arr.forEach(a => a.classList.remove('active')));
  if (links[relPath]) {
    links[relPath].forEach(a => a.classList.add('active'));
    links[relPath][0].scrollIntoView({ block: 'nearest' });
  }
  taskbar.classList.remove('show');
  vscode.setState({ path: relPath });
  pendingOverviewPath = absPath;
  const file = FILES[relPath];
  const overview = file && file.overview;
  if (overview) {
    // Patch the absolute path to the local machine's filesystem before render.
    overview.file = absPath;
    overview.path = relPath;
    renderOverview(absPath, overview);
  } else {
    renderOverviewNotInit(relPath, absPath, label);
  }
}

let pendingOverviewPath = null;
let lastOverview = null;

function renderOverview(absPath, overview) {
  // Bail if a newer request came in after this one was sent.
  if (pendingOverviewPath && pendingOverviewPath !== absPath) return;
  lastOverview = overview;
  main.classList.add('ov');

  const fns = overview.functions || [];
  const edges = overview.edges || [];
  const meta = [];
  if (overview.language) meta.push(['lang', overview.language]);
  if (overview.lineCount) meta.push(['loc', overview.lineCount]);
  meta.push(['functions', fns.length]);
  meta.push(['internal calls', edges.length]);
  if (overview.usedBy && overview.usedBy.length) meta.push(['used by', overview.usedBy.length]);
  if (overview.todos && overview.todos.length) meta.push(['todos', overview.todos.length]);

  const metaHtml = meta.map(([k, v]) =>
    '<span class="m-kv">' + esc(k) + ' <b>' + esc(v) + '</b></span>'
  ).join('');

  // Sync button visual state mirrors task-chip semantics:
  //   - already synced → done-hue pill + check glyph
  //   - never synced (shouldn't happen here since this branch has data, but
  //     defensive) → primary clay pill + doing glyph
  const syncedAgo = overview.syncedAt
    ? formatRelativeTime(new Date(overview.syncedAt)) : null;
  const syncBtnCls = syncedAgo ? 'sync-btn done' : 'sync-btn primary';
  const syncIcon   = syncedAgo ? SEG_ICONS.done   : SEG_ICONS.doing;
  const syncText   = syncedAgo ? 'Synced ' + esc(syncedAgo) : 'Sync';

  let html = '';
  html += '<div class="hd-line">';
  html += '<h1>' + esc(overview.title || overview.path) + '</h1>';
  html += '<span class="hd-file">' + esc(overview.path) + '</span>';
  html += '<button class="' + syncBtnCls + '" data-path="' + esc(absPath) +
    '" title="Re-run LSP analysis and overwrite .agent-repo-shell/code-render/' + esc(overview.path) + '.json">' +
    syncIcon + '<span>' + syncText + '</span></button>';
  html += '</div>';
  html += '<div class="meta-strip">' + metaHtml + '</div>';

  // 01 Summary — only if there's a body.
  if (overview.summary) {
    html += '<div class="sec-hd"><span class="sec-num">01</span> Summary</div>';
    html += paraToHtml(overview.summary);
  }

  // 02 Call structure — diagram only if there are functions (and edges or
  // standalone nodes). Skip if no functions at all (json/yaml/md/etc).
  let secNum = overview.summary ? 2 : 1;
  if (fns.length) {
    html += '<div class="sec-hd">' +
      '<span class="sec-num">' + String(secNum).padStart(2, '0') + '</span> Call structure' +
      '<span class="sec-aside">hover for summary &middot; click to jump to definition &rarr;</span>' +
      '</div>';
    secNum++;

    html += '<div class="mermaid-wrap"><div class="mermaid" id="arch">' + buildMermaidSource(fns, edges) + '</div></div>';
  }

  // 03 Functions
  if (fns.length) {
    const exportedCount = fns.filter(f => !f.name.startsWith('_')).length;
    html += '<div class="sec-hd">' +
      '<span class="sec-num">' + String(secNum).padStart(2, '0') + '</span> Functions' +
      '<span class="sec-aside">' + fns.length + ' defined &middot; ' + exportedCount + ' exported</span>' +
      '</div>';
    secNum++;
    html += '<div class="fn-list">';
    for (const f of fns) {
      html += renderFunctionAccordion(f, fns);
    }
    html += '</div>';
  }

  // 04 Used by
  if (overview.usedBy && overview.usedBy.length) {
    html += '<div class="sec-hd"><span class="sec-num">' + String(secNum).padStart(2, '0') + '</span> Used by</div>';
    secNum++;
    html += '<ul class="used-list">';
    for (const u of overview.usedBy) {
      html += '<li data-path="' + esc(u.absPath) + '" data-line="' + esc(u.line) + '">' +
        '<span class="dot"></span>' +
        '<div>' +
          '<div><span class="file">' + esc(u.file) + '</span><span class="ln">:' + esc(u.line + 1) + '</span></div>' +
          '<div class="desc">' + esc(u.desc) + '</div>' +
        '</div>' +
        '<span class="arrow">&rarr;</span>' +
        '</li>';
    }
    html += '</ul>';
  }

  // 05 TODO / FIXME
  if (overview.todos && overview.todos.length) {
    html += '<div class="sec-hd"><span class="sec-num">' + String(secNum).padStart(2, '0') + '</span> Todo / fixme' +
      '<span class="sec-aside">' + overview.todos.length + ' pending</span></div>';
    secNum++;
    html += '<ul class="todo-list">';
    for (const t of overview.todos) {
      const cls = t.tag.toLowerCase();
      html += '<li data-line="' + esc(t.line) + '">' +
        '<span class="tag ' + esc(cls) + '">' + esc(t.tag) + '</span>' +
        '<div>' +
          '<div class="todo-text">' + esc(t.text) + '</div>' +
          '<div class="todo-where">' + (t.where ? esc(t.where) + ' ' : '') +
            '<span class="ln">:' + esc(t.line + 1) + '</span></div>' +
        '</div>' +
        '</li>';
    }
    html += '</ul>';
  }

  // If we ended up with nothing beyond the header, show a helpful note.
  if (!overview.summary && !fns.length && !overview.usedBy?.length && !overview.todos?.length) {
    html += '<p class="ov-empty">No overview available — the language server didn\'t return symbols or hover content for this file. ' +
      'Add a top-of-file docstring or open it directly in the editor for full content.</p>';
  }

  main.innerHTML = html;
  bindOverviewHandlers(overview);
  window.scrollTo(0, 0);
}

function buildMermaidSource(fns, edges) {
  let src = 'flowchart TD\n';
  // Define all nodes (functions with no edges still appear).
  for (const f of fns) {
    const id = sanitizeId(f.name);
    src += '  ' + id + '["' + escForMermaidLabel(f.name) + '"]:::' + (f.tier || 'mid') + '\n';
  }
  for (const [from, to] of edges) {
    src += '  ' + sanitizeId(from) + ' --> ' + sanitizeId(to) + '\n';
  }
  src += '  classDef entry  stroke:#CC6B4F,stroke-width:1.2px,fill:#F6E6DC,color:#CC6B4F,font-weight:600\n';
  src += '  classDef mid    stroke:#E2D9CB,stroke-width:1px,fill:#FBF8F2,color:#2A2520,font-weight:500\n';
  src += '  classDef helper stroke:#E2D9CB,stroke-width:1px,fill:#FBF8F2,color:#5C544C,font-weight:400\n';
  return src;
}

function renderFunctionAccordion(f, fns) {
  const linesByName = Object.fromEntries(fns.map(x => [x.name, x.line]));
  const calls = f.calls || [];
  const calledBy = f.calledBy || [];
  const treeRow = (name, isLast) => {
    const branch = isLast ? '└──' : '├──';
    const ln = linesByName[name];
    return '<li><span class="branch">' + branch + '</span>' +
      '<span class="nm callable" data-target="' + esc(name) + '">' + esc(name) + '</span>' +
      (ln != null ? '<span class="ln">:' + esc(ln + 1) + '</span>' : '') +
      '</li>';
  };
  const callsHtml = calls.length
    ? calls.map((n, i) => treeRow(n, i === calls.length - 1)).join('')
    : '<li class="empty">(none)</li>';
  const calledByHtml = calledBy.length
    ? calledBy.map((n, i) => treeRow(n, i === calledBy.length - 1)).join('')
    : '<li class="empty">(none)</li>';

  return '<details class="fn" data-fn="' + esc(f.name) + '">' +
    '<summary>' +
      '<span class="fn-name">' + esc(f.name) + '</span>' +
      '<span class="fn-line">line ' + esc((f.line || 0) + 1) + '</span>' +
      '<span class="fn-summary">' + esc(f.summary || '(no description)') + '</span>' +
    '</summary>' +
    '<div class="fn-detail">' +
      (f.sig ? '<span class="sig">' + esc(f.sig) + '</span>' : '') +
      paraToHtml(f.doc || '') +
      '<div class="fn-rels">' +
        '<span class="fn-rel-label">calls &rarr;</span>' +
        '<ul class="fn-tree">' + callsHtml + '</ul>' +
        '<span class="fn-rel-label">called by &larr;</span>' +
        '<ul class="fn-tree">' + calledByHtml + '</ul>' +
      '</div>' +
      '<a class="fn-jump" data-line="' + esc(f.line || 0) + '">' +
        '&rarr; jump to definition (line ' + esc((f.line || 0) + 1) + ')' +
      '</a>' +
    '</div>' +
  '</details>';
}

function bindOverviewHandlers(overview) {
  const absPath = overview.file;
  const fnByName = Object.fromEntries((overview.functions || []).map(f => [f.name, f]));

  // Sync button in the header — re-runs LSP analysis on the extension side.
  main.querySelector('.sync-btn')?.addEventListener('click', (e) => {
    triggerSync(absPath, e.currentTarget);
  });

  // Mermaid: render + wire click/hover.
  const mermaidEl = main.querySelector('.mermaid');
  if (mermaidEl && window.mermaid) {
    // Generate a unique id so mermaid doesn't reuse stale state.
    mermaidEl.removeAttribute('data-processed');
    const SVG_NS = 'http://www.w3.org/2000/svg';
    window.mermaid.run({ querySelector: '.mermaid' }).then(() => {
      const wrap = main.querySelector('.mermaid-wrap');
      if (!wrap) return;
      wrap.querySelectorAll('g.node').forEach(g => {
        const label = (g.textContent || '').trim();
        const f = fnByName[label];
        if (!f) return;
        g.style.cursor = 'pointer';
        const titleEl = document.createElementNS(SVG_NS, 'title');
        titleEl.textContent = f.summary || f.name;
        g.insertBefore(titleEl, g.firstChild);
        g.addEventListener('click', () => {
          vscode.postMessage({ type: 'openLine', path: absPath, line: f.line });
        });
      });
    }).catch(err => {
      console.warn('mermaid render failed', err);
    });
  }

  // Accordion: jump links + callable tree names.
  main.querySelectorAll('.fn-jump').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const line = parseInt(el.dataset.line, 10);
      vscode.postMessage({ type: 'openLine', path: absPath, line });
    });
  });
  main.querySelectorAll('.fn-tree .nm.callable').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = el.dataset.target;
      const f = fnByName[target];
      if (!f) return;
      // Open the target function's accordion and scroll to it.
      const det = main.querySelector('details.fn[data-fn="' + CSS.escape(target) + '"]');
      if (det) {
        det.open = true;
        det.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      vscode.postMessage({ type: 'openLine', path: absPath, line: f.line });
    });
  });

  // Used by + todos: row click jumps to file:line.
  main.querySelectorAll('.used-list li').forEach(el => {
    el.addEventListener('click', () => {
      const p = el.dataset.path;
      const ln = parseInt(el.dataset.line, 10);
      if (p) vscode.postMessage({ type: 'openLine', path: p, line: ln });
    });
  });
  main.querySelectorAll('.todo-list li').forEach(el => {
    el.addEventListener('click', () => {
      const ln = parseInt(el.dataset.line, 10);
      vscode.postMessage({ type: 'openLine', path: absPath, line: ln });
    });
  });
}

// Render the direct children of folderPath (which has just been resolved
// by the extension) into the lazy folder's details body. Only emits entries
// that are direct children of folderPath; deeper paths in items belong to
// nested lazy folders which themselves contain placeholders.
function renderLazyFolderBody(detailsEl, folderPath, items) {
  const body = detailsEl.querySelector('.lazy-body');
  if (!body) return;
  body.innerHTML = '';
  // Merge into FILES so the rest of the webview (overviews, hidden/favorites
  // checks, etc.) sees the new entries.
  Object.assign(FILES, items);
  const prefix = folderPath + '/';
  const folderEntries = [], fileEntries = [];
  Object.keys(items).forEach(p => {
    if (!p.startsWith(prefix)) return;
    const rest = p.slice(prefix.length);
    if (rest.includes('/')) return;          // deeper than direct child
    const file = items[p];
    if (file.kind === 'folder') folderEntries.push({ name: rest, path: p });
    else                        fileEntries.push({ name: rest, path: p });
  });
  // VSCode-style: folders first, then files; both alphabetical.
  folderEntries.sort((a, b) => a.name.localeCompare(b.name));
  fileEntries.sort((a, b) => a.name.localeCompare(b.name));
  [...folderEntries, ...fileEntries].forEach(e => body.appendChild(makeAnchor(e)));
  detailsEl.dataset.loadState = 'loaded';
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'folderContents') {
    const det = list.querySelector(
      'details.lazy-folder[data-path="' + CSS.escape(msg.path) + '"]'
    );
    if (det) renderLazyFolderBody(det, msg.path, msg.items);
  } else if (msg.type === 'folderContentsError') {
    const det = list.querySelector(
      'details.lazy-folder[data-path="' + CSS.escape(msg.path) + '"]'
    );
    if (det) {
      const body = det.querySelector('.lazy-body');
      if (body) body.innerHTML = '<span class="lazy-loading">failed: ' + esc(msg.error) + '</span>';
      delete det.dataset.loadState;  // allow retry on next toggle
    }
  } else if (msg.type === 'syncDone') {
    // Extension finished the Sync. The file watcher will trigger a webview
    // refresh momentarily; in the meantime render the fresh overview directly
    // so the user sees the result without waiting for the rebuild.
    pendingOverviewPath = null;
    renderOverview(msg.path, msg.overview);
  } else if (msg.type === 'syncStarted') {
    // Spinner already started by triggerSync(); nothing more.
  } else if (msg.type === 'syncError') {
    main.classList.add('ov');
    const btn = main.querySelector('.sync-btn');
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('syncing', 'primary', 'done');
      btn.classList.add('failed');
      // Use innerHTML (not textContent) so the SVG glyph stays.
      btn.innerHTML = SEG_ICONS.todo + '<span>Sync (failed)</span>';
    }
    let banner = main.querySelector('.sync-error');
    if (!banner) {
      banner = document.createElement('p');
      banner.className = 'sync-error';
      main.insertBefore(banner, main.firstChild.nextSibling);
    }
    banner.textContent = 'Sync failed: ' + msg.error;
  }
});

// Patch the existing md-render path to clear the .ov flag so the editorial
// font/layout doesn't leak into normal markdown renders.
const _origRender = render;
render = function (path) {
  main.classList.remove('ov');
  main.classList.toggle('session', path.startsWith('[sessions]/'));
  const r = _origRender(path);
  reapplyFind();
  return r;
};

// =============================================================================
// Find-in-content (custom widget)
//   Wraps each match in a <mark.find-hit>, navigates between them, and auto-
//   opens any <details> containing the current match. We control the UI fully
//   so we can render a match counter and current/total navigation — features
//   VSCode's webview find widget doesn't surface.
// =============================================================================
const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const findCount = document.getElementById('find-count');
const findPrev = findBar.querySelector('[data-act="prev"]');
const findNext = findBar.querySelector('[data-act="next"]');
const findClose = findBar.querySelector('[data-act="close"]');
let findHits = [];
let findCurrent = -1;

function clearFind() {
  main.querySelectorAll('mark.find-hit').forEach(m => {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
  });
  // Merge the text nodes we just split, so the next search sees clean nodes.
  main.normalize();
  findHits = [];
  findCurrent = -1;
  findCount.textContent = '';
  findCount.classList.remove('empty');
  findPrev.disabled = true;
  findNext.disabled = true;
}

function doFind(query) {
  clearFind();
  if (!query) return;
  const lcQuery = query.toLowerCase();

  // Collect text nodes inside main. Skip SVG (mermaid diagram), script,
  // style, and the find bar itself.
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest('script, style, svg')) return NodeFilter.FILTER_REJECT;
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  // For each node, wrap matches in reverse so earlier indices don't shift
  // after surroundContents splits the node.
  textNodes.forEach(node => {
    const text = node.nodeValue;
    const lc = text.toLowerCase();
    const idxs = [];
    let i = 0;
    while ((i = lc.indexOf(lcQuery, i)) !== -1) {
      idxs.push(i);
      i += lcQuery.length;
    }
    if (!idxs.length) return;
    const wrapped = [];
    idxs.reverse().forEach(idx => {
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + lcQuery.length);
      const mark = document.createElement('mark');
      mark.className = 'find-hit';
      try {
        range.surroundContents(mark);
        wrapped.unshift(mark);
      } catch (_) { /* skip rare cross-boundary range */ }
    });
    findHits.push(...wrapped);
  });

  if (findHits.length) {
    findPrev.disabled = false;
    findNext.disabled = false;
    goToHit(0);
  } else {
    findCount.textContent = 'No results';
    findCount.classList.add('empty');
  }
}

function goToHit(idx) {
  if (!findHits.length) return;
  if (findCurrent >= 0 && findHits[findCurrent]) {
    findHits[findCurrent].classList.remove('current');
  }
  findCurrent = ((idx % findHits.length) + findHits.length) % findHits.length;
  const hit = findHits[findCurrent];
  hit.classList.add('current');
  // Auto-open any collapsed <details> on the path to the hit, so scrolling
  // actually reveals it.
  let p = hit.parentElement;
  while (p && p !== main) {
    if (p.tagName === 'DETAILS') p.open = true;
    p = p.parentElement;
  }
  hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
  findCount.textContent = (findCurrent + 1) + ' of ' + findHits.length;
  findCount.classList.remove('empty');
}

function openFind() {
  findBar.hidden = false;
  findInput.focus();
  findInput.select();
}

function closeFind() {
  clearFind();
  findInput.value = '';
  findBar.hidden = true;
}

// Re-run the active search after main is re-rendered (file click, overview
// load, etc.). Called from the render patches above.
function reapplyFind() {
  if (!findBar.hidden && findInput.value) doFind(findInput.value);
}

findInput.addEventListener('input', () => doFind(findInput.value));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (findHits.length) goToHit(findCurrent + (e.shiftKey ? -1 : 1));
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeFind();
  }
});
findPrev.addEventListener('click', () => findHits.length && goToHit(findCurrent - 1));
findNext.addEventListener('click', () => findHits.length && goToHit(findCurrent + 1));
findClose.addEventListener('click', closeFind);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    openFind();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === ';' || e.key === "'")) {
    // Cmd/Ctrl+; toggles the agent-pet review panel.
    e.preventDefault();
    celebratePet();
    if (petPanelEl.classList.contains('show')) {
      closePanel();
    } else {
      openPanel();
      setTimeout(() => petInputEl.focus(), 0);
    }
  }
});

// Re-apply find after code-file overview renders too (md path is covered by
// the render() patch above).
const _origRenderOverview = renderOverview;
renderOverview = function (absPath, overview) {
  const r = _origRenderOverview(absPath, overview);
  reapplyFind();
  return r;
};
const _origRenderOverviewNotInit = renderOverviewNotInit;
renderOverviewNotInit = function (relPath, absPath, label) {
  const r = _origRenderOverviewNotInit(relPath, absPath, label);
  reapplyFind();
  return r;
};

// =============================================================================
// Anchored comments — selection-based via Recogito Text Annotator.
// Recogito (BSD-3, https://github.com/recogito/text-annotator-js) owns
// selection, range serialization, highlight rendering, and drift-resilient
// re-attachment across re-renders. We own the popup UI, the per-file
// localStorage of {id, text, anchorText, ts, annotation}, and the submit-
// to-agent flow.
// =============================================================================

let currentPath = null;
let currentAbsPath = null;
let comments = [];
let nextCommentNum = 1;

// Per-mount annotator. Recogito only holds *saved* highlights — selection
// (the transient cursor highlight) is the browser's job, tracked here as
// activeRange below. Both reset on each re-render via initAnnotator().
let annotator = null;
let activeRange = null;          // native DOM Range from window.getSelection()
let activeAnnotation = null;     // set when user clicks an existing highlight
let lastSelectionRect = null;

const petEl = document.getElementById('pet');
const petPanelEl = document.getElementById('pet-panel');
const petCloseEl = document.getElementById('pet-close');
const petCmtsEl = document.getElementById('pet-cmts');
const petInputEl = document.getElementById('pet-input');
const petSendEl = document.getElementById('pet-send');
const petBadgeEl = document.getElementById('pet-badge');
const cmtPopover = document.getElementById('cmt-popover');
const selToolbar = document.getElementById('sel-toolbar');
const selCommentBtn = document.getElementById('sel-comment-btn');

// Page-to-extension debug logger — webview can't write files, so we post
// every dbg() to the extension which appends to /tmp/agent-shell-dbg.log.
// Read the file with: tail -f /tmp/agent-shell-dbg.log
function dbg(label, payload) {
  try {
    const ts = new Date().toISOString().slice(11, 23);
    let line = '[' + ts + '] ' + label;
    if (payload !== undefined) {
      const s = typeof payload === 'string' ? payload
        : JSON.stringify(payload, (k, v) => {
            if (v && v.nodeType) return '<' + (v.tagName || 'node') + '>';
            return v;
          });
      line += ' ' + (s || '').slice(0, 600);
    }
    vscode.postMessage({ type: 'dbgLog', line });
    console.log('[recogito]', label, payload);
  } catch (_) {}
}
dbg('boot', {
  hasRecogito: !!window.RecogitoJS,
  hasMain: !!main,
  hasToolbar: !!selToolbar,
  hasBtn: !!selCommentBtn,
});

function commentsKey(p) { return 'comments:' + (p || '_global_'); }

function loadComments(p) {
  if (!p) { comments = []; nextCommentNum = 1; return; }
  try {
    comments = JSON.parse(localStorage.getItem(commentsKey(p)) || '[]');
  } catch (_) { comments = []; }
  nextCommentNum = (comments.reduce((m, c) => Math.max(m, c.num || 0), 0) || 0) + 1;
}

function saveComments() {
  if (!currentPath) return;
  // Strip the live DOM Range (and offsetReference HTMLElement) from each
  // annotation's selectors before serializing — those can't go through
  // JSON.stringify. On load we revive via RecogitoJS.reviveAnnotation.
  const ser = JSON.stringify(comments, (k, v) => {
    if (k === 'range' || k === 'offsetReference') return undefined;
    return v;
  });
  localStorage.setItem(commentsKey(currentPath), ser);
}

function findCommentByAnnotationId(annId) {
  if (!annId) return null;
  return comments.find(c => c.annotation && c.annotation.id === annId) || null;
}

function quoteFromAnnotation(ann) {
  if (!ann || !ann.target) return '';
  const sels = Array.isArray(ann.target.selector)
    ? ann.target.selector : [ann.target.selector];
  for (const s of sels) {
    if (s && typeof s.quote === 'string') return s.quote;
    if (s && typeof s.exact === 'string') return s.exact;
  }
  return '';
}

// Bounding rect for a saved annotation. Recogito's SPANS renderer doesn't
// tag spans with the annotation id, so we look up the live Range from the
// store (via the selector's .range field that reviveSelector attached).
function rectFromAnnotation(ann) {
  try {
    const sel = ann && ann.target && ann.target.selector && ann.target.selector[0];
    if (sel && sel.range) return sel.range.getBoundingClientRect();
  } catch (_) {}
  return lastSelectionRect;
}

// Render an inline "[💬 comment text]" chip at the end of each saved
// highlight. Recogito's SPANS renderer doesn't wrap the highlighted text
// in DOM — it paints absolutely-positioned overlay divs. So we anchor the
// bubble directly to the Range's endpoint via splitText, putting it in
// the flow exactly where the highlight ends. Re-built on every mutation
// (cheap; comments lists stay small).
function renderInlineBubbles() {
  if (!main) return;
  main.querySelectorAll('.cmt-inline').forEach(el => el.remove());
  let placed = 0, noRange = 0, failed = 0;
  for (const c of comments) {
    if (!c.annotation || !c.annotation.target) continue;
    const sel = c.annotation.target.selector && c.annotation.target.selector[0];
    if (!sel || !sel.range) { noRange++; continue; }

    const bubble = document.createElement('span');
    bubble.className = 'cmt-inline' + (c.submitted ? ' submitted' : '');
    bubble.dataset.cmtId = c.id;
    bubble.title = 'Click to edit · use the × in the pet panel to delete';
    const icon = document.createElement('span');
    icon.className = 'cmt-inline-icon';
    icon.textContent = '💬';
    const txt = document.createElement('span');
    txt.className = 'cmt-inline-text';
    txt.textContent = c.text;
    bubble.appendChild(icon);
    bubble.appendChild(txt);
    bubble.addEventListener('click', (e) => {
      e.stopPropagation();
      openPopoverEdit(c, c.annotation);
    });

    try {
      const r = sel.range;
      let node = r.endContainer;
      const offset = r.endOffset;
      if (!node) { failed++; continue; }
      if (node.nodeType === 3) {
        // Text node: split at the offset, insert bubble between the halves.
        if (offset > 0 && offset < node.length) {
          node.splitText(offset);
        }
        if (offset === 0) {
          node.parentNode.insertBefore(bubble, node);
        } else {
          node.parentNode.insertBefore(bubble, node.nextSibling);
        }
      } else {
        // Element node: offset is a child index.
        const ref = node.childNodes[offset];
        node.insertBefore(bubble, ref || null);
      }
      placed++;
    } catch (e) {
      dbg('bubble insert failed', String(e));
      failed++;
    }
  }
  dbg('renderInlineBubbles', { total: comments.length, placed, noRange, failed });
}

// Rebuild the annotator against the (just re-rendered) main element. Called from
// the render hooks. Loads any previously-stored annotations for this file so
// highlights re-appear on file switch / workspace refresh.
function initAnnotator() {
  if (!main) { dbg('init: no main element'); return; }
  if (!window.RecogitoJS) {
    dbg('init: RecogitoJS global missing — script load failed');
    toast('Recogito failed to load; comments disabled');
    return;
  }
  // Bind Recogito to .md-body, not main. Main has variable header content
  // (filename, badges, taskbar) that would shift character offsets between
  // views and break revival in the snapshot view.
  const mdBody = main.querySelector('.md-body');
  if (!mdBody) { dbg('init: no .md-body wrapper'); return; }
  dbg('init', { storedComments: comments.length });
  if (annotator) {
    try { annotator.destroy(); } catch (e) { dbg('destroy failed', String(e)); }
    annotator = null;
  }
  activeRange = null;
  activeAnnotation = null;
  hideSelToolbar();

  try {
    annotator = RecogitoJS.createTextAnnotator(mdBody, {
      renderer: 'SPANS',
      annotatingEnabled: false,
    });
  } catch (e) {
    dbg('createTextAnnotator threw', String(e));
    toast('Recogito init failed: ' + (e.message || e));
    return;
  }
  dbg('annotator created');

  // Revive against the same .md-body so offsets line up with what
  // rangeToSelector wrote at save time.
  const valid = [];
  for (const c of comments) {
    if (!c.annotation || !c.annotation.target) continue;
    try {
      const revived = RecogitoJS.reviveAnnotation
        ? RecogitoJS.reviveAnnotation(c.annotation, mdBody)
        : c.annotation;
      c.annotation = revived;
      valid.push(revived);
    } catch (e) {
      dbg('reviveAnnotation failed', String(e));
      valid.push(c.annotation);
    }
  }
  if (valid.length) {
    try { annotator.setAnnotations(valid); }
    catch (e) { dbg('setAnnotations failed', String(e)); }
  }
  renderInlineBubbles();

  // Clicking a saved highlight opens the popover for editing that comment.
  annotator.on('clickAnnotation', (ann) => {
    const c = findCommentByAnnotationId(ann.id);
    if (c) openPopoverEdit(c, ann);
  });
}

function showSelToolbarAtRect(rect) {
  if (!rect) return;
  // Position above the selection (flip below if it'd go off-screen).
  const tbW = 130, tbH = 34;
  let left = rect.left + (rect.width / 2) - (tbW / 2);
  left = Math.max(8, Math.min(window.innerWidth - tbW - 8, left));
  let top = window.scrollY + rect.top - tbH - 8;
  if (top < window.scrollY + 8) top = window.scrollY + rect.bottom + 8;
  selToolbar.style.left = left + 'px';
  selToolbar.style.top = top + 'px';
  selToolbar.classList.add('show');
}

function hideSelToolbar() { selToolbar.classList.remove('show'); }

// Native selection watcher. The browser handles the live highlight; we
// just observe it. When the user finishes a non-collapsed selection inside
// main, we open the comment popover directly (no intermediate "Comment"
// toolbar). The popover positions itself below the selection so it never
// overlaps the text being commented on, and can be dragged from its
// quote-preview header.
function refreshFromNativeSelection() {
  // Snapshot view is read-only — no popping the comment popover there.
  if (snapshotMode) return;
  // The popover only auto-shows in *review* mode now. Edit / draw / view
  // selections are just plain browser selections (cut/paste/cursor), and
  // review is opt-in via the toolbar button.
  if (!reviewMode) return;
  // No annotator means we're on a non-md view (code overview, history
  // table, error page). Selection commenting isn't supported there.
  if (!annotator) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    activeRange = null;
    return;
  }
  const range = sel.getRangeAt(0);
  if (!main || !main.contains(range.commonAncestorContainer)) {
    activeRange = null;
    return;
  }
  // Don't reopen while a popover is already up (editing existing, or the
  // user is mid-comment for the previous selection).
  if (cmtPopover.classList.contains('show')) return;
  activeRange = range.cloneRange();
  lastSelectionRect = range.getBoundingClientRect();
  dbg('selection', { quote: range.toString().slice(0, 40) });
  openPopoverCreate(activeRange);
}
// mouseup catches the end-of-drag for the common mouse-selection case.
document.addEventListener('mouseup', () => setTimeout(refreshFromNativeSelection, 0));
// keyup catches keyboard selection (shift+arrow, shift+cmd+arrow, etc.).
document.addEventListener('keyup', (e) => {
  if (e.shiftKey || /^Arrow/.test(e.key)) setTimeout(refreshFromNativeSelection, 0);
});
// selectionchange is noisy during drag; we only use it to hide the toolbar
// when the user clicks elsewhere and the selection collapses.
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    activeRange = null;
    hideSelToolbar();
  }
});

selCommentBtn.addEventListener('mousedown', (e) => {
  // mousedown + preventDefault keeps the native selection alive (a regular
  // click would blur/collapse it before we got to read the range).
  e.preventDefault();
  e.stopPropagation();
  if (!activeRange) return;
  openPopoverCreate(activeRange);
  hideSelToolbar();
});

let popoverMode = null;     // 'create' | 'edit' | null
let popoverDraft = null;    // W3C annotation being acted on
let popoverEditing = null;  // existing comment object when editing

function openPopoverCreate(range) {
  popoverMode = 'create';
  popoverDraft = range;  // a native DOM Range
  popoverEditing = null;
  setPreviewHighlight(range);
  positionPopover(
    range.getBoundingClientRect(),
    range.toString(),
    '',
  );
}

// Paint a temporary blue highlight on the given range, mimicking the
// browser's native ::selection style. Cleared via clearPreviewHighlight()
// when the popover closes. Uses the CSS Custom Highlight API so it's
// purely visual — no DOM mutation, no interference with Recogito.
function setPreviewHighlight(range) {
  if (!range || !window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;
  try {
    const hl = new Highlight(range);
    CSS.highlights.set('cmt-preview', hl);
  } catch (_) {}
}
function clearPreviewHighlight() {
  if (!window.CSS || !CSS.highlights) return;
  try { CSS.highlights.delete('cmt-preview'); } catch (_) {}
}

function openPopoverEdit(comment, annotation) {
  popoverMode = 'edit';
  popoverDraft = annotation || (comment && comment.annotation) || null;
  popoverEditing = comment;
  positionPopover(
    rectFromAnnotation(popoverDraft),
    comment.anchorText || quoteFromAnnotation(popoverDraft),
    comment.text,
  );
}

function positionPopover(rect, quote, text) {
  cmtPopover.querySelector('.anchor-preview').textContent = (quote || '').trim() || '(no quote)';
  const ta = cmtPopover.querySelector('textarea');
  ta.value = text || '';
  const delBtn = cmtPopover.querySelector('[data-act="delete"]');
  if (delBtn) delBtn.style.display = (popoverMode === 'edit') ? '' : 'none';
  populateDrawingChips();
  const popW = 360, popH = 200, gap = 10;
  cmtPopover.style.visibility = 'hidden';
  cmtPopover.classList.add('show');
  const r = rect || { left: 100, top: 100, right: 200, bottom: 120, height: 20 };
  // Vertical: prefer below the selection's bottom (so it never sits on top
  // of the highlighted text). Flip above if no room.
  let topPx;
  if (r.bottom + gap + popH < window.innerHeight) {
    topPx = window.scrollY + r.bottom + gap;
  } else if (r.top - gap - popH > 0) {
    topPx = window.scrollY + r.top - gap - popH;
  } else {
    // Tight viewport — pin under the top edge.
    topPx = window.scrollY + Math.max(12, window.innerHeight - popH - 20);
  }
  // Horizontal: align to selection left, but clamp inside viewport.
  let left = Math.min(window.innerWidth - popW - 12, Math.max(12, r.left));
  cmtPopover.style.left = left + 'px';
  cmtPopover.style.top = topPx + 'px';
  cmtPopover.style.visibility = '';
  setTimeout(() => ta.focus(), 0);
}

// Render one chip per saved drawing inside the popover. Coral when the
// comment already mentions @drawN (= drawing is attached), neutral
// otherwise. Click toggles the mention in the textarea — saves the user
// from having to type the label manually and gives a visible cue of
// what's attached.
function populateDrawingChips() {
  const wrap = cmtPopover.querySelector('.draw-chips');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!drawings || !drawings.length) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  const ta = cmtPopover.querySelector('textarea');
  for (const d of drawings) {
    const chip = document.createElement('span');
    chip.className = 'draw-chip';
    chip.textContent = '@' + d.label;
    chip.title = 'Click to attach / detach ' + d.label + ' from this comment';
    chip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleDrawingMention(d.label);
    });
    wrap.appendChild(chip);
  }
  refreshChipStates();
  ta.addEventListener('input', refreshChipStates);
}

function refreshChipStates() {
  const ta = cmtPopover.querySelector('textarea');
  const text = ta.value || '';
  cmtPopover.querySelectorAll('.draw-chip').forEach(chip => {
    const label = chip.textContent.slice(1);  // strip leading "@"
    const re = new RegExp('(^|\\s|[^\\w])@' + label + '(?![\\w])');
    chip.classList.toggle('attached', re.test(text));
  });
}

function toggleDrawingMention(label) {
  const ta = cmtPopover.querySelector('textarea');
  const text = ta.value || '';
  const mention = '@' + label;
  const re = new RegExp('(^|\\s)@' + label + '(?![\\w])', 'g');
  if (re.test(text)) {
    // Already attached → remove all occurrences + tidy spaces.
    ta.value = text.replace(re, '$1').replace(/\s+/g, ' ').trim();
  } else {
    // Not attached → insert at cursor (or append with a leading space).
    const start = ta.selectionStart || text.length;
    const before = text.slice(0, start);
    const after = text.slice(start);
    const insert = (before && !/\s$/.test(before) ? ' ' : '') + mention
      + (after && !/^\s/.test(after) ? ' ' : '');
    ta.value = before + insert + after;
    const pos = (before + insert).length;
    ta.setSelectionRange(pos, pos);
    ta.focus();
  }
  refreshChipStates();
}

// Drag the popover by its quote-preview bar. Useful when the auto-placed
// position covers something the user wants to see.
(function wireDrag() {
  const handle = cmtPopover.querySelector('.anchor-preview');
  if (!handle) return;
  handle.style.cursor = 'move';
  handle.title = 'Drag to move';
  let drag = null;
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = cmtPopover.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
  });
  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const left = Math.max(0, Math.min(window.innerWidth - 40, e.clientX - drag.dx));
    const top = Math.max(0, e.clientY - drag.dy) + window.scrollY;
    cmtPopover.style.left = left + 'px';
    cmtPopover.style.top = top + 'px';
  });
  document.addEventListener('mouseup', () => { drag = null; });
})();

function closePopover() {
  cmtPopover.classList.remove('show');
  popoverMode = null;
  popoverDraft = null;
  popoverEditing = null;
  clearPreviewHighlight();
  // Nothing to "discard" in Recogito — with annotatingEnabled:false the
  // store only holds saved highlights, and the native selection is just
  // browser state that goes away when the user clicks elsewhere.
}

function savePopover() {
  const saveBtn = cmtPopover.querySelector('[data-act="save"]');
  if (saveBtn && saveBtn.disabled) return;          // guard against double-click
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.dataset._origLabel = saveBtn.innerHTML;
    saveBtn.innerHTML = '<span style="opacity:.7">saving…</span>';
  }
  const restoreBtn = () => {
    if (!saveBtn) return;
    saveBtn.disabled = false;
    if (saveBtn.dataset._origLabel) saveBtn.innerHTML = saveBtn.dataset._origLabel;
  };
  // Hard guarantee: popover closes and the button restores even if anything
  // below throws unexpectedly.
  try {
    const ta = cmtPopover.querySelector('textarea');
    const text = (ta && ta.value || '').trim();
    if (!text) { closePopover(); return; }

    if (popoverMode === 'edit' && popoverEditing) {
      popoverEditing.text = text;
      popoverEditing.ts = Date.now();
      // Edited → no longer matches what was last submitted, so undim it.
      popoverEditing.submitted = false;
      saveComments();
      renderPetPanel();
      try { renderInlineBubbles(); } catch (e) { dbg('renderInlineBubbles after edit threw', String(e)); }
      closePopover();
      return;
    }

    // Create: convert the native Range into a W3C selector via Recogito's
    // helper, build the annotation, hand it to Recogito to render the coral
    // highlight, and mirror into comments[] for the pet panel + submit.
    const range = popoverDraft;
    if (!range || !annotator || !window.RecogitoJS || !RecogitoJS.rangeToSelector) {
      dbg('save: aborted', {
        hasRange: !!range,
        hasAnnotator: !!annotator,
        hasRecogito: !!window.RecogitoJS,
        hasRangeToSelector: !!(window.RecogitoJS && RecogitoJS.rangeToSelector),
        currentPath,
      });
      toast('Save aborted — selection lost. Re-select the text and try again.');
      closePopover();
      return;
    }
    let selector;
    const mdBody = main.querySelector('.md-body') || main;
    try { selector = RecogitoJS.rangeToSelector(range, mdBody); }
    catch (e) {
      dbg('rangeToSelector failed', String(e));
      toast('Save failed: ' + (e.message || e));
      closePopover();
      return;
    }

    const newId = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : ('c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
    const annotation = {
      id: newId,
      bodies: [{
        annotation: newId,
        purpose: 'commenting',
        value: text,
        creator: { id: 'agent-shell-view' },
      }],
      target: {
        annotation: newId,
        selector: [selector],
      },
    };
    try { annotator.addAnnotation(annotation); }
    catch (e) {
      dbg('addAnnotation failed', String(e));
      toast('Save failed: ' + (e.message || e));
      closePopover();
      return;
    }

    // Climb from both ends of the range to the nearest block element with
    // a data-source-line attr (injected at render time by the markdown-it
    // plugin). These map directly back to source.md line numbers — no
    // fuzzy text matching needed downstream.
    const lineFor = (node) => {
      while (node && node !== mdBody) {
        if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute('data-source-line')) {
          return {
            start: parseInt(node.getAttribute('data-source-line'), 10) || null,
            end: parseInt(node.getAttribute('data-source-line-end'), 10) || null,
          };
        }
        node = node.parentNode;
      }
      return null;
    };
    const startInfo = lineFor(range.startContainer) || {};
    const endInfo   = lineFor(range.endContainer)   || {};
    const lineStart = startInfo.start || null;
    const lineEnd   = endInfo.end || endInfo.start || lineStart || null;

    comments.push({
      id: newId,
      num: nextCommentNum++,
      anchorText: (selector.quote || range.toString()).slice(0, 200),
      text,
      ts: Date.now(),
      annotation,
      lineStart,
      lineEnd,
    });
    saveComments();
    renderPetPanel();
    try { renderInlineBubbles(); } catch (e) { dbg('renderInlineBubbles after create threw', String(e)); }
    closePopover();
    celebratePet();
    // New review added → check if the previous batch was finished by the
    // agent in the meantime, so dimmed comments don't linger next to the
    // fresh one.
    pollReviewStateNow();
  } catch (e) {
    dbg('savePopover threw', String(e));
    toast('Save failed: ' + (e.message || e));
    closePopover();
  } finally {
    restoreBtn();
  }
}

function deleteCurrentComment() {
  if (popoverMode !== 'edit' || !popoverEditing) { closePopover(); return; }
  const c = popoverEditing;
  if (c.annotation && c.annotation.id && annotator) {
    try { annotator.removeAnnotation(c.annotation.id); } catch (_) {}
  }
  comments = comments.filter(x => x.id !== c.id);
  saveComments();
  renderPetPanel();
  renderInlineBubbles();
  closePopover();
}

cmtPopover.addEventListener('click', (e) => e.stopPropagation());
cmtPopover.querySelector('[data-act="cancel"]').addEventListener('click', closePopover);
cmtPopover.querySelector('[data-act="save"]').addEventListener('click', savePopover);
const _delBtn = cmtPopover.querySelector('[data-act="delete"]');
if (_delBtn) _delBtn.addEventListener('click', deleteCurrentComment);
cmtPopover.querySelector('textarea').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    savePopover();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePopover();
  }
});
// Close the popover on click outside (its own UI + the toolbar + any
// highlight are safe zones — Recogito handles the selection-dismissal side
// via dismissOnNotAnnotatable).
document.addEventListener('mousedown', (e) => {
  if (!cmtPopover.classList.contains('show')) return;
  if (cmtPopover.contains(e.target)) return;
  if (e.target.closest('#sel-toolbar')) return;
  if (e.target.closest('.r6o-annotation')) return;
  closePopover();
});

// Single-click on a saved comment highlight → open edit popover.
// Belt-and-suspenders fallback alongside Recogito's clickAnnotation event:
// in practice that event sometimes doesn't fire for SPANS-renderer hits
// (race with our selection refresh, etc). This delegated handler reads the
// annotation id off whichever attribute Recogito stamps on the wrapper span
// and looks the comment up directly.
document.addEventListener('click', (e) => {
  if (!main || !main.contains(e.target)) return;
  // Ignore drags — only single-click without a selection should open edit.
  const sel = window.getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed) return;
  const span = e.target.closest('.r6o-annotation');
  if (!span) return;
  // Find the annotation id — Recogito uses data-annotation-id, but some
  // builds use data-id; try both.
  const id = span.getAttribute('data-annotation-id')
          || span.getAttribute('data-id')
          || span.getAttribute('annotation-id');
  if (!id) { dbg('click-edit: span has no id attr', {attrs: Array.from(span.attributes).map(a => a.name + '=' + a.value).join(' ')}); return; }
  const c = comments.find(x => x.id === id || (x.annotation && x.annotation.id === id));
  if (!c) { dbg('click-edit: no comment for id', {id}); return; }
  e.preventDefault();
  e.stopPropagation();
  openPopoverEdit(c, c.annotation);
});

// Esc collapses the native selection (which our selectionchange listener
// then translates into a hide-toolbar). Browsers don't collapse on Esc by
// default — they clear it on click — so we do it explicitly.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  try { window.getSelection().removeAllRanges(); } catch (_) {}
  hideSelToolbar();
});

// =============================================================================
// Pet renderer + drag + mood cycling (ported from references/notes/pet-pack/).
// Two body styles (pixel | ascii). Seven moods. Drag the pet anywhere; on drop
// the next mood is shown. Click without drag toggles the panel. State persists
// to localStorage.
// =============================================================================
const PET_MOODS = ['idle', 'thinking', 'typing', 'success', 'celebrating', 'sleeping', 'error'];
const PET_STYLES = ['pixel', 'ascii'];

const PIXEL_GRIDS = {
  idle: [
    "....DDDDDDDD....","..DDLLLLLLCCDD..",".DLLLLLLLLCCCCD.",".DLLLLCCCCCCCCD.",
    "DLLLLCCCCCCCCCCD","DLLCCCKCCCCKCCCD","DLCCCCKCCCCKCCCD","DCCCCCCCCCCCCCCD",
    "DCCBBCCCCCCCCBBD","DCBBCCCDDDDCCBBD","DCCBCCCCCCCCCCBD","DCCCCCCCCCCCCCCD",
    ".DCCCCCCCCCCCCD.",".DCCCCCCCCCCCCD.","..DDCCCCCCCCDD..","....DDDDDDDD....",
  ],
  thinking: [
    "....DDDDDDDD....","..DDLLLLLLCCDD..",".DLLLLLLLLCCCCD.",".DLLLLCCCCCCCCD.",
    "DLLLLCCCCCCCCCCD","DLLCCCCCKCCCCKCD","DLCCCCCCKCCCCKCD","DCCCCCCCCCCCCCCD",
    "DCCCCCCCCCCCCCCD","DCCCCCCDDDCCCCCD","DCCCCCCCCCCCCCCD","DCCCCCCCCCCCCCCD",
    ".DCCCCCCCCCCCCD.",".DCCCCCCCCCCCCD.","..DDCCCCCCCCDD..","....DDDDDDDD....",
  ],
  typing: [
    "....DDDDDDDD....","..DDLLLLLLCCDD..",".DLLLLLLLLCCCCD.",".DLLLLCCCCCCCCD.",
    "DLLLLCCCCCCCCCCD","DLLCCC-CCCC-CCCD","DLCCCC-CCCC-CCCD","DCCCCCCCCCCCCCCD",
    "DCCCCCCCCCCCCCCD","DCCCCCCDDDDCCCCD","DCCCCCCCCCCCCCCD","DCCCCCCCCCCCCCCD",
    ".DCCCCCCCCCCCCD.",".DCCCCCCCCCCCCD.","..DDCCCCCCCCDD..","....DDDDDDDD....",
  ],
  success: [
    "....DDDDDDDD....","..DDLLLLLLCCDD..",".DLLLLLLLLCCCCD.",".DLLLLCCCCCCCCD.",
    "DLLLLCCCCCCCCCCD","DLLCCCCCCCCCCCCD","DLLCKKCCCCKKCCCD","DLCKCCKCCKCCKCCD",
    "DCBBCCCCCCCCBBCD","DCCCCCCCCCCCCCCD","DCCCCCCDDCCCCCCD","DCCCCCCDDCCCCCCD",
    ".DCCCCCCCCCCCCD.",".DCCCCCCCCCCCCD.","..DDCCCCCCCCDD..","....DDDDDDDD....",
  ],
  celebrating: [
    "....DDDDDDDD....","..DDLLLLLLCCDD..",".DLLLLLLLLCCCCD.",".DLLLLCCCCCCCCD.",
    "DLLLLCCCCCCCCCCD","DLHHCHHCCHHCHHCD","DLHHHHHCCHHHHHCD","DLLHHHCCCCHHHCCD",
    "DCCCHCCCCCCHCCCD","DCBBCCCCCCCCBBCD","DCCCCCDDDDCCCCCD","DCCCCCCLLCCCCCCD",
    ".DCCCCCCCCCCCCD.",".DCCCCCCCCCCCCD.","..DDCCCCCCCCDD..","....DDDDDDDD....",
  ],
  sleeping: [
    "....DDDDDDDD....","..DDLLLLLLCCDD..",".DLLLLLLLLCCCCD.",".DLLLLCCCCCCCCD.",
    "DLLLLCCCCCCCCCCD","DLLCCCCCCCCCCCCD","DLCCC----CC----D","DCCCCCCCCCCCCCCD",
    "DCCCCCCCCCCCCCCD","DCCCCCCDDDCCCCCD","DCCCCCCCCCCCCCCD","DCCCCCCCCCCCCCCD",
    ".DCCCCCCCCCCCCD.",".DCCCCCCCCCCCCD.","..DDCCCCCCCCDD..","....DDDDDDDD....",
  ],
  error: [
    "....DDDDDDDD....","..DDLLLLLLCCDD..",".DLKKLLLLKKCCCD.",".DLLKKCCCCKKCCD.",
    "DLLLLCCCCCCCCCCD","DLLCCCKCCCCKCCCD","DLCCCCKCCCCKCCCD","DCCCCCCCCCCCCCCD",
    "DCCCCCCCCCCCCCCD","DCCCCDDDDDDCCCCD","DCCCCCCCCCCCCCCD","DCCCCCCCCCCCCCCD",
    ".DCCCCCCCCCCCCD.",".DCCCCCCCCCCCCD.","..DDCCCCCCCCDD..","....DDDDDDDD....",
  ],
};
const PIXEL_COLORS = {
  ".": "transparent",
  C: "var(--pt-coral)",
  D: "var(--pt-coralDeep)",
  L: "var(--pt-coralLight)",
  K: "var(--pt-ink)",
  B: "var(--pt-blush)",
  H: "var(--pt-ink)",
  "-": "var(--pt-ink)",
};
const ASCII_FACES = {
  idle:        ["╭───╮", "│◕ ◕│", "╰───╯"],
  thinking:    ["╭───╮", "│◔ ◔│", "╰───╯"],
  typing:      ["╭───╮", "│- -│", "╰───╯"],
  success:     ["╭───╮", "│^ ^│", "╰─◡─╯"],
  celebrating: ["╭───╮", "│✦ ✦│", "╰─◡─╯"],
  sleeping:    ["╭───╮", "│- -│", "╰───╯"],
  error:       ["╭───╮", "│× ×│", "╰─╴─╯"],
};
const PET_ANIM = {
  idle:        'pet_breathe 3.4s ease-in-out infinite',
  thinking:    'pet_sway 2.2s ease-in-out infinite',
  typing:      'pet_typeBob 0.7s ease-in-out infinite',
  success:     'pet_bounce 1.4s cubic-bezier(.4,1.6,.5,1) infinite',
  celebrating: 'pet_party 1s cubic-bezier(.4,1.6,.5,1) infinite',
  sleeping:    'pet_breatheSlow 5s ease-in-out infinite',
  error:       'pet_shake 0.6s ease-in-out infinite',
};
const MOOD_ACCENT = {
  idle: 'var(--pt-coral)',
  thinking: 'var(--pt-thinkBlue)',
  typing: 'var(--pt-coralDeep)',
  success: 'var(--pt-successGreen)',
  celebrating: 'var(--pt-party1)',
  sleeping: 'var(--pt-sleepBlue)',
  error: 'var(--pt-errorRed)',
};

const petBodyEl = document.getElementById('pet-body');
const petOverlayEl = document.getElementById('pet-overlay');
const petStyleToggleEl = document.getElementById('pet-style-toggle');

let petStyle = localStorage.getItem('petStyle') || 'pixel';
let petMoodIdx = parseInt(localStorage.getItem('petMoodIdx') || '0', 10);
if (!Number.isFinite(petMoodIdx) || petMoodIdx < 0) petMoodIdx = 0;
petMoodIdx = petMoodIdx % PET_MOODS.length;

function currentMood() { return PET_MOODS[petMoodIdx]; }

function renderPetBody() {
  const mood = currentMood();
  petBodyEl.style.animation = PET_ANIM[mood] || PET_ANIM.idle;
  if (petStyle === 'pixel') {
    const grid = PIXEL_GRIDS[mood] || PIXEL_GRIDS.idle;
    // overflow:visible so accessories drawn above the 16x16 viewBox (e.g.
    // the sleep cap, which sits at y<0) don't get clipped.
    let svg = '<svg viewBox="0 0 16 16" shape-rendering="crispEdges" '
      + 'style="image-rendering:pixelated; overflow:visible">';
    for (let y = 0; y < grid.length; y++) {
      const row = grid[y];
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        const fill = PIXEL_COLORS[ch] || 'transparent';
        if (fill === 'transparent') continue;
        svg += '<rect x="' + x + '" y="' + y + '" width="1" height="1" fill="' + fill + '"/>';
      }
    }
    // Inline accessories (currently just the sleep cap). Drawn AFTER the
    // pixel grid so they paint on top of the head. Coords are in 16-unit
    // grid space — they breathe/scale with the pet automatically because
    // they're inside the same SVG that the .pet-body animation transforms.
    if (mood === 'sleeping') {
      const ink = 'var(--pt-ink, #2A1F18)';
      const blue = 'var(--pt-sleepBlue, #8FA8C2)';
      // Cap scaled 1.5× around the brim center (7.8, 0.25) so the brim
      // still rests on the top row of head pixels but the cap is larger.
      svg += '<g transform="translate(7.8 0.25) scale(1.5) translate(-7.8 -0.25)">'
        + '<path d="M 5 0.4 Q 6 -3.2 9.4 -3.6 Q 11.3 -2.4 10 -0.2 Z" '
        +   'fill="' + blue + '" stroke="' + ink + '" stroke-width="0.28" '
        +   'stroke-linejoin="round" stroke-linecap="round"/>'
        + '<rect x="4.4" y="-0.4" width="6.8" height="1.3" rx="0.35" '
        +   'fill="#FBF8F2" stroke="' + ink + '" stroke-width="0.28"/>'
        + '<circle cx="10.4" cy="-4.0" r="0.75" '
        +   'fill="#FBF8F2" stroke="' + ink + '" stroke-width="0.24"/>'
        + '</g>';
    }
    svg += '</svg>';
    petBodyEl.innerHTML = svg;
  } else {
    const face = ASCII_FACES[mood] || ASCII_FACES.idle;
    const color = MOOD_ACCENT[mood];
    // Wrap pre in a relative box so the cap pins to pre's own top edge,
    // not the much taller .pet-body container.
    let inner = '<div style="position:relative; display:inline-block;">';
    inner += '<pre style="font-size:13px; color:' + color + '; margin:0">' + face.join('\n') + '</pre>';
    if (mood === 'sleeping') {
      const ink = 'var(--pt-ink, #2A1F18)';
      const blue = 'var(--pt-sleepBlue, #8FA8C2)';
      // bottom:100% puts the SVG just above the pre; translateY(+6px)
      // pulls it back down so the brim rests on the pre's top edge.
      // 45x22 = 1.5× the previous 30x15 (per user's "再加大 50%").
      inner += '<svg viewBox="0 0 16 8" '
        + 'style="position:absolute; left:50%; bottom:100%; '
        +   'transform:translateX(-50%) translateY(6px); '
        +   'width:68px; height:34px; overflow:visible; pointer-events:none;">'
        + '<path d="M 5 7.5 Q 6 3.8 9.4 3.4 Q 11.3 4.6 10 6.8 Z" '
        +   'fill="' + blue + '" stroke="' + ink + '" stroke-width="0.28" '
        +   'stroke-linejoin="round" stroke-linecap="round"/>'
        + '<rect x="4.4" y="6.6" width="6.8" height="1.3" rx="0.35" '
        +   'fill="#FBF8F2" stroke="' + ink + '" stroke-width="0.28"/>'
        + '<circle cx="10.4" cy="3.0" r="0.75" '
        +   'fill="#FBF8F2" stroke="' + ink + '" stroke-width="0.24"/>'
        + '</svg>';
    }
    inner += '</div>';
    petBodyEl.innerHTML = inner;
  }
  renderPetOverlay();
}

function renderPetOverlay() {
  const mood = currentMood();
  let html = '';
  if (mood === 'sleeping') {
    // Cap itself is drawn inside the pet body's SVG (renderPetBody) so it
    // scales/breathes with the pet. The overlay only owns the floating zzz.
    html = '<div style="position:absolute; top:-2px; right:-12px; font-family:var(--mono); font-size:12px; color:var(--pt-sleepBlue); font-weight:700; width:22px; height:22px;">'
      + '<span style="position:absolute; top:0; left:0; opacity:0; animation:pet_zzz 2.4s ease-out infinite 0s;">z</span>'
      + '<span style="position:absolute; top:0; left:0; opacity:0; animation:pet_zzz 2.4s ease-out infinite 0.8s;">z</span>'
      + '<span style="position:absolute; top:0; left:0; opacity:0; animation:pet_zzz 2.4s ease-out infinite 1.6s;">z</span>'
      + '</div>';
  } else if (mood === 'thinking') {
    // ASCII pet sits at the BOTTOM of .pet-body (flex-end), so the pet's
    // visible top is ~14px below the container top. Pull the pill down
    // accordingly so it doesn't float in empty space above the pet.
    const top = (petStyle === 'pixel') ? '-4px' : '7px';
    html = '<div style="position:absolute; top:' + top + '; left:50%; transform:translateX(-50%); display:flex; gap:3px; background:var(--pt-paperSoft); border:2px solid var(--pt-ink); border-radius:999px; padding:3px 7px;">'
      + '<div style="width:3px; height:3px; border-radius:999px; background:var(--pt-ink); animation:pet_dotPulse 1.2s ease-in-out infinite 0s;"></div>'
      + '<div style="width:3px; height:3px; border-radius:999px; background:var(--pt-ink); animation:pet_dotPulse 1.2s ease-in-out infinite 0.18s;"></div>'
      + '<div style="width:3px; height:3px; border-radius:999px; background:var(--pt-ink); animation:pet_dotPulse 1.2s ease-in-out infinite 0.36s;"></div>'
      + '</div>';
  } else if (mood === 'typing') {
    html = '<div style="position:absolute; bottom:0; left:50%; transform:translateX(-50%); display:flex; gap:2px;">'
      + '<div style="width:5px; height:4px; background:var(--pt-coralDeep); border-radius:1px; opacity:0.4; animation:pet_keyBlink 0.9s ease-in-out infinite 0s;"></div>'
      + '<div style="width:5px; height:4px; background:var(--pt-coralDeep); border-radius:1px; opacity:0.4; animation:pet_keyBlink 0.9s ease-in-out infinite 0.15s;"></div>'
      + '<div style="width:5px; height:4px; background:var(--pt-coralDeep); border-radius:1px; opacity:0.4; animation:pet_keyBlink 0.9s ease-in-out infinite 0.3s;"></div>'
      + '</div>';
  } else if (mood === 'celebrating') {
    const confetti = [
      { c: 'var(--pt-party1)', x: -16, y: -22, dx: -8, dy: 18 },
      { c: 'var(--pt-party2)', x:   8, y: -20, dx:  6, dy: 20 },
      { c: 'var(--pt-party3)', x:  18, y:  -8, dx: 12, dy: 16 },
      { c: 'var(--pt-party1)', x: -22, y:  -6, dx: -12, dy: 18 },
      { c: 'var(--pt-party2)', x:   0, y: -28, dx:  2, dy: 22 },
      { c: 'var(--pt-party3)', x:  12, y: -28, dx:  4, dy: 24 },
    ];
    html = '<div style="position:absolute; inset:0;">'
      + confetti.map((c, i) =>
          '<div style="position:absolute; left:50%; top:50%; width:4px; height:7px; background:'
          + c.c + '; border-radius:1px; transform:translate(' + c.x + 'px,' + c.y + 'px);'
          + ' animation:pet_confetti 1.4s ease-out infinite ' + (i * 0.18) + 's;'
          + ' --cdx:' + c.dx + 'px; --cdy:' + c.dy + 'px;"></div>'
        ).join('')
      + '</div>';
  }
  petOverlayEl.innerHTML = html;
}

function cyclePetMood() {
  petMoodIdx = (petMoodIdx + 1) % PET_MOODS.length;
  localStorage.setItem('petMoodIdx', String(petMoodIdx));
  renderPetBody();
}

function togglePetStyle() {
  petStyle = (petStyle === 'pixel') ? 'ascii' : 'pixel';
  localStorage.setItem('petStyle', petStyle);
  renderPetBody();
}

// Position: restore from localStorage if previously dragged. Otherwise keep
// the CSS default (bottom-right). We use left/top in inline style after first
// drag, clearing right/bottom.
function applyPetPos() {
  let pos = null;
  try { pos = JSON.parse(localStorage.getItem('petPos') || 'null'); } catch (_) {}
  if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
    const w = petEl.offsetWidth || 64;
    const h = petEl.offsetHeight || 78;
    const left = Math.max(0, Math.min(window.innerWidth - w, pos.left));
    const top = Math.max(0, Math.min(window.innerHeight - h, pos.top));
    petEl.style.left = left + 'px';
    petEl.style.top = top + 'px';
    petEl.style.right = 'auto';
    petEl.style.bottom = 'auto';
  }
}

// Drag wiring. mousedown → record start; track movement; if moved beyond
// threshold, follow mouse and on mouseup advance mood. If under threshold,
// treat as a click (toggle panel).
let dragState = null;
const DRAG_THRESHOLD = 5;
petEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const rect = petEl.getBoundingClientRect();
  dragState = {
    startX: e.clientX, startY: e.clientY,
    offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
    moved: false,
  };
  e.preventDefault();
});
document.addEventListener('mousemove', (e) => {
  if (!dragState) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  if (!dragState.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
  if (!dragState.moved) {
    dragState.moved = true;
    petEl.classList.add('dragging');
  }
  const w = petEl.offsetWidth, h = petEl.offsetHeight;
  const left = Math.max(0, Math.min(window.innerWidth  - w, e.clientX - dragState.offsetX));
  const top  = Math.max(0, Math.min(window.innerHeight - h, e.clientY - dragState.offsetY));
  petEl.style.left = left + 'px';
  petEl.style.top  = top  + 'px';
  petEl.style.right = 'auto';
  petEl.style.bottom = 'auto';
});
document.addEventListener('mouseup', () => {
  if (!dragState) return;
  const moved = dragState.moved;
  petEl.classList.remove('dragging');
  if (moved) {
    // Persist position and advance mood.
    localStorage.setItem('petPos', JSON.stringify({
      left: parseFloat(petEl.style.left) || 0,
      top:  parseFloat(petEl.style.top)  || 0,
    }));
    cyclePetMood();
    // Re-anchor panel if it's open.
    if (petPanelEl.classList.contains('show')) positionPanel();
  } else {
    // No drag → treat as click: toggle panel.
    if (petPanelEl.classList.contains('show')) closePanel();
    else openPanel();
  }
  dragState = null;
});

petStyleToggleEl.addEventListener('click', togglePetStyle);

// Briefly switch the pet to "celebrating" then restore. Called on submit
// success, comment save, and the Cmd+; panel-toggle shortcut.
function celebratePet() {
  const prevIdx = petMoodIdx;
  petMoodIdx = PET_MOODS.indexOf('celebrating');
  renderPetBody();
  setTimeout(() => {
    petMoodIdx = prevIdx;
    renderPetBody();
  }, 1500);
}

function renderPetPanel() {
  if (!comments.length) {
    petCmtsEl.innerHTML = '<div class="empty">Select any text in the md and submit comment.</div>';
  } else {
    petCmtsEl.innerHTML = '';
    [...comments].sort((a, b) => a.num - b.num).forEach(c => {
      const div = document.createElement('div');
      div.className = 'pet-cmt'
        + (c.orphan ? ' orphan' : '')
        + (c.submitted ? ' submitted' : '');
      div.dataset.cmtId = c.id;
      const num = document.createElement('span'); num.className = 'num'; num.textContent = c.num;
      const body = document.createElement('div'); body.className = 'body';
      const prev = document.createElement('div'); prev.className = 'preview';
      prev.title = 'Click to scroll to the highlighted text';
      prev.textContent = (c.orphan ? '⚠ (drifted) ' : '') + (c.anchorText || '(no anchor)');
      prev.addEventListener('click', () => {
        if (annotator && c.annotation && c.annotation.id) {
          try { annotator.scrollIntoView(c.annotation); return; } catch (_) {}
        }
      });
      const txt = document.createElement('div'); txt.className = 'text'; txt.textContent = c.text;
      txt.title = 'Click to edit';
      txt.style.cursor = 'text';
      txt.addEventListener('click', () => {
        openPopoverEdit(c, c.annotation || null);
      });
      body.appendChild(prev); body.appendChild(txt);
      const del = document.createElement('span'); del.className = 'del'; del.title = 'Delete'; del.textContent = '×';
      del.addEventListener('click', () => {
        if (c.annotation && c.annotation.id && annotator) {
          try { annotator.removeAnnotation(c.annotation.id); } catch (_) {}
        }
        comments = comments.filter(x => x.id !== c.id);
        saveComments();
        renderPetPanel();
        renderInlineBubbles();
      });
      div.appendChild(num); div.appendChild(body); div.appendChild(del);
      petCmtsEl.appendChild(div);
    });
  }
  updatePetBadge();
}

let _lastBadgeCount = 0;
function updatePetBadge() {
  const n = comments.length;
  if (n > 0) {
    petBadgeEl.textContent = String(n);
    petBadgeEl.classList.add('show');
    if (n !== _lastBadgeCount) {
      petBadgeEl.classList.remove('pulse');
      void petBadgeEl.offsetWidth;
      petBadgeEl.classList.add('pulse');
    }
  } else {
    petBadgeEl.classList.remove('show');
  }
  _lastBadgeCount = n;
}

// Anchor panel to pet — open up-and-left from the pet's bounding rect, clamped
// to the viewport. Falls back to bottom-right defaults if no pet pos yet.
function positionPanel() {
  if (!petPanelEl) return;
  const petRect = petEl.getBoundingClientRect();
  // Measure panel size: temporarily make it visible-but-hidden to get size.
  const wasShown = petPanelEl.classList.contains('show');
  if (!wasShown) {
    petPanelEl.style.visibility = 'hidden';
    petPanelEl.classList.add('show');
  }
  const pw = petPanelEl.offsetWidth || 380;
  const ph = petPanelEl.offsetHeight || 420;
  if (!wasShown) {
    petPanelEl.classList.remove('show');
    petPanelEl.style.visibility = '';
  }
  const margin = 8;
  // Prefer above and aligned to pet's right edge.
  let top = petRect.top - ph - margin;
  if (top < margin) top = petRect.bottom + margin;
  if (top + ph > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - ph - margin);
  let left = petRect.right - pw;
  if (left < margin) left = margin;
  if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
  petPanelEl.style.left = left + 'px';
  petPanelEl.style.top = top + 'px';
  petPanelEl.style.right = 'auto';
  petPanelEl.style.bottom = 'auto';
}

function openPanel() {
  positionPanel();
  petPanelEl.classList.add('show');
  pollReviewStateNow();
}
function closePanel() { petPanelEl.classList.remove('show'); }

// Poll the latest review folder's .state while there are submitted comments
// in the UI. As soon as the agent flips it to done, the message handler
// drops those comments. Cheap: one readdir + one tiny readFile every 5s,
// and ONLY while submitted comments exist (otherwise the timer is a no-op).
let _reviewStateTimer = null;
function pollReviewStateNow() {
  if (currentPath && comments.some(c => c.submitted)) {
    vscode.postMessage({ type: 'getReviewState', path: currentPath });
  }
}
_reviewStateTimer = setInterval(pollReviewStateNow, 5000);

// Initial paint + restore position.
renderPetBody();
applyPetPos();
petCloseEl.addEventListener('click', closePanel);

petInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    submitReview();
  }
});

petSendEl.addEventListener('click', submitReview);

async function submitReview() {
  const msg = (petInputEl.value || '').trim();
  if (!msg && comments.length === 0) {
    toast('Type a message or add at least one comment');
    return;
  }
  // Refresh state right before submit — if the agent finished while we
  // were elsewhere, the previous-batch dimmed comments get cleared first
  // so we don't accidentally re-submit them in the new folder.
  pollReviewStateNow();
  // Strip live DOM Range/HTMLElement refs so postMessage can clone the
  // payload (and the extension can JSON.stringify it into comments.json).
  const stripLive = (k, v) => (k === 'range' || k === 'offsetReference') ? undefined : v;

  // Capture one PNG per drawing while the live view still has them all
  // rendered. Done before postMessage so the images are part of the
  // single submit transaction. captureDrawingsAsPng never throws — if
  // html2canvas is missing/blocked, returns [].
  let drawingImages = [];
  if (Array.isArray(drawings) && drawings.length) {
    toast('Capturing ' + drawings.length + ' drawing(s)…');
    try { drawingImages = await captureDrawingsAsPng(drawings); }
    catch (e) { dbg('captureDrawingsAsPng failed', String(e)); }
  }

  const payload = {
    path: currentPath,
    absPath: currentAbsPath,
    message: msg,
    comments: comments.map(c => ({
      id: c.id,
      num: c.num,
      anchorText: c.anchorText,
      orphan: !!c.orphan,
      text: c.text,
      ts: c.ts,
      lineStart: c.lineStart || null,
      lineEnd: c.lineEnd || null,
      annotation: c.annotation
        ? JSON.parse(JSON.stringify(c.annotation, stripLive))
        : null,
    })),
    drawings: Array.isArray(drawings) ? drawings : [],
    // Per-drawing PNG snapshots — base64 data URLs. Extension decodes and
    // writes drawN.png next to prompt.md so vision agents can actually see
    // the drawing in context.
    drawingImages,
    ts: Date.now(),
  };
  vscode.postMessage({ type: 'submitReview', payload });
  petInputEl.value = '';
  toast('Submitting & copying to clipboard…');
}

// Wire render hooks so comments load + Recogito re-attaches when the view
// changes. Re-init is required because the previous main DOM the
// annotator bound to has been replaced.
const _origRender3 = render;
render = function (path) {
  const f = FILES[path];
  const willRender = !!(f && f.kind === 'md');
  const r = _origRender3(path);
  if (!willRender) return r;
  currentPath = path;
  currentAbsPath = null;
  loadComments(path);
  loadStrokes(path);
  initAnnotator();
  initSvgLayer();
  renderPetPanel();
  // Check if the agent finished the previous review for this file while we
  // were viewing something else — clears dimmed comments before any new
  // edits land on top.
  pollReviewStateNow();
  // Default mode = view (read-only). User explicitly clicks Edit / Review /
  // Draw to opt in. Sessions also stay in view.
  refreshModeToolbar();
  return r;
};
const _origRenderOverview3 = renderOverview;
renderOverview = function (absPath, overview) {
  const r = _origRenderOverview3(absPath, overview);
  currentPath = (overview && overview.path) ? overview.path : absPath;
  currentAbsPath = absPath;
  loadComments(currentPath);
  loadStrokes(currentPath);
  initAnnotator();
  initSvgLayer();
  renderPetPanel();
  pollReviewStateNow();
  return r;
};

// Receive extension responses (submit ack, history list, etc.).
window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'reviewSubmitted') {
    // Keep UI state (comments + strokes) so the user can iterate while the
    // folder is still in todo state — next Submit-and-Copy overwrites the
    // same folder with the updated full state. User clears manually.
    // Dim everything we just handed off so newly added/edited comments
    // stand out as still pending.
    comments.forEach(c => { c.submitted = true; });
    saveComments();
    renderPetPanel();
    try { renderInlineBubbles(); } catch (_) {}
    const verb = m.reused ? 'Updated' : 'Wrote';
    const clipNote = m.clipboard ? ' · copied to clipboard' : '';
    const label = verb + ' ' + (m.relPath || m.path) + clipNote;
    if (m.path && m.path !== '(no file)') {
      toastWithAction(label, 'Open', () => {
        vscode.postMessage({ type: 'openFile', path: m.path });
      });
    } else {
      toast(label);
    }
    // Celebrate: pet does its bounce animation.
    celebratePet();
  } else if (m.type === 'reviewError') {
    toast('Submit failed: ' + m.error);
  } else if (m.type === 'reviewStateUpdate') {
    // Agent has reached the done state for the latest review folder of
    // this src. Drop the comments we previously dimmed (they've been
    // addressed) and their inline highlights so the UI is clean.
    if (m.state === 'done' && m.path === currentPath) {
      const toRemove = comments.filter(c => c.submitted);
      if (toRemove.length) {
        toRemove.forEach(c => {
          if (c.annotation && c.annotation.id && annotator) {
            try { annotator.removeAnnotation(c.annotation.id); } catch (_) {}
          }
        });
        comments = comments.filter(c => !c.submitted);
        // Renumber survivors 1..N and reset the counter — otherwise a new
        // comment after a done-cleanup would be numbered something like
        // "### 7", but it's actually the first one of a fresh review pass.
        comments
          .sort((a, b) => (a.num || 0) - (b.num || 0))
          .forEach((c, i) => { c.num = i + 1; });
        nextCommentNum = comments.length + 1;
        saveComments();
        renderPetPanel();
        try { renderInlineBubbles(); } catch (_) {}
        toast('Agent finished — cleared ' + toRemove.length + ' submitted comment(s)');
      }
    }
  } else if (m.type === 'reviewHistoryList') {
    showReviewHistory(m.specPath, m.entries);
  } else if (m.type === 'reviewSnapshot') {
    showReviewSnapshot(m);
  } else if (m.type === 'saveFileDone') {
    toast('Saved ' + m.path);
  } else if (m.type === 'saveFileError') {
    toast('Save failed: ' + m.error);
  }
});

// Render the "Past reviews on this file" view. Each row's primary action
// is "view" — opens the rendered snapshot inline (source-at-submit-time
// with the comments laid out as inline bubbles). The raw .md files and
// the diff stay one click away.
function showReviewHistory(filePath, entries) {
  if (!entries || !entries.length) {
    main.innerHTML = '<div class="filename">' + (filePath || '') + '</div>'
      + '<h1>Past reviews</h1>'
      + '<p style="color:var(--g500)">No reviews submitted yet for this file. Select text and use the 💬 toolbar to start one.</p>';
    return;
  }
  const th = (label) => '<th style="text-align:left; padding:6px 14px; border-bottom:1.5px solid var(--g300); font-size:11px; letter-spacing:0.06em; text-transform:uppercase; color:var(--g500);">' + label + '</th>';
  let html = '<div class="filename">' + (filePath || '') + '</div>';
  html += '<h1>Past reviews</h1>';
  html += '<p style="color:var(--g500); font-family:var(--mono); font-size:12px">'
    + entries.length + ' review(s) — newest first</p>';
  html += '<table style="font-family:var(--mono); font-size:13px; border-collapse:collapse; margin-top:16px;">';
  html += '<thead><tr>' + th('When') + th('Message') + th('Actions') + '</tr></thead><tbody>';
  entries.forEach((e, i) => {
    const preview = (e.preview || '—')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    html += '<tr>'
      + '<td style="padding:8px 14px 8px 0; white-space:nowrap; color:var(--g700);">' + e.ts + '</td>'
      + '<td style="padding:8px 14px; color:var(--g700);">' + preview + '</td>'
      + '<td style="padding:8px 0 8px 14px; white-space:nowrap;">'
      +   '<a href="#" data-snapshot-i="' + i + '" style="color:var(--clay); font-weight:600;">view</a>'
      +   ' · '
      +   '<span style="color:var(--g500); font-size:11px;">raw:</span> '
      +   '<a href="#" data-review-open="' + e.promptPath + '" style="color:var(--g500);">prompt.md</a>'
      +   ' · '
      +   '<a href="#" data-review-open="' + e.sourcePath + '" style="color:var(--g500);">source.md</a>'
      +   ' · '
      +   '<a href="#" data-review-diff="' + e.sourcePath + '" data-target="' + filePath + '" style="color:var(--g500);">diff vs current</a>'
      + '</td>'
      + '</tr>';
  });
  html += '</tbody></table>';
  main.innerHTML = html;

  // Stash entries on the webview side so the click handler doesn't have to
  // round-trip back to the extension to know which review to load.
  main.querySelectorAll('a[data-snapshot-i]').forEach(a => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const e = entries[parseInt(a.dataset.snapshotI, 10)];
      if (!e) return;
      vscode.postMessage({
        type: 'requestReviewSnapshot',
        targetPath: filePath,
        ts: e.ts,
        sourcePath: e.sourcePath,
        promptPath: e.promptPath,
      });
    });
  });
  main.querySelectorAll('a[data-review-open]').forEach(a => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      vscode.postMessage({ type: 'openFile', path: a.dataset.reviewOpen });
    });
  });
  main.querySelectorAll('a[data-review-diff]').forEach(a => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      vscode.postMessage({
        type: 'openDiff',
        leftPath: a.dataset.reviewDiff,
        rightRelPath: a.dataset.target,
      });
    });
  });
}

// Snapshot view — renders the source-at-submit-time as HTML and lays out
// each saved comment as an inline [💬 text] bubble at its original anchor.
// Read-only: the selection→popover create flow is suppressed while
// snapshotMode is on (no point letting users comment a frozen snapshot).
let snapshotMode = false;

function showReviewSnapshot(data) {
  if (data.error) {
    main.innerHTML = '<h1>Snapshot</h1><p style="color:var(--clay)">Failed: ' + data.error + '</p>';
    return;
  }
  snapshotMode = true;
  activeRange = null;
  clearPreviewHighlight();
  if (cmtPopover.classList.contains('show')) closePopover();
  // We don't run Recogito here — destroying the live annotator avoids
  // confusing clicks on overlays meant for the live view.
  if (annotator) { try { annotator.destroy(); } catch (_) {} annotator = null; }

  // Marked is server-side only; ask the extension to pre-render? Simpler:
  // ship the raw markdown and let our own minimal renderer handle it.
  // Actually we don't bundle marked client-side — but the live view also
  // doesn't. The server pre-rendered HTML lives in FILES[path].html. For
  // the snapshot we don't have that; fall back to a <pre> rendering of
  // the raw source unless data.sourceHtml is provided.
  let bodyHtml;
  if (data.sourceHtml) {
    bodyHtml = data.sourceHtml;
  } else {
    bodyHtml = '<pre style="white-space:pre-wrap; font-family:var(--mono); font-size:13px; color:var(--g700);">'
      + escapeHtml(data.sourceMd || '') + '</pre>';
  }
  const backLabel = (data.targetPath || 'file').split('/').pop();
  const header =
    '<div class="filename" style="display:flex; justify-content:space-between; align-items:center;">'
    + '<span><a href="#" data-snapshot-back="1" style="color:var(--clay); text-decoration:none;">← back to ' + escapeHtml(backLabel) + '</a>'
    + ' &nbsp;·&nbsp; snapshot @ ' + (data.ts || '') + '</span>'
    + '<span style="font-size:11px; color:var(--g500);">' + (data.comments || []).length + ' comment(s)</span>'
    + '</div>';
  // Wrap the snapshot body in .md-body — same container the live view
  // uses, so saved offsets revive at the exact same positions.
  main.innerHTML = header + '<div class="md-body">' + bodyHtml + '</div>';
  const mdBody = main.querySelector('.md-body');

  // Revive each saved annotation against .md-body (NOT main — main's
  // header content differs between live and snapshot views, which would
  // shift the character offsets).
  const arr = Array.isArray(data.comments) ? data.comments : [];
  const ranges = [];
  for (const c of arr) {
    if (!c.annotation || !c.annotation.target) continue;
    let ann;
    try {
      ann = (window.RecogitoJS && RecogitoJS.reviveAnnotation)
        ? RecogitoJS.reviveAnnotation(c.annotation, mdBody)
        : c.annotation;
    } catch (_) { continue; }
    // Clone the range BEFORE splitText mutates the DOM (defensive — DOM
    // Ranges live-update, but a clone removes any chance of surprises).
    const r = ann && ann.target && ann.target.selector && ann.target.selector[0]
      && ann.target.selector[0].range;
    if (r) ranges.push(r.cloneRange());
    insertSnapshotBubble(c, ann);
  }
  // Paint every anchor in one CSS Custom Highlight pass.
  if (ranges.length && window.CSS && CSS.highlights && typeof Highlight !== 'undefined') {
    try { CSS.highlights.set('snapshot-anchor', new Highlight(...ranges)); }
    catch (_) {}
  }

  // Re-render any saved freehand drawings on top of the snapshot body —
  // same SVG overlay we use in the live view, just read-only here. New
  // payload shape: drawings = [{label, strokes:[]}, ...]. Fall back to
  // the legacy flat strokes array for reviews submitted before the
  // labeled-drawings refactor.
  const snapDrawings = Array.isArray(data.strokes) ? data.strokes : [];
  const flatStrokes = [];
  for (const d of snapDrawings) {
    if (d && Array.isArray(d.strokes)) {
      for (const s of d.strokes) flatStrokes.push({ ...s, _drawLabel: d.label });
    } else if (d && d.points) {
      flatStrokes.push(d);  // legacy flat stroke
    }
  }
  if (flatStrokes.length) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'md-strokes');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    mdBody.appendChild(svg);
    renderStrokesInto(svg, flatStrokes);
  }

  main.querySelector('a[data-snapshot-back]').addEventListener('click', (ev) => {
    ev.preventDefault();
    snapshotMode = false;
    if (window.CSS && CSS.highlights) {
      try { CSS.highlights.delete('snapshot-anchor'); } catch (_) {}
    }
    if (currentPath) render(currentPath);
  });
}

function insertSnapshotBubble(c, ann) {
  const sel = ann && ann.target && ann.target.selector && ann.target.selector[0];
  if (!sel || !sel.range) return;
  const bubble = document.createElement('span');
  bubble.className = 'cmt-inline';
  bubble.title = c.anchorText || '';
  const icon = document.createElement('span');
  icon.className = 'cmt-inline-icon';
  icon.textContent = '💬';
  const txt = document.createElement('span');
  txt.className = 'cmt-inline-text';
  txt.textContent = c.text || '';
  bubble.appendChild(icon);
  bubble.appendChild(txt);
  try {
    const r = sel.range;
    let node = r.endContainer;
    const offset = r.endOffset;
    if (node.nodeType === 3) {
      if (offset > 0 && offset < node.length) node.splitText(offset);
      if (offset === 0) node.parentNode.insertBefore(bubble, node);
      else node.parentNode.insertBefore(bubble, node.nextSibling);
    } else {
      const ref = node.childNodes[offset];
      node.insertBefore(bubble, ref || null);
    }
  } catch (_) { /* anchor drifted; skip */ }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// =============================================================================
// Draw mode — freehand SVG overlay on .md-body. Strokes persist in
// localStorage live; on submitReview they get serialized into draws.json
// alongside comments.json so the snapshot view can re-render them.
// v1: absolute coords (no per-paragraph anchoring), single color/width.
// =============================================================================

// drawMode is declared earlier (top-of-script) so render() can read it.
// Each Draw → Done cycle creates one *drawing* — a labeled group of
// strokes. drawings[] holds finished ones (draw1, draw2, ...). While in
// draw mode, currentDrawing.strokes accumulates the in-progress strokes;
// only on Done are they bundled into a new entry in drawings[].
let drawings = [];         // [{ label: 'draw1', strokes: [...] }, ...]
let currentDrawing = null; // { strokes: [...] } during draw mode, else null
let currentStroke = null;  // single stroke being dragged
let svgLayer = null;       // the <svg> element inside .md-body

function strokesKey(p) { return 'drawings:' + (p || '_global_'); }

function loadStrokes(p) {
  if (!p) { drawings = []; return; }
  let raw = [];
  try { raw = JSON.parse(localStorage.getItem(strokesKey(p)) || '[]'); }
  catch (_) { raw = []; }
  // Backward compat: older versions stored a flat array of strokes; wrap
  // it as a single "draw1" drawing if we see that shape.
  if (Array.isArray(raw) && raw.length && raw[0] && raw[0].points && !raw[0].strokes) {
    drawings = [{ label: 'draw1', strokes: raw }];
  } else {
    drawings = Array.isArray(raw) ? raw : [];
  }
}
function saveStrokes() {
  if (!currentPath) return;
  localStorage.setItem(strokesKey(currentPath), JSON.stringify(drawings));
}

// All strokes currently on the page, tagged with their owning drawing's
// label + offset so render can apply the group offset and so hover/drag
// can identify which drawing a path belongs to.
function allStrokes() {
  const out = [];
  for (const d of drawings) {
    const off = d.offset || { dx: 0, dy: 0 };
    for (const s of d.strokes || []) {
      out.push({ ...s, _drawLabel: d.label, _drawOffset: off });
    }
  }
  if (currentDrawing) {
    const off = currentDrawing.offset || { dx: 0, dy: 0 };
    for (const s of currentDrawing.strokes || []) {
      out.push({ ...s, _drawLabel: '(pending)', _drawOffset: off });
    }
  }
  return out;
}

// Pick the next label like draw1/draw2/… that isn't already used.
function nextDrawingLabel() {
  const used = new Set(drawings.map(d => d.label));
  let n = drawings.length + 1;
  while (used.has('draw' + n)) n++;
  return 'draw' + n;
}

function pointsToPath(pts) {
  if (!pts || !pts.length) return '';
  let d = 'M ' + pts[0][0] + ' ' + pts[0][1];
  for (let i = 1; i < pts.length; i++) d += ' L ' + pts[i][0] + ' ' + pts[i][1];
  return d;
}

// Block-level elements we'll anchor strokes to (closest to where the
// user started drawing). Mirrors the comment-anchor candidates but adds
// table/code-block so a stroke on a table still has a parent to track.
const STROKE_ANCHOR_SEL = 'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, table, ul, ol';

// Walk up from the element under (absX, absY) inside .md-body to the
// nearest block-level ancestor. Returns that element, or .md-body itself
// if nothing better fits.
function findAnchorBlock(absX, absY) {
  const mdBody = main && main.querySelector('.md-body');
  if (!mdBody) return null;
  const rect = mdBody.getBoundingClientRect();
  const el = document.elementFromPoint(absX + rect.left, absY + rect.top);
  if (!el || !mdBody.contains(el)) return mdBody;
  let block = el;
  while (block && block !== mdBody && !block.matches(STROKE_ANCHOR_SEL)) {
    block = block.parentElement;
  }
  return (block && block !== mdBody) ? block : mdBody;
}

// Find a saved anchor's block in the current DOM by matching its quote
// (first ~80 chars of text content). Returns null if the paragraph was
// removed/edited beyond recognition — caller can fall back to last-known
// position.
function findElementByAnchorQuote(quote) {
  const mdBody = main && main.querySelector('.md-body');
  if (!mdBody || !quote) return null;
  const candidates = mdBody.querySelectorAll(STROKE_ANCHOR_SEL);
  for (const el of candidates) {
    if ((el.textContent || '').trim().slice(0, 80) === quote) return el;
  }
  return null;
}

// Convert storage format (anchor + relative points + drawing offset) →
// absolute coords inside .md-body that the SVG layer can render. Falls
// back to the saved absolute origin if the anchor element can no longer
// be located. _drawOffset (set by allStrokes) translates every stroke
// in a drawing together when the user drags it.
function expandStrokes(strokeList) {
  const mdBody = main && main.querySelector('.md-body');
  if (!mdBody) return strokeList || [];
  const mdRect = mdBody.getBoundingClientRect();
  return (strokeList || []).map(s => {
    const off = s._drawOffset || { dx: 0, dy: 0 };
    if (!s.anchor) {
      // Legacy / unanchored = already absolute; just apply drag offset.
      return {
        ...s,
        points: (s.points || []).map(([x, y]) => [x + off.dx, y + off.dy]),
      };
    }
    let ax = s.anchor.ax || 0;
    let ay = s.anchor.ay || 0;
    const el = findElementByAnchorQuote(s.anchor.quote);
    if (el) {
      const r = el.getBoundingClientRect();
      ax = r.left - mdRect.left;
      ay = r.top - mdRect.top;
    }
    return {
      ...s,
      points: (s.points || []).map(([x, y]) => [
        x + ax + off.dx,
        y + ay + off.dy,
      ]),
    };
  });
}

function renderStrokesInto(svgEl, strokeList) {
  if (!svgEl) return;
  svgEl.innerHTML = '';
  // expandStrokes turns stored relative coords into absolute SVG coords.
  // For each stroke we emit two sibling paths: a wide invisible hit-area
  // (clickable in draw mode → deletes the stroke) and then the visible
  // stroke. Order matters so .md-stroke-hit:hover + path can paint a
  // hover preview color on the visible sibling.
  for (const s of expandStrokes(strokeList)) {
    const d = pointsToPath(s.points);
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'md-stroke-hit');
    hit.dataset.strokeId = s.id;
    if (s._drawLabel) hit.dataset.drawLabel = s._drawLabel;
    svgEl.appendChild(hit);
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    if (s.color) p.setAttribute('stroke', s.color);
    if (s.width) p.setAttribute('stroke-width', String(s.width));
    p.dataset.strokeId = s.id;
    if (s._drawLabel) p.dataset.drawLabel = s._drawLabel;
    svgEl.appendChild(p);
  }
}

// Create (or refresh) the SVG overlay inside .md-body and re-render all
// strokes for currentPath. Called from the render hook and from draw-mode
// mutations.
function initSvgLayer() {
  if (!main) return;
  const mdBody = main.querySelector('.md-body');
  if (!mdBody) { svgLayer = null; return; }
  // Tear down any leftover from a prior render.
  mdBody.querySelectorAll('.md-strokes').forEach(el => el.remove());
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'md-strokes');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  // viewBox spans the document; preserveAspect off so coords are 1:1 px.
  mdBody.appendChild(svg);
  svgLayer = svg;
  renderStrokesInto(svgLayer, allStrokes());
}

function localPointFromEvent(e) {
  // Coords relative to .md-body's top-left. Use offsetLeft/offsetTop walk
  // since getBoundingClientRect would shift on scroll (and we want stable
  // stroke coords as the page scrolls).
  const mdBody = main.querySelector('.md-body');
  const r = mdBody.getBoundingClientRect();
  return [
    Math.round(e.clientX - r.left),
    Math.round(e.clientY - r.top),
  ];
}

function onStrokePointerDown(e) {
  if (!drawMode || e.button !== 0) return;
  // Always start a tentative stroke — even when pressing on an existing
  // stroke's hit-area. We tell click-from-drag apart on pointerup: tiny
  // movement = it was a click → select the underlying stroke; otherwise
  // = the user was drawing, finalize the new stroke. This keeps "draw
  // a new stroke that crosses an old one" working.
  hideStrokeChip();
  e.preventDefault();
  svgLayer.setPointerCapture(e.pointerId);
  const [x, y] = localPointFromEvent(e);
  const hitId = (e.target && e.target.dataset && e.target.dataset.strokeId) || null;
  currentStroke = {
    id: 's-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    points: [[x, y]],
    color: '#cc6b4f',  // coral, matches highlight palette
    width: 2,
    _hitId: hitId,           // remember which stroke (if any) was under cursor
    _downX: x, _downY: y,    // for click-vs-drag detection on pointerup
  };
  // Append a live path that we mutate as the pointer moves.
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', pointsToPath(currentStroke.points));
  p.setAttribute('stroke', currentStroke.color);
  p.setAttribute('stroke-width', String(currentStroke.width));
  p.dataset.strokeId = currentStroke.id;
  svgLayer.appendChild(p);
  currentStroke._el = p;
}

function onStrokePointerMove(e) {
  if (!drawMode || !currentStroke) return;
  const [x, y] = localPointFromEvent(e);
  const last = currentStroke.points[currentStroke.points.length - 1];
  // Skip near-duplicate points to keep paths short.
  if (Math.abs(x - last[0]) < 1 && Math.abs(y - last[1]) < 1) return;
  currentStroke.points.push([x, y]);
  currentStroke._el.setAttribute('d', pointsToPath(currentStroke.points));
}

function onStrokePointerUp(e) {
  if (!drawMode || !currentStroke) return;
  // Click-vs-drag: if the pointer barely moved AND we pressed on an
  // existing stroke, treat as "select for delete" rather than "new stroke".
  const [upX, upY] = localPointFromEvent(e);
  const moved = Math.hypot(upX - currentStroke._downX, upY - currentStroke._downY);
  if (moved < 4 && currentStroke._hitId) {
    if (currentStroke._el) currentStroke._el.remove();
    const hitId = currentStroke._hitId;
    currentStroke = null;
    selectStroke(hitId, e.clientX, e.clientY);
    return;
  }
  // Drop very short "strokes" (taps on empty area); usually accidental clicks.
  if (currentStroke.points.length < 2) {
    if (currentStroke._el) currentStroke._el.remove();
    currentStroke = null;
    return;
  }
  // Anchor the stroke to the nearest block element under its first point,
  // then store points as offsets from that block's top-left. On re-render
  // we look the block up by its text quote and translate back to absolute
  // coords — so when paragraphs shift the strokes follow them.
  const [x0, y0] = currentStroke.points[0];
  const anchorEl = findAnchorBlock(x0, y0);
  const mdBody = main.querySelector('.md-body');
  if (anchorEl && mdBody) {
    const mdRect = mdBody.getBoundingClientRect();
    const aRect = anchorEl.getBoundingClientRect();
    const ax = aRect.left - mdRect.left;
    const ay = aRect.top - mdRect.top;
    currentStroke.anchor = {
      quote: (anchorEl.textContent || '').trim().slice(0, 80),
      ax,  // absolute origin at draw time — fallback if quote drifts
      ay,
    };
    currentStroke.points = currentStroke.points.map(([x, y]) => [x - ax, y - ay]);
  }
  // Drop the live path; the next renderStrokesInto will recreate from
  // the canonical (relative) data.
  if (currentStroke._el) currentStroke._el.remove();
  delete currentStroke._el;
  // Strokes go into the in-progress drawing — NOT directly into the
  // saved drawings array. They only persist (with a label) when the
  // user clicks Done.
  if (!currentDrawing) currentDrawing = { strokes: [] };
  currentDrawing.strokes.push(currentStroke);
  currentStroke = null;
  // Re-render so the just-finalized stroke sits at its anchored position
  // (not the live absolute coords). allStrokes() = finished + in-progress.
  renderStrokesInto(svgLayer, allStrokes());
}

function enterDrawMode() {
  if (drawMode) return;
  if (!currentPath) {
    const saved = (vscode.getState() || {}).path || null;
    dbg('mode-button: no currentPath', {
      hasMain: !!main,
      hasMdBody: !!(main && main.querySelector('.md-body')),
      filenameDivText: main && main.querySelector('.filename')
        ? main.querySelector('.filename').textContent.slice(0, 80)
        : null,
      hasFiles: typeof FILES === 'object' && Object.keys(FILES || {}).length,
      savedState: saved,
      savedInFiles: !!(saved && FILES && FILES[saved]),
      savedKind: saved && FILES && FILES[saved] && FILES[saved].kind,
    });
    toast('Open a file first');
    return;
  }
  const mdBody = main.querySelector('.md-body');
  if (!mdBody || !svgLayer) return;
  drawMode = true;
  // Start a new in-progress drawing. Strokes accumulate here; on Done they
  // get bundled into drawings[] with the next free label (draw1/draw2/…).
  currentDrawing = { strokes: [], offset: { dx: 0, dy: 0 } };
  mdBody.classList.add('draw-mode');
  svgLayer.addEventListener('pointerdown', onStrokePointerDown);
  svgLayer.addEventListener('pointermove', onStrokePointerMove);
  svgLayer.addEventListener('pointerup', onStrokePointerUp);
  svgLayer.addEventListener('pointercancel', onStrokePointerUp);
  const controls = main.querySelector('.edit-controls');
  if (controls) {
    controls.innerHTML =
      '<button data-draw="undo" title="Undo last stroke in this drawing">Undo</button>'
      + '<button data-draw="clear" title="Clear strokes in this drawing only">Clear</button>'
      + '<button class="primary" data-draw="exit" title="Finish this drawing (gets a label like draw1)">Done</button>';
  }
  // Lock the refresh while drawing — same reason as edit mode.
  vscode.postMessage({ type: 'editStart' });
  dbg('draw: enter', { path: currentPath });
}

function exitDrawMode() {
  if (!drawMode) return;
  drawMode = false;
  hideStrokeChip();
  const mdBody = main.querySelector('.md-body');
  if (mdBody) mdBody.classList.remove('draw-mode');
  if (svgLayer) {
    svgLayer.removeEventListener('pointerdown', onStrokePointerDown);
    svgLayer.removeEventListener('pointermove', onStrokePointerMove);
    svgLayer.removeEventListener('pointerup', onStrokePointerUp);
    svgLayer.removeEventListener('pointercancel', onStrokePointerUp);
  }
  currentStroke = null;
  // Finalize the in-progress drawing iff it has strokes; otherwise just
  // discard it. Empty draw sessions don't create empty labels.
  let finishedLabel = null;
  if (currentDrawing && currentDrawing.strokes.length) {
    const label = nextDrawingLabel();
    drawings.push({
      label,
      strokes: currentDrawing.strokes,
      offset: currentDrawing.offset || { dx: 0, dy: 0 },
    });
    saveStrokes();
    finishedLabel = label;
  }
  currentDrawing = null;
  // Re-render so any deleted strokes / re-renumbering takes effect.
  renderStrokesInto(svgLayer, allStrokes());
  refreshModeToolbar();
  vscode.postMessage({ type: 'editEnd' });
  dbg('draw: exit', { drawings: drawings.length, finishedLabel });
  if (finishedLabel) toast('Saved as ' + finishedLabel);
}

function undoStroke() {
  // Undo only affects the in-progress drawing — finished drawings are
  // immutable from inside draw mode (use × to delete a single stroke).
  if (!currentDrawing || !currentDrawing.strokes.length) return;
  currentDrawing.strokes.pop();
  renderStrokesInto(svgLayer, allStrokes());
}

// Two-step delete: clicking a stroke selects it + pops a × chip; clicking
// the chip commits the delete. Selection is purely visual state in
// selectedStrokeId — re-rendering the SVG re-applies the .selected class
// to any path whose dataset.strokeId matches.
let selectedStrokeId = null;
const strokeChipEl = document.getElementById('stroke-chip');

function paintSelection() {
  if (!svgLayer) return;
  svgLayer.querySelectorAll('path.selected').forEach(el => el.classList.remove('selected'));
  if (!selectedStrokeId) return;
  // Style the VISIBLE path (the hit-area is transparent anyway). The
  // visible sibling sits right after the hit sibling in DOM order.
  svgLayer.querySelectorAll('path[data-stroke-id="' + selectedStrokeId + '"]').forEach(el => {
    if (!el.classList.contains('md-stroke-hit')) el.classList.add('selected');
  });
}

function selectStroke(id, clientX, clientY) {
  selectedStrokeId = id;
  paintSelection();
  // Position chip just above-right of the click, clamped to viewport.
  const w = 24, h = 24, gap = 6;
  let left = Math.min(window.innerWidth - w - 8, clientX + gap);
  let top = window.scrollY + Math.max(8, clientY - h - gap);
  strokeChipEl.style.left = left + 'px';
  strokeChipEl.style.top = top + 'px';
  strokeChipEl.classList.add('show');
}

function hideStrokeChip() {
  if (selectedStrokeId === null && !strokeChipEl.classList.contains('show')) return;
  selectedStrokeId = null;
  strokeChipEl.classList.remove('show');
  paintSelection();
}

function commitStrokeDelete() {
  if (!selectedStrokeId) { hideStrokeChip(); return; }
  const id = selectedStrokeId;
  // The stroke might be in the in-progress drawing OR in one of the
  // saved drawings — strip it from wherever it lives.
  if (currentDrawing) {
    currentDrawing.strokes = currentDrawing.strokes.filter(s => s.id !== id);
  }
  let touched = false;
  for (const d of drawings) {
    const before = d.strokes.length;
    d.strokes = (d.strokes || []).filter(s => s.id !== id);
    if (d.strokes.length !== before) touched = true;
  }
  // Drop drawings that ended up empty (cleaned via stroke-by-stroke deletes).
  drawings = drawings.filter(d => d.strokes && d.strokes.length);
  if (touched) saveStrokes();
  hideStrokeChip();
  renderStrokesInto(svgLayer, allStrokes());
}

strokeChipEl.addEventListener('mousedown', (e) => {
  // mousedown so we beat the document-level "click elsewhere → hide" path.
  e.preventDefault();
  e.stopPropagation();
  commitStrokeDelete();
});

// Hide the chip on any click outside it/the strokes (e.g. user changes
// their mind and clicks empty doc area, exits draw mode, etc.).
document.addEventListener('mousedown', (e) => {
  if (!strokeChipEl.classList.contains('show')) return;
  if (e.target === strokeChipEl) return;
  // svgLayer pointerdown already manages selection/draw; let it handle
  // clicks on strokes or empty doc area inside .md-body. Outside main
  // (sidebar, header) — hide chip.
  if (!main.contains(e.target)) hideStrokeChip();
});

// =============================================================================
// PNG snapshot of each drawing — runs on submit so the review folder gets
// drawN.png alongside prompt.md / source.md. We pass each drawing's bounding
// box (in .md-body coords, plus the drawing's offset) to html2canvas so
// the resulting image is tightly cropped to that drawing's region. Other
// drawings that fall in the same crop also show through; that's fine —
// the label tells the agent which one is the focal point.
// =============================================================================

const DRAWING_CAPTURE_PAD = 40;  // px around the strokes' bbox

function drawingBbox(drawing) {
  // Mirror the math expandStrokes does: each stroke's points are relative
  // to its anchor block (which is in turn relative to .md-body). Plus the
  // drawing's drag offset translates everything.
  const mdBody = main && main.querySelector('.md-body');
  if (!mdBody || !drawing || !drawing.strokes || !drawing.strokes.length) return null;
  const mdRect = mdBody.getBoundingClientRect();
  const off = drawing.offset || { dx: 0, dy: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of drawing.strokes) {
    let ax = 0, ay = 0;
    if (s.anchor) {
      ax = s.anchor.ax || 0;
      ay = s.anchor.ay || 0;
      const el = findElementByAnchorQuote(s.anchor.quote);
      if (el) {
        const r = el.getBoundingClientRect();
        ax = r.left - mdRect.left;
        ay = r.top - mdRect.top;
      }
    }
    for (const [x, y] of s.points || []) {
      const X = x + ax + off.dx;
      const Y = y + ay + off.dy;
      if (X < minX) minX = X;
      if (Y < minY) minY = Y;
      if (X > maxX) maxX = X;
      if (Y > maxY) maxY = Y;
    }
  }
  if (!isFinite(minX)) return null;
  // The exported PNG is a standalone image of just this drawing's strokes
  // (no underlying text). Don't clamp to mdBody.scrollWidth/scrollHeight —
  // strokes can legitimately extend beyond mdBody because the SVG layer has
  // overflow:visible, and clamping here was cutting the right/bottom edge
  // off the saved PNG. width/height = full stroke bbox + padding.
  const x = minX - DRAWING_CAPTURE_PAD;
  const y = minY - DRAWING_CAPTURE_PAD;
  const w = (maxX - minX) + DRAWING_CAPTURE_PAD * 2;
  const h = (maxY - minY) + DRAWING_CAPTURE_PAD * 2;
  return { x, y, width: w, height: h };
}

// SVG → PNG via a Blob + Image + canvas. Browser-native, no library
// needed. Resolves to a base64 data URL.
function svgToPngDataUrl(svgStr, width, height) {
  return new Promise((resolve) => {
    const scale = window.devicePixelRatio || 1;
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      } catch (e) { resolve(null); }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

async function captureDrawingsAsPng(drawingList) {
  const out = [];
  for (const d of drawingList) {
    const bb = drawingBbox(d);
    if (!bb) continue;
    // Build an SVG containing just this drawing's strokes, translated so
    // the bbox starts at (0,0). No underlying text — just the marks.
    const expanded = expandStrokes(
      (d.strokes || []).map(s => ({
        ...s,
        _drawOffset: d.offset || { dx: 0, dy: 0 },
      })),
    );
    const paths = expanded.map(s => {
      const pts = (s.points || []).map(([x, y]) => [x - bb.x, y - bb.y]);
      const dAttr = pointsToPath(pts);
      const stroke = (s.color || '#cc6b4f');
      const width = (s.width || 2);
      return '<path d="' + dAttr + '" fill="none" stroke="' + stroke
        + '" stroke-width="' + width
        + '" stroke-linecap="round" stroke-linejoin="round"/>';
    }).join('');
    const svgStr =
      '<svg xmlns="http://www.w3.org/2000/svg"'
      + ' width="' + Math.round(bb.width) + '"'
      + ' height="' + Math.round(bb.height) + '"'
      + ' viewBox="0 0 ' + Math.round(bb.width) + ' ' + Math.round(bb.height) + '">'
      + paths + '</svg>';
    const dataUrl = await svgToPngDataUrl(svgStr, bb.width, bb.height);
    if (dataUrl) out.push({ label: d.label, dataUrl });
  }
  return out;
}

function clearAllStrokes() {
  // Clear in draw mode = wipe only the *in-progress* drawing. Finished
  // drawings (draw1/draw2/…) are untouched — delete those one stroke at
  // a time via the × chip.
  if (!currentDrawing || !currentDrawing.strokes.length) {
    toast('No strokes in this drawing');
    return;
  }
  const n = currentDrawing.strokes.length;
  currentDrawing.strokes = [];
  renderStrokesInto(svgLayer, allStrokes());
  hideStrokeChip();
  toast('Cleared ' + n + ' stroke' + (n === 1 ? '' : 's') + ' from this drawing');
}

// =============================================================================
// Drawing hover label + drag-to-move. Works on every saved drawing (and the
// in-progress one), independent of draw mode. Hover any stroke → its label
// (draw1/draw2/…) floats near the cursor. Click+drag → the whole drawing
// follows the pointer; on release the new offset persists to localStorage.
// =============================================================================
const drawLabelEl = document.getElementById('draw-label');

function findDrawingByLabel(label) {
  if (!label) return null;
  for (const d of drawings) if (d.label === label) return d;
  if (currentDrawing && label === '(pending)') return currentDrawing;
  return null;
}

let drawingDrag = null;  // { drawing, startX, startY, baseDx, baseDy, hasMoved }

document.addEventListener('pointermove', (e) => {
  if (drawingDrag) {
    const dx = drawingDrag.baseDx + (e.clientX - drawingDrag.startX);
    const dy = drawingDrag.baseDy + (e.clientY - drawingDrag.startY);
    drawingDrag.drawing.offset = { dx, dy };
    if (!drawingDrag.hasMoved
        && Math.hypot(e.clientX - drawingDrag.startX, e.clientY - drawingDrag.startY) >= 3) {
      drawingDrag.hasMoved = true;
      const mdBody = main && main.querySelector('.md-body');
      if (mdBody) mdBody.classList.add('drag-active');
    }
    if (drawingDrag.hasMoved) {
      renderStrokesInto(svgLayer, allStrokes());
      drawLabelEl.classList.remove('show');  // hide label while dragging
    }
    return;
  }
  // Plain hover: show / move the floating drawN label.
  const tgt = e.target;
  const label = tgt && tgt.dataset && tgt.dataset.drawLabel;
  if (!label || !svgLayer || !svgLayer.contains(tgt)) {
    drawLabelEl.classList.remove('show');
    return;
  }
  drawLabelEl.textContent = '@' + label;
  drawLabelEl.style.left = (e.clientX + 12) + 'px';
  drawLabelEl.style.top = (window.scrollY + e.clientY + 12) + 'px';
  drawLabelEl.classList.add('show');
});

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const tgt = e.target;
  const label = tgt && tgt.dataset && tgt.dataset.drawLabel;
  if (!label || !svgLayer || !svgLayer.contains(tgt)) return;
  // In draw mode the svgLayer's own pointerdown handles draw/select; let
  // it handle clicks on the hit-area paths. We only intercept here to
  // start dragging when the pointer is on the visible stroke (not the
  // wide invisible hit-area).
  if (drawMode && tgt.classList.contains('md-stroke-hit')) return;
  const drawing = findDrawingByLabel(label);
  if (!drawing) return;
  // Prepare drag — actual movement starts after 3px to distinguish from a
  // plain click (which could be a select-for-delete in draw mode).
  e.preventDefault();
  drawingDrag = {
    drawing,
    startX: e.clientX,
    startY: e.clientY,
    baseDx: (drawing.offset && drawing.offset.dx) || 0,
    baseDy: (drawing.offset && drawing.offset.dy) || 0,
    hasMoved: false,
  };
});

document.addEventListener('pointerup', (e) => {
  if (!drawingDrag) return;
  const moved = drawingDrag.hasMoved;
  const mdBody = main && main.querySelector('.md-body');
  if (mdBody) mdBody.classList.remove('drag-active');
  drawingDrag = null;
  if (moved) {
    saveStrokes();
    renderStrokesInto(svgLayer, allStrokes());
  }
});

// =============================================================================
// Edit mode — Word/Notion-style in-place editing of the rendered markdown.
// Powered by browser contenteditable for the UX, Turndown (MIT) for the
// HTML→markdown round-trip on save.
// =============================================================================

// editMode is declared earlier (top-of-script) so render() can read it.
let turndownService = null;

function getTurndown() {
  if (!turndownService && window.TurndownService) {
    turndownService = new TurndownService({
      headingStyle: 'atx',          // # / ## / ###
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '*',
      strongDelimiter: '**',
    });
    // Drop our inline comment chips — they're UI, not user content.
    turndownService.addRule('drop-cmt-inline', {
      filter: (node) => node.classList && node.classList.contains('cmt-inline'),
      replacement: () => '',
    });
    // Drop Recogito's highlight overlay layer too if it sneaks in.
    turndownService.addRule('drop-r6o-layer', {
      filter: (node) => node.classList
        && (node.classList.contains('r6o-span-highlight-layer')
            || node.classList.contains('r6o-annotation')),
      replacement: () => '',
    });
  }
  return turndownService;
}

// ---- Mode state machine ----------------------------------------------------
// 'view' | 'edit' | 'review' | 'draw'. 'view' is the read-only fallback for
// sessions / overview pages. Real md docs default to 'edit' on render, with
// Review and Draw as opt-in side modes (mutually exclusive with edit).

// reviewMode is declared earlier (top-of-script) so render() can read it.
function currentMode() {
  if (editMode)   return 'edit';
  if (drawMode)   return 'draw';
  if (reviewMode) return 'review';
  return 'view';
}

// Inner HTML of the 3-button toolbar with the active mode highlighted.
// Called from the file header render() + from exit-mode handlers (so the
// pill outline updates without a full re-render).
function modeToolbarHtml() {
  const m = currentMode();
  const cls = (name) => 'class="' + (m === name ? 'active' : '') + '"';
  return ''
    + '<button ' + cls('edit')   + ' data-edit="enter"   title="Click to edit this file in-place">Edit</button>'
    + '<button ' + cls('review') + ' data-review="enter" title="Select text to leave a comment for the agent">Review</button>'
    + '<button ' + cls('draw')   + ' data-draw="enter"   title="Draw / annotate with the pen">Draw</button>';
}
function refreshModeToolbar() {
  const controls = main && main.querySelector('.edit-controls');
  if (controls) controls.innerHTML = modeToolbarHtml();
}

function enterEditMode() {
  if (editMode) return;
  if (!currentPath) {
    const saved = (vscode.getState() || {}).path || null;
    dbg('mode-button: no currentPath', {
      hasMain: !!main,
      hasMdBody: !!(main && main.querySelector('.md-body')),
      filenameDivText: main && main.querySelector('.filename')
        ? main.querySelector('.filename').textContent.slice(0, 80)
        : null,
      hasFiles: typeof FILES === 'object' && Object.keys(FILES || {}).length,
      savedState: saved,
      savedInFiles: !!(saved && FILES && FILES[saved]),
      savedKind: saved && FILES && FILES[saved] && FILES[saved].kind,
    });
    toast('Open a file first');
    return;
  }
  const mdBody = main.querySelector('.md-body');
  if (!mdBody) return;
  if (reviewMode) exitReviewMode();
  editMode = true;
  // Tear down Recogito (its overlay layer intercepts pointer events and
  // would block typing in contenteditable). But KEEP the .cmt-inline
  // bubbles in place as static visual markers — they let you see where
  // comments live while editing, without the coral text-highlight. They
  // get marked contenteditable=false so the cursor can't enter them, and
  // Turndown strips them at save-time so they never leak into the .md.
  // Re-init happens on exitEditMode via render(currentPath).
  if (annotator) { try { annotator.destroy(); } catch (_) {} annotator = null; }
  mdBody.querySelectorAll('.cmt-inline').forEach(el => el.setAttribute('contenteditable', 'false'));
  if (cmtPopover.classList.contains('show')) closePopover();
  clearPreviewHighlight();

  mdBody.setAttribute('contenteditable', 'true');
  mdBody.setAttribute('spellcheck', 'false');
  const controls = main.querySelector('.edit-controls');
  if (controls) {
    controls.innerHTML =
      '<button class="primary" data-edit="save" title="Cmd/Ctrl+S to save">Save</button>'
      + '<button data-edit="cancel" title="Esc to cancel">Cancel</button>';
  }
  setTimeout(() => mdBody.focus(), 0);
  vscode.postMessage({ type: 'editStart' });
  dbg('edit: enter', { path: currentPath });
}

function exitEditMode(rerender) {
  if (!editMode) return;
  editMode = false;
  const mdBody = main.querySelector('.md-body');
  if (mdBody) {
    mdBody.removeAttribute('contenteditable');
    mdBody.removeAttribute('spellcheck');
  }
  vscode.postMessage({ type: 'editEnd' });
  if (rerender && currentPath) {
    // Re-render from FILES (cancel path).
    render(currentPath);
  } else {
    // Save path: don't re-render (we want to keep the user's just-typed
    // content visible until the file-watcher refresh pushes the new
    // version). But DO recreate the annotator + bubbles against the
    // current DOM, otherwise switching to review mode right away would
    // hit the !annotator early-return in refreshFromNativeSelection and
    // silently swallow every selection.
    initAnnotator();
    renderInlineBubbles();
    refreshModeToolbar();
  }
}

// Review mode: drag-to-select pops the comment popover. No contenteditable.
// Locks the file-watcher refresh (same as edit/draw) — without it, any
// stray workspace change while the user is mid-comment would reload the
// webview and wipe the review state + popover.
function enterReviewMode() {
  if (reviewMode) return;
  if (!currentPath) {
    const saved = (vscode.getState() || {}).path || null;
    dbg('mode-button: no currentPath', {
      hasMain: !!main,
      hasMdBody: !!(main && main.querySelector('.md-body')),
      filenameDivText: main && main.querySelector('.filename')
        ? main.querySelector('.filename').textContent.slice(0, 80)
        : null,
      hasFiles: typeof FILES === 'object' && Object.keys(FILES || {}).length,
      savedState: saved,
      savedInFiles: !!(saved && FILES && FILES[saved]),
      savedKind: saved && FILES && FILES[saved] && FILES[saved].kind,
    });
    toast('Open a file first');
    return;
  }
  if (editMode) cancelEdit();
  if (drawMode) exitDrawMode();
  reviewMode = true;
  vscode.postMessage({ type: 'editStart' });
  refreshModeToolbar();
  dbg('review: enter', { path: currentPath });
}
function exitReviewMode() {
  if (!reviewMode) return;
  reviewMode = false;
  if (cmtPopover.classList.contains('show')) closePopover();
  clearPreviewHighlight();
  vscode.postMessage({ type: 'editEnd' });
  refreshModeToolbar();
  dbg('review: exit');
}

function saveEdit() {
  if (!editMode) return;
  const mdBody = main.querySelector('.md-body');
  if (!mdBody || !currentPath) { exitEditMode(true); return; }
  const td = getTurndown();
  if (!td) { toast('Turndown not loaded'); return; }
  let markdown;
  try { markdown = td.turndown(mdBody.innerHTML); }
  catch (e) { dbg('turndown failed', String(e)); toast('Convert failed: ' + (e.message || e)); return; }
  dbg('edit: save', { path: currentPath, bytes: markdown.length });
  vscode.postMessage({
    type: 'requestSaveFile',
    path: currentPath,
    content: markdown,
  });
  // Exit edit mode immediately — the file watcher will push the freshly
  // re-rendered content soon (sub-second).
  exitEditMode(false);
  toast('Saving ' + currentPath + '…');
}

function cancelEdit() {
  if (!editMode) return;
  exitEditMode(true);  // re-render from FILES to discard local changes
}

// Event delegation for the Edit / Review / Draw / Save / Cancel buttons
// in the file header. Edit, Review, Draw are mutually exclusive — entering
// one auto-exits the others.
document.addEventListener('click', (e) => {
  const editBtn = e.target && e.target.closest && e.target.closest('[data-edit]');
  if (editBtn) {
    e.preventDefault();
    if (drawMode)   exitDrawMode();
    if (reviewMode) exitReviewMode();
    const action = editBtn.dataset.edit;
    if (action === 'enter') enterEditMode();
    else if (action === 'save') saveEdit();
    else if (action === 'cancel') cancelEdit();
    return;
  }
  const reviewBtn = e.target && e.target.closest && e.target.closest('[data-review]');
  if (reviewBtn) {
    e.preventDefault();
    const action = reviewBtn.dataset.review;
    // Toggle: clicking Review again while already in review mode exits it.
    if (action === 'enter' && reviewMode) { exitReviewMode(); return; }
    if (editMode) cancelEdit();
    if (drawMode) exitDrawMode();
    if (action === 'enter') enterReviewMode();
    return;
  }
  const drawBtn = e.target && e.target.closest && e.target.closest('[data-draw]');
  if (drawBtn) {
    e.preventDefault();
    const action = drawBtn.dataset.draw;
    // Toggle: clicking Draw again while already in draw mode exits it
    // (strokes are auto-saved, no ambiguity).
    if (action === 'enter' && drawMode) { exitDrawMode(); return; }
    if (editMode)   cancelEdit();
    if (reviewMode) exitReviewMode();
    if (action === 'enter') enterDrawMode();
    else if (action === 'exit') exitDrawMode();
    else if (action === 'undo') undoStroke();
    else if (action === 'clear') clearAllStrokes();
    return;
  }
});

// Keyboard shortcuts in edit mode.
document.addEventListener('keydown', (e) => {
  if (!editMode) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    saveEdit();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelEdit();
  }
});

// Initial render, deferred to here so it goes through every wrapper
// (currentPath set, comments + strokes loaded, Recogito booted, mode
// toolbar rendered). The start variable was picked up near the top of
// the script from vscode.getState() — its render is just delayed, not lost.
if (start) render(start);
</script>
</body>
</html>
`;
