# Security Policy

## Supported versions

安全修复只保证覆盖最新发布版本（当前为 `0.1.x`）。旧版本请先升级再复测。

## Reporting a vulnerability

请不要在公开 issue 中提交密钥、真实用户目录、可利用细节或未脱敏日志。优先使用仓库的 **GitHub Security Advisories** 私密报告，并附：

- 受影响版本/提交；
- 复现步骤；
- 影响（读/写越界、覆盖、信息泄露、更新绕过等）；
- 建议修复。

完整的威胁模型、密钥处理和隐私边界见 [docs/SECURITY.md](docs/SECURITY.md)。更新包签名、路径隔离和日志脱敏属于重点范围。
