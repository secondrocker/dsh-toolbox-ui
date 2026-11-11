import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { installCommandsRuntime } from '../lib/commands-runtime.js';

// Independent, opt-in official SDK integration fixture; never resolve the project's
// older SDK or replace commands/inject/effect with test doubles. Bootstrap with:
// npm install --prefix /tmp/dsh-command-real-fixture --no-audit --no-fund \
//   @deepseek-ai/cordis@4.1.0 @deepseek-ai/dsh-commands@0.2.2-rc.1 \
//   @deepseek-ai/dsh-scope@0.2.2-rc.1 @deepseek-ai/dsh-llm@0.2.2-rc.1
// commands@0.2.2-rc.1 requires cordis ~4.1.0, not 4.0.5.
// DSH_COMMAND_REAL_FIXTURE can select another independently installed fixture.
const fixturePath = process.env.DSH_COMMAND_REAL_FIXTURE || '/tmp/dsh-command-real-fixture';
const available = existsSync(join(fixturePath, 'node_modules/@deepseek-ai/dsh-commands/package.json'));
if (process.env.DSH_COMMAND_REAL_FIXTURE && !available) {
  throw new Error(`Official commands SDK fixture missing at ${fixturePath}`);
}
const integration = (name, fn) => test(name, {
  skip: available ? false : 'Install the isolated official SDK fixture documented in this file',
}, fn);
let sdkPromise;
function sdk() {
  return sdkPromise ??= (async () => {
    const require = createRequire(join(fixturePath, 'package.json'));
    const load = (name) => import(pathToFileURL(require.resolve(name)).href);
    const [{ Context }, { default: Commands }, { createScope }, { Session }, llm] = await Promise.all([
      load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-commands'),
      load('@deepseek-ai/dsh-scope'), load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-llm'),
    ]);
    assert.equal(typeof llm.createUserMessage, 'function');
    return { Context, Commands, createScope, Session, load };
  })();
}

async function fixture(t, { lateCommands = false } = {}) {
  const { Context, Commands, createScope, Session, load } = await sdk();
  const root = new Context();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'toolbox-real-commands-')));
  const scopes = [];
  let runtime;
  t.after(async () => {
    await runtime?.dispose();
    for (const scope of scopes) await scope.dispose();
    await root.fiber.dispose();
    // directory is the exact, existing mkdtemp result above, never a derived input.
    assert.ok(directory.startsWith(realpathSync(tmpdir()) + '/toolbox-real-commands-'));
    rmSync(directory, { recursive: true, force: true });
  });
  if (!lateCommands) await root.plugin(Commands);
  const agents = [], cwd = new Map();
  const prompts = [];
  // No model/provider/GUI is started. The agent boundary is deliberately a small
  // harness: real Session + real scoped Cordis ctx; steer records delivered input.
  // Only host registry, dependency injection, events and disposal are under test.
  function agent(workspace = directory) {
    const value = { session: new Session(`real-commands-${agents.length}`), steer: (message) => prompts.push(message) };
    const scope = createScope(root, value);
    scopes.push(scope);
    value.ctx = scope.ctx;
    agents.push(value);
    cwd.set(value.session, workspace);
    return value;
  }
  const first = agent(), second = agent();
  let snapshot = { revision: 1, commands: [{
    id: 'ship', name: 'ship-dev', description: 'Ship development', body: 'Do $ARGUMENTS',
    inputHint: '[target]', workspaces: [directory],
  }] };
  const ctx = root.extend({
    agents: { list: () => agents }, workingDirectory: { get: (session) => cwd.get(session) },
    loader: { import: load },
  });
  return {
    root, Commands, first, second, prompts, directory, cwd, agent,
    setSnapshot: (next) => { snapshot = next; },
    install() { return runtime = installCommandsRuntime(ctx, { list: async () => snapshot }); },
    async settled() {
      // A real dependency-injected Fiber is awaitable, not a synchronous apply.
      for (const value of agents) await value.ctx.inject(['commands'], () => {});
      await runtime.ready;
      await runtime.reconcile();
    },
    execute: (value, line) => root.commands.execute(value, line, [], new AbortController().signal),
  };
}

integration('official SDK: inject returns an asynchronous Fiber; bare scoped commands access is prohibited', async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.first.ctx.commands, /without inject/);
  let applied = false, dispose;
  const fiber = f.first.ctx.inject(['commands'], (ctx) => {
    applied = true;
    dispose = ctx.commands.register({ name: 'probe', description: 'Probe', handler: () => ({ kind: 'success' }) });
  });
  assert.equal(typeof fiber.dispose, 'function');
  assert.equal(typeof fiber.then, 'function');
  assert.equal(applied, false);
  await fiber;
  assert.equal(applied, true);
  assert.equal(typeof dispose, 'function');
  assert.ok(f.root.commands.find(f.first, 'probe'));
  assert.equal(f.root.commands.find(f.second, 'probe'), undefined);
  dispose(); dispose();
  assert.equal(f.root.commands.find(f.first, 'probe'), undefined);
  await fiber.dispose();
});

