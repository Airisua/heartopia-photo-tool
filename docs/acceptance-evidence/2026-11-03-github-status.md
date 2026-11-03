# GitHub 仓库与 Actions 状态

- 日期：2026-11-03
- 仓库：<https://github.com/Airisua/heartopia-photo-tool>（Public）
- 状态：**Pass（A10 发布可访问性）**；公开仓库、提交、`v0.1.0` Release 与四个附件已复核。该结论不包含 A8 跨版本更新或 A9 干净机安装。

## 已验证

- 已确认仓库推送与 Actions 发布权限可用；认证来源和本机凭据管理细节不记录。
- 公开仓库已创建，`origin` 已配置。
- 中文及英文 README、使用说明已提交到 `main`；公开文件的匿名下载内容与提交内容一致。
- `main` 的最新 CI 已完成并通过；历史中旧的失败运行不代表当前提交失败。
- `v0.1.0` Release 已公开，包含安装包、`.sig`、`latest.json` 和 `SHA256SUMS.txt`；匿名页面和附件访问已验证。
- 公开安装包完整下载后的 SHA-256 与已验签的本地产物摘要及公开 SHA-256 清单一致。
- 对公开包执行真实 Tauri Updater 验签：有效包通过；篡改包、篡改签名和签名版本不匹配均被拒绝。
- Actions secrets 已保存（只核对名称，不读取值）：
  - `HEARTOPIA_CRYPTO_MATERIAL_B64`
  - `TAURI_SIGNING_PRIVATE_KEY`
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

## 验证方法

```powershell
node --use-env-proxy scripts/verify-published-release.mjs --repo Airisua/heartopia-photo-tool --tag v0.1.0 --summary artifacts/release/0.1.0/published/release-summary.json

./scripts/local-verify-update.ps1 -Package '<PUBLIC_SETUP>' -Signature '<PUBLIC_SIG>' -Manifest '<PUBLIC_MANIFEST>'
```

网络代理仅在当前验证进程中设置，不写入配置或公共证据。公开下载检查与密码学验签相互独立，不能代替实际安装或重启更新。

## 仍需独立验收

- `0.1.1` 构建、签名和公开发布；
- `0.1.0` → `0.1.1` 应用内下载、安装、重启及配置保留；
- 干净 Windows 10/11 x64 离线安装与 WebView2 缺失场景。

A10 的结论依据已公开产物和匿名复核，而不是仅依据仓库公开或 secrets 存在。
