---
name: Refactor with Patch
description: Refactor an toàn bằng patch mode với verify
trigger: /refactor
applyMode: patch
attach:
  - active-file
  - diagnostics:warning
---

## Instruction

Refactor file trên. Yêu cầu:
- Mỗi thay đổi dùng `mode: "patch"` với anchor unique
- Verify bằng cách đảm bảo diagnostics TRƯỚC và SAU không tăng
- Không đổi public API (function signature, export)
- Không đổi format output/log message

Trả lời từng bước: 1) mô tả ngắn gọn thay đổi, 2) code block patch, 3) lý do.