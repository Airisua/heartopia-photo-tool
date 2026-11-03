# 干净 Windows 验收手册

## 1. 严格定义

“干净 Windows 验收”指：

- 全新 Windows 10 22H2 x64 或 Windows 11 x64 虚拟机/实体机快照；
- 未安装 Node.js、Rust、Python、OpenSSL、Visual Studio、Git 等开发工具；
- 未安装 TapTap 或心动小镇客户端；
- 未安装过本工具；
- 安装/更新测试前处于离线状态（或仅允许访问 GitHub Release，用于更新测试的另一阶段）；
- 在私有记录中登记虚拟化平台、快照名称/ID/创建时间、系统 build、安装包 SHA-256 和 WebView2 版本；公开证据只保留脱敏摘要。

开发机、浏览器 preview、带开发工具的主机、或无法说明来源的 Windows 环境都**不是**干净机证据。

## 2. 当前状态

当前开发主机是已安装开发工具和游戏目录的 Windows 11 x64 机器，没有可用的 `Get-VM`、`VBoxManage`、`vmrun` 或 Windows Sandbox 入口。具体系统 build、硬件型号和工具清单不写入公开文档，只保留在私有验收记录中。因此：

> **Windows 10/11 干净机验收：Unsupported until actual clean env available（当前不可执行）。**

这不是产品失败，也不是“已经通过”；只是没有可用的干净环境。详见 [状态记录](acceptance-evidence/2026-11-03-clean-machine-status.md)。

## 3. 环境自检脚本

在候选干净机内运行（不需要开发工具，只需要 PowerShell）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-clean-machine.ps1
```

输出 JSON 供证据归档：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-clean-machine.ps1 -Json |
  Out-File -FilePath clean-machine.json -Encoding utf8
```

脚本会检查 Windows 家族/架构、Hypervisor 标志、VM 工具、开发工具是否存在、TapTap/游戏目录，并明确打印 `proof: false`。默认只输出脱敏摘要，不输出机器型号、精确 build 或工具名称；非标准安装位置用 `-TapTapPath` 或 `HEARTOPIA_TAPTAP_PATHS` 指定，也不会输出完整用户目录。

`-RequireClean` 在无法证明干净环境时返回退出码 3；不要在没有外部快照证明时绕过。

## 4. 验收步骤（Windows 10 与 Windows 11 各一次）

1. 在虚拟化平台创建全新快照，记录快照名称/ID、创建时间、ISO/镜像来源。
2. 在 guest 内运行第 3 节脚本，保存 JSON；确认 `devTools` 为空、TapTap/game 为 false。
3. 断网（安装 WebView2 阶段必须验证离线）。
4. 从 Release 下载 `*-setup.exe`，在 guest 内计算 SHA-256，与 Release 记录一致。
5. 以普通用户安装（不提升管理员），记录安装路径与 WebView2 版本。
6. 启动应用，选择本地样本目录和独立输出目录，扫描并解密一张 JPG/PNG。
7. 关闭并重启应用，确认输入/输出 basename、筛选和并发设置保留。
8. 检查界面/日志不显示完整用户目录或密钥；记录日志轮转。
9. 升级测试使用下一版本（0.1.0 → 0.1.1），验证 `.sig` 被应用接受；再篡改 manifest/signature 验证拒绝且旧版本仍可用。
10. 把 JSON、SHA-256、截图/计数和结论写入 `docs/acceptance-evidence/`；只有完成两台系统后才把 A9 标为 Pass。

## 5. 更新签名验收要求

- Release 构建必须生成 `<setup>.exe.sig`；`latest.json` 的 `signature` 必须是 `.sig` 内容，不是路径。
- `.sig` 的 trusted comment 必须含 `version:<版本>`，且应用设置 `requireSignedVersion: true`；否则只验包字节、不绑定版本，旧包可被配新版本号。
- `verify-published-release.mjs` 只检查 manifest 一致性/可访问性；密码学验签由 Tauri Updater 在下载时执行。
- 必须做正向（有效签名可安装）和负向（篡改 `.sig`/manifest 被拒绝、当前版本继续可用）测试。
- 版本号必须来自 `latest.json` 且高于当前版本；Tag、package/tauri/Cargo 版本一致。

## 6. 当前不可执行的原因

当前主机没有可创建/恢复干净快照的虚拟化管理入口（`Get-VM`/`VBoxManage`/`vmrun` 均不可用），Windows Sandbox 也未安装；即使手工启动 Hyper-V 管理器，也不能把此前的开发机运行当作干净机证据。必须先提供可用快照环境，才能进行 A9。
