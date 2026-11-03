# 验收记录

本文件是验收账本，不是通过声明。只有附上当前提交、可复现命令和证据后，才能把状态改为 `Pass`。未执行的项目保持 `Pending`。

图例：`Pending` 未验证；`Partial` 有部分证据但未覆盖全部要求；`Pass` 有证据且符合预期；`Fail` 有证据但不符合；`Blocked` 受外部条件阻塞并注明原因。

> 2026-11-03 本地检查曾在加固前全绿，随后 core 加固引入 `WriteOutcome::Cancelled` 编译错误，见 [core hardening status](acceptance-evidence/2026-11-03-core-hardening-status.md)；发布前必须复跑。原生开发构建已跑通主路径，见 [部分运行证据](acceptance-evidence/2026-11-03-native-dev-partial.md)；这不等于干净机、安装版或更新链路验收，A1–A10 仍按证据逐项判定。

## 1. 验收环境

| 项目 | 值 |
|---|---|
| 代码提交 | 待填 |
| 构建日期 | 待填 |
| 安装包 SHA-256 | 待填 |
| Windows 版本 | 待填（至少 Win10 22H2 x64 与 Win11 x64） |
| WebView2 版本 | 待填 |
| 是否干净机 | 待填 |
| 验收人 | 待填 |

## 2. 功能与安全账本

| ID | 要求 | 验证方法 | 证据 | 状态 |
|---|---|---|---|---|
| A1 | 原生 AES-256-CBC/PKCS7 能解出可打开 JPG/PNG；损坏密文明确失败 | `cargo test --manifest-path crates/photo-core/Cargo.toml`；真实样本只读解密并与源哈希对照（Photo/Draw 已实测；Limit/NoBgPhoto/Announcement 待逐类） | 单测曾 34 PASS（加固后待复跑）；[部分运行证据](acceptance-evidence/2026-11-03-native-dev-partial.md)：JPEG/PNG 解码后可正常打开，源哈希/大小/mtime 不变 | Partial |
| A2 | 文件名日期按 Windows FILETIME（100ns 自 1601 UTC）解析；无法解析回退修改时间并标注来源 | 日期单测 + 真实 Photo 样本批量对照（具体计数不入库）；核对本地日期边界和今天/7天/30天 | [FILETIME 证据](acceptance-evidence/2026-11-03-filetime.md)（行为高置信，待补命令/来源）；7d 筛选原生运行部分证据 | Partial |
| A3 | 递归扫描、扩展名过滤、取消、错误计数；大列表虚拟滚动与按需缩略图，后台扫描不阻塞界面 | 使用不同规模的图片库；私有记录耗时、错误数；检查列表滚动、缩略图与取消 | 原生开发构建已完成图片库只读扫描（部分，不公开本机规模或固定耗时）；滚动/缩略图/取消待测 | Partial |
| A4 | 输入只读；输出不得相同/嵌套/别名/受保护目录；拒绝 junction/symlink | 路径单测 + 手工 junction + 受保护目录快照比对 | 单测、拒绝提示、快照比对输出 | Pending |
| A5 | 输入/输出/最近/筛选/并发/重名策略重启保留；切换筛选保留选择 | 关闭重开；筛选前后勾选计数 | [部分运行证据](acceptance-evidence/2026-11-03-native-dev-partial.md)：basename/查询/7d/workers2/skip 重启保留；筛选结果保留隐藏选择 | Partial |
| A6 | 批量解密、进度、取消、单文件失败继续、跳过/重命名、无半成品、失败清单 | 正常批次 + 混合损坏文件 + 取消 + 重名冲突 + 只读输出 | [部分运行证据](acceptance-evidence/2026-11-03-native-dev-partial.md)：两批成功/跳过、无临时文件、已存在输出未覆盖；取消/损坏/失败 CSV 待测 | Partial |
| A7 | 日志面板/文件、轮转、打开目录、导出；无敏感路径/密钥 | 触发各类事件；搜索日志与导出文件 | 脱敏日志片段、搜索命令输出 | Pending |
| A8 | 签名更新可检查、下载、安装、重启；失败不影响当前版本；配置保留 | 发布 0.1.0 与 0.1.1，执行第 7 节更新链路；`.sig` trusted comment 必须含匹配 `version:`；开发机正向测试可验证 `.sig`/版本，但不能替代干净机；必须做篡改 manifest/`.sig` 的负向测试 | 两版 Release、`.sig` trusted comment、更新截图、版本与配置记录 | Pending |
| A9 | 干净 Windows 10/11 x64 无开发环境可安装启动；离线 WebView2 | 两个干净 VM/实体机，断网安装并解密 | [当前状态](acceptance-evidence/2026-11-03-clean-machine-status.md)：**Unsupported until actual clean env available**；需按 [CLEAN_MACHINE.md](CLEAN_MACHINE.md) 执行 | Blocked |
| A10 | 文档齐全；Git 提交清晰；公开仓库与 Release 可访问 | 检查 README/使用/架构/构建/发布/CHANGELOG；`git log`；匿名访问 Release | [GitHub 状态](acceptance-evidence/2026-11-03-github-status.md)：Public repo + 3 secrets 已核验；Release/提交/资产待完成 | Partial |

