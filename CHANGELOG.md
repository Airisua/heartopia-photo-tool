# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 和 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.1] - 2026-11-03

维护补丁测试版本，用于继续验证签名更新与升级后的配置保留；不包含运行中替换代码。

### Added

- 英文 README 与使用说明，中英文文档可相互切换；应用界面仍为简体中文。

### Changed

- README 更新首个桌面测试版本的安装包发布状态，保留未完成的干净机和跨版本更新验收说明。
- 中文使用说明与实际界面保持一致：解密包含筛选外的已选图片，补齐全选/反选按钮和更新按钮名称。

### Fixed

- 发布流程在生成更新清单前规范化安装包对外文件名，避免 GitHub 将空格改为点后产生无效下载地址。
- 本地构建仅校验本次版本的独立暂存包，避免旧版安装包保留在缓存目录时误报；不删除或改写旧包。
- 构建/原生验收辅助脚本显式加载 Windows DPAPI，兼容未预加载相关程序集的 Windows PowerShell 进程。
- 更新验签负向测试不再把目标版本固定为 `0.1.1`，而是针对输入版本生成确实不同的测试版本，避免新版本被误判为“签名版本校验失效”。

### Tests

- 增加无真实密钥的辅助脚本回归检查，并纳入 CI 与 Release 工作流；验证密钥分阶段隔离、失败后清理、代理恢复和旧包不变。
- 增加验签测试版本选择的回归检查，覆盖当前版本、预发布、构建元数据及未来版本。

### Verification

- `0.1.0` 已收到使用者“实机查看无问题”的反馈；该反馈记录为实机烟测，不扩大为双系统干净机或跨版本更新验收。
- 公开 `0.1.0` 安装包的完整下载、SHA-256 一致性和 Tauri Updater 签名正反例已复核；`0.1.1` 安装、升级与配置保留仍须实际执行后记录。

## [0.1.0] - 2026-11-03

首个公开版本，发布验收进行中。

### Added

- Tauri 2 桌面界面：目录配置、自动探测、最近目录、筛选、虚拟列表、缩略图和多选。
- Rust 原生 AES-256-CBC/PKCS7 解密，输出按文件签名校正 JPG/PNG。
- 文件名日期按 Windows FILETIME（100ns 自 1601 UTC）解析，失败时回退修改时间；支持今天、近 7 天、近 30 天、自定义起止日期。该规则已用真实 Photo 样本与文件修改时间批量对照验证；具体计数属于本机私有数据，不写入仓库，也不作为固定规模。
- 批量解密、进度、取消、单文件失败继续、失败清单导出。
- 重名跳过与自动重命名，临时文件完成后原子改名，不覆盖、不留半成品。
- 日志面板、日志文件轮转、打开日志目录、导出日志。
- 输入/输出目录持久化，跨筛选保留选择。
- 输入只读、输出隔离、受保护目录拒绝、重解析点防护。
- Tauri Updater + GitHub Releases 签名更新，启动/手动检查更新。
- NSIS x64 安装包，内置 WebView2 离线安装器。
- README、使用/架构/构建/发布/安全文档和验收账本。

### Security

- 游戏 AES 材料仅构建期注入，不写入源码、配置、日志或 IPC。
- 更新包必须通过内置公钥验签；禁止降级。
- 日志与失败清单路径脱敏，发布前执行 secret scan。

### Verification

- 当前状态：`Pending`。功能、性能、干净 Windows 10/11 安装、真实图片回归和更新链路必须按 `docs/ACCEPTANCE.md` 记录证据；未完成前不得宣称全部验收通过。

[Unreleased]: https://github.com/Airisua/heartopia-photo-tool/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Airisua/heartopia-photo-tool/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Airisua/heartopia-photo-tool/releases/tag/v0.1.0
