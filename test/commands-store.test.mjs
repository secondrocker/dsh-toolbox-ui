import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink, unlink, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// An override lets the exact suite run against an explicitly staged module.
const { CommandStore } = await import(process.env.COMMAND_STORE_MODULE || '../lib/commands-store.js')
async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'commands-store-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'commands')
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  return { base, root, workspace, store: new CommandStore({ root, ...options }) }
}
const command = (name = 'ship-dev', extra = {}) => ({ name, description: 'Deploy', inputHint: '<target>', body: 'Hello $ARGUMENTS', ...extra })

test('CRUD persists immutable hashed bodies and revisions; new commands default disabled', async t => {
  const { store, root, workspace } = await fixture(t)
  assert.deepEqual(await store.list(), { revision: 0, commands: [] })
  const first = await store.save({ revision: 0, command: command() })
  assert.equal(first.revision, 1)
  const saved = first.commands[0]
  assert.match(saved.id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(saved.workspaces, [])
  assert.equal(saved.body, 'Hello $ARGUMENTS')
  const originalFiles = await readdir(join(root, 'content'))
  const digest = createHash('sha256').update(saved.body).digest('hex')
  assert.equal(originalFiles[0], `${saved.id}-${digest}.md`)
  const enabled = await store.setEnabled({ revision: 1, id: saved.id, workspace, enabled: true })
  assert.deepEqual(enabled.commands[0].workspaces, [await realpath(workspace)])
  const edited = await store.save({ revision: 2, command: { ...enabled.commands[0], body: 'changed' } })
  assert.equal(edited.commands[0].id, saved.id)
  assert.equal(await readFile(join(root, 'content', originalFiles[0]), 'utf8'), saved.body)
  assert.equal((await readdir(join(root, 'content'))).length, 2)
  const disabled = await store.setEnabled({ revision: 3, id: saved.id, workspace, enabled: false })
  assert.deepEqual(disabled.commands[0].workspaces, [])
  assert.deepEqual(await store.remove({ revision: 4, id: saved.id }), { revision: 5, commands: [] })
  assert.equal(JSON.parse(await readFile(join(root, 'registry.json'), 'utf8')).version, 1)
  assert.equal((await readdir(join(root, 'content'))).length, 2)
})

test('concurrent independent stores cannot commit the same revision', async t => {
  const { root, store } = await fixture(t)
  const other = new CommandStore(root)
  const results = await Promise.allSettled([
    store.save({ revision: 0, command: command('first') }),
    other.save({ revision: 0, command: command('second') }),
  ])
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1)
  assert.equal(results.find(x => x.status === 'rejected').reason.code, 'REVISION_CONFLICT')
  assert.equal((await store.list()).commands.length, 1)
  await assert.rejects(store.remove({ revision: 0, id: (await store.list()).commands[0].id }), { code: 'REVISION_CONFLICT' })
})

test('rejects duplicate names, malformed input, oversized UTF-8 bodies and invalid workspace paths', async t => {
  const { store, base, workspace } = await fixture(t)
  const first = await store.save({ revision: 0, command: command() })
  await assert.rejects(store.save({ revision: 1, command: command() }), /duplicate/i)
  for (const name of ['Bad', '../escape', 'a/b', '', 'a.b']) {
    await assert.rejects(store.save({ revision: 1, command: command(name) }), /name/i)
  }
  await assert.rejects(store.save({ revision: 1, command: command('big', { body: '中'.repeat(400000) }) }), /body|large|size/i)
  for (const path of ['relative', join(base, 'missing')]) {
    await assert.rejects(store.save({ revision: 1, command: command('bad-path', { workspaces: [path] }) }))
  }
  const file = join(base, 'file')
  await writeFile(file, '')
  await assert.rejects(store.setEnabled({ revision: 1, id: first.commands[0].id, workspace: file, enabled: true }))
  const alias = join(base, 'alias')
  await symlink(workspace, alias)
  const result = await store.save({ revision: 1, command: command('canonical', { workspaces: [alias, workspace] }) })
  assert.deepEqual(result.commands[1].workspaces, [await realpath(workspace)])
  await assert.rejects(store.remove({ revision: 2, id: '../escape' }))
  await assert.rejects(store.save({ revision: 2, command: command('injected', { id: '../escape' }) }))
  await assert.rejects(store.setEnabled({ revision: 2, id: first.commands[0].id, workspace, enabled: 'yes' }))
  await assert.rejects(store.save({ revision: NaN, command: command('bad-revision') }))
  assert.equal((await store.list()).revision, 2)
})

test('missing identifiers cannot silently create or remove commands', async t => {
  const { store, workspace } = await fixture(t)
  const id = '00000000-0000-4000-8000-000000000000'
  await assert.rejects(store.save({ revision: 0, command: command('unknown', { id }) }), /not found/i)
  await assert.rejects(store.remove({ revision: 0, id }), /not found/i)
  await assert.rejects(store.setEnabled({ revision: 0, id, workspace, enabled: true }), /not found/i)
  assert.deepEqual(await store.list(), { revision: 0, commands: [] })
})

