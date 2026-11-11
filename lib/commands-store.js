import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const NAME = /^[a-z][a-z0-9_-]{0,127}$/
const MAX_REGISTRY_BYTES = 16 * 1024 * 1024
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const MAX_COMMAND_BODY_BYTES = 1024 * 1024
const digest = body => createHash('sha256').update(body).digest('hex')
const contentName = command => `${command.id}-${digest(command.body)}.md`
function fail(message, code = 'INVALID_COMMAND') {
  return Object.assign(new Error(message), { code })
}
function validRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw fail('Invalid revision')
}
function validId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw fail('Invalid command id')
}
function validateFields(command) {
  if (!command || typeof command !== 'object' || typeof command.name !== 'string' || !NAME.test(command.name)) throw fail('Invalid command name')
  for (const key of ['description', 'inputHint', 'body']) {
    if (typeof command[key] !== 'string') throw fail(`Invalid command ${key}`)
  }
  if (!command.description.trim()) throw fail('Command description must not be empty')
  if (!command.body.trim()) throw fail('Command body must not be empty')
  if (Buffer.byteLength(command.description, 'utf8') > 4096 || Buffer.byteLength(command.inputHint, 'utf8') > 4096) throw fail('Command metadata exceeds size limit')
  if (Buffer.byteLength(command.body, 'utf8') > MAX_COMMAND_BODY_BYTES) throw fail('Command body exceeds size limit')
  if (!Array.isArray(command.workspaces)) throw fail('Invalid command workspaces')
}
async function checkedPath(path, directory, optional = false) {
  let info
  try { info = await lstat(path) } catch (error) {
    if (optional && error.code === 'ENOENT') return false
    throw error
  }
  if (info.isSymbolicLink()) throw fail(`Refusing symbolic link: ${path}`, 'UNSAFE_PATH')
  if (directory ? !info.isDirectory() : !info.isFile()) throw fail(`Unexpected file type: ${path}`, 'UNSAFE_PATH')
  return true
}
// O_NOFOLLOW also refuses a symlink swapped in after lstat on supported hosts.
async function readRegular(path, maxBytes) {
  await checkedPath(path, false)
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > maxBytes) throw fail(`Invalid or oversized file: ${path}`, 'CORRUPT_REGISTRY')
    return await file.readFile('utf8')
  } finally { await file.close() }
}
async function canonicalWorkspace(workspace) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace) || workspace.includes('\0')) throw fail('Workspace must be an absolute existing directory')
  const canonical = await realpath(workspace)
  if (!(await stat(canonical)).isDirectory()) throw fail('Workspace must be a directory')
  return canonical
}

/**
 * Standalone prompt-command persistence. No command bodies are executed here.
 * Registry v1: {version, revision, commands:[{id,name,description,inputHint,
 * workspaces,contentFile}]}. contentFile is a basename under content/.
 * Registry replacement is the sole commit point; old/uncommitted bodies are
 * deliberately retained, so lock-free readers can finish an older snapshot.
 * Dependencies accept the same signatures as the official atomic-write API.
 */
