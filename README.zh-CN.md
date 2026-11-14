# gs — 多 Git 身份与 SSH 配置管理器

[![Node](https://img.shields.io/badge/node-%3E%3D22.6-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-success)](package.json)

在一台电脑上管理**多个 Git 账号**，告别配置互相打架。

如果你用个人密钥推 GitHub、用另一把推 Gitee、再用第三把推公司 Gitea，
而 `~/.gitconfig` 和 `~/.ssh/config` 总是互相干扰——`gs` 把它们变成
**声明式、可移植、可审查**的配置。

[English](README.md)

---

## 它解决什么问题

多账号 Git 环境通常在三个地方出问题：

| 症状 | 根因 | `gs` 的解法 |
|---|---|---|
| 某个站点 `Permission denied (publickey)` | SSH 没有按站点指定密钥，试了错的那把 | 每个身份生成独立 `Host` 块，带 `IdentitiesOnly yes` |
| 提交邮箱总是错的 | 全局 `user.email` 渗进所有仓库 | 目录 → 身份规则，生成 `includeIf` |
| 换新电脑要重配几小时 | 配置散落在各处 | 可移植快照 + 一条命令导入 |

---

## 核心特性

- **目录 → 身份映射** —— 声明式规则，生成 `gitdir:` 形式的 `includeIf`
- **托管块** —— 只改 `# >>> gs:managed >>>` 标记内，块外逐字节保留
- **SSH 密钥路由** —— 每个站点一个 `Host` 别名 + `IdentitiesOnly yes`，永不提交错误的密钥
- **默认安全** —— 原子写入、时间戳备份、`apply` 幂等
- **并发保护** —— 计划生成后被他人改动的文件拒绝覆盖
- **绝不存秘密** —— `profiles.yaml` 校验会拒绝密码、令牌、私钥
- **零运行时依赖** —— 纯 Node，无需 `node_modules`
- **中英双语** —— CLI 与图形界面均自动跟随系统语言

---

## 快速开始

三种运行方式，任选其一：

```bash
# 1. 从源码运行：Node 直接执行 TypeScript（无需构建）
node src/cli.ts init

# 2. 全局安装（npm 会执行 prepare，自动编译 dist/）
npm install -g .
gs init

# 3. 先构建一次，再用启动器
npm install && npm run build && node dist/gs.mjs init
```

然后：

```bash
gs diff     # 预览所有变更
gs apply    # 写入托管块（自动备份）
gs list     # 查看当前目录归属哪个身份
```

> `dist/` 里存放的是**编译后的 JavaScript**，不是 TypeScript 源码：Node 拒绝为
> `node_modules` 内的文件剥离类型，所以直接发布 `.ts` 文件安装后将无法运行。
> TypeScript 仅作为开发依赖，发布包依然零运行时依赖。

`gs init` 会读取你的机器并给出建议配置：

```
$ gs init
i 探测结果
·   git 身份        zhulj <zhulj@pde.com.cn>
·   SSH 主机        3
·   仓库            4
i 建议的身份
·   github       zhulj <zhulj@pde.com.cn>  → ssh.github.com
·   pdesoft      zhulj <zhulj@pde.com.cn>  → git.pdesoft.cn
·   gitee        zhulj <zhulj@pde.com.cn>  → gitee.com
i 建议的目录规则
·   ~/code/github  →  github
·   ~/code/gitee   →  gitee
·   ~/code/PDE-GIT →  pdesoft
! gitee.com：暂时没有可用的 SSH 密钥，请在 profiles.yaml 中为该身份设置 sshKey
✓ 已写入 ~/.config/gs/profiles.yaml
· 下一步：gs diff   （预览）   然后   gs apply
```

配置位于 `~/.config/gs/profiles.yaml`，按需修改后应用：

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
        port: 443
        sshHostName: ssh.github.com    # SSH 端点与主机不同时填写
        alias: gh

rules:
  - dir: D:/CODE/PDE-GIT
    identity: work
  - dir: D:/CODE/github
    identity: personal

settings:
  backupKeep: 20
```

> **关于 `sshHostName`**：`host` 是 Git 主机名（出现在 `git@github.com:...` 里），
> `sshHostName` 是实际拨号的 SSH 端点。GitHub 要通过 `ssh.github.com:443` 访问 SSH
> 时才需要它。两者填反会导致认证成功但传输时断开。

然后：

```bash
gs diff     # 预览所有变更
gs apply    # 写入托管块（自动备份）
```

---

## 命令

| 命令 | 作用 |
|---|---|
| `gs init [--root <dir>] [--force]` | 探测 SSH 主机与仓库，生成初始配置 |
| `gs list` | 查看身份、目录规则、当前目录归属，以及全局身份 |
| `gs diff` | 预览所有变更 |
| `gs apply [--dry-run] [--force]` | 写入 `~/.gitconfig` 与 `~/.ssh/config` 的托管块 |
| `gs doctor [--online]` | 诊断密钥、SSH 配置、当前目录身份 |
| `gs gui [--port N] [--no-open]` | 本地图形界面（仅监听 `127.0.0.1`） |
| `gs key list` | 列出 SSH 密钥的指纹及使用它的身份 |
| `gs key gen <name>` | 生成 ed25519 密钥对，公钥自动复制到剪贴板 |
| `gs key copy <name>` | 复制公钥到剪贴板 |
| `gs key restore <snapshot> [--force]` | 把快照中的密钥写回 `~/.ssh` |
| `gs snapshot export <file> [--with-keys] [--force]` | 导出可移植快照 |
| `gs snapshot import <file> [--remap OLD=NEW] [--force]` | 在另一台机器上恢复配置 |

全局选项：`--home <dir>`（使用备用 home 目录）、`--json`、`--no-color`、`--lang <en|zh-CN>`。

退出码：`0` 成功 · `1` 警告 · `2` 错误。

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

注意事项：

- 不加 `--with-keys` 时快照**不含任何密钥材料**；密钥应在每台机器上单独生成
  （更安全：一台机器一把钥匙）。
- 加 `--with-keys` 时整个快照用 scrypt + AES-256-GCM 和你设定的口令
  （或 `GS_PASSPHRASE`）加密。口令错误会明确失败，且不写入任何内容。
- 快照里的私钥**绝不会**被自动写入 `~/.ssh`。
- `--remap` 在目录结构不同时改写规则，只匹配完整路径段
  （`D:/CODE` 不会误伤 `D:/CODEX`）。
- 快照只包含 `gs` 托管的 `~/.ssh/config` 块，不含你自己的配置。

### `gs gui`

八个页面的本地 Web 界面，顺序遵循配置的依赖链：

| 页面 | 作用 |
|---|---|
| 总览 | 身份与站点一览，并显示**全局身份**（可在此修改） |
| 密钥 | 列出密钥、复制公钥、生成新密钥、**重命名**、从快照恢复 |
| 身份 | 新增、**编辑**、删除身份（含 `SSH 主机名` 等字段） |
| 规则 | 目录 → 身份映射，带服务端目录选择器 |
| 变更预览 | 唯一会写文件的页面，永远先展示 diff |
| 诊断 | `gs doctor` 的图形化结果，可复跑，可加 `--online` |
| 迁移 | 快照导出与导入 |
| 初始化 | 首次使用的两步向导 |

```bash
gs gui          # 打印 http://127.0.0.1:<port>/#token=… 并打开浏览器
```

界面是纯 JavaScript，无构建步骤、无框架，与 CLI 跑在同一个零依赖 Node 进程里。

**安全设计**：

| 控制 | 原因 |
|---|---|
| 只绑定 `127.0.0.1` | 永远无法从网络访问 |
| 每进程随机口令 | 每个 API 请求必须携带 `x-gs-token` |
| 校验 `Host` 头 | 抵御 DNS 重绑定 |
| 校验 `Origin` | 拒绝跨站请求 |
| 无 CORS 头 | 浏览器无法跨源读取响应 |
| 严格 CSP + `no-store` | 无内联脚本，不缓存敏感内容 |
| 目录浏览限定在允许的根目录内，拒绝 `..` | 选择器无法逃出 home |

界面**永远先出计划再写入**：预览 → 展示 diff → 确认 → 应用。

**空间是哪个？** 用 `--home` 启动时，界面顶部会显示醒目的**沙箱提示**，明确说明
改动不会影响真实的 `~/.ssh` 与 `~/.gitconfig`。

### `gs doctor` 能查出什么

```
$ gs doctor
✗ ~/.ssh/id_ed25519_missing 不存在
·    被 work 引用；git push/pull 会报 "no such identity"
·    修复：ssh-keygen -t ed25519 -C "<email>" -f "~/.ssh/id_ed25519_missing"
! work：未配置 SSH 密钥
✓ ~/.ssh/id_ed25519_github 存在
✓ ~/.ssh/config 中存在托管块
✓ 当前身份：zlj20@163.com
! 未进行连通性探测
·    加 --online 可执行真实的 ssh 握手
```

它把错误排在前面，遇到损坏的密钥也绝不抛出异常，并为每项给出可直接执行的修复命令。
加上 `--online` 会额外执行真实的 `ssh -T` 握手验证。

---

## 工作原理

`gs` **不拦截** `git`。它是一个**生成器**：`apply` 之后，你照常使用原生的 `git` 和 `ssh`。

```
profiles.yaml
      │
      │  gs apply
      ▼
~/.gitconfig                    (includeIf 块)
~/.config/gs/identities/*.gitconfig
~/.ssh/config                   (Host 块)
      │
      ▼
   git & ssh                    原封不动
```

生成的 `~/.gitconfig` 块：

```ini
# >>> gs:managed >>>
[includeIf "gitdir:D:/CODE/PDE-GIT/"]
	path = ~/.config/gs/identities/work.gitconfig
[includeIf "gitdir:D:/CODE/github/"]
	path = ~/.config/gs/identities/personal.gitconfig
# <<< gs:managed <<<
```

> **重要**：`includeIf "gitdir:..."` 只在 Git 解析仓库时生效。
> 因此规则目录下必须包含 Git 仓库，映射才会起作用——这恰好也是你实际的工作方式。

> **全局身份**：没有匹配规则的目录会回退到 `~/.gitconfig` 的 `user.name`/`user.email`。
> 这个值**不在** `gs` 托管块内，`gs list` 和界面总览都会明确显示它，避免个人项目
> 误用公司邮箱提交。

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
| 配置错误 | 报错时给出行号或字段路径，绝不静默忽略；界面仍可用并可一键修复 |
| 写入失败 | 按文件报告真实目标名与原因；其余文件照常写入；不残留临时文件 |
| 界面写操作 | 身份/规则/快照的改动只写 `profiles.yaml`，必须经「变更预览」确认才写入系统配置 |

---

## 技术选择

| 选择 | 原因 |
|---|---|
| 零运行时依赖 | 可移植：发布包没有依赖树 |
| Node ≥22.6 原生类型剥离 | 开发时无需构建步骤 |
| 发布构建用 `tsc` | Node 禁止在 `node_modules` 内剥离类型 |
| 手写 YAML 子集 | `profiles.yaml` 只需要有文档的子集，不需要完整解析器 |
| 界面用纯 JS + Web Components | 无打包器、无框架，约 30 KB 源码 |
| 生成器而非 `git` 包装 | `gs apply` 之后，原生 `git` 直接可用 |
| 词表驱动双语 | 一份文案表同时服务 CLI 与界面，缺失项回退英文 |

---

## 环境要求

- Node.js ≥ 22.6（使用原生 TypeScript 类型剥离）
- Git 2.36+

支持 Windows / macOS / Linux。

---

## 开发

```bash
npm install           # 仅开发依赖（typescript、@types/node）
npm test              # 单元测试 + 端到端测试
npm run typecheck     # tsc --noEmit
npm run build         # 编译到 dist/ 用于发布
```

所有测试都在**临时 home 目录**中运行，绝不触碰你真实的
`~/.gitconfig` 与 `~/.ssh/config`。

工作流参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 路线图

- [x] M1 —— 托管块，`init` / `apply` / `diff` / `list`
- [x] M2 —— `doctor` 诊断（密钥、SSH 配置、身份解析）
- [x] M3 —— `gs gui`（本地界面，零依赖）
- [x] M4 —— 密钥管理、加密快照、`export` / `import`
- [x] M5 —— 界面与 CLI 功能对齐、中英双语、错误自愈

---

## 许可证

MIT
