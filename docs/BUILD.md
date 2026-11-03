# 构建与打包说明

## 1. 开发环境

仅开发机构建需要以下工具；安装后的应用不需要它们。

- Windows 10/11 x64。
- Node.js 22 LTS（CI 使用 22）。
- Rust stable（MSVC toolchain；仓库 `rust-version` 以 `src-tauri/Cargo.toml` 为准）。
- Visual Studio Build Tools，勾选“使用 C++ 的桌面开发”和 Windows SDK。
- WebView2 Runtime（开发机通常已由 Edge 提供）。
- Git。

检查：

```powershell
node --version
rustc --version
cargo --version
git --version
```

## 2. 安装依赖

```powershell
npm ci
```

首次本地开发若还没有锁文件，可先执行 `npm install`，随后提交 `package-lock.json`；CI 和发布流程使用 `npm ci`。

## 3. 开发运行

```powershell
npm run tauri dev
```

前端由 Vite 在 `127.0.0.1:1420` 提供，Tauri 启动原生窗口。前端不接触文件系统；所有路径和解密操作都通过 Rust command。

## 4. 测试与静态检查

```powershell
npm run typecheck
npm test
npm run build
cargo fmt --manifest-path crates/photo-core/Cargo.toml --all -- --check
cargo clippy --manifest-path crates/photo-core/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path crates/photo-core/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
node scripts/scan-secrets.mjs
node scripts/preflight-release.mjs --ci
```

`npm run verify` 组合了前端类型检查、前端测试、生产构建、核心库测试和 Tauri 命令层测试。发布前还需要执行发布配置预检（见第 6 节）。

## 5. 游戏解密材料的构建注入

游戏 AES 材料只用于兼容文件格式，不是可长期保密的凭据。发布二进制仍可被逆向提取，因此不要把“密钥未公开”当作访问控制。

构建契约（由根集成实现）：

- 环境变量 `HEARTOPIA_CRYPTO_MATERIAL_B64`：base64，解码后必须恰好 48 字节，前 32 字节为 AES key，后 16 字节为 IV。
- `src-tauri/build.rs` 在构建期读取该环境变量，把字节写入 `OUT_DIR` 生成的数组；不写入源码或仓库文件。
- 未设置时允许公开开发构建，但应用必须报告 `keyAvailable=false`，解密入口不可用。
- 发布构建必须设置 `HEARTOPIA_RELEASE=1`；材料缺失、base64 非法或长度不为 48 字节时构建失败，且错误信息不回显材料。

本地开发不要把手写密钥粘进源码、`.env` 或聊天记录。仓库提供当前用户 DPAPI 辅助脚本（`.secrets/` 已被忽略）：

```powershell
# 一次性：从本机反编译源码读取 KEY/IV，经 DPAPI 保存；不显示材料
.\scripts\local-prepare-secrets.ps1 -EncryptionSource '<本机 EncryptUtil.cs 路径>'

# 构建：临时注入材料与更新私钥，结束后自动清除环境变量
.\scripts\local-build.ps1 -Mode build

# 开发/测试
.\scripts\local-build.ps1 -Mode dev
.\scripts\local-build.ps1 -Mode test
```

`local-build.ps1` 只从 `.secrets/crypto.dpapi` 读取 48 字节并在进程内注入；不会把材料写入仓库或输出。没有本地材料的公开贡献者可以只运行 `npm run tauri dev`，此时应用应显示 `keyAvailable=false`，解密不可用。也可在当前 PowerShell 会话手动设置，构建后立即清除：

```powershell
# 值从受保护的本地存储读取，不在此文档中展示
$env:HEARTOPIA_CRYPTO_MATERIAL_B64 = '<从本地安全存储注入>'
$env:HEARTOPIA_RELEASE = '1'
node scripts/verify-crypto-material.mjs --require

# ...执行发布构建...

Remove-Item Env:HEARTOPIA_CRYPTO_MATERIAL_B64
Remove-Item Env:HEARTOPIA_RELEASE
```

公开 CI 不注入该 secret，因此只能构建 `keyAvailable=false` 的开发产物；Release workflow 必须注入仓库 secret，并在构建前用 `scripts/verify-crypto-material.mjs --require` 校验。

## 6. 发布配置预检

```powershell
node scripts/preflight-release.mjs --release
```

检查项包括：

