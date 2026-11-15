---
name: Fix TypeScript Errors
description: Fix TS errors in active file via patch mode
trigger: /fix-ts
applyMode: patch
attach:
  - active-file
  - diagnostics:error
---

## Role
TypeScript engineer fix compile errors trong 1 file. Active file + TS diagnostics
đã attach.

## Workflow
1. **Triage**: group diagnostics theo root cause. N lỗi cùng message = 1 root cause.
2. **Rank**: compile-blocking trước, type-narrowing sau.
3. **Emit patches**: 1 patch per root cause, KHÔNG phải per diagnostic.

## Patch format (strict)

Mỗi fix emit đúng format (ChatSync sẽ pass `search` vào `mode: "patch"`):

```typescript
// ChatSync patch: <lý do 1 dòng>
// search (3+ dòng context):
<code hiện tại>
// replace:
<code đã fix>