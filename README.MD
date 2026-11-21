# ChatSync

Cầu nối giữa **chat web AI** (DeepSeek, ChatGPT, Claude) và **VS Code**: gõ prompt trên chat web, patch code thẳng vào VS Code, verify tự động bằng execa + tree-kill, báo kết quả ngược lại chat.

---

## Mục lục

- [ChatSync làm gì?](#chatsync-làm-gì)
- [Trạng thái milestone](#trạng-thái-milestone)
- [Kiến trúc tổng quan](#kiến-trúc-tổng-quan)
- [Yêu cầu hệ thống](#yêu-cầu-hệ-thống)
- [Cài đặt nhanh (developer)](#cài-đặt-nhanh-developer)
- [Load extension vào VS Code](#load-extension-vào-vs-code)
- [Cài userscript vào chat web](#cài-userscript-vào-chat-web)
- [Chạy test](#chạy-test)
- [Build & đóng gói .vsix cho user cuối](#build--đóng-gói-vsix-cho-user-cuối)
- [Cấu trúc dự án](#cấu-trúc-dự-án)
- [An toàn](#an-toàn)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [License](#license)

---

## ChatSync làm gì?

ChatSync gồm 2 thành phần, kết nối qua local HTTP server `127.0.0.1:7123`:

### 1. Userscript (Tampermonkey)

Chèn vào chat web:
- Palette lệnh `/` — `/apply`, `/loop/status`, `/review`
- Palette context `@` — `@file`, `@folder`, `@problems`, `@terminal`, `@git`
- Gửi payload JSON về VS Code extension qua `GM_xmlhttpRequest`

**Trạng thái hiện tại:** build pipeline hoạt động (`userscript/dist/*.user.js`), nhưng palette + composer + adapters vẫn là **stub TODO**. Userscript hiện chỉ log `[chatsync] userscript loaded`. Implementation thật (~200 dòng) là **user code** theo plan.

### 2. VS Code extension

Nhận payload và xử lý:

| Layer | Milestone | Chức năng |
|---|---|---|
| **Patch engine** | M2 | Áp patch 3 tầng: exact → line-trimmed → fuzzy (diff-match-patch). Fallback merge 3-way (node-diff3) khi file đã đổi từ lúc AI thấy |
| **Verify loop** | M1 | Chạy `npm run typecheck` / `npm run test:unit` với timeout + kill process tree (execa + tree-kill), redact secrets (sk-*, ghp_*, AKIA*), báo kết quả về chat |
| **Context providers** | M3 | Đọc file/folder/problems/terminal/git theo `@mention` |
| **Compose pstack** | M3+ | Rules-once (dedup rules), sliding window (5 rounds), arg compaction (head+tail) |
| **Review webview** | M2+M3 | diff2html hiển thị diff nhiều file, command `chatsync.review.show` |
| **HTTP server** | M1+M3+ | `/health` + `/review` (route `/apply` chưa có) |

**Nguyên tắc an toàn:**
- Verify runner **chỉ chạy command allowlist** (`npm`, `pnpm`, `yarn`, `npx`) — không bao giờ thực thi command AI gợi ý
- **Approval-once**: user phải xác nhận từng round patch, không silent apply
- **Redact secrets** trước khi auto-report lên chat
- Local server bind `127.0.0.1` only, không expose ra internet

---

## Trạng thái milestone

| Milestone | Nội dung | Trạng thái |
|---|---|---|
| **M1** | Verify loop: xstate machine, execa runner, redact reporter, skills loader (gray-matter) | ✅ Scaffold + 4 test pass |
| **M2** | Patch engine (diff-match-patch 3-tier), merge3 (node-diff3 + excludeFalseConflicts), batch queue (p-queue), approve-once policy, review webview (diff2html + DOMPurify) | ✅ Scaffold + 10 test pass |
| **M3** | 5 context providers, registry + compose pstack, symbols parser (web-tree-sitter + regex fallback), review command, `activate()` entry | ✅ Scaffold + 8 test pass + entry wired |
| **M3+ (extra)** | Compose pstack policy (rules-once, sliding window, arg compaction) | ✅ 9 test pass |
| **M3+ (extra)** | WASM grammars (36 grammar copied to `media/wasm/`) | ✅ `tree-sitter-wasms` installed |
| **M3+ (extra)** | Server `/review` route + handler + extension wire | ✅ 2 test pass |
| **M3+ (extra)** | Userscript build pipeline (`vite-plugin-monkey@5.0.8`) | ✅ `dist/*.user.js` produced |

**Tổng test:** `test:m2` (10) + `test:m3` (17) + `test:server` (2) = **29 test pass**.

**Chưa implement** (đúng scope "user code" của plan):
- **Userscript palette thật** — `attachPalette`, `insertIntoTextarea`, `insertIntoContentEditable`, `observeComposer` (stub TODO)
- **Route `/apply`** trong server — hiện chỉ có `/review`
- **Wire `/review` end-to-end** — userscript phải POST `/review` thay vì gọi `GM_*` trực tiếp
- **WASM AST test** — `test:m3` hiện dùng regex fallback, chưa force AST path
- **E2E end-to-end** (userscript ↔ server ↔ extension) — hiện chỉ có E2E cho review webview

---


---

## Yêu cầu hệ thống

| Thành phần | Phiên bản | Ghi chú |
|---|---|---|
| **Node.js** | 20+ (khuyến nghị 22 LTS) | `node --version` |
| **npm** | 10+ | `npm --version` |
| **VS Code** | 1.85+ | Cho extension |
| **Chromium** | Playwright tự cài | Chỉ cho E2E test |
| **OS** | Windows / macOS / Linux | Script build dùng Node, cross-platform |

---

## Cài đặt nhanh (developer)

```bash
# 1. Clone repo
git clone https://github.com/SangPham1997/ChatSync.git
cd ChatSync

# 2. Cài dependencies (root)
npm install

# 3. (Tuỳ chọn) Cài userscript deps nếu muốn build userscript
npm --prefix userscript install

# 4. Build extension bundle (out/extension.js)
npm run build:ext

# 5. Verify tất cả test xanh
npm run verify:all

Kiến trúc:
chatsync/
├── src/                          # Extension source (TypeScript)
│   ├── loop/                     # M1: verify loop
│   │   ├── schema.ts             # zod contracts (/apply, /loop/status)
│   │   ├── stateMachine.ts       # xstate round lifecycle
│   │   ├── runner.ts             # execa + tree-kill + strip-ansi
│   │   └── reporter.ts           # redact secrets + build report
│   ├── skills/                   # M1: skills loader
│   │   └── loader.ts             # gray-matter + dual-root (.chatsync/skills, .agents/skills)
│   ├── patch/                    # M2: patch engine
│   │   ├── locate.ts             # 3-tier: exact → line-trimmed → fuzzy
│   │   ├── merge3.ts             # node-diff3 + excludeFalseConflicts
│   │   └── engine.ts             # glue + conflict detection
│   ├── batch/                    # M2: batch coordination
│   │   ├── queue.ts              # p-queue (sequential per file, parallel across files)
│   │   └── approvePolicy.ts      # Cline-style approve-once + max-count
│   ├── context/                  # M3: @-mention providers
│   │   ├── taxonomy.ts           # parseMention (@file/@folder/@problems/@terminal/@git)
│   │   ├── providers/
│   │   │   ├── file.ts
│   │   │   ├── folder.ts
│   │   │   ├── problems.ts
│   │   │   ├── terminal.ts       # side-channel file (VS Code has no terminal API)
│   │   │   └── git.ts
│   │   ├── registry.ts           # resolveMention / resolveAll
│   │   ├── render.ts             # compose (simple, no policy)
│   │   ├── policy.ts             # M3+: rules-once, sliding window, arg compaction
│   │   └── composePstack.ts      # M3+: PstackComposer (policy-aware)
│   ├── symbols/                  # M3: symbol extraction
│   │   ├── parser.ts             # web-tree-sitter wrapper (default Parser import)
│   │   └── signatures.ts         # extractSignatures + regex fallback
│   ├── review/                   # M2+M3: review webview
│   │   ├── render.ts             # diff2html + DOMPurify + marked
│   │   ├── provider.ts           # VS Code webview panel
│   │   ├── command.ts            # chatsync.review.show
│   │   └── assets.ts             # copy diff2html.min.css on activate
│   ├── git/                      # M2: simple-git wrapper
│   │   └── diff.ts
│   ├── server/                   # M3+: local HTTP server
│   │   ├── handlers.ts           # /review handler (pure, testable)
│   │   └── index.ts              # http.createServer + route dispatch
│   ├── types/
│   │   └── shims.d.ts            # tree-kill + node-diff3 type shims
│   ├── register.ts               # M3: registerM3(ctx) wires all M3
│   └── extension.ts              # M3: VS Code activate() entry + startServer()
├── userscript/                   # Tampermonkey userscript (vite + preact)
│   ├── src/
│   │   ├── index.ts              # entry (stub TODO: main() wiring)
│   │   ├── adapters/deepseek.ts  # DOM selectors (stub TODO: observeComposer)
│   │   ├── palette/index.ts      # Tribute + fuzzysort (stub TODO: attachPalette)
│   │   └── composer/insert.ts    # text-field-edit / ClipboardEvent (stub TODO)
│   ├── dist/
│   │   └── chatsync-userscript.user.js  # build output
│   ├── vite.config.ts            # vite-plugin-monkey@5.0.8
│   └── package.json
├── test/
│   ├── unit/                     # vitest
│   │   ├── patch/tiers.test.ts
│   │   ├── merge3/merge3.test.ts
│   │   ├── approve/approvePolicy.test.ts
│   │   ├── context/
│   │   │   ├── parse.test.ts
│   │   │   ├── policy.test.ts    # M3+: RulesOnce, SlidingWindow, compactArgs
│   │   │   └── pstack.test.ts    # M3+: PstackComposer
│   │   ├── symbols/signatures.test.ts
│   │   ├── server/handlers.test.ts  # M3+: /review handler
│   │   └── smoke.test.ts         # M1
│   ├── e2e/
│   │   └── review.spec.ts        # Playwright + diff2html
│   ├── fixtures/
│   │   ├── deepseek-composer.html
│   │   └── review/unified.diff
│   └── mocks/
│       └── vscode.ts             # vscode module stub for vitest
├── media/                        # runtime assets
│   ├── diff2html.min.css         # copied on activate
│   ├── wasm/                     # 36 tree-sitter WASM grammars
│   └── .gitkeep
├── reports/                      # run logs + status MD (gitignored)
├── out/                          # build output (gitignored)
├── .chatsync/                    # per-project skills + config
│   └── skills/
├── .chatsync-backup/             # archived legacy trees (gitignored)
├── esbuild.mjs                   # bundle src/extension.ts → out/extension.js
├── playwright.config.ts
├── tsconfig.json
├── vitest.config.ts              # with vscode mock alias
└── package.json