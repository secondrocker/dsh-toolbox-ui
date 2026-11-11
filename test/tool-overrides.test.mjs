import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOOL_DESCRIPTION_KEY,
  mergeToolOverrides,
  normalizeToolOverrides,
  validateToolOverrideEntry,
  applyToolOverrides,
} from '../lib/tool-overrides.js'

test('normalize：读侧宽容——坏形状按没配处理，__proto__ 键不丢', () => {
  assert.deepEqual(normalizeToolOverrides(undefined), { tools: {} })
  assert.deepEqual(normalizeToolOverrides('nope'), { tools: {} })
  // __proto__ 键用 defineProperty 造：对象字面量里的它落在原型上，测的不是同一件事。
  const raw = { tools: {
    good: { defaultArgs: { limit: 10 }, argDescriptions: { q: '关键词' } },
    empty: {},
    'not-object': 'nope',
  } }
  Object.defineProperty(raw.tools, '__proto__', { value: { defaultArgs: { x: 1 } }, enumerable: true, writable: true, configurable: true })
  const normalized = normalizeToolOverrides(raw)
  assert.deepEqual(Object.keys(normalized.tools).sort(), ['__proto__', 'good'])
})

test('validate：写侧严格——只接受 defaultArgs / argDescriptions，空条目归一成 null（删除）', () => {
  assert.deepEqual(validateToolOverrideEntry('t', null), null)
  assert.deepEqual(validateToolOverrideEntry('t', {}), null, '两个区都空 = 删掉这条覆盖')
  assert.deepEqual(
    validateToolOverrideEntry('t', { defaultArgs: { limit: 5 }, argDescriptions: { [TOOL_DESCRIPTION_KEY]: '工具描述' } }),
    { defaultArgs: { limit: 5 }, argDescriptions: { __tool__: '工具描述' } },
  )
  assert.throws(() => validateToolOverrideEntry('t', { nope: 1 }), /未知的覆盖字段/)
  assert.throws(() => validateToolOverrideEntry('t', { defaultArgs: { [TOOL_DESCRIPTION_KEY]: 1 } }), /保留键/)
  assert.throws(() => validateToolOverrideEntry('t', { argDescriptions: { q: 5 } }), /必须是字符串/)
  assert.throws(() => validateToolOverrideEntry('', {}), /缺少工具名/)
})

test('merge：项目按工具名整体胜出，不做逐字段混合', () => {
  const merged = mergeToolOverrides(
    { tools: { t1: { defaultArgs: { a: 1 }, argDescriptions: {} }, t2: { defaultArgs: { b: 2 }, argDescriptions: {} } } },
    { tools: { t1: { defaultArgs: { a: 9 }, argDescriptions: { q: '项目描述' } } } },
  )
  assert.deepEqual(merged.t1, { defaultArgs: { a: 9 }, argDescriptions: { q: '项目描述' } })
  assert.deepEqual(merged.t2, { defaultArgs: { b: 2 }, argDescriptions: {} })
})

test('apply：只改 default/description，输入 schema 不被被动到', () => {
  const schema = {
    name: 'mcp__exa__search',
    description: '原描述',
    parameters: { type: 'object', required: ['q'], properties: { q: { type: 'string', description: '原参数描述' }, limit: { type: 'number' } } },
  }
  const original = JSON.parse(JSON.stringify(schema))
  const { schemas, missed } = applyToolOverrides([schema], {
    'mcp__exa__search': {
      defaultArgs: { limit: 20 },
      argDescriptions: { q: '关键词', [TOOL_DESCRIPTION_KEY]: '新描述' },
    },
  })
  assert.deepEqual(missed, [])
  assert.deepEqual(schema, original, '纯函数：输入不被动到')
  const [out] = schemas
  assert.equal(out.description, '新描述')
  assert.equal(out.parameters.properties.limit.default, 20)
  assert.equal(out.parameters.properties.q.description, '关键词')
  assert.equal(out.parameters.properties.q.type, 'string', '类型不动')
  assert.deepEqual(out.parameters.required, ['q'], 'required 不动')
  assert.equal(out.parameters.properties.limit.type, 'number')
})

test('apply：schema 里不存在的参数名进 missed，不静默丢弃', () => {
  const { schemas, missed } = applyToolOverrides(
    [{ name: 't', parameters: { type: 'object', properties: { a: {} } } }],
    { t: { defaultArgs: { gone: 1 }, argDescriptions: { alsoGone: 'x', [TOOL_DESCRIPTION_KEY]: 'd' } } },
  )
  assert.deepEqual(missed.sort(), ['t.alsoGone', 't.gone'])
  assert.equal(schemas[0].description, 'd', '工具级描述照样生效')
})

test('apply：没有覆盖时原样返回同一个数组', () => {
  const schemas = [{ name: 't' }]
  assert.equal(applyToolOverrides(schemas, {}).schemas, schemas)
})

test('apply：没有 properties 的 schema 全部按 miss 报', () => {
  const { missed } = applyToolOverrides([{ name: 't', parameters: { type: 'object' } }], {
    t: { defaultArgs: { x: 1 }, argDescriptions: {} },
  })
  assert.deepEqual(missed, ['t.x'])
})
