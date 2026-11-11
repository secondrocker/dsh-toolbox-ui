import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanExternalSkills, readExternalSkillDocument } from '../lib/external-skills.js'

const valid = (name, description = '') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n正文。`

const withHome = async (build) => {
  const home = await mkdtemp(join(tmpdir(), 'ext-skills-home-'))
  await build(home)
  return home
}

test('扫描：目录捆绑与扁平 .md 都认，frontmatter 解析出名称与描述', async () => {
  const home = await withHome(async (dir) => {
    await mkdir(join(dir, '.claude', 'skills', 'brainstorming'), { recursive: true })
    await writeFile(join(dir, '.claude', 'skills', 'brainstorming', 'SKILL.md'), valid('brainstorming', '设计前探索'), 'utf8')
    await mkdir(join(dir, '.claude', 'skills', 'orphan'), { recursive: true })
    await writeFile(join(dir, '.claude', 'skills', 'orphan', 'SKILL.md'), '没有 frontmatter 的正文', 'utf8')
    await mkdir(join(dir, '.codex', 'skills'), { recursive: true })
    await writeFile(join(dir, '.codex', 'skills', 'flat-tool.md'), valid('flat-tool', '扁平技能'), 'utf8')
  })
  try {
    const { sources } = await scanExternalSkills({ home, installedNames: [] })
    assert.equal(sources.length, 2, '两个来源都有内容都要出现')
    const claude = sources.find((source) => source.id === 'claude')
    assert.ok(claude, 'claude 来源存在')
    assert.equal(claude.skills.length, 2)
    const good = claude.skills.find((item) => item.entry === 'brainstorming')
    assert.equal(good.name, 'brainstorming')
    assert.equal(good.description, '设计前探索')
    assert.equal(good.kind, 'bundle')
    assert.equal(good.alreadyPresent, false)
    const bad = claude.skills.find((item) => item.entry === 'orphan')
    assert.equal(bad.invalid !== undefined, true, 'frontmatter 非法要如实报原因')
    assert.equal(bad.name, null)
    const codex = sources.find((source) => source.id === 'codex')
    const flat = codex.skills[0]
    assert.equal(flat.kind, 'flat')
    assert.equal(flat.name, 'flat-tool')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('比对：与 DSH 已有技能同名时标 alreadyPresent；隐藏目录不出现', async () => {
  const home = await withHome(async (dir) => {
    await mkdir(join(dir, '.claude', 'skills', 'dup'), { recursive: true })
    await writeFile(join(dir, '.claude', 'skills', 'dup', 'SKILL.md'), valid('dup', '同名技能'), 'utf8')
    await mkdir(join(dir, '.claude', 'skills', '.dsh-import-abc'), { recursive: true })
    await writeFile(join(dir, '.claude', 'skills', '.dsh-import-abc', 'SKILL.md'), valid('ghost'), 'utf8')
  })
  try {
    const { sources } = await scanExternalSkills({ home, installedNames: ['dup'] })
    const [item] = sources[0].skills
    assert.equal(item.name, 'dup')
    assert.equal(item.alreadyPresent, true)
    assert.equal(sources[0].skills.length, 1, '点开头的暂存目录不是技能')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('空来源整体不返回；不存在的目录同理', async () => {
  const home = await withHome(async (dir) => {
    await mkdir(join(dir, '.codex', 'skills'), { recursive: true })
  })
  try {
    const { sources } = await scanExternalSkills({ home, installedNames: [] })
    assert.deepEqual(sources, [], '空目录的来源不出现（claude 目录根本没建）')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('预览：只认 (sourceId, entry) 坐标，拒绝路径分隔符与未知来源', async () => {
  const home = await withHome(async (dir) => {
    await mkdir(join(dir, '.claude', 'skills', 'preview-skill'), { recursive: true })
    await writeFile(join(dir, '.claude', 'skills', 'preview-skill', 'SKILL.md'), valid('preview-skill'), 'utf8')
  })
  try {
    const text = await readExternalSkillDocument({ sourceId: 'claude', entry: 'preview-skill' }, home)
    assert.match(text, /name: preview-skill/)
    await assert.rejects(() => readExternalSkillDocument({ sourceId: 'nope', entry: 'x' }, home), /未知的外部技能来源/)
    await assert.rejects(() => readExternalSkillDocument({ sourceId: 'claude', entry: '../.claude' }, home), /非法/)
    await assert.rejects(() => readExternalSkillDocument({ sourceId: 'claude', entry: 'a/b' }, home), /非法/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
