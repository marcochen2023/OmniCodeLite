# Omni Code

**Web-based AI Agent / IDE** — a Claude Code equivalent that runs on your own machine.

> 🌐 **Read this in:** [English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

Say one sentence, and the AI figures out the rest: reading and writing files, searching
code, running commands, generating image assets — even operating this IDE's interface
itself. You just watch it get done.

> ⭐ **Self-improvement — the feature that sets Omni Code apart.**
> Omni Code can modify *its own source code*. Switch to **Self-improve mode**, tell it
> what's wrong or what you want ("make the file tree support drag-to-move", "the token
> meter is laggy"), and it will investigate, patch, verify, and record the change into a
> versioned history — *the tool you're reading about built the feature you're reading
> about*. See [§ Self-improvement](#-self-improvement--the-tool-that-builds-itself)
> below. No other local coding agent does this out of the box.

```
┌────────────────────────────────────────────────────────────────┐
│ OmniCode │ D:/xampp/htdocs/myapp │ Claude Sonnet 5 │🧠High│●Manual│12k│
├───┬──────────────┬─────────────────────────┬──────────────────┤
│📁 │ Explorer      │ ● app.js  ● style.css   │ 🤖 Omni Code      │
│🔍 │ ├ app/       │                          │                  │
│🕐 │ │ ├ js/      │  1  'use strict';        │ 🔧 Read app.js    │
│🧠 │ │ │ ├ app.js │  2  function init() {    │ 🔧 Edit app.js    │
│✨ │ │ │ └ ui.js  │  3    ...                │  +12 −3           │
│🧩 │ └ index.html │                          │                  │
│   │              ├──────────────────────────┤ Fixed the login  │
│🖼 │              │ Terminal │ Changes │ Preview│ boundary bug and │
│⚙ │              │ $ npm test               │ verified with    │
│   │              │ ✓ 24 passed              │ tests.           │
│   │              │                          │ [Type a message… ↑]│
└───┴──────────────┴──────────────────────────┴──────────────────┘
```

> 📚 New here: [`docs/INSTALL.md`](docs/INSTALL.md) install & dependency guide ｜
> [`docs/MODELS.md`](docs/MODELS.md) model source list

---

## Quick start

### 1. Requirements

- **XAMPP with PHP 8.2 + Apache** (only `curl` / `json` / `mbstring` / `openssl` extensions needed —
  no composer, no build step, no bundler)
- Any **Claude / OpenAI / Gemini / OpenRouter** API key (stored only in your browser's localStorage)

### 2. Install

1. Copy this folder to `D:/xampp/htdocs/app/OmniCode` (or anywhere under `htdocs`)
2. Start Apache in the XAMPP control panel
3. Open `http://localhost/app/OmniCode/app/`
4. Paste an API key when asked (top-right key icon) — **Claude is recommended for coding**

No `npm install`. No build. The frontend is plain `<script>` tags; the backend is
zero-framework PHP.

### 3. Interface language

The whole UI switches between **English / 繁體中文 / 简体中文 / 日本語 / 한국어**
from the language dropdown at the top of the **Settings** panel. English is the default;
your choice is saved to `data/config.json` and applied before first paint (no flicker).

---

## 🚀 Self-improvement — the tool that builds itself

> Other agents help you build *your* project. Omni Code can rebuild *Omni Code*.

Click the **self-improvement button** in the chat header (or press `Ctrl+Shift+S`) to
switch the workspace to Omni Code's own source tree. From there, just talk:

- "The settings panel is ugly, redesign it like the models panel"
- "Add a Japanese translation for the new dialog"
- "Find the race condition in the terminal output reader"

What happens under the hood:

1. **Scoped workspace** — the Agent's file permissions are pinned to the Omni Code
   install dir, exactly like a project workspace. The safety boundary works the same way.
2. **History & versions** (`data/selfimprove/state.json`) — every completed change is
   logged with title, summary, touched files, and a semver bump
   (`patch` = bugfix, `minor` = feature, `major` = architecture). If the model forgets
   to log, the system files a fallback entry automatically.
3. **Roadmap** — future work lives as versioned items (`v1.0.0: …`). Say "add X to the
   roadmap" and it survives across sessions; completing a roadmap item checks it off
   automatically via `selfimprove_log`.
4. **Self panel** — the button also opens the history & roadmap viewer: past versions,
   what changed, which conversation produced it (one click jumps back to that session).

This README's multilingual version, the settings-panel redesign, the five-language
dictionary itself — all were built this way, by Omni Code, inside Omni Code.

---

## Core concepts

### Workspace — the only file safety boundary

**The workspace can be any folder on disk**, not just folders under Omni Code.
Three ways to switch:

1. Click the folder path in the top bar → browse or paste a path directly
2. `cd` to a folder outside the workspace in the terminal → a "switch here" button appears
3. Sidebar "Settings → Change workspace"

> **Pick a single project's folder, not `htdocs` or a whole drive.**
> The workspace scopes search and the file tree: hundreds of thousands of files will
> make global search time out with partial results (it tells you, but it's unpleasant).
> The default workspace is Omni Code's own folder — a good playground to start.

**Why a workspace at all?** It's Omni Code's only file safety boundary.
The Agent has 100% permissions inside the workspace (create / delete / modify / move);
paths outside it are rejected by the backend. Switch projects by switching workspaces —
one open scope at a time.

### Start

Type anything in the right-side input box:

- "Look at this project's structure"
- "The login validation in app/js has a boundary bug, fix it and add a test"

Prefix with `/` for slash commands (`/doctor` health check, `/compact` compress context,
`/forget <name>` delete a memory, …). Type `@` to mention files, `Shift+Tab` to cycle
permission modes.

### Modes — how much to ask before acting

| Mode | Meaning |
|---|---|
| 📋 Plan | Investigate only: read and search, no writes or commands |
| ● Manual | Ask before writing files or running commands (safest daily mode) |
| ✏️ Auto-edit | File create/modify/delete without asking; commands still ask |
| 🚀 Full-auto | 100%: all file ops, commands, network auto-approved in the workspace |

The boundary always holds: workspace files only, local connections only.

### Effort — reasoning strength

Same grade names as Claude Code (`off` → `max`). Reasoning costs tokens but never
appears in the final answer. Per-model caps are respected automatically.

---

## Left panel tour

| Icon | Panel | What it's for |
|---|---|---|
| 📁 | Explorer | File tree of the workspace |
| 🔍 | Search | Global search (respects workspace scope) |
| 🕐 | Sessions | Conversation history: pin, rename, export, resume, cross-workspace |
| 🧠 | Memory | Local-only memories (`data/memory/`): preferences, corrections, project conventions |
| ✨ | Skills | SKILL.md SOPs the model loads on demand |
| 🧩 | MCP | External tools via MCP servers (filesystem, browser, DB, self-hosted) |
| 🎛 | Models | Text / image model lists, providers, per-1M-token prices |
| 📊 | Token usage | Cost & token analytics with recalculation |
| 🖼 | Image studio | Generate & edit images with the primary image model |
| ⚙ | Settings | Workspace, behavior, permission rules, Sentinel, vault, language |

---

## Safety

- The service only accepts connections from `127.0.0.1`; everything else gets 403
- The Agent's file permissions are strictly limited to your chosen workspace; path
  escapes are rejected by the backend
- The API relay has a domain whitelist — it can't become an open proxy
- API keys live in browser localStorage by default

**Do not expose this service to the public internet.** It's designed to have full
permissions over local files.
