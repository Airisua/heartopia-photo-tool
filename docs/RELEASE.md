# 发布说明

## 1. 发布目标

- 仓库：`https://github.com/Airisua/heartopia-photo-tool`（公开）。
- 平台：Windows 10/11 x64。
- 安装包：NSIS `*-setup.exe`，内置 WebView2 离线安装器。
- 更新：Tauri Updater + GitHub Releases `latest.json`，安装包必须带 `.sig` 并由应用内置公钥验签。
- 应用内“热更新”仅指版本升级，不包含运行中替换代码。

## 2. 一次性准备

### 2.1 更新签名密钥

在仓库外生成，私钥不要进入工作区：

```powershell
npm run tauri signer generate -- -w "$env:USERPROFILE\.tauri\heartopia-photo-tool.key"
```

命令会输出公钥内容。把**公钥**写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`；私钥只保存到 GitHub Actions secret。私钥丢失后，已安装用户无法验证新版本，必须妥善备份。

同时设置：

```json
"requireSignedVersion": true
```

它要求 `.sig` 的 trusted comment 包含 `version:<版本>`，并与 `latest.json` 的版本一致。关闭时，攻击者可以把旧安装包的有效签名与新版本号配对，绕过降级保护。构建后必须检查 `.sig` 确实含版本，而不是只检查公钥。

Tauri CLI 的 `signer sign` 提供 `--app-version`，且 `tauri build` 会自动传入应用版本；手工签名安装包时必须显式加 `--app-version <version>`，否则 `.sig` 没有版本绑定。

### 2.2 GitHub Actions secrets

在 `Settings → Secrets and variables → Actions` 添加：

| Secret | 用途 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri 更新签名私钥内容（或私钥文件内容） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码；私钥没有密码时可不创建，workflow 会传入空字符串。不要填占位文本 |
| `HEARTOPIA_CRYPTO_MATERIAL_B64` | 48 字节游戏 AES 材料（32 key + 16 IV）的 base64，仅构建期使用 |

`GITHUB_TOKEN` 由 Actions 自动提供，不需要手动创建。不要把任何 secret 写入仓库、Release 说明、issue 或日志。

### 2.3 仓库设置

- 仓库可见性为 Public。
- Actions 允许运行工作流。
- 建议保护 `main`：要求 PR、通过 CI、禁止强制推送。
- 不需要在仓库中保存游戏客户端或真实截图。

## 3. 版本号与变更记录

发布前同步修改：

1. `package.json` 的 `version`；
2. `src-tauri/tauri.conf.json` 的 `version`；
3. `src-tauri/Cargo.toml` 的 `[package].version`；
4. `CHANGELOG.md`，把 `Unreleased` 改为发布日期；
5. 锁文件（`package-lock.json`、`Cargo.lock`）随构建更新。

```powershell
npm install --package-lock-only
cargo check --manifest-path src-tauri/Cargo.toml
node scripts/preflight-release.mjs --ci
```

版本号使用 SemVer；Tag 使用 `v<version>`，例如 `v0.1.0`。Tag 一旦发布不要移动或复用。

## 4. 发布流程

1. 在 `main` 上完成功能、文档和测试。
2. 确认工作区干净，`node scripts/scan-secrets.mjs` 和 `node scripts/scan-secrets.mjs --history` 都通过。历史扫描覆盖全部分支和标签，不能仅检查最新文件。
3. 打 Tag 并推送：

```powershell
git tag -a v0.1.0 -m "Heartopia Photo Tool v0.1.0"
git push origin main
git push origin v0.1.0
```

4. `.github/workflows/release.yml` 分成只读构建与独立发布两个 job：
   - Windows 构建 job 不持有仓库写权限，checkout 不保留 Git 凭据；先运行依赖安装、前端/Rust 测试和完整历史隐私扫描；
   - 校验 Tag、版本与签名密钥是否已配置；原生编译步骤单独校验并注入游戏解密材料；
   - 前端不接触发布密钥，`tauri build --no-bundle` 不接触签名私钥；`tauri bundle --bundles nsis` 仅在独立步骤接收签名私钥；
   - 不保存可能包含构建材料的 Rust target 缓存；
   - 从 `CHANGELOG.md` 提取说明，生成 `latest.json`、本地产物摘要和 `SHA256SUMS.txt`；
   - 发布前校验本地 manifest、版本绑定和安装包，并用真实 Tauri Updater `Update::verify()` 检查有效包、篡改包、篡改签名及版本不匹配；
   - 只上传经校验的安装包及发布资料到 Actions artifact，不包含密钥、配置、测试图片或本机日志；
   - 独立发布 job 才拥有仓库写权限；复核 artifact 的 SHA-256 后创建草稿、上传资产，再公开 Release；
   - 公开后流式下载资产，与本地摘要的 SHA-256 和大小比对；短暂的 403/404 使用有界重试，持续失败仍使验证失败。
5. 也可在 Actions 页面手动触发 `Release`，填入已存在的 Tag。

发布工作流不会自动修改版本号；Tag 与三个版本字段不一致时预检失败。

## 5. Release 资产

一次成功发布至少包含：

- `<ProductName>_<version>_x64-setup.exe`：用户安装包；
- `<ProductName>_<version>_x64-setup.exe.sig`：更新签名；
- `latest.json`：更新清单；
- 可选的 SHA-256 清单/构建日志。

`latest.json` 结构：

```json
{
  "version": "0.1.0",
  "notes": "更新说明",
  "pub_date": "2026-11-03T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<.sig 文件内容，不是文件路径>",
      "url": "https://github.com/Airisua/heartopia-photo-tool/releases/download/v0.1.0/<安装包文件名>"
    }
  }
}
```

`signature` 必须是 `.sig` 的内容；写路径或 URL 会导致更新失败。`url` 指向同版本 Release 资产，不能指向 `latest` 之外的临时地址。

GitHub 会把上传资产文件名中的空格转换为点。发布流程因此先把安装包及 `.sig` 的对外文件名规范化，再生成 manifest、摘要和 SHA-256 清单；本地 Tauri 原始构建文件不改名。不能用含空格的本地名字猜测已上传的下载 URL。重命名不改变文件内容，发布前仍对规范化文件运行实际更新验签。

`.sig` 的内部 trusted comment 应类似：

```text
timestamp:...	file:<安装包文件名>	version:0.1.0
```

`verify-release-artifacts.mjs`、`generate-release-manifest.mjs` 和 `verify-published-release.mjs` 会解析这段 comment；缺少 `version:` 或版本不匹配会直接失败。最终密码学验签仍由 Tauri Updater 在客户端执行。

正常流程由 `generate-release-manifest.mjs` 从同批签名产物生成 `latest.json`。若需要手工构建/核对，可使用同一脚本：

```powershell
node scripts/generate-release-manifest.mjs `
  --setup "src-tauri\target\release\bundle\nsis\<ProductName>_0.1.0_x64-setup.exe" `
  --sig "src-tauri\target\release\bundle\nsis\<ProductName>_0.1.0_x64-setup.exe.sig" `
  --version 0.1.0 --tag v0.1.0 --repo Airisua/heartopia-photo-tool `
  --notes-file CHANGELOG.md --output artifacts/latest.json

