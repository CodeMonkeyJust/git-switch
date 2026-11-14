# 安全策略

[English](SECURITY.md)

## 支持的版本

| 版本 | 是否支持 |
|---|---|
| 0.x  | ✅ 直到 1.0 |

## 报告漏洞

安全问题请**不要开公开 issue**。

通过 GitHub Security Advisories 私下报告：
<https://github.com/CodeMonkeyJust/git-switch/security/advisories/new>

请附上复现步骤与受影响版本。我们争取在 7 天内响应。

## 安全模型

`gs` 会修改你拥有但并非由你创建的配置文件（`~/.gitconfig`、`~/.ssh/config`），
并管理对 SSH 密钥的引用。它的设计约束如下。

### `gs` 会保存什么

| 数据 | 位置 | 说明 |
|---|---|---|
| 身份（名称、邮箱） | `~/.config/gs/profiles.yaml` | 公开信息 |
| 目录规则 | `~/.config/gs/profiles.yaml` | 绝对路径 |
| SSH 密钥**名称** | `profiles.yaml` | 在 `~/.ssh` 下解析，绝不复制 |
| 被修改文件的备份 | `~/.config/gs/backups/` | 带时间戳 |

### `gs` 绝不保存什么

- 私钥或口令
- HTTPS 密码或访问令牌
- 任何一旦配置被提交就会变得危险的内容

`profiles.yaml` 在加载时即校验：任何匹配 `password`、`passphrase`、`token`、
`secret`、`api_key`、`private_key`、`credential(s)` 的键名，以及任何包含 PEM
私钥头的值，都会导致直接失败。

HTTPS 凭据请交给系统凭据管理器，密钥请交给 `ssh-agent`。

### 写入安全

- 每次写入都是原子的（临时文件 → `fsync` → 重命名）。
- 每个被修改的文件都会先备份。
- 计划生成后被改动的文件，除非指定 `--force`，否则不会被覆盖。
- 标记块残缺或重复时直接中止，绝不猜测。

### 范围限制

- `gs` 不拦截 `git` 或 `ssh`，它只生成这些工具会读取的文件。
- 当前版本中 `gs` 不访问任何网络服务。
- `gs gui` 只绑定 `127.0.0.1`，带有每进程随机令牌、`Host`/`Origin` 校验与严格 CSP。
