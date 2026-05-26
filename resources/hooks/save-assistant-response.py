#!/usr/bin/env python3
"""Stop hook entry.

Two synchronous, transcript-driven jobs on each Stop:

1. Rebuild prompts.md from the transcript JSONL. Captures top-level user
   prompts AND interrupts (which live as `type=attachment,
   attachment.type=queued_command` and are invisible to UserPromptSubmit).

2. Rebuild responses.md from the transcript JSONL. Groups assistant text by
   preceding user prompt and emits a "first N tokens … last N tokens" extract
   per turn. No LLM call, no subprocess, no buffer — fully local and
   idempotent.

Failures are silent so the hook never blocks the user.
"""
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

HEAD_N = 30               # tokens kept from the start of long responses
TAIL_N = 50               # tokens kept from the end of long responses

# A "token" is either an alphanumeric run or a single CJK character.
TOKEN_RE = re.compile(r"[A-Za-z0-9]+|[一-鿿]")


def _to_local(iso: str, fmt: str) -> str:
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return dt.astimezone().strftime(fmt)
    except Exception:
        return iso[11:19] if len(iso) >= 19 else iso


def _extract_text(content) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = [
            p.get("text", "")
            for p in content
            if isinstance(p, dict) and p.get("type") == "text"
        ]
        return "\n".join(t for t in parts if t.strip()).strip()
    return ""


def head_tail(text: str) -> str:
    """Return 'first HEAD_N tokens [break] last TAIL_N tokens', or the full
    text if short.

    Preserves the original line breaks inside head/tail so markdown structure
    (code fences, lists, paragraphs) renders correctly downstream. Earlier
    versions collapsed all whitespace to single spaces; that produced
    one-line blobs that marked could not parse as code/lists.

    Strips a leading markdown header marker (`#`, `##`, …) from the result so
    the embedded line doesn't re-parse as a heading when rendered inside a
    section that already has its own `## HH:MM:SS` header.

    If the head or tail cuts in the middle of a fenced code block (uneven
    number of ``` markers), append/prepend a matching ``` so the renderer
    doesn't run the entire rest of the document as code.
    """
    text = text.strip()
    matches = list(TOKEN_RE.finditer(text))
    if len(matches) <= HEAD_N + TAIL_N:
        result = text
    else:
        head_end = matches[HEAD_N - 1].end()
        tail_start = matches[-TAIL_N].start()
        head = text[:head_end].strip()
        tail = text[tail_start:].strip()
        if head.count("```") % 2:
            head += "\n```"
        if tail.count("```") % 2:
            tail = "```\n" + tail
        result = f"{head}\n\n.....\n\n{tail}"
    return re.sub(r"^#+\s+", "", result)


_CODE_KEYWORDS = (
    "import ", "export ", "function ", "const ", "let ", "var ", "class ",
    "def ", "return ", "if ", "else ", "for ", "while ", "switch ", "case ",
    "interface ", "type ", "enum ", "public ", "private ", "static ", "async ",
    "await ", "use ", "using ", "package ", "namespace ", "struct ", "impl ",
    "fn ", "pub ", "module ", "from ", "#include", "#define",
)

def _looks_code_line(ln: str) -> bool:
    """Heuristic: does this line look like source code rather than prose?"""
    s = ln.strip()
    if not s:
        return False
    # Any line with even a few CJK characters is almost certainly prose
    # (a comment with a Chinese word counts, but a Chinese sentence does not
    # belong inside a ``` code block).
    cjk = sum(1 for c in s if "一" <= c <= "鿿")
    if cjk >= 3:
        return False
    # Block-comment / JSDoc lines (inc. lone `*`, `/*`, `*/`, `* foo`).
    if s.startswith(("/*", "*/", "//", "* ", "*")) and not s.startswith("**"):
        return True
    if any(s.startswith(k) for k in _CODE_KEYWORDS):
        return True
    # Lines that START with closing brackets or block-end punctuation —
    # `} else {`, `});`, `]`, etc.
    if s[0] in "}])":
        return True
    # Lines ending in code punctuation are almost always code.
    if s.endswith(("{", "}", ";", "(", ")", "[", "]", "=>", ",", ":")):
        return True
    # Density of source-code chars (now includes object/CSS punctuation).
    code_chars = sum(1 for c in s if c in "{}()[]<>;=:,\"")
    if code_chars >= 5:
        return True
    # Indented (typical for nested code) AND contains code punctuation —
    # catches object literals like `  bg: "#F4EFE7",` that don't open with
    # a keyword and don't have many brackets.
    if ln.startswith(("  ", "\t")) and any(c in s for c in "{}()[]<>;:=,\""):
        return True
    return False

def _wrap_code_pastes(text: str) -> str:
    """Wrap unfenced multi-line code pastes in ``` fences so marked() renders
    them as proper code blocks (currently they render as one giant paragraph
    with HTML/JSX/JS bracket soup). Conservative: only wraps a run of >= 8
    consecutive non-blank lines where >= 70% match _looks_code_line. Already
    fenced regions pass through untouched."""
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    in_fence = False
    while i < len(lines):
        if lines[i].strip().startswith("```"):
            in_fence = not in_fence
            out.append(lines[i])
            i += 1
            continue
        if in_fence:
            out.append(lines[i])
            i += 1
            continue
        # Find a contiguous run of lines that's NOT broken by a blank-blank
        # gap and NOT crossing a ``` marker.
        run_start = i
        j = i
        while j < len(lines):
            if lines[j].strip().startswith("```"):
                break
            j += 1
            # paragraph break = 2 consecutive blank lines
            if (j < len(lines) and not lines[j].strip()
                    and j + 1 < len(lines) and not lines[j + 1].strip()):
                break
        run = lines[run_start:j]
        # Trim trailing blanks so the fence sits flush against content.
        while run and not run[-1].strip():
            run.pop()
        if not run:
            out.extend(lines[run_start:j])
            i = j
            continue
        non_blank = [l for l in run if l.strip()]
        code_count = sum(1 for l in non_blank if _looks_code_line(l))
        if len(non_blank) >= 8 and code_count >= 0.7 * len(non_blank):
            out.append("```")
            out.extend(run)
            out.append("```")
        else:
            out.extend(run)
        # Re-emit any trailing blanks we stripped so paragraph structure stays.
        out.extend(lines[run_start + len(run):j])
        i = j
    return "\n".join(out)