## 3. 必跑命令

```powershell
npm ci
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

发布前：

```powershell
$env:HEARTOPIA_RELEASE = '1'
node scripts/verify-crypto-material.mjs --require
node scripts/preflight-release.mjs --release
```

受保护目录只读验证（先快照，执行应用测试，再比对）：

```powershell
$env:HEARTOPIA_PROTECTED_PATHS = '<GAME_ROOT>;<PROJECT_ROOT>'

powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-protected-paths.ps1 `
  -Mode snapshot -Record artifacts\protected-before.json -Hash

# ...运行扫描/解密/取消等测试...

powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-protected-paths.ps1 `
  -Mode compare -Record artifacts\protected-before.json -Hash
```

快照记录不写入受保护目录。脚本不内置本机路径；请用 `HEARTOPIA_PROTECTED_PATHS`（分号分隔）或 `-Path` 指定 `<GAME_ROOT>` 与 `<PROJECT_ROOT>`。`-Hash` 会遍历并读取所有文件，耗时较长，但比只比元数据更强。

干净机自检（当前开发主机会返回 `UNSUPPORTED`，退出码 3）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-clean-machine.ps1 -RequireClean
```

在真正的干净 guest 中先运行不带 `-RequireClean` 的 JSON 输出并归档，再按 `CLEAN_MACHINE.md` 执行安装/解密/重启。

## 4. 真实图片回归（只读）

1. 选择真实 `ScreenCapture` 的一个子目录（建议先 `Photo` 中小批量）。
2. 在测试前后对源目录做快照；确认无新增、删除、修改。
3. 解密到独立输出目录，抽查 JPG/PNG 能被系统图片查看器打开。
4. 对同一文件重复解密，确认默认跳过、可选重命名且不覆盖。
5. 记录源文件数量、成功/失败/跳过数、耗时、输出总大小。

不得把真实截图、用户目录或密钥材料提交到仓库；证据只保留脱敏后的计数、哈希和截图。

## 5. 路径与权限用例

| 用例 | 预期 |
|---|---|
| 输出等于输入 | 拒绝，提示不能相同 |
| 输出在输入内部 | 拒绝，提示不能嵌套 |
| 输出经 junction/symlink 指向输入 | 拒绝 |
| 输出指向 TapTap 根目录（含游戏安装） | 拒绝 |
| 中文路径 | 正常扫描/输出 |
| 超过 260 字符路径 | 正常或明确错误，不崩溃 |
| 只读源文件 | 可读可解密，源文件不变 |
| 输出磁盘满/只读 | 单文件失败，无半成品，任务继续或明确终止 |
| 损坏/截断/0 字节密文 | 记录失败原因，不生成输出 |

## 6. 性能记录

使用不同数量、分辨率和容量的图片库进行性能测试，并在本地记录以下指标；公开资料只保留脱敏汇总，测试样本不作为固定用户规模或数量限制：

- 扫描总耗时、每秒文件数、错误/跳过数；
- 列表滚动是否保持响应，缩略图并发与内存峰值；
- 批量解密吞吐、成功/失败/跳过、取消响应时间；
- 任务期间 UI 是否可操作（至少可取消、看进度）。

不设固定文件数、分辨率档数、总容量或未经验证的秒数承诺；以“界面不阻塞、可取消、单文件失败不拖垮整批”为硬性要求。实测指标留在私有记录中，公开证据只说明测试方法、行为结果与尚未覆盖的项目。

## 7. 干净机与更新

### A9 干净机

1. 使用未安装开发工具和游戏的 Windows 10 22H2 x64 / Windows 11 x64 快照。
2. 断网，安装 Release 中的 `*-setup.exe`。
3. 首次启动应完成 WebView2 离线安装（若系统缺失），随后显示主界面。
4. 用 U 盘/本地样本完成一次解密，确认不依赖网络或游戏进程。
5. 重启应用，确认配置保留。

### A8 更新

1. 安装 0.1.0 并设置配置。
2. 发布 0.1.1，确认 `latest.json` 指向新安装包和签名。
3. 0.1.0 检查更新、下载、安装、重启。
4. 确认版本与配置；再测试断网、404、篡改签名时不破坏当前版本。

## 8. 完成签署

- 所有 A1–A10 为 `Pass`，或对未测项明确写 `Blocked` 及原因；
- 证据文件位于 `docs/acceptance-evidence/`，不含秘密和完整用户目录；
- 公开仓库、Tag、Release 资产可匿名访问；
- README、使用说明、架构、构建/发布说明和 CHANGELOG 与当前实现一致；
- 验收人签字/日期。
