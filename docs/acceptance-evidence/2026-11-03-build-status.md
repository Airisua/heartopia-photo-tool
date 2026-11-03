# 构建状态快照（非验收通过）

- 日期：2026-11-03
- 用途：记录当前工作树的阻断项，便于后续修复后对照；不是产品验收证据。
- 状态：**Resolved**（2026-11-03 后续修复；见 [测试通过记录](2026-11-03-tests-pass.md)）

## 已通过

- `node scripts/preflight-release.mjs --ci`：PASS
- 合成 48B 材料下 `node scripts/preflight-release.mjs --release`：PASS（非真实密钥）
- `node scripts/scan-secrets.mjs`：PASS
- 发布 manifest/产物校验脚本自测：PASS（合成 130 MiB 稀疏文件 + 假签名）

## 当时未通过（已修复）

### 前端

```text
npm run typecheck
src/components/TaskPanel.tsx: Property 'failed' does not exist on type 'never' (127-153)
npm test
3 failed | 13 passed
- PhotoTable.test.tsx: getByRole("checkbox", {name:/选择 20261028/}) matched multiple same-name rows
- filter.test.ts: expected [end, middle, start], received [start, middle, end]
- PhotoThumb act(...) warnings
```

### 核心库

```text
cargo test --manifest-path crates/photo-core/Cargo.toml
error[E0639]: cannot create non-exhaustive struct using struct expression
  crates/photo-core/src/thumbnail.rs:53 (image::Limits)
```

## 未执行

- Tauri NSIS 真实构建与更新签名
- 真实 `ScreenCapture` 批量回归
- 干净 Windows 10/11 安装
- 0.1.0 → 0.1.1 更新链路
- GitHub Release 发布与线上 manifest 下载

修复后请新增新的证据记录，不要直接改写本文件为“通过”。
