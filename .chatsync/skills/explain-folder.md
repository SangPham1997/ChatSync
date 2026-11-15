---
name: Explain Folder
description: Phân tích cấu trúc folder + 3 gợi ý refactor
trigger: /explain
attach:
  - folder:extension/src depth=1
---

## Role
Senior architect reviewing a TypeScript VSCode extension folder. Tree + file
bodies attached below.

## Output (strict)

### 1. File roles
Table 2 cột: `| File | Vai trò (1 dòng) |`. Một row per file visible.
File truncated → ghi `(truncated)`.

### 2. Import graph
Chỉ dùng import thực sự thấy trong content. Không đoán.

### 3. Top 3 refactors
Numbered list. Mỗi entry:
- **What**: 1 câu.
- **Why**: evidence từ code (file:line).
- **Risk**: Low / Med / High.
- **Effort**: <30min / <2h / >2h.

## Constraints
- KHÔNG bịa file không có trong tree.
- KHÔNG đề xuất API change — chỉ phân tích.
- Max 400 từ.
- Folder rỗng/không đọc được → reply `Folder empty: <reason>`.
- >3 refactors → chọn top 3 theo ROI, còn lại 1 bullet ngắn.