export class CommandStore {
  constructor(options) {
    const { root, atomicWrite = writeFileAtomic, withLock = withFileLock } = typeof options === 'string' ? { root: options } : (options || {})
    if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) throw fail('Command store root must be absolute')
    this.root = resolve(root)
    this.registry = join(this.root, 'registry.json')
    this.content = join(this.root, 'content')
    this.atomicWrite = atomicWrite
    this.withLock = withLock
  }

  async checkLayout(create = false) {
    const exists = await checkedPath(this.root, true, true)
    if (!exists) {
      if (!create) return false
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      await checkedPath(this.root, true)
    }
    await checkedPath(this.registry, false, true)
    await checkedPath(this.content, true, true)
    if (create) {
      await checkedPath(`${this.registry}.lock`, false, true)
      await mkdir(this.content, { recursive: true, mode: 0o700 })
      await checkedPath(this.content, true)
    }
    return true
  }

  async list() {
    if (!await this.checkLayout()) return { revision: 0, commands: [] }
    if (!await checkedPath(this.registry, false, true)) return { revision: 0, commands: [] }
    let registry
    try { registry = JSON.parse(await readRegular(this.registry, MAX_REGISTRY_BYTES)) } catch (error) {
      if (error.code === 'UNSAFE_PATH') throw error
      throw fail(`Cannot read command registry: ${error.message}`, 'CORRUPT_REGISTRY')
    }
    if (!registry || registry.version !== 1 || !Number.isSafeInteger(registry.revision) || registry.revision < 0 || !Array.isArray(registry.commands)) throw fail('Invalid command registry schema', 'CORRUPT_REGISTRY')
    const commands = []
    const names = new Set()
    const ids = new Set()
    for (const entry of registry.commands) {
      validId(entry?.id)
      if (typeof entry.contentFile !== 'string' || !new RegExp(`^${entry.id}-[0-9a-f]{64}\\.md$`).test(entry.contentFile)) throw fail('Invalid command content path', 'CORRUPT_REGISTRY')
      const body = await readRegular(join(this.content, entry.contentFile), MAX_COMMAND_BODY_BYTES)
      const command = { id: entry.id, name: entry.name, description: entry.description, inputHint: entry.inputHint, body, workspaces: entry.workspaces }
      validateFields(command)
      if (contentName(command) !== entry.contentFile) throw fail('Command body hash mismatch', 'CORRUPT_REGISTRY')
      if (names.has(command.name) || ids.has(command.id)) throw fail('Duplicate command in registry', 'CORRUPT_REGISTRY')
      for (const workspace of command.workspaces) {
        // Do not realpath persisted workspaces: an unplugged workspace must not
        // prevent disabling/deleting its commands. Inputs are canonicalized.
        if (typeof workspace !== 'string' || !isAbsolute(workspace) || workspace.includes('\0') || resolve(workspace) !== workspace) throw fail('Invalid stored workspace', 'CORRUPT_REGISTRY')
      }
      if (new Set(command.workspaces).size !== command.workspaces.length) throw fail('Duplicate stored workspace', 'CORRUPT_REGISTRY')
      names.add(command.name)
      ids.add(command.id)
      commands.push(command)
    }
    return { revision: registry.revision, commands }
  }

  async mutate(revision, operation) {
    validRevision(revision)
    await this.checkLayout(true)
    return this.withLock(this.registry, async () => {
      await this.checkLayout()
      const previous = await this.list()
      if (revision !== previous.revision) throw fail('Command registry revision conflict; reload and retry', 'REVISION_CONFLICT')
      if (revision === Number.MAX_SAFE_INTEGER) throw fail('Command revision exhausted')
      const commands = await operation(previous.commands)
      await this.checkLayout()
      const registry = { version: 1, revision: revision + 1, commands: commands.map(({ body, ...metadata }) => ({ ...metadata, contentFile: contentName({ ...metadata, body }) })) }
      const serialized = `${JSON.stringify(registry, null, 2)}\n`
      if (Buffer.byteLength(serialized, 'utf8') > MAX_REGISTRY_BYTES) throw fail('Command registry exceeds size limit')
      await this.atomicWrite(this.registry, serialized, { mode: 0o600, dirMode: 0o700 })
      return { revision: registry.revision, commands }
    })
  }

  async save({ revision, command }) {
    return this.mutate(revision, async commands => {
      if (!command || typeof command !== 'object') throw fail('Invalid command')
      const id = command.id === undefined ? randomUUID() : command.id
      validId(id)
      const index = commands.findIndex(entry => entry.id === id)
      if (command.id !== undefined && index < 0) throw fail('Command not found', 'NOT_FOUND')
      const candidate = {
        id, name: command.name, description: command.description ?? '',
        inputHint: typeof command.inputHint === 'string' ? command.inputHint.trim() : (command.inputHint ?? ''), body: command.body,
        workspaces: command.workspaces ?? (index < 0 ? [] : commands[index].workspaces),
      }
      validateFields(candidate)
      const retained = new Set(index < 0 ? [] : commands[index].workspaces)
      candidate.workspaces = [...new Set(await Promise.all(candidate.workspaces.map(path => retained.has(path) ? path : canonicalWorkspace(path))))]
      if (commands.some(entry => entry.id !== id && entry.name === candidate.name)) throw fail('Duplicate command name', 'DUPLICATE_NAME')
      await this.checkLayout()
      const filename = join(this.content, contentName(candidate))
      // Exclusive create never overwrites an existing body or follows a link.
      let file
      try { file = await open(filename, 'wx', 0o600) } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const existing = await readRegular(filename, MAX_COMMAND_BODY_BYTES)
        if (existing !== candidate.body) throw fail('Existing immutable command body is corrupt', 'CORRUPT_REGISTRY')
      }
      if (file) {
        try { await file.writeFile(candidate.body, 'utf8') } finally { await file.close() }
      }
      if (index < 0) commands.push(candidate)
      else commands[index] = candidate
      return commands
    })
  }

  async remove({ revision, id }) {
    validId(id)
    return this.mutate(revision, commands => {
      if (!commands.some(command => command.id === id)) throw fail('Command not found', 'NOT_FOUND')
      return commands.filter(command => command.id !== id)
    })
  }

  async setEnabled({ revision, id, workspace, enabled }) {
    validId(id)
    if (typeof enabled !== 'boolean') throw fail('enabled must be a boolean')
    return this.mutate(revision, async commands => {
      const command = commands.find(entry => entry.id === id)
      if (!command) throw fail('Command not found', 'NOT_FOUND')
      const canonical = !enabled && command.workspaces.includes(workspace) ? workspace : await canonicalWorkspace(workspace)
      command.workspaces = command.workspaces.filter(path => path !== canonical)
      if (enabled) command.workspaces.push(canonical)
      return commands
    })
  }
}
