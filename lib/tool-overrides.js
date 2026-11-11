// MCP 工具参数覆盖（默认值 / 描述重写）的**纯决策层**。
//
// 只回答四个问题，不做 IO、不知道 profile / 工作区：
//   1. 一份原始配置归一成什么样（读侧宽容：手改坏了按"没配"处理，不让面板打不开）；
//   2. 一条用户提交的覆盖是否合法（写侧严格：拒绝比落一个坏值好）；
//   3. 全局与项目两份如何合并（项目按工具名整体覆盖，不逐字段混合）；
//   4. 给定一批工具 schema，覆盖之后长什么样（**不改输入**：深拷贝被改写的节点）。
//
// 安全边界（设计已确认）：只允许改写 **default** 与 **description** 两个展示性字段。
// 不改参数类型、不增删 required、不隐藏参数——把 schema 改坏会让模型按着错的形状调用，
// 比没有覆盖贵得多。运行时仍按服务器原始 schema 校验，这里只影响"模型看到什么"。
//
// wire / 存储形状：`{ tools: { [toolName]: { defaultArgs, argDescriptions } } }`。
// `argDescriptions` 的 `__tool__` 键表示**工具级描述**（不是某个参数）。`__tool__` 不是
// 合法参数名（JSON Schema 属性名虽无此限制，但 MCP 参数名不可能以双下划线开头），
// 冲突在结构上不可能。

/** profile patch / 项目配置里的键名（与 toolSearch / toolLoading 同级）。 */
export const TOOL_OVERRIDES_CONFIG_KEY = 'toolOverrides'

/** 工具级描述的保留键。 */
export const TOOL_DESCRIPTION_KEY = '__tool__'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * 归一一份覆盖配置（读侧宽容）。
 *
 * @param {unknown} raw - 例如 profile 的 `config.toolOverrides` 或项目配置的 `toolOverrides`。
 * @returns {{ tools: Record<string, { defaultArgs: Record<string, unknown>, argDescriptions: Record<string, string> }> }}
 */
export function normalizeToolOverrides(raw) {
  const source = isPlainObject(raw) && isPlainObject(raw.tools) ? raw.tools : {}
  const tools = {}
  for (const [name, entry] of Object.entries(source)) {
    if (typeof name !== 'string' || name === '' || !isPlainObject(entry)) continue
    const normalized = normalizeEntry(entry)
    if (normalized !== null) setOwn(tools, name, normalized)
  }
  return { tools }
}

function normalizeEntry(entry) {
  const defaultArgs = isPlainObject(entry.defaultArgs) ? entry.defaultArgs : {}
  const rawDescriptions = isPlainObject(entry.argDescriptions) ? entry.argDescriptions : {}
  const argDescriptions = {}
  for (const [key, value] of Object.entries(rawDescriptions)) {
    if (typeof key === 'string' && key !== '' && typeof value === 'string') setOwn(argDescriptions, key, value)
  }
  if (Object.keys(defaultArgs).length === 0 && Object.keys(argDescriptions).length === 0) return null
  return { defaultArgs, argDescriptions }
}

/** `Object.prototype` 保护：工具名/参数名可能叫 `__proto__`，普通赋值会丢键。 */
function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

/**
 * 校验一条用户提交的覆盖（写侧严格）。返回归一后的条目；空条目返回 null（= 删除该工具的覆盖）。
 *
 * @param {string} toolName
 * @param {unknown} entry - `{ defaultArgs?: object, argDescriptions?: object }`
 * @returns {{ defaultArgs: Record<string, unknown>, argDescriptions: Record<string, string> } | null}
 * @throws 字段名/形状非法时抛出可读错误。
 */
export function validateToolOverrideEntry(toolName, entry) {
  if (typeof toolName !== 'string' || toolName === '') throw new Error('缺少工具名')
  if (entry === null || entry === undefined) return null
  if (!isPlainObject(entry)) throw new Error('覆盖条目必须是对象')
  const extra = Object.keys(entry).filter((key) => key !== 'defaultArgs' && key !== 'argDescriptions')
  if (extra.length) throw new Error(`未知的覆盖字段：${extra.join('、')}（只接受 defaultArgs / argDescriptions）`)
  const defaultArgs = {}
  if (entry.defaultArgs !== undefined) {
    if (!isPlainObject(entry.defaultArgs)) throw new Error('defaultArgs 必须是对象')
    for (const [key, value] of Object.entries(entry.defaultArgs)) {
      if (typeof key !== 'string' || key === '') throw new Error('defaultArgs 的键必须是参数名')
      if (key === TOOL_DESCRIPTION_KEY) throw new Error('defaultArgs 不接受工具级保留键')
      setOwn(defaultArgs, key, value)
    }
  }
  const argDescriptions = {}
  if (entry.argDescriptions !== undefined) {
    if (!isPlainObject(entry.argDescriptions)) throw new Error('argDescriptions 必须是对象')
    for (const [key, value] of Object.entries(entry.argDescriptions)) {
      if (typeof key !== 'string' || key === '') throw new Error('argDescriptions 的键必须是参数名或 __tool__')
      if (typeof value !== 'string') throw new Error(`argDescriptions[${key}] 必须是字符串`)
      setOwn(argDescriptions, key, value)
    }
  }
  if (Object.keys(defaultArgs).length === 0 && Object.keys(argDescriptions).length === 0) return null
  return { defaultArgs, argDescriptions }
}

