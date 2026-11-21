# ChatSync

Cầu nối 2 chiều giữa **chat web AI** (DeepSeek, ChatGPT, Claude) và **VS Code**: đính kèm ngữ cảnh (file, selection, errors, git diff) từ VS Code vào ô chat AI bằng `@` và `/`, sau đó áp dụng code AI tạo ngược lại editor hoặc review diff trực quan.

---

## Mục lục

1. [ChatSync làm gì?](#chatsync-làm-gì)
2. [Yêu cầu hệ thống](#yêu-cầu-hệ-thống)
3. [Cài đặt nhanh](#cài-đặt-nhanh)
   - [Bước 1: Cài đặt VS Code Extension (.vsix)](#bước-1-cài-đặt-vs-code-extension-vsix)
   - [Bước 2: Cài đặt Userscript vào trình duyệt](#bước-2-cài-đặt-userscript-vào-trình-duyệt)
4. [Hướng dẫn sử dụng chi tiết](#hướng-dẫn-sử-dụng-chi-tiết)
   - [1. Chèn Context vào chat qua `@`](#1-chèn-context-vào-chat-qua-)
   - [2. Sử dụng Skills tùy chỉnh qua `/`](#2-sử-dụng-skills-tùy-chỉnh-qua-)
   - [3. Áp dụng code từ chat vào VS Code (Apply code)](#3-áp-dụng-code-từ-chat-vào-vs-code-apply-code)
   - [4. Xem Diff Review nhiều file trực quan](#4-xem-diff-review-nhiều-file-trực-quan)
   - [5. Quản lý trạng thái và kết nối từ VS Code](#5-quản-lý-trạng-thái-và-kết-nối-từ-vs-code)
5. [Cấu hình & Tạo Skills mới](#cấu-hình--tạo-skills-mới)
6. [Dành cho Developer (Build & Test)](#dành-cho-developer-build--test)
7. [Xử lý sự cố (Troubleshooting)](#xử-lý-sự-cố-troubleshooting)

---

## ChatSync làm gì?

ChatSync gồm 2 thành phần kết nối với nhau qua server HTTP nội bộ `http://127.0.0.1:7123`:

| Thành phần | Môi trường | Chức năng chính |
|---|---|---|
| **VS Code Extension** | VS Code | Chạy local server (`7123`), cung cấp ngữ cảnh file/diagnostics/git, áp dụng patch code 3 tầng (exact $\rightarrow$ line-trimmed $\rightarrow$ fuzzy), và mở giao diện Review Diff trực quan. |
| **Userscript** | Trình duyệt (Tampermonkey) | Chèn vào web chat (DeepSeek, ChatGPT, Claude): cung cấp autocomplete `@context` và `/skill`, tự động gắn thanh công cụ Apply dưới các block code. |

---

## Yêu cầu hệ thống

- **VS Code**: Phiên bản `1.85+` (khuyến nghị bản mới nhất).
- **Trình duyệt**: Chrome, Edge, Brave, hoặc Firefox đã cài extension quản lý userscript (**Tampermonkey** hoặc **Violentmonkey**).
- **Node.js**: Phiên bản `20+` (nếu cần tự build mã nguồn).

---

## Cài đặt nhanh

### Bước 1: Cài đặt VS Code Extension (.vsix)

File cài đặt `chatsync-0.1.0.vsix` đã được đóng gói sẵn trong thư mục gốc của dự án.

**Cách 1 — Dùng Terminal:**
```powershell
code --install-extension chatsync-0.1.0.vsix --force
```

**Cách 2 — Cài từ giao diện VS Code:**
1. Mở VS Code, nhấn tổ hợp `Ctrl + Shift + X` để vào tab **Extensions**.
2. Nhấn vào biểu tượng **`...`** (Views and More Actions) ở góc trên bên phải của panel Extensions.
3. Chọn **Install from VSIX...**
4. Trỏ tới file `chatsync-0.1.0.vsix` và nhấn **Install**.
5. Reload VS Code (`Ctrl + Shift + P` $\rightarrow$ gõ `Developer: Reload Window`).

> **Kiểm tra**: Sau khi cài xong, bạn sẽ thấy biểu tượng **`$(plug) ChatSync :7123`** xuất hiện ở góc dưới bên phải thanh Status Bar của VS Code.

---

### Bước 2: Cài đặt Userscript vào trình duyệt

1. Cài đặt tiện ích [Tampermonkey](https://www.tampermonkey.net/) trên trình duyệt web của bạn.
2. Mở Tampermonkey Dashboard $\rightarrow$ chọn tab **Utilities** (hoặc nhấn nút **+** để tạo script mới).
3. Copy toàn bộ nội dung của một trong 2 file userscript sau và dán vào:
   - **Bản khuyến nghị**: [userscript/dist/chatsync-userscript.user.js](userscript/dist/chatsync-userscript.user.js) (đã tích hợp Tribute palette, composer adapter và tự động đồng bộ).
   - **Bản standalone**: [userscript/chatsync.user.js](userscript/chatsync.user.js) (bản monolithic có thêm Floating Action Button và Floating Panel).
4. Nhấn `Ctrl + S` trong trình duyệt để lưu Userscript.
5. Truy cập vào trang web AI:
   - DeepSeek: `https://chat.deepseek.com`
   - ChatGPT: `https://chatgpt.com`
   - Claude: `https://claude.ai`
6. Mở DevTools Console (`F12`), bạn sẽ thấy thông báo:
   ```
   [chatsync] userscript loaded
   [chatsync] ✅ connected to extension server
   ```

---

## Hướng dẫn sử dụng chi tiết

### 1. Chèn Context vào chat qua `@`

Khi đang gõ prompt trong ô chat trên trình duyệt, gõ ký tự **`@`** để mở menu đính kèm ngữ cảnh từ VS Code:

- **`@file`**: Lấy toàn bộ nội dung (hoặc đoạn text bạn đang bôi đen) của file đang active trong VS Code và chèn vào ô nhập kèm định dạng code block.
- **`@folder`**: Nhập đường dẫn thư mục trong workspace để gửi cấu trúc cây thư mục kèm nội dung các file.
- **`@problems`**: Tự động gom toàn bộ danh sách lỗi (Errors) và cảnh báo (Warnings) từ panel Problems của VS Code gửi sang AI.
- **`@git`**: Lấy diff git hiện tại của các file chưa commit và chèn vào prompt.

---

### 2. Sử dụng Skills tùy chỉnh qua `/`

Gõ ký tự **`/`** trong ô chat để gọi các prompt mẫu (Skills) được định nghĩa sẵn trong thư mục `.chatsync/skills/`:

- **`/fix-ts`**: Yêu cầu AI sửa lỗi TypeScript theo ngữ cảnh file và chẩn đoán lỗi đang mở.
- **`/explain-folder`**: Yêu cầu AI phân tích và giải thích cấu trúc mã nguồn thư mục.
- **`/refactor-patch`**: Yêu cầu AI refactor mã nguồn theo chuẩn patch search/replace.

---

### 3. Áp dụng code từ chat vào VS Code (Apply code)

Dưới mỗi đoạn block code mà AI trả về trên trình duyệt, ChatSync sẽ tự động gắn một thanh công cụ:

- **`⚡ Apply to VSCode`**: Áp dụng ngay nội dung code vào file đang mở trong VS Code (tự động thay thế vùng chọn nếu đang bôi đen, hoặc thay thế toàn bộ file).
- **`⚙ Options`**: Mở hộp thoại tùy chỉnh chế độ ghi:
  - `replace`: Ghi đè toàn bộ file.
  - `replaceSelection`: Thay thế vùng đang bôi đen.
  - `insert`: Chèn tại vị trí con trỏ chuột.
  - `append`: Thêm vào cuối file.
  - `newFile`: Tạo file mới theo đường dẫn mong muốn.
  - `patch`: Tìm kiếm và thay thế đoạn code tương ứng.
- **`＋ New file`**: Tạo nhanh một file mới trong workspace từ code block.
- **`⧉ Copy`**: Sao chép code đã loại bỏ markdown fence.

---

### 4. Xem Diff Review nhiều file trực quan

Khi bạn cần review các thay đổi giữa branch hiện tại và `main`, hoặc xem diff vừa nhận từ AI:

1. Trong VS Code, nhấn `Ctrl + Shift + P` (hoặc `F1`).
2. Gõ và chọn lệnh: **`ChatSync: Show Review`**.
3. VS Code sẽ mở một Webview sử dụng engine `diff2html` hiển thị diff side-by-side hoặc line-by-line trực quan, an toàn (đã lọc qua DOMPurify).

---

### 5. Quản lý trạng thái và kết nối từ VS Code

- **Thanh trạng thái (Status Bar)**:
  - Nhấp vào biểu tượng **`$(plug) ChatSync :7123`** ở góc dưới bên phải.
  - Menu nhanh sẽ xuất hiện cho phép:
    - **Copy URL**: Sao chép `http://127.0.0.1:7123`.
    - **Show Review**: Mở ngay panel review git diff.
- **Các lệnh trong Command Palette (`Ctrl + Shift + P`)**:
  - `ChatSync: Show Connection Info`: Xem thông tin cổng và trạng thái server.
  - `ChatSync: Check Server Status`: Kiểm tra tình trạng lắng nghe của server bridge.
  - `ChatSync: Show Review`: Mở webview xem diff.

---

## Cấu hình & Tạo Skills mới

Bạn có thể tự tạo thêm các Skill mới cho dự án của mình bằng cách tạo file markdown trong thư mục `.chatsync/skills/` (hoặc `.agents/skills/`):

Ví dụ file `.chatsync/skills/my-skill.md`:
```markdown
---
name: Tên Skill
description: Mô tả ngắn gọn xuất hiện trong autocomplete menu
trigger: /my-skill
applyMode: patch
attach:
  - active-file
  - diagnostics:error
---

## Vai trò
Hướng dẫn chi tiết dành cho AI khi người dùng kích hoạt skill này...
```

Sau khi lưu file, Userscript trên trình duyệt sẽ tự động nhận diện skill mới khi gõ `/`.

---

## Dành cho Developer (Build & Test)

```bash
# 1. Cài đặt dependencies
npm install
npm --prefix userscript install

# 2. Build extension bundle (out/extension.js)
npm run build:ext

# 3. Build userscript (userscript/dist/chatsync-userscript.user.js)
npm run userscript:build

# 4. Chạy kiểm tra kiểu dữ liệu (TypeScript)
npm run typecheck
npm run userscript:typecheck

# 5. Chạy unit tests (37 tests)
npm run test:unit

# 6. Chạy toàn bộ verify pipeline
npm run verify:all

# 7. Đóng gói lại file VSIX
npm run package:vsix
```

---

## Xử lý sự cố (Troubleshooting)

### Trình duyệt báo `[chatsync] cannot reach extension server at 127.0.0.1:7123`
1. Đảm bảo VS Code đang mở và thanh Status Bar có icon `$(plug) ChatSync :7123`.
2. Kiểm tra lại script Tampermonkey: Directive `@connect` phải là `127.0.0.1` và `localhost` (không gắn kèm số cổng `:7123`).
3. Nếu bạn từng dùng phiên bản cũ cấu hình cổng `3847`, mở Tampermonkey Settings $\rightarrow$ xóa cache storage của ChatSync hoặc reload trang web để script tự động migrate về cổng `7123`.

### Trình duyệt báo lỗi CORS hoặc Private Network Access
- Server extension đã được tích hợp đầy đủ header `Access-Control-Allow-Origin: *`, xử lý preflight `OPTIONS` và `Access-Control-Allow-Private-Network: true`. Hãy đảm bảo bạn đã cài bản `.vsix` mới nhất `0.1.0`.

### Muốn chạy self-test thủ công từ Terminal
Mở terminal và gõ:
```powershell
curl.exe -i http://127.0.0.1:7123/health
```
Kết quả trả về hợp lệ:
```json
{"ok":true,"service":"chatsync","port":7123,"version":"0.1.0",...}
```

---

## License

Mã nguồn phát hành theo giấy phép [MIT](LICENSE).
