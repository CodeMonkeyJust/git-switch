# 架构

`gs` 是一个**生成器**：它计算 `git` 与 `ssh` 会读取的配置文件，并诊断生成后的环境。
它从不拦截或包装 `git`。

[English](architecture.md)

```
┌──────────────────────────────────────────────┐
│  表现层（轻量、可选）                          │
│    src/cli.ts        gs list | diff | apply  │
│    src/server/       gs gui（HTTP + 静态资源）│
│    web/              纯 JS，无框架             │
└───────────────┬──────────────────────────────┘
                │  Plan 对象
┌───────────────▼──────────────────────────────┐
│  核心层  src/core/  — 无 UI、无 argv、无 http  │
│    model / yaml / profiles / discover        │
│    managed-block / render/* / checks         │
│    plan  →  apply                            │
└──────────────────────────────────────────────┘
```

界面只是一层**表现层**：`src/server/http.ts` 把 HTTP 端点映射到 CLI 调用的同一批
`core` 函数，`web/` 是静态 ES 模块。替换前端永远不需要改动引擎。

## `Plan` 对象

`plan()` 是“将会发生什么”与“真正执行”之间的接缝。

- 它读取当前文件，返回带 `before`/`after` 内容的 `FileOp[]`。
- 它对文件系统**只读**。
- CLI 把 `Plan` 渲染成 unified diff，界面渲染成可视化差异。两者消费同一个对象，
  因此不可能互相矛盾。

`apply()` 执行一个 `Plan`：

1. 校验每个目标文件仍是计划生成时的内容；
2. 为每个文件生成带时间戳的备份；
3. 原子写入（临时文件 → `fsync` → 重命名）。

## 托管块

`gs` 修改的是不属于它的文件。它写入的所有内容都位于：

```ini
# >>> gs:managed >>>
…
# <<< gs:managed <<<
```

规则：

- 标记之外的内容逐字节保留，包含 CRLF。
- 标记重复或残缺时中止：猜测可能损坏用户文件。
- 内容为空时整块移除，而不是留下空标记。

## 生成产物

| 文件 | 内容 |
|---|---|
| `~/.gitconfig` | `includeIf "gitdir:<规则>/"` 条目，指向各身份的配置 |
| `~/.config/gs/identities/<名称>.gitconfig` | `user.name/email`、凭据用户名、`url.*.insteadOf` |
| `~/.ssh/config` | 每个站点一个 `Host <别名>`，带 `IdentityFile` 与 `IdentitiesOnly yes` |

### 为什么用 `includeIf "gitdir:"` 而不是逐仓库配置

`gitdir:` 把映射集中在一处，并作用于某目录下的所有仓库（含子目录），无需逐个修改仓库。

**重要语义**：`includeIf "gitdir:..."` 只在 git 解析仓库时求值。一个没有 `.git`
的普通目录不会应用该身份——这与实际使用一致，因为你总是在仓库内提交。

**格式约束（已在 Windows 版 git 上验证）**：模式必须是绝对路径，使用正斜杠，
并以斜杠结尾。

### 为什么用 SSH 别名而不是直接的 `Host github.com`

一个直接的 `Host github.com` 条目会作用于机器上的所有仓库，并可能与用户自己的
配置冲突。别名（`gh`、`pde`）通过 `insteadOf` 路由匹配，因此只有经由别名的仓库
才会使用预期的密钥。

## 路径处理

- 规则以正斜杠存储，结尾不带分隔符。
- `~` 在加载时展开，在显示与移植时收缩。
- Windows 上路径匹配不区分大小写，且是前缀安全的
  （`/code/git` 不会匹配 `/code/githubx`）。