/**
 * 全局 + 项目合并（项目按工具名**整体**胜出）。逐字段混合会让"改一个默认值"顺带继承
 * 全局的旧描述，两侧各改一半时用户无法推断最终结果——整条覆盖只有一个来源才可预测。
 *
 * @param {{tools: object}} globalConfig
 * @param {{tools: object}} projectConfig
 * @returns {Record<string, { defaultArgs: object, argDescriptions: object }>}
 */
export function mergeToolOverrides(globalConfig, projectConfig) {
  const merged = { ...normalizeToolOverrides(globalConfig).tools }
  for (const [name, entry] of Object.entries(normalizeToolOverrides(projectConfig).tools)) {
    setOwn(merged, name, entry)
  }
  return merged
}

/**
 * 把覆盖应用到一批工具 schema 上（**纯函数**：返回新数组，输入不被动到）。
 *
 * 只改写 `default` / `description`；被命中的 schema 做结构共享的浅拷贝——未命中的条目
 * 原样引用（组装每轮都跑，逐工具深拷贝整个 registry 的 schema 集是不必要的开销）。
 * schema 里找不到的参数名如实放进 `missed`，调用方据此提示"这个参数在当前 schema 里不存在"
 * （服务器升级后参数改名是常态，静默丢弃覆盖会让用户以为它还在生效）。
 *
 * @param {object[]} schemas - `ctx.tools.schemas()` 形状的条目（至少有 name/parameters）。
 * @param {Record<string, object>} overrides - mergeToolOverrides 的结果。
 * @returns {{ schemas: object[], missed: string[] }}
 */
export function applyToolOverrides(schemas, overrides) {
  const table = overrides ?? {}
  const keys = Object.keys(table)
  if (keys.length === 0 || !Array.isArray(schemas)) return { schemas, missed: [] }
  const missed = []
  const next = schemas.map((schema) => {
    const entry = schema != null && typeof schema.name === 'string' ? table[schema.name] : undefined
    if (entry === undefined) return schema
    let changed = false
    const out = { ...schema }
    // 工具级描述。
    const toolDescription = entry.argDescriptions?.[TOOL_DESCRIPTION_KEY]
    if (typeof toolDescription === 'string' && toolDescription !== '' && out.description !== toolDescription) {
      out.description = toolDescription
      changed = true
    }
    const params = schema.parameters
    if (isPlainObject(params) && isPlainObject(params.properties)) {
      // 参数级改写：拷贝 parameters → properties → 被改的那个属性节点，三层各浅拷一次。
      const properties = { ...params.properties }
      for (const [key, value] of Object.entries(entry.defaultArgs ?? {})) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) { missed.push(`${schema.name}.${key}`); continue }
        properties[key] = { ...(isPlainObject(properties[key]) ? properties[key] : {}), default: value }
      }
      for (const [key, value] of Object.entries(entry.argDescriptions ?? {})) {
        if (key === TOOL_DESCRIPTION_KEY) continue
        if (typeof value !== 'string') continue
        if (!Object.prototype.hasOwnProperty.call(properties, key)) { missed.push(`${schema.name}.${key}`); continue }
        properties[key] = { ...(isPlainObject(properties[key]) ? properties[key] : {}), description: value }
      }
      out.parameters = { ...params, properties }
      changed = true
    } else {
      // schema 没有 properties（MCP 工具几乎不会），全部按 miss 报，不假装应用过。
      for (const key of Object.keys(entry.defaultArgs ?? {})) missed.push(`${schema.name}.${key}`)
      for (const key of Object.keys(entry.argDescriptions ?? {})) {
        if (key !== TOOL_DESCRIPTION_KEY) missed.push(`${schema.name}.${key}`)
      }
    }
    return changed ? out : schema
  })
  return { schemas: next, missed }
}
