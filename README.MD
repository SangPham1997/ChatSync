# ChatSync

Cầu nối giữa **chat web AI** (DeepSeek, ChatGPT, Claude) và **VS Code**: gõ prompt trên chat web, patch code thẳng vào VS Code, verify tự động bằng execa + tree-kill, báo kết quả ngược lại chat.

---

## Mục lục

- [ChatSync làm gì?](#chatsync-làm-gì)
- [Trạng thái milestone](#trạng-thái-milestone)
- [Yêu cầu hệ thống](#yêu-cầu-hệ-thống)
- [Cài đặt nhanh (developer)](#cài-đặt-nhanh-developer)
- [Load extension vào VS Code](#load-extension-vào-vs-code)
- [Cài userscript vào chat web](#cài-userscript-vào-chat-web)
- [Chạy test](#chạy-test)
- [Build & đóng gói .vsix cho user cuối](#build--đóng-gói-vsix-cho-user-cuối)
- [Cấu trúc dự án](#cấu-trúc-dự-án)
- [An toàn](#an-toàn)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## ChatSync làm gì?

ChatSync gồm 2 thành phần, kết nối qua local server `127.0.0.1:7123`:

1. **Userscript** (Tampermonkey) chèn vào chat web:
   - Palette lệnh `/` — `/apply`, `/loop/status`, `/review`
   - Palette context `@` — `@file`, `@folder`, `@problems`, `@terminal`, `@git`
   - Gửi payload JSON về VS Code extension

2. **VS Code extension** nhận payload và:
   - **Patch engine** (M2): áp patch 3 tầng (exact → line-trimmed → fuzzy bằng diff-match-patch), fallback merge 3-way (node-diff3) khi file đã đổi
   - **Verify loop** (M1): chạy `npm run typecheck` / `npm run test:unit` với timeout + kill process tree (execa + tree-kill), redact secrets (sk-*, ghp_*, AKIA*), báo kết quả về chat
   - **Context providers** (M3): đọc file/folder/problems/terminal/git theo `@mention`
   - **Review webview** (M2+M3): diff2html hiển thị diff nhiều file

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
| **M2** | Patch engine (diff-match-patch 3-tier), merge3 (node-diff3), batch queue (p-queue), approve-once, review webview (diff2html + DOMPurify) | ✅ Scaffold + 10 test pass |
| **M3** | 5 context providers, registry + compose pstack, symbols parser (web-tree-sitter + regex fallback), review command, `activate()` entry | ✅ Scaffold + 8 test pass + entry wired |

**Chưa implement** (đúng scope "user code" của plan):
- Compose pstack policy (rules-once, sliding window, arg compaction)
- WASM grammars cho `web-tree-sitter` (regex fallback đã hoạt động)
- Wire `/review` route từ M1 server vào command `chatsync.review.show`
- Build userscript (chỉ có scaffold `userscript/`, chưa bundle)
- E2E end-to-end flow (userscript ↔ server ↔ extension) — hiện chỉ có E2E cho review webview

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