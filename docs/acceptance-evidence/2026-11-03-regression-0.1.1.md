# 0.1.1 候选版本回归记录

- 日期：2026-11-03。
- 范围：独立项目的本地 `0.1.1` 候选工作树；最终发布提交以 `v0.1.1` 标签为准。
- 环境性质：开发环境，不是干净 Windows 安装验收。
- 原始图片、真实目录、实际图片库规模、样本 ID、密钥和完整日志均不进入公开证据。

## 本轮已执行

| 检查 | 结果 | 证据范围 |
|---|---|---|
| TypeScript 检查、前端测试、生产构建 | Pass；前端 26 项测试通过 | 筛选、选择、缓存与前端桥接测试；不等同于安装版 GUI 全流程 |
| 核心与 Tauri 格式检查、clippy | Pass | 两个 Cargo 项目，`--all-targets -- -D warnings` |
| 核心测试 | Pass；50 项 | 解密、日期、扫描、路径、输出、重名、取消等核心逻辑 |
| Tauri 层测试 | Pass；8 项 | 配置、路径脱敏、日志及更新下载超时策略测试 |
| 隐私与发布校验器测试 | Pass；31 项 | 扫描规则、发布清单与下载校验器测试 |
| 原生图片与异常回归 | Pass | 真实目录只读扫描、代表性图片解密与图像解码；源文件未变；损坏输入、跳过/重命名、取消、中文/长路径与临时输出检查 |
| 原生 CLI 工作目录边界 | Pass；6 个拒绝场景 | 相同/嵌套/游戏图片树内/包含输入/非空/重解析点工作目录均拒绝；输入未变，无路径泄露 |
| 构建辅助脚本回归 | Pass | 合成 DPAPI 材料、全新 Windows PowerShell 进程、旧新包共存、分阶段密钥隔离、清理与代理恢复；没有真实私钥或编译器参与模拟场景 |
| 更新验签版本选择回归 | Pass | 测试版本必须确实不同于签名版本，覆盖当前版本、预发布和构建元数据 |
| 本地 `0.1.1` 安装包与清单 | Pass | NSIS x64 产物和 `.sig` 已生成；独立暂存目录、版本绑定、清单与哈希校验通过 |
| 真实 Tauri Updater 验签 | Pass | `0.1.1` 有效包通过；篡改包、篡改签名和版本不匹配被拒绝；原包未被修改 |
| Release 可执行文件依赖检查 | Pass（静态检查） | 导入表未发现 Node、Rust、Python、OpenSSL 或额外 VC 运行库 DLL，仅见 Windows 系统 API/UCRT；不替代干净机启动 |

## 可复现命令

```powershell
npm run typecheck
npm test
npm run build
cargo fmt --manifest-path crates/photo-core/Cargo.toml --all -- --check
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path crates/photo-core/Cargo.toml --locked --all-targets -- -D warnings
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path crates/photo-core/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked --example verify_update
node --test scripts/privacy-scan.node.mjs scripts/verify-published-release.node.mjs
./scripts/local-build.tests.ps1
./scripts/local-native-acceptance.ps1
./scripts/local-native-acceptance.tests.ps1
./scripts/local-verify-update.ps1 -Package '<SETUP>' -Signature '<SIG>' -Manifest '<MANIFEST>'
```

原生真实图片回归需要已准备的本地 DPAPI 材料。路径和详细规模仅留在被忽略的本地输出中。

## 本轮修正的验收工具问题

1. 全新 Windows PowerShell 进程未加载 DPAPI 类型，导致辅助脚本失败；显式初始化后合成材料回归通过。
2. 本地缓存同时保留旧新版包时，校验器选中旧包并误报版本/签名不符；辅助脚本改为只暂存本次版本，严格单包校验不变，旧包保留。
3. 验签负向测试把不同版本固定为 `0.1.1`，测试 `0.1.1` 时实际未改变版本；回归测试先复现失败，再修正为保证语义版本不同的探针，真实验签正反例通过。

## 更新传输策略修正

源代码与缓存的 Tauri Updater 实现共同确认：原来的短超时会同时应用于更新清单检查和整个安装包下载。包含离线 WebView2 的安装包较大，慢网速下可能提前超时。

`0.1.1` 保留短元数据检查超时，并给返回的已校验发布来源的更新对象设置独立、更长的下载超时。回归测试先复现共用短超时的失败，再验证新策略通过；签名、公钥、下载来源限制及失败时保留当前版本的处理不变。已经安装的旧版不能远程改变其超时策略，遇到下载失败时应使用公开的完整安装包直接升级，不应关闭签名验证。

这些工具问题不应被描述为已发布 `0.1.0` 的解密或签名功能失效。

## 未覆盖的要求

- 该记录不是 Windows 10/11 双系统干净机安装或缺失 WebView2 的离线安装证明。
- 验签示例不运行安装器，不证明真实 `0.1.0` → `0.1.1` 下载、安装、重启或配置保留。
- 核心原生示例不覆盖日志面板交互、日志/失败清单的 GUI 导出与完整安装版操作。
- 知识图服务当前不可用，代码核对采用精确文件源读取和上述测试；不声称图索引覆盖完整。