integration('official SDK runtime: exact-agent scoped commands execute through real CommandRuntime and LLM message factory', async (t) => {
  const f = await fixture(t);
  const runtime = f.install();
  await f.settled();
  assert.equal(f.root.commands.list(f.first).length, 1);
  assert.equal(f.root.commands.list(f.second).length, 1);
  assert.equal(f.root.commands.find({}, 'ship-dev'), undefined);
  const execution = await f.execute(f.first, '/ship-dev new-dev-v3');
  assert.equal(execution.result.kind, 'success');
  assert.equal(f.prompts[0].content[0].text, 'Do new-dev-v3');
  assert.equal(f.first.session.seq, 2, 'official executor appended run/done lifecycle events');
  await runtime.dispose();
  assert.deepEqual(f.root.commands.list(f.first), []);
  assert.deepEqual(f.root.commands.list(f.second), []);
});

integration('official SDK runtime: dynamic deletion unregisters and rejects retained handlers', async (t) => {
  const f = await fixture(t);
  const runtime = f.install();
  await f.settled();
  const retained = f.root.commands.find(f.first, 'ship-dev');
  f.setSnapshot({ revision: 2, commands: [] });
  assert.equal((await retained.handler({ agent: f.first, signal: new AbortController().signal })).kind, 'error');
  await runtime.reconcile();
  assert.deepEqual(f.root.commands.list(f.first), []);
  assert.deepEqual(f.root.commands.list(f.second), []);
  assert.equal(await f.execute(f.first, '/ship-dev'), undefined);
  assert.deepEqual(f.prompts, []);
});

integration('official SDK runtime: existing global command is not shadowed and reports a conflict', async (t) => {
  const f = await fixture(t);
  const disposeGlobal = f.root.commands.register({ name: 'ship-dev', description: 'Official global', handler: () => ({ kind: 'success', text: 'global' }) });
  const runtime = f.install();
  await f.settled();
  assert.match(runtime.diagnostics()[0].error, /already registered/);
  assert.equal(f.root.commands.find(f.first, 'ship-dev').description, 'Official global');
  assert.equal((await f.execute(f.first, '/ship-dev')).result.text, 'global');
  assert.deepEqual(f.prompts, []);
  disposeGlobal();
  await runtime.reconcile();
  assert.deepEqual(runtime.diagnostics(), []);
  assert.equal(f.root.commands.find(f.first, 'ship-dev').description, 'Ship development');
});

integration('official SDK runtime: cwd changes cannot leak invocation or registrations across agents', async (t) => {
  const f = await fixture(t);
  const runtime = f.install();
  await f.settled();
  const retained = f.root.commands.find(f.first, 'ship-dev');
  f.cwd.set(f.first.session, join(f.directory, 'other'));
  assert.equal((await f.execute(f.first, '/ship-dev')).result.kind, 'error', 'guard works before async reconcile');
  f.root.emit('session/event', f.first.session, { type: 'working-directory/change' });
  await new Promise(queueMicrotask);
  await runtime.reconcile();
  assert.equal(f.root.commands.find(f.first, 'ship-dev'), undefined);
  assert.ok(f.root.commands.find(f.second, 'ship-dev'));
  assert.equal((await retained.handler({ agent: f.first, signal: new AbortController().signal })).kind, 'error');
  assert.deepEqual(f.prompts, []);
  f.cwd.set(f.first.session, f.directory);
  f.root.emit('session/event', f.first.session, { type: 'working-directory/change' });
  await new Promise(queueMicrotask);
  await runtime.reconcile();
  assert.ok(f.root.commands.find(f.first, 'ship-dev'));
  await f.root.parallel('agent/disposed', { agent: f.first });
  assert.equal(f.root.commands.find(f.first, 'ship-dev'), undefined);
  assert.ok(f.root.commands.find(f.second, 'ship-dev'));
});

integration('official SDK runtime: agent/created mounts a real injected child and agent scope disposal unregisters it', async (t) => {
  const f = await fixture(t);
  f.install();
  await f.settled();
  const third = f.agent();
  assert.equal(f.root.commands.find(third, 'ship-dev'), undefined);
  await f.root.parallel('agent/created', { agent: third });
  await f.settled();
  assert.ok(f.root.commands.find(third, 'ship-dev'));
  await third.ctx.fiber.dispose();
  assert.equal(f.root.commands.find(third, 'ship-dev'), undefined);
  assert.ok(f.root.commands.find(f.first, 'ship-dev'));
});

integration('official SDK runtime: characterize ready resolving before a late commands dependency is applied', async (t) => {
  const f = await fixture(t, { lateCommands: true });
  const runtime = f.install();
  await runtime.ready;
  assert.equal(f.root.get('commands'), undefined, 'ready resolved while the required service is absent');
  // This is a readiness limitation, not proof of a completed registration.
  // Installing the actual service later activates the actual pending Fibers.
  await f.root.plugin(f.Commands);
  await f.settled();
  assert.ok(f.root.commands.find(f.first, 'ship-dev'));
});