node scripts/verify-release-artifacts.mjs `
  --bundle-dir "src-tauri\target\release\bundle\nsis" `
  --manifest artifacts/latest.json
```

手工生成的 manifest 不会自动上传。手工发布也必须先核对安装包、`.sig`、`latest.json` 与 SHA-256，再上传草稿并公开；不可覆盖已经发布的同版本资产。

## 6. 发布后验证

```powershell
node scripts/verify-published-release.mjs --repo Airisua/heartopia-photo-tool --tag v0.1.0 --summary artifacts/release/release-summary.json
```

该脚本检查：

- `latest.json` 可访问、版本匹配、`pub_date` 合法；
- `platforms.windows-x86_64.signature` 非空；
- 安装包 URL 为 HTTPS、指向 GitHub Release、可下载且体积符合内置 WebView2 的预期。
- 传入 `--summary` 时，流式下载后的大小、文件名和 SHA-256 必须与已验签的本地产物摘要一致。

它验证的是发布资产的一致性和可访问性；**密码学签名校验由 Tauri Updater 在客户端下载时执行**。不要用该脚本代替应用内更新测试。

无窗口的签名正反例验收可通过 `scripts/local-verify-update.ps1` 执行，它调用 Tauri Updater 的实际验签路径，但不安装、不重启，也不替代跨版本更新和配置保留验收。

随后在干净 Windows 上安装该版本，确认启动、配置持久化、解密和日志。记录到 `docs/acceptance-evidence/`。

## 7. 更新链路验证（0.1.0 → 0.1.1）

真正的更新验收需要两个已发布版本：

1. 安装 `0.1.0`，设置输入/输出目录、筛选和并发数。
2. 发布 `0.1.1`（修复或小功能），确保 `latest.json` 指向 0.1.1。
3. 在 0.1.0 中手动/自动检查更新，确认显示版本、说明和下载进度。
4. 下载完成后确认签名校验通过，点击安装并重启。
5. 确认版本变为 0.1.1，输入/输出目录、最近目录和筛选偏好仍在。
6. 断网/篡改 manifest/错误签名场景下，当前版本仍可正常使用。

没有完成这一步前，更新功能只能标记为“待验收”。

## 8. 失败与回滚

- 构建失败：Tag 保留但不要创建 Release；修复后发布新补丁版本，不复用 Tag。
- 更新包损坏/签名失败：更新器拒绝安装，用户仍可使用旧版本；在 Release 页面标注并发布修复版本。
- 新版本有严重问题：发布更高版本修复；Tauri 默认不降级，不能依赖“回滚 tag”让已更新用户自动回退。
- 不要删除旧 Release 资产；已安装用户的更新器和审计记录可能仍引用它们。
- 私钥泄露：立即停止发布，生成新密钥对；但旧版本内置的是旧公钥，无法验证新密钥签名，必须通过完整安装包引导用户迁移。这是固定公钥更新的固有限制。

## 9. 不发布的内容

- 游戏原始截图、真实 `ScreenCapture` 目录、用户配置、日志。
- `.secrets/`、本地 DPAPI 数据、更新私钥、GitHub token。
- 开发机绝对路径、用户名、机器名。
- 未经验收的“已通过”声明。验收状态以 `docs/ACCEPTANCE.md` 和证据目录为准。
