# 为 gs 贡献代码

感谢你愿意花时间参与贡献。

[English](CONTRIBUTING.md)

## 基本规则

1. **代码和测试绝不写入开发者真实的 home 目录。**
   任何涉及文件系统的测试都必须使用临时 home（`test/helpers/tmp-home.ts`）。
   这一条没有例外——`gs` 会修改 dotfiles。
2. **`src/core/` 不得从 `src/commands/`、`src/server/` 或 `web/` 导入。**
   核心层由 CLI 与界面共用；在其中引入界面依赖会破坏这个约定。
3. **运行时依赖保持为零。** 只使用 Node 标准库。
4. **秘密绝不进入 `profiles.yaml`。** 校验层已经会拒绝它们，不要放宽。

## 开发环境

```bash
git clone https://github.com/CodeMonkeyJust/git-switch.git
cd git-switch

node --version   # 必须 >= 22.6
npm test         # 运行单元测试 + 端到端测试
npm run typecheck
```

开发阶段没有构建步骤：Node 通过原生类型剥离直接执行 TypeScript 源码。

## 项目结构

```
src/
  cli.ts            命令行入口
  core/             引擎——不含 UI、不含命令行解析、不引入框架
    model.ts        profiles.yaml 的 schema 与校验
    yaml.ts         极简、无依赖的 YAML 子集
    profiles.ts     读写 profiles
    managed-block.ts  标记块的读写，保留 CRLF
    plan.ts         计算变更集（CLI 与界面共用）
    apply.ts        执行计划：备份、保护、原子写入
    render/         gitconfig 与 ssh-config 的渲染
  commands/         包裹 core 的薄 CLI 层
  util/             原子文件操作、日志、diff
test/
  unit/             纯逻辑
  e2e/              真实文件系统 + 真实 git，运行在临时 home 中
  helpers/tmp-home.ts
```

## 提交信息

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat(core): support repository-level overrides
fix(apply): refuse to overwrite files changed after planning
docs: explain includeIf gitdir semantics
test(e2e): cover CRLF preservation
```

## 拉取请求

- 保持改动聚焦，一个 PR 只处理一件事。
- 补充或更新测试。没有测试的行为变更不会被合并。
- 在 `CHANGELOG.md` 的 `## [Unreleased]` 下记录变更。
- 确保本地 `npm test` 与 `npm run typecheck` 通过。

## 报告缺陷

请提供：

- `gs` 版本（`gs version`）
- 操作系统与 Node 版本
- `gs list` 与 `gs diff` 的输出——必要时请**隐去路径与邮箱**
- 相关目录中是否包含 Git 仓库

**绝对不要把私钥或令牌贴进 issue。**
