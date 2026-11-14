# `profiles.yaml` schema（版本 1）

位于 `~/.config/gs/profiles.yaml`。这个文件是唯一的事实来源。

[English](profiles-schema.md)

## 顶层

```yaml
schemaVersion: 1      # 必填，整数
identities: {}        # 必填，至少一个
rules: []             # 目录 -> 身份
repositories: []      # 仓库级覆盖
settings: {}          # 可选
```

## identities

```yaml
identities:
  <名称>:
    user:
      name: zhulj
      email: zhulj@pde.com.cn
    sshKey: id_ed25519               # 可选，~/.ssh 下的文件名
    credentialUsername: zlj20@163.com # 可选，HTTPS 凭据用户名
    sites:                           # 可选
      - host: git.pdesoft.cn         # 必填——远程地址中真实使用的 git 主机
        port: 9092                   # 可选
        user: git                    # 可选，默认 git
        sshKey: id_ed25519           # 可选，覆盖身份级密钥
        alias: pde                   # 可选，SSH 别名
        sshHostName: ssh.example.com # 可选，实际拨号的端点
        alsoRoutes: [example.com]    # 可选，额外经由该别名路由的主机
```

- `<名称>` 可包含字母、数字、`.`、`-`、`_`。
- `user.email` 必须形如邮箱地址。
- `sshKey` **只能是文件名**（如 `id_ed25519_github`），在 `~/.ssh` 下解析。
  绝对路径与路径分隔符都会被拒绝。
- `host` 是远程地址中出现的 git 主机名，它决定 `insteadOf` 路由。
  当 SSH 端点与主机不同时（例如 GitHub 走 443 端口），设置 `sshHostName`——
  该端点只用于建立连接，绝不参与 URL 改写。
- `alsoRoutes` 用于让额外的 git 主机名复用同一个别名，例如公司简短域名与
  完整主机的并存。

## rules

```yaml
rules:
  - dir: D:/CODE/PDE-GIT
    identity: work
    comment: 公司仓库        # 可选，仅用于显示
```

- `dir` 会被规范化为使用正斜杠的绝对路径。
- **最长匹配**的规则生效；`/code` 上的规则会作用于 `/code/x`。
- 重复的 `dir` 会被拒绝。

## repositories

```yaml
repositories:
  - path: D:/CODE/github/old-corporate-repo
    identity: work
```

仓库级覆盖优先于目录规则。

## settings

```yaml
settings:
  backupKeep: 20     # 保留的备份数量
  allowRoots: []     # 界面目录浏览器额外允许的根目录
```

## 禁止的内容

校验会拒绝任何名为 `password`、`passphrase`、`token`、`secret`、`api_key`、
`private_key`、`credential` 或 `credentials` 的键，以及任何包含私钥头的值。

`profiles.yaml` 绝不能包含秘密。密钥请用 `ssh-agent`，HTTPS 凭据请交给系统凭据管理器。
