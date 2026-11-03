# 验收证据：发布/安全脚本自测

- 日期：2026-11-03
- 提交：待补（脚本首次加入时）
- 状态：**Tooling self-test**，只证明脚本本身可执行，不证明应用、安装包或更新链路通过验收。

## 执行

```powershell
node scripts/preflight-release.mjs --ci
node scripts/scan-secrets.mjs
node scripts/preflight-release.mjs --release   # 使用合成 48B 测试材料，非真实密钥
node scripts/release-notes.mjs --version v0.1.0 --file CHANGELOG.md --output artifacts/release-notes.md
node scripts/generate-release-manifest.mjs ... # 合成 130 MiB 稀疏 setup + 假签名
node scripts/verify-release-artifacts.mjs ...
```

## 结果

| 检查 | 结果 | 说明 |
|---|---|---|
| CI 配置预检 | PASS | 版本、NSIS、offline WebView2、CSP、图标、capabilities、锁文件 |
| secret scan | PASS | 无跟踪秘密、无绝对用户路径 |
| Release 配置预检（合成材料） | PASS | 仅验证配置与 48B 校验逻辑；合成材料不是游戏密钥 |
| CHANGELOG 更新说明提取 | PASS | 752 字符；写入 `latest.json` notes 的路径可执行 |
| manifest 生成/校验（加固前） | PASS（历史） | 当时用 2048 字符假签名；加入 trusted comment 版本绑定后该假签名不再通过 |
| `.sig` trusted comment 版本解析 | PASS | 合成 minisign 信封：`version:0.1.0` 匹配通过，`0.1.1` 拒绝 |
| 受保护目录快照/比对 | PASS | 小目录快照、无变化 PASS、修改后 FAIL 检出 1 项 |
| 发布后 manifest 下载校验 | 未执行 | 尚无公开 Release；不能用合成数据替代 |
| Tauri 更新器密码学校验 | 未执行 | 由客户端运行时完成，需 0.1.0→0.1.1 实测 |

## 限制

- 合成材料、假签名和稀疏文件只测试脚本路径，不是真实安装包。
- 未执行真实 `cargo build`、Tauri NSIS 构建、干净 Windows 安装或 GitHub Release 下载。
