# 提示词 Commands 管理

打开工具箱 →「命令」，可以新增、编辑、删除提示词命令，并按工作区启用或禁用。正文全局共享，修改会影响所有启用工作区；新命令默认在所有工作区禁用。

## 调用

命令名称不带 `/`，只能使用小写字母开头和小写字母、数字、下划线、连字符。说明与正文不能为空，参数提示可选。

例如：名称 `ship-dev`、参数提示 `[dev分支名]`，正文通过 `$ARGUMENTS` 引用调用时的文本参数：

```text
/ship-dev
/ship-dev new-dev-v3
```

命令通过官方 `ctx.commands.register()` 注册到接收会话的 agent 作用域。仅在当前工作目录匹配已启用工作区时可发现、执行。切换工作目录后重新协调注册，执行时再次校验目录和启用状态；不会覆盖宿主或其他插件的同名命令。

提示词通过官方 `agent.steer(createUserMessage(...))` 交给同一会话，沿用会话权限、审批、工具和执行规则。插件不会 eval 正文为 JavaScript，也不会直接执行 shell。未声明附件支持。

## 数据

默认数据目录为 `$DSH_HOME/commands`（未设置时 `~/.dsh/commands`）：

- `registry.json`：版本、revision、命令元数据和启用工作区。
- `content/<ID>-<SHA256>.md`：不可变提示词正文。
- `resources/`：提示词引用的辅助资料，例如 `ship-dev-projects.md`。

正文先写入独立文件，再以原子替换 registry 作为提交点。文件锁与 revision 校验防止多页面编辑互相覆盖。删除命令移除 registry 引用，不立即删除旧正文，以保护并发读者及便于恢复。损坏文件不会被静默清空。

UI 修改会动态协调活跃会话，无需重新加载插件。直接手工编辑文件不是本版推荐的修改途径：可点刷新查看，注册表不提供目录文件 watcher；执行时仍重读当前定义以拒绝已删除或禁用的旧处理器。重新启用/保存会协调注册。

## 兼容与诊断

Commands 依赖宿主提供官方 `commands`、`agents`、`workingDirectory` 服务及 loader。已用 DSH 0.2.2-rc.1 官方 Commands/Scope/LLM/Session SDK 集成测试验证。缺失服务时管理页面仍可保存，但不会报告已生效；显示保存与动态注册诊断。

名称冲突或运行中注册失败会明确显示「已保存但未完全生效」，不能把它等同于保存失败。发生 revision 冲突时保留草稿，需取消并刷新最新版本后重试。

## 本机迁移

已将原 Claude Code `ship-dev` 提示词和 11 个项目的默认开发分支表复制到本机命令目录，启用于表中项目工作区。原文件保留；迁移本身不提交、不推送、不合并任何仓库。

## 验证

```sh
node --test test/commands-store.test.mjs test/commands-runtime.test.mjs test/commands-client.test.mjs
node --test test/commands-real-host.test.mjs
npm run contract:check
npm run client:check
```

真实 SDK 测试的隔离依赖安装方式见测试文件头部；没有夹具时明确 skip，显式设置 `DSH_COMMAND_REAL_FIXTURE` 后路径无效会失败，不冒充真实宿主验证。当前 GUI 客户端产物更新后需刷新页面；没有同一 checkout 的 dev:web watcher 时不承诺 HMR 自动替换。