test('corrupt registry is never silently reset or overwritten', async t => {
  const { root, store } = await fixture(t)
  await mkdir(root)
  for (const contents of ['{bad', JSON.stringify({ version: 2, revision: 0, commands: [] }), JSON.stringify({ version: 1, revision: -1, commands: [] }), JSON.stringify({ version: 1, revision: 1, commands: [{}] })]) {
    await writeFile(join(root, 'registry.json'), contents)
    await assert.rejects(store.list())
    await assert.rejects(store.save({ revision: 0, command: command() }))
    assert.equal(await readFile(join(root, 'registry.json'), 'utf8'), contents)
  }
})

test('missing or tampered immutable content is corruption; mutations do not erase it', async t => {
  const { root, store } = await fixture(t)
  const first = await store.save({ revision: 0, command: command() })
  const [file] = await readdir(join(root, 'content'))
  const originalRegistry = await readFile(join(root, 'registry.json'), 'utf8')
  await writeFile(join(root, 'content', file), 'tampered')
  await assert.rejects(store.list())
  await assert.rejects(store.remove({ revision: 1, id: first.commands[0].id }))
  await unlink(join(root, 'content', file))
  await assert.rejects(store.list())
  assert.equal(await readFile(join(root, 'registry.json'), 'utf8'), originalRegistry)
})

test('registry content path injection is rejected before reading outside the store', async t => {
  const { root, store } = await fixture(t)
  await store.save({ revision: 0, command: command() })
  const registry = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'))
  registry.commands[0].contentFile = '../outside.md'
  await writeFile(join(root, 'registry.json'), JSON.stringify(registry))
  await assert.rejects(store.list())
})

for (const target of ['root', 'registry', 'content', 'body', 'lock']) {
  test(`rejects symlink ${target} without changing its referent`, async t => {
    const { root, base, store } = await fixture(t)
    const outside = join(base, 'outside')
    if (target === 'root' || target === 'content') {
      await mkdir(outside)
      if (target === 'content') await mkdir(root)
      await symlink(outside, target === 'root' ? root : join(root, 'content'))
    } else if (target === 'registry' || target === 'lock') {
      await mkdir(root)
      await writeFile(outside, JSON.stringify({ version: 1, revision: 0, commands: [] }))
      await symlink(outside, join(root, target === 'registry' ? 'registry.json' : 'registry.json.lock'))
    } else {
      await store.save({ revision: 0, command: command() })
      const [file] = await readdir(join(root, 'content'))
      await writeFile(outside, 'Hello $ARGUMENTS')
      await unlink(join(root, 'content', file))
      await symlink(outside, join(root, 'content', file))
    }
    if (target !== 'lock') await assert.rejects(store.list(), /symlink|symbolic/i)
    await assert.rejects(store.save({ revision: target === 'body' ? 1 : 0, command: command('new') }), /symlink|symbolic/i)
    if (target === 'root' || target === 'content') assert.deepEqual(await readdir(outside), [])
    else if (target === 'body') assert.equal(await readFile(outside, 'utf8'), 'Hello $ARGUMENTS')
    else assert.equal(await readFile(outside, 'utf8'), JSON.stringify({ version: 1, revision: 0, commands: [] }))
  })
}

test('registry commit failure preserves prior revision and body', async t => {
  const { root, store } = await fixture(t)
  const first = await store.save({ revision: 0, command: command() })
  const previous = await readFile(join(root, 'registry.json'), 'utf8')
  const failing = new CommandStore({ root, atomicWrite: async () => { throw new Error('disk full') } })
  await assert.rejects(failing.save({ revision: 1, command: { ...first.commands[0], body: 'replacement' } }), /disk full/)
  await assert.rejects(failing.remove({ revision: 1, id: first.commands[0].id }), /disk full/)
  assert.equal(await readFile(join(root, 'registry.json'), 'utf8'), previous)
  assert.deepEqual(await store.list(), first)
})


test('offline existing workspaces can be retained during edit and disabled', async t => {
  const {store, workspace} = await fixture(t)
  let snapshot = await store.save({revision:0, command:command('offline',{workspaces:[workspace]})})
  const canonical = snapshot.commands[0].workspaces[0]
  await rm(workspace,{recursive:true})
  snapshot = await store.save({revision:1, command:{...snapshot.commands[0],body:'Edited'}})
  assert.deepEqual(snapshot.commands[0].workspaces,[canonical])
  snapshot = await store.setEnabled({revision:2,id:snapshot.commands[0].id,workspace:canonical,enabled:false})
  assert.deepEqual(snapshot.commands[0].workspaces,[])
})

test('whitespace-only input hint normalizes to no input metadata', async t => {
  const {store} = await fixture(t)
  const snapshot=await store.save({revision:0,command:command('hint',{inputHint:'   '})})
  assert.equal(snapshot.commands[0].inputHint,'')
})

test('oversized valid names cannot commit an unreadable registry',async t=>{
 const {store}=await fixture(t)
 await assert.rejects(store.save({revision:0,command:command('a'.repeat(300))}),/name|metadata|size/i)
 assert.deepEqual(await store.list(),{revision:0,commands:[]})
})
