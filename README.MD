# ChatSync

Cầu nối giữa **chat web AI** (DeepSeek, ChatGPT, Claude) và **VS Code**: soạn prompt trên chat, patch code thẳng vào editor, verify tự động, báo kết quả ngược lại chat.

> ⚠️ **Trạng thái thực tế**: extension core (verify loop, patch engine, context providers) đã test được 29 unit test. **Userscript phần lớn là stub TODO** (palette `/`, composer insert, wire end-to-end). Dùng được cho development & review diff; chưa ready để daily driver cho end user.

---

## Mục lục

- [Cách dùng (cho phần đã implement)](#cách-dùng-cho-phần-đã-implement)
- [Cài đặt developer](#cài-đặt-developer)
- [Load extension vào VS Code](#load-extension-vào-vs-code)
- [Build & cài userscript](#build--cài-userscript)
- [Chạy test](#chạy-test)
- [Kiến trúc theo milestone](#kiến-trúc-theo-milestone)
- [Verify loop (M1)](#verify-loop-m1)
- [Patch engine (M2)](#patch-engine-m2)
- [Compose pstack (M3+)](#compose-pstack-m3)
- [Review webview](#review-webview)
- [An toàn](#an-toàn)
- [Troubleshooting](#troubleshooting)
- [Roadmap — phần chưa implement](#roadmap)
- [License](#license)

---

## Cách dùng (cho phần đã implement)

### 1. Xem diff nhiều file (Review webview)

Trong VS Code, khi cần review diff của một branch so với `main`:
