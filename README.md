# 心动小镇图片解密工具

**简体中文** | [English](README.en.md)

## 项目介绍

心动小镇图片解密工具（Heartopia Photo Tool）是一款面向 Windows 10/11 x64 的本地桌面工具，用于批量扫描与还原《心动小镇》客户端 `ScreenCapture` 目录中的加密截图。

工具在本地离线运行，安装后无需预装 Node.js、Rust、Python 或 OpenSSL，也不需要启动游戏客户端或任何外部本地服务。处理过程中对原始输入目录保持只读，输出文件仅写入用户指定的外部目录，并通过临时文件原子写入与重名跳过/自动重命名策略避免覆盖已有文件。

## 免责声明

- 本项目为非官方桌面工具，与游戏开发商及发行商没有任何关联。
- 请仅使用本工具处理你本机合法拥有并有权访问的截图文件，切勿用于任何未经授权的用途。
- 本软件按“现状”提供，不附带任何明示或暗示的担保；使用前建议保留原始截图备份。

## 技术栈

- **桌面框架**：Tauri 2（Windows x64 NSIS 安装包、内置 WebView2 离线安装器、签名版应用更新）
- **后端与核心解密**：Rust（原生 AES-256-CBC / PKCS7 解密、后台扫描与并发任务调度、路径安全校验、日志轮转）
- **前端界面**：React 19、TypeScript、Vite、`@tanstack/react-virtual`（虚拟滚动）、`lucide-react`
- **测试与质量保障**：Vitest、Testing Library、Cargo Test
