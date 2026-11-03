# 心动小镇图片解密工具

一个面向 Windows 10/11 x64 的本地桌面工具，用来批量还原《心动小镇》客户端 `ScreenCapture` 目录中的加密截图。基于 Tauri 2、Rust 原生 AES-256-CBC/PKCS7 和 React，安装后不依赖 Node.js、Rust、Python、OpenSSL，也不需要启动游戏或任何本地服务。

[Windows 安装包](https://github.com/Airisua/heartopia-photo-tool/releases) · [使用说明](docs/USAGE.md) · [版本记录](CHANGELOG.md)

> 当前为首个桌面测试版本。安装包已完成本地构建，正在验证和上传；正式下载以 Releases 页面实际附件为准。纯净 Windows 10/11 安装与跨版本更新验收尚未全部完成。

> 非官方工具，与游戏开发商和发行商无关。仅处理你本机有权访问的文件。

## 功能

- 自动探测默认 `LocalLow\xd\心动小镇\ScreenCapture`，也支持手动选择根目录或 `Photo`、`Draw` 等子目录。
- 递归扫描 `ScreenCapture` 及 `Photo`、`Limit`、`Draw`、`NoBgPhoto`、`Announcement` 等子目录。
- 按目录、JPG/PNG、日期范围、今天/近 7 天/近 30 天和关键字筛选；日期优先按文件名中的 Windows FILETIME 解析，失败时回退修改时间并标明来源。
- 长列表虚拟滚动，缩略图按需加载，不在首屏创建大量 DOM 节点。
- 支持大批量图片处理，扫描与解密在后台线程执行，并限制并发数量，避免阻塞界面；实际耗时取决于图片数量、大小和磁盘性能。
- 复选框多选、全选、反选、按当前筛选全选、清空；切换筛选保留选择。
- 批量解密、进度、取消、单文件失败继续、失败清单导出。
- 默认跳过重名文件，可选自动重命名；绝不覆盖已有文件。
- 临时文件写完再原子改名，失败或取消不留下半成品。
- 日志面板、日志文件轮转、打开日志目录、导出日志。
- 启动/手动检查更新，下载进度、签名校验、安装后重启；更新失败不影响当前版本。
- 应用内“热更新”指桌面应用版本升级，不会在运行中替换程序代码。
- 输入目录只读，输出目录不得等于或位于输入目录内部，并拒绝符号链接/junction 逃逸和受保护目录写入。

## 快速开始

1. 从 [Releases](https://github.com/Airisua/heartopia-photo-tool/releases/latest) 下载 `*-setup.exe`，核对页面提供的 SHA-256 后安装。
2. 选择 `ScreenCapture` 根目录或某个子目录，再选择独立的输出目录。
3. 扫描、按需筛选，勾选图片后开始解密。

安装包内置 WebView2 离线安装器。首次在没有 WebView2 的干净 Windows 上安装时，安装器会补齐运行时，不需要联网。

## 隐私与边界

- 原图只读，工具不会修改、移动或删除源文件。
- 输出只写入你指定的输出目录；重名不覆盖。
- 界面只显示目录最后一级名称和最近目录别名，手动路径输入使用遮罩；日志和失败清单不写完整用户目录。
- 游戏 AES 材料只在构建期注入，不显示、不记录、不提交；它随二进制分发，不能对本地逆向者保密。
- 应用离线运行；只有“检查更新”需要网络，且可以关闭。

详见 [架构说明](docs/ARCHITECTURE.md) 和 [安全说明](docs/SECURITY.md)。

## 系统要求

- Windows 10 22H2 x64 或 Windows 11 x64。
- 安装包为 NSIS x64，默认当前用户安装，不需要管理员权限。
- 不需要预装 Node.js、Rust、Python、OpenSSL 或游戏客户端。

## 开发者文档

以下资料面向维护者，**不是安装步骤或“已发布成功”的声明**。普通用户只需下载上方安装包并查看使用说明。

<details>
<summary>展开源码构建、架构与发布流程</summary>

开发环境需要 Node.js 22、Rust stable（MSVC）、Visual Studio C++ Build Tools 和 WebView2。

```powershell
npm ci
npm run tauri dev
```

测试与发布构建（含离线 WebView2、更新签名、干净机验收）见 [构建说明](docs/BUILD.md) 和 [发布说明](docs/RELEASE.md)。

- [架构说明](docs/ARCHITECTURE.md)
- [构建说明](docs/BUILD.md)
- [维护者打包与发布流程](docs/RELEASE.md)
- [验收记录](docs/ACCEPTANCE.md)
- [干净 Windows 验收手册](docs/CLEAN_MACHINE.md)
- [安全与隐私](docs/SECURITY.md)
- [安全报告政策](SECURITY.md)
- [CHANGELOG](CHANGELOG.md)

</details>

## 验收状态

`0.1.0` 的功能、性能、干净 Windows 安装和 0.1.0 → 0.1.1 更新链路以 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) 为准。未附证据的项目保持 `Pending`；不要仅凭单元测试或开发机启动就认定干净机验收通过。

## 许可证

[MIT](LICENSE)
