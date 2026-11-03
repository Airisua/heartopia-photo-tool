# GitHub 仓库与 Actions 状态

- 日期：2026-11-03
- 仓库：<https://github.com/Airisua/heartopia-photo-tool>（Public）
- 状态：**Partial**；仓库与 secret 名称已验证，Release/安装包尚未发布。

## 已验证

- 已确认仓库推送与 Actions 发布权限可用；认证来源和本机凭据管理细节不记录。
- 公开仓库已创建，`origin` 已配置。
- Actions secrets 已保存（只核对名称，不读取值）：
  - `HEARTOPIA_CRYPTO_MATERIAL_B64`
  - `TAURI_SIGNING_PRIVATE_KEY`
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

## 待完成

- 提交并推送最终文档/代码；
- CI 在 GitHub 上实际运行；
- Release workflow 构建、签名、上传 `setup.exe`/`.sig`/`latest.json`；
- 匿名下载 Release 资产；
- 干净 Windows 安装与 0.1.0 → 0.1.1 更新链路。

A10 因此只能标 `Partial`，不能因为仓库公开和 secrets 存在就标 `Pass`。
