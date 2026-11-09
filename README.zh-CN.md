# gs — 多 Git 身份与 SSH 配置管理器

[![Node](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

在一台电脑上管理**多个 Git 账号**，告别配置互相打架。

如果你用个人密钥推 GitHub、用另一把推 Gitee、再用第三把推公司 Gitea，
而 `~/.gitconfig` 和 `~/.ssh/config` 总是互相干扰——`gs` 把它们变成
**声明式、可移植、可审查**的配置。

> 为什么选 YAML 而不是 SQLite？因为配置里本来就不存放任何秘密。私钥交给
> ssh-agent，令牌交给系统凭据管理器。没有秘密要保护，加密引擎就没有收益，
> 反而牺牲了可移植性与可审查性。

---

## 它解决什么问题

| 症状 | 根因 | `gs` 的解法 |
|---|---|---|
| 某个站点 `Permission denied (publickey)` | SSH 没有按站点指定密钥，试了错的那把 | 每个身份生成独立 `Host` 块，带 `IdentitiesOnly yes` |
| 提交邮箱总是错的 | 全局 `user.email` 渗进所有仓库 | 目录 → 身份规则，生成 `includeIf` |
| 换新电脑要重配几小时 | 配置散落在各处 | 可移植快照 + 一条命令导入 |

---

## 核心特性

- **目录 → 身份映射**：声明式规则，生成 `gitdir:` 形式的 `includeIf`
- **托管块**：只改 `# >>> gs:managed >>>` 标记内的内容，块外逐字节保留（含 CRLF）
- **SSH 密钥路由**：每个站点一个 `Host` 别名 + `IdentitiesOnly yes`
- **默认安全**：原子写入、自动备份、`apply` 幂等
- **并发保护**：计划生成后被他人改动的文件拒绝覆盖
- **绝不存秘密**：`profiles.yaml` 校验会拒绝密码、令牌、私钥
- **零运行时依赖**：纯 Node，无需 `node_modules`

---

## 快速开始

```bash
node src/cli.ts init    # 自动探测 SSH 主机与仓库，生成初始配置
node src/cli.ts diff    # 预览将要写入的内容
node src/cli.ts apply   # 写入托管块（自动备份）
node src/cli.ts list    # 查看当前目录归属哪个身份
node src/cli.ts doctor  # 诊断密钥、SSH 配置与当前目录身份
```

| 命令 | 作用 |
|---|---|
| `gs init [--root <dir>] [--force]` | 探测 SSH 主机与仓库，生成初始配置 |
| `gs list` | 查看身份、规则、当前目录归属 |
| `gs diff` | 预览所有变更 |
| `gs apply [--dry-run] [--force]` | 写入托管块 |
| `gs doctor [--online]` | 诊断密钥、SSH 配置、当前目录身份 |
| `gs key list\|gen\|copy` | 密钥列举、生成、复制公钥 |
| `gs snapshot export\|import` | 可移植快照（含加密与路径改写） |

### 迁移到新电脑

```bash
# 旧机器
gs key list                                   # 确认每个身份用的是哪把密钥
gs snapshot export backup.gsnap --with-keys   # 含私钥，整体加密

# 新机器
gs snapshot import backup.gsnap --remap D:/CODE=/home/me/code
gs doctor                                     # 确认还缺什么
gs apply
```

**安全原则**：
- 默认导出**不含任何密钥材料**，密钥应在每台机器上单独生成（更安全）
- `--with-keys` 时整个快照用 scrypt + AES-256-GCM 加密，口令错误会明确失败
- 快照里的私钥**绝不会**被自动写入 `~/.ssh`
- 快照只包含 `gs` 托管的 SSH 块，不含你自己的配置

`gs doctor` 会把**问题按严重程度排在前面**，并对每项给出可直接执行的修复命令。
加上 `--online` 会真实执行 `ssh -T` 握手验证。

`gs init` 会读取你的机器并给出建议：识别 `~/.ssh/config` 中的主机、
扫描代码目录下的 Git 仓库、按顶层文件夹归组，并生成对应的身份与规则。

配置位于 `~/.config/gs/profiles.yaml`：

```yaml
schemaVersion: 1
identities:
  work:
    user:
      name: zhulj
      email: zhulj@pde.com.cn
    sshKey: id_ed25519
    sites:
      - host: git.pdesoft.cn
        port: 9092
        alias: pde
  personal:
    user:
      name: zlj20
      email: zlj20@163.com
    sshKey: id_ed25519_github
    sites:
      - host: github.com
        alias: gh

rules:
  - dir: D:/CODE/PDE-GIT
    identity: work
  - dir: D:/CODE/github
    identity: personal

settings:
  backupKeep: 20
```

---

## 工作原理

`gs` **不拦截** `git`。它是一个生成器：`apply` 之后，你照常使用原生的 `git` 和 `ssh`。

```
profiles.yaml
      │  gs apply
      ▼
~/.gitconfig                    (includeIf 块)
~/.config/gs/identities/*.gitconfig
~/.ssh/config                   (Host 块)
      │
      ▼
   git & ssh                    原封不动
```

> **重要**：`includeIf "gitdir:..."` 只在 Git 解析仓库时生效。
> 因此规则目录下必须包含 Git 仓库，映射才会起作用。

---

## 安全模型

| 属性 | 保证 |
|---|---|
| 块外内容 | 逐字节保留，包含 CRLF 换行 |
| 备份 | 每次写入前生成带时间戳的备份 |
| 幂等 | 配置无变化时，第二次 `apply` 不写入任何文件 |
| 并发 | 计划生成后被修改的文件拒绝覆盖（`--force` 可覆盖） |
| 标记 | 重复或残缺标记直接报错，绝不猜测 |
| 秘密 | `profiles.yaml` 不允许出现密码、令牌、私钥 |

---

## 环境要求

- Node.js ≥ 22.6（使用原生 TypeScript 类型剥离）
- Git 2.36+

支持 Windows / macOS / Linux。

---

## 开发

```bash
npm test              # 单元测试 + 端到端测试
npm run typecheck     # tsc --noEmit
```

所有测试都在**临时 home 目录**中运行，绝不触碰你真实的
`~/.gitconfig` 与 `~/.ssh/config`。

---

## 路线图

- [x] M1 —— 托管块、`init` / `apply` / `diff` / `list`
- [x] M2 —— `doctor` 诊断（密钥、SSH 配置、身份解析）
- [x] M3 —— `gs gui`（本地界面，零依赖）
- [x] M4 —— 密钥管理、加密快照、`export` / `import`

---

## 许可证

MIT
