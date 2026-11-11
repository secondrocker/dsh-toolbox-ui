# 外部技能导入 + MCP 工具运行与参数覆盖 · 设计

**状态**：已与用户确认（2026-11-11）

两个新能力，均落在现有三能力面（MCP / 工具 / 技能）之内，不新增能力面：

1. **外部技能发现与导入**：扫描本机 Claude / Codex 全局技能目录，可搜索、可预览，快照复制导入 DSH 技能根。
2. **MCP 工具运行与参数覆盖**：面板手动运行 MCP 工具调试；逐工具编辑默认参数值与参数描述重写，**注入模型看到的工具 schema**。

明确**不做**（用户决定）：技能版本管理、技能分发（zip 导出/导入）、skillhub 发布。

## 一、外部技能发现与导入

### 扫描（Host，`lib/external-skills.js`）

- 默认来源（`os.homedir()` 相对）：
  - `claude` → `~/.claude/skills`
  - `codex` → `~/.codex/skills`
- 目录不存在或为空 → 该来源整体不返回（面板不显示空来源）。
- 每个来源下的每个条目：目录含 `SKILL.md` 视为一个技能；解析 frontmatter 取
  `name` / `description`（frontmatter 缺 `name` 时回退目录名），复用 `skills-frontmatter`
  的解析与诊断。frontmatter 非法 → 该行如实标 `invalid` 与原因，不猜。
- 与 DSH 已有技能（`skills-registry` 的全局+项目胜出视图）按技能名比对：
  同名 → 标 `alreadyPresent`，导入时要求显式覆盖确认。

### 导入（快照复制）

- 复用技能面已有的 `importSkill` 宿主实现（与 skillhub 安装同一条代码路径）：
  整个技能目录原子复制进目标技能根（默认全局 `~/.dsh/skills`，可选项目 `.dsh/skills`），
  写完调用 `ctx.skills.invalidateCache()`，宿主文件监听约 0.25s 生效。
- 不做格式转换：Claude / Codex / DSH 同为 agents 标准 `SKILL.md`；frontmatter
  差异（如有）在预览里如实披露，不静默改写。
- 导入后即为普通 DSH 技能：现有启停、调用面开关、诊断全部适用。

### Wire（`skillsManager` 命名空间）

- 新增 `externalSkills(payload)`（非 mutating）：返回 `{ sources: [{ id, label, path, skills: [...] }] }`，
  `payload.wsPath` 可选用于项目级比对。
- 实际导入走现有 `importSkill(payload)`，payload 增加 `sourceDir`（外部技能的物理目录）。

### UI（技能面「发现」模式）

- 「发现市场」模式从单一 skillhub 扩为分段：`skillhub.cn` / `本机外部技能`。
- 本机来源是可搜索列表（按名称/描述过滤），行显示来源徽章、`已导入` 徽章；
  点开先读正文预览（Host 读外部 `SKILL.md`，不经市场），确认后选择目标根导入。

## 二、MCP 工具运行与参数覆盖

### 运行（`mcpManager.runTool`）

- payload：`{ name, wsPath?, args }`（项目 MCP 带 `wsPath` 精确定位，与 `tools` 同规则）。
- Host 侧从 `ctx.tools` 解析该 MCP 工具的 `ToolDefinition`，直接
  `definition.execute(args, { signal })` —— 不创建会话、不经过浏览器。
- 30s 超时 + 客户端可中止；结果返回 `{ ok, durationMs, value | error }`，
  `isError` 的 MCP 结果按错误文本返回。凭据类参数值不回传明文以外的额外拷贝。

### 参数覆盖（`config.toolOverrides`）

- 每个工具可覆盖两类字段（**只这两类**）：
  - `defaultArgs`：参数名 → 默认值，写进 schema 对应属性的 `default`；
  - `argDescriptions`：参数名（或 `__tool__` 表示顶层工具描述）→ 描述文本。
- **安全边界**：不允许改参数类型、增删 required、隐藏参数 —— 写入前校验，
  超界键拒绝并报原因；运行时仍按服务器原始 schema 校验。
- 存储沿用双作用域：
  - 全局：profile patch 的 `config.toolOverrides`（与 `toolSearch`/`toolLoading` 同构，
    `withPatchWrite` + `commitPatch` 落盘）；
  - 项目：`.dsh/mcp.json` 的 `toolOverrides` 键（与项目工具加载策略同一条读写路径）。
- 生效：写盘后覆盖立即进入下一次组装（无缓存，无需失效宿主缓存）。

### Schema 注入（模型可见）

- 复用 tool-search-adapter 的**呈现端口**（`systemPrompt.assemble` 装饰分发层，
  多消费者链式）：注册第二个消费者，在组装产物上对 `assembly.tools` 里命中的
  工具 schema 改写 `default` / `description` 后返回。
- 与 ToolSearch 正交：延迟工具被发现后进入全量 schema 时同样会经过该消费者；
  工具被 ToolSearch 隐藏（只剩名字）时不呈现 schema，覆盖自然不出现。

### Wire（`mcpManager` 命名空间，均 mutating 结果带三字段）

- `toolOverrides(payload)` → 读当前（全局+项目合并视图）。
- `setToolOverride(payload)` → 写一条覆盖（`{ name, wsPath?, defaultArgs?, argDescriptions?, clear? }`，
  `clear: true` 删除该工具覆盖）。
- `runTool(payload)` → 见上。

### UI（MCP 面）

- 工具详情展开区新增：
  - **运行**：按输入 JSON Schema 动态渲染参数表单（必填标红、枚举下拉、
    默认值预填——已应用覆盖默认值），运行后显示耗时/错误/格式化 JSON，可复制；
  - **覆盖编辑**：`defaultArgs`（按 schema 属性逐个填默认值）与
    `argDescriptions`（逐参数 + 工具级描述）编辑，保存/清除；有覆盖的工具
    行显示「已覆盖」徽章。

## 验证清单

1. `~/.claude/skills` 中选一个技能导入 `~/.dsh/skills`，技能面可见、可启停，
   宿主 `Tool.listTools` 的技能目录里出现；
2. 对一个已连接 MCP 工具填参数运行，拿到真实结果；
3. 设一个 `defaultArgs` 覆盖后，用宿主 `Tool.listTools` 确认模型看到的 schema
   带新默认值；
4. 全量 `node --test` 通过，`contract:check` / `client:check` 通过。
