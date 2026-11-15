# ChatSync — bridge your browser chat ↔ VSCode

ChatSync runs a **localhost-only HTTP server inside VSCode** so a Tampermonkey userscript on
`chat.deepseek.com` (or ChatGPT / Claude / Gemini) can:

- pull **live editor context** into the prompt — active file, selection, Problems panel, open tabs;
- push **AI code blocks back into VSCode** — as a diff preview you approve, or a direct (undoable) edit.

No cloud, no account, no relay. The browser talks to `http://127.0.0.1:3847` on your own machine.

## Quick start

1. Install this extension (`chatsync.vsix`).
2. `Ctrl+Shift+P` → **ChatSync: Save userscript into workspace** → a `chatsync.user.js` file appears
   with your **port and token already filled in**.
3. In Tampermonkey: *Utilities → Import from file* (or drag the file onto the Tampermonkey dashboard).
4. Reload `https://chat.deepseek.com`. A **⌘ button** appears bottom-right → the ChatSync panel.
5. Click **📎 Attach file đang mở** to inject context, then **⚡ Apply to VSCode** on any code block.

Status lives in the VSCode status bar: `$(plug) ChatSync :3847`. Click it for actions.

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | liveness, version, port, token (public, localhost only) |
| GET | `/context/file` | active editor: path, language, selections, content, ready-to-paste `contextText` |
| GET | `/context/errors` | Problems panel (`minSeverity`, `onlyActiveFile`, `limit`) |
| GET | `/context/workspace` | workspace root, folders, open documents |
| GET | `/tabs` | every open tab |
| GET | `/file?path=` | read any workspace file |
| POST | `/apply` | apply a code block (see modes below) |
| POST | `/apply/batch` | `{ applies: [...] }` |
| POST | `/apply/confirm` · `/apply/cancel` | resolve a diff preview by `applyId` |
| GET | `/apply/list` | pending previews |
| GET | `/userscript.js` | the userscript source |
| POST | `/run` · `/terminal` | disabled by default (`chatsync.allowRunCommand`, `chatsync.allowTerminal`) |

`/apply` body:

```jsonc
{
  "path": "src/app.ts",          // optional: relative to workspace, absolute, or just a filename;
                                 // defaults to the active editor
  "mode": "replace",             // replace | replaceSelection | insert | insertAtLine | append
                                 // | patch | lines | newFile
  "content": "```ts\n// code\n```", // markdown fences and a leading `// path/to/file` comment are stripped
  "search": "old code",          // required for mode=patch (must match exactly once, or set replaceAll)
  "line": 10, "endLine": 20,     // for insertAtLine / lines (1-based, inclusive)
  "preview": true,               // open a VSCode diff and wait for confirmation
  "save": false,
  "label": "userscript"
}
```

Auth: send `X-ChatSync-Token: <token>` (or `Authorization: Bearer <token>`, or `?token=`).

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `chatsync.port` | `3847` | busy port → tries the next ones (`portFallbackRange`) |
| `chatsync.host` | `127.0.0.1` | keep it. `0.0.0.0` exposes the bridge to your LAN |
| `chatsync.requireToken` | `true` | turn off only if you understand the risk |
| `chatsync.token` | `""` | empty = stable auto-generated token per machine |
| `chatsync.allowedOrigins` | deepseek/chatgpt/claude/gemini + localhost | `*`, `*.example.com`, `http://localhost:*` supported |
| `chatsync.applyMode` | `diff` | `diff` = preview + approve, `direct` = write immediately (still Ctrl+Z-able) |
| `chatsync.autoSave` | `false` | save after applying |
| `chatsync.maxContextChars` | `60000` | content is truncated with a marker |
| `chatsync.rateLimitPerMinute` | `240` | 429 above that |

## Security model

- Binds to loopback; `Host` header must be loopback (DNS-rebinding guard).
- Origin allowlist + full CORS headers incl. `Access-Control-Allow-Private-Network`.
- Token on every endpoint except `/health`; constant-time comparison.
- Every write is backed up to a temp file and is a single undo step (`Ctrl+Z`).
- Refuses to create files outside the workspace root.
- `/run` and `/terminal` are **off by default**.

## Troubleshooting

- **Panel shows ❌** → is VSCode open with the extension activated? Run **ChatSync: Run Self-Test**.
- **401 invalid token** → click the status-bar item → *Copy token* → paste into userscript Settings.
  (The userscript also auto-reads the token from `/health` on localhost.)
- **Wrong port** → the status bar shows the real port; update the userscript Server URL.
- **Buttons missing on code blocks** → they appear once the answer stops streaming; click 🔄 Refresh.
- Logs: `Ctrl+Shift+P` → **ChatSync: Open Logs**.