def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def rebuild_prompts(transcript_path: str, prompts_file: Path, session_id: str) -> None:
    """Rebuild prompts.md from transcript. Captures interrupts too."""
    if not transcript_path or not os.path.exists(transcript_path):
        return

    entries: list[tuple[str, str, str]] = []  # (ts_iso, kind, text)
    ai_title: str | None = None
    with open(transcript_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = e.get("type")
            ts_iso = e.get("timestamp", "")

            if t == "ai-title":
                title = e.get("aiTitle")
                if title:
                    ai_title = title
                continue

            if t == "user":
                text = _extract_text((e.get("message") or {}).get("content"))
                if text:
                    entries.append((ts_iso, "prompt", text))

            elif t == "attachment":
                att = e.get("attachment") or {}
                if att.get("type") != "queued_command":
                    continue
                texts = [
                    p.get("text", "")
                    for p in att.get("prompt", [])
                    if isinstance(p, dict) and p.get("type") == "text"
                ]
                text = "\n".join(t for t in texts if t.strip()).strip()
                if text:
                    entries.append((ts_iso, "interrupt", text))

    if not entries:
        return

    entries.sort(key=lambda x: x[0])

    # Title precedence:
    #   1. ai-title event in the transcript (old Claude Code behavior).
    #   2. First non-empty user prompt, trimmed (current Claude Code stopped
    #      emitting ai-title to the JSONL once tengu_classifier_summary_*
    #      flags went off, so the transcript no longer carries it).
    #   3. session-<uuid> as a last resort.
    def _first_prompt_title() -> str | None:
        for _, kind, text in entries:
            if kind != "prompt":
                continue
            t = text.strip()
            if not t:
                continue
            # Skip Claude-Code's internal slash-command wrappers:
            #   <command-name>/foo</command-name> <command-message>...
            #   <local-command-stdout>...</local-command-stdout>
            # plus bare slash-commands like /exit /clear /help.
            if t.startswith("<"):
                continue
            if t.startswith("/") and " " not in t.split("\n", 1)[0]:
                continue
            # Use the first non-empty line of the prompt verbatim. A heading
            # has to be one line, but we don't cap the length — long prompts
            # are fine; the sidebar wraps. User prompts themselves are NEVER
            # truncated anywhere (rebuild_prompts writes them in full).
            for ln in t.splitlines():
                ln = ln.strip()
                if ln:
                    return ln
            return None
        return None
    heading = ai_title or _first_prompt_title() or f"session-{session_id}"
    out = [f"# {heading}\n\n"]
    out.append(f"*Session {session_id}*  \n")
    out.append(f"*Started {_to_local(entries[0][0], '%Y-%m-%d %H:%M:%S')}*\n\n")
    for ts, kind, text in entries:
        suffix = " *(interrupt)*" if kind == "interrupt" else ""
        out.append(f"## {_to_local(ts, '%H:%M:%S')}{suffix}\n\n{_wrap_code_pastes(text)}\n\n")

    _atomic_write(prompts_file, "".join(out))


def rebuild_responses(transcript_path: str, responses_file: Path) -> None:
    """Group assistant texts by preceding user prompt, emit head/tail extracts."""
    if not transcript_path or not os.path.exists(transcript_path):
        return

    groups: list[dict] = []
    current: dict | None = None
    with open(transcript_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = e.get("type")

            if t == "user":
                if _extract_text((e.get("message") or {}).get("content")):
                    if current:
                        groups.append(current)
                    current = None
                continue

            if t == "attachment":
                att = e.get("attachment") or {}
                if att.get("type") == "queued_command":
                    if current:
                        groups.append(current)
                    current = None
                continue

            if t == "assistant":
                content = (e.get("message") or {}).get("content") or []
                text = _extract_text(content)
                has_tool = isinstance(content, list) and any(
                    isinstance(p, dict) and p.get("type") == "tool_use" for p in content
                )
                if not text and not has_tool:
                    continue  # thinking-only or empty entry
                if current is None:
                    current = {"ts": e.get("timestamp", ""), "texts": [], "has_tool": False}
                if text:
                    current["texts"].append(text)
                if has_tool:
                    current["has_tool"] = True

    if current:
        groups.append(current)

    if not groups:
        return

    out = ["# Assistant responses (head/tail extracts)\n\n"]
    for g in groups:
        combined = "\n\n".join(g["texts"]).strip()
        if not combined and not g.get("has_tool"):
            continue
        body = head_tail(combined) if combined else "*(tool calls only)*"
        out.append(f"## {_to_local(g['ts'], '%H:%M:%S')}\n\n{body}\n\n")

    _atomic_write(responses_file, "".join(out))


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError:
        return

    session_id = data.get("session_id") or "unknown"
    transcript_path = data.get("transcript_path", "")

    project_dir = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    session_dir = Path(project_dir) / "history" / session_id

    rebuild_prompts(transcript_path, session_dir / "prompts.md", session_id)
    rebuild_responses(transcript_path, session_dir / "responses.md")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
