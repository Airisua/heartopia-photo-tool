# 测试通过记录（本地工作树）

- 日期：2026-11-03
- 提交：待补（发布提交后填写）
- 适用范围：类型检查、前端单测、核心库单测、Tauri 命令层单测、发布配置预检、secret scan。
- 状态：**Local checks pass**，不等于干净机、真实批量解密或更新链路验收。

> 测试数量是本次运行快照；核心库/界面后续加固可能改变数量，发布前必须重新执行并更新本记录。
>
> **后续状态：** 2026-11-03 核心库加固引入 `WriteOutcome::Cancelled` 未覆盖的编译错误，见 [core hardening status](2026-11-03-core-hardening-status.md)。本记录仅代表加固前快照，发布前必须复跑。

## 命令与结果

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | PASS |
| `npm test` | PASS，8 files / 26 tests（后续运行） |
| `npm run verify` | 加固前 PASS；加固后因核心库 `WriteOutcome::Cancelled` 编译错误 FAIL |
| `cargo test --manifest-path crates/photo-core/Cargo.toml` | 加固前 PASS（34 tests）；加固后编译 FAIL |
| `cargo test --manifest-path src-tauri/Cargo.toml` | PASS，5 tests |
| `cargo fmt --manifest-path crates/photo-core/Cargo.toml --all -- --check` | PASS |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` | PASS |
| `cargo clippy --manifest-path crates/photo-core/Cargo.toml --all-targets -- -D warnings` | PASS |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | PASS |
| `node scripts/scan-secrets.mjs` | PASS |
| `node scripts/preflight-release.mjs --ci` | PASS |
| `node scripts/preflight-release.mjs --release`（合成 48B） | PASS（非真实材料） |

## 已修复的静态检查

```text
2026-11-03 首轮 app clippy 曾报 commands.rs:191 unnecessary return、
commands.rs:244 unnecessary_sort_by；修复后复跑 PASS。
```

## 仍待完成

- 使用真实 `ScreenCapture` 的只读批量回归与源文件大小/mtime 前后对照（不记录源/输出图片哈希）；
- Tauri NSIS 真实构建、更新签名和安装包体积/WebView2 离线验证；
- 干净 Windows 10/11 安装与启动；
- 0.1.0 → 0.1.1 更新链路；
- 公开 GitHub Release 下载与线上 `latest.json` 校验。

本地测试输出中的临时路径只出现在开发终端，不属于应用日志；不要把带用户名路径的原始输出提交到证据目录。