- `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 版本一致；
- NSIS x64、`createUpdaterArtifacts`、`currentUser` 安装；
- `webviewInstallMode = offlineInstaller` 且静默安装；
- 禁止降级、更新公钥与 GitHub `latest.json` 端点；
- `requireSignedVersion = true`，且签名 trusted comment 含版本；
- CSP 不含 `unsafe-eval`，未关闭 CSP 资产保护；
- 图标、锁文件、`.gitignore` 和 Git 跟踪文件不含 `.secrets`/`.env`；
- 发布材料存在且为 48 字节。

## 7. 构建安装包

签名与更新材料只通过环境变量传入，不写入配置文件：

```powershell
$env:HEARTOPIA_RELEASE = '1'
$env:HEARTOPIA_CRYPTO_MATERIAL_B64 = '<从本地安全存储注入>'
$env:TAURI_SIGNING_PRIVATE_KEY = '<私钥内容或仓库外路径>'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '<私钥密码；无密码则不设置该变量>'

npm run tauri build -- --bundles nsis
```

`tauri build` 会自动把应用版本写入 `.sig` 的 trusted comment；如果手工使用 `tauri signer sign`，必须传 `--app-version <version>`。发布配置必须启用 `requireSignedVersion`，否则应用不会比较该版本字段。

产物位置：

```text
src-tauri/target/release/bundle/nsis/<ProductName>_<version>_x64-setup.exe
src-tauri/target/release/bundle/nsis/<ProductName>_<version>_x64-setup.exe.sig
```

`verify-release-artifacts.mjs` 要求 NSIS 目录中恰好有一个 `*-setup.exe`。本地重复构建可能留下旧版本产物；请在确认旧产物不再需要后清理，或使用 CI 的干净 runner 构建。

安装包内置 WebView2 离线安装器，体积通常增加约 127 MB；若安装包明显小于 120 MiB，说明离线运行时未正确嵌入。可用以下命令核对：

```powershell
node scripts/verify-release-artifacts.mjs --bundle-dir src-tauri/target/release/bundle/nsis --summary artifacts/release-summary.json
```

该脚本检查：恰好一个 `*-setup.exe`、版本号、`.sig` 非空、SHA-256、体积启发式。体积检查不能替代干净机安装测试。

安装阶段的 WebView2 方案：

- `bundle.windows.webviewInstallMode = { "type": "offlineInstaller", "silent": true }`；
- NSIS 安装器检测系统是否已安装 WebView2 Runtime；缺失时运行内嵌的离线安装器，已有则跳过；
- 不采用“下载 bootstrapper”模式，因此目标机断网也能完成安装；
- 若企业策略禁止安装 WebView2，安装器会失败并保留明确错误，不会假装启动成功。

## 8. 干净 Windows 验证

至少准备 Windows 10 22H2 x64 和当前 Windows 11 x64 两个干净虚拟机/实体机快照：

1. 不安装 Node.js、Rust、Python、OpenSSL、Visual Studio 或游戏客户端。
2. 断开网络（或禁用网卡），确认安装包仍能安装 WebView2 并启动应用。
3. 用普通用户安装（不提升管理员），确认安装目录在用户范围。
4. 选择 `ScreenCapture` 样本与独立输出目录，扫描、筛选、勾选、解密。
5. 重启应用，确认输入/输出目录和筛选偏好保留。
6. 检查日志、失败清单和界面中没有完整用户目录、密钥或令牌。
7. 记录系统版本、WebView2 版本、安装包 SHA-256 和结果到 `docs/acceptance-evidence/`。

未完成这一步前，不得把“干净 Windows 可安装启动”标记为通过。

## 9. 代码签名（可选）

未购买 Authenticode 证书时，Windows SmartScreen 可能提示未知发布者。不要把自签名证书当作可信发布。若配置正式证书，使用 Tauri 的 Windows 签名配置或 `signCommand`，并确保证书和密码只存在于 CI secret。

## 10. 常见构建问题

- **`cargo` 找不到链接器**：安装 Visual Studio Build Tools 的 C++ 工作负载，并使用 `stable-x86_64-pc-windows-msvc`。
- **`npm ci` 失败**：确认 `package-lock.json` 与 `package.json` 一致，不要手改锁文件。
- **发布预检报缺少公钥**：运行 `npm run tauri signer generate` 生成更新密钥，把公钥写入 `plugins.updater.pubkey`；私钥只放 CI secret。
- **安装包过小**：检查 `bundle.windows.webviewInstallMode.type` 是否为 `offlineInstaller`，以及构建日志是否真的下载/嵌入了 WebView2 安装器。
- **构建时报材料长度错误**：重新从受保护存储读取 48 字节并 base64；不要用文本密钥、hex 或带换行的值。
