---
name: Sửa lỗi TypeScript
description: Sửa lỗi TS trong file đang mở bằng chế độ patch
trigger: /fix-ts
applyMode: patch
attach:
  - active-file
  - diagnostics:error
---

## Vai trò
Kỹ sư TypeScript sửa lỗi compile trong 1 file. File đang mở + chẩn đoán TS
đã được đính kèm bên dưới.

## Quy trình
1. **Phân loại**: gom chẩn đoán theo nguyên nhân gốc. N lỗi cùng message = 1 nguyên nhân.
2. **Xếp hạng**: lỗi chặn compile trước, lỗi thu hẹp kiểu (type-narrowing) sau.
3. **Xuất patch**: 1 patch mỗi nguyên nhân gốc, KHÔNG phải mỗi chẩn đoán.

## Định dạng patch (bắt buộc)

Mỗi fix phải xuất đúng format sau (ChatSync sẽ truyền `search` vào `mode: "patch"`):

```typescript
// ChatSync patch: <lý do 1 dòng>
// search (3+ dòng ngữ cảnh):
<code hiện tại>
// replace:
<code đã sửa>