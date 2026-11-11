import { realpathSync } from 'node:fs';

function workspaceOf(ctx, agent) {
  const cwd = ctx.workingDirectory?.get(agent.session);
  if (typeof cwd !== 'string' || !cwd) return '';
  try { return realpathSync(cwd); } catch { return cwd; }
}

/** Own exact agent-scoped official command registrations; never install global fallbacks. */
export function installCommandsRuntime(ctx, store) {
  const slots = new Map();
  const diagnostics = new Map();
  const listeners = [];
  let disposed = false;
  let queue = Promise.resolve();
  const warn = (error) => ctx.logger?.warn?.(`commands-manager: ${error?.message || error}`);
  const createMessage = ctx.loader.import('@deepseek-ai/dsh-llm').then((module) => module.createUserMessage);
  // Keep failed host imports observable without an unhandled rejection on older hosts.
  createMessage.catch(warn);

  async function invoke(id, invocation) {
    const { agent, rawInput = '', signal } = invocation;
    signal?.throwIfAborted();
    const snapshot = await store.list();
    const definition = snapshot.commands.find((item) => item.id === id);
    const workspace = workspaceOf(ctx, agent);
    if (disposed || !slots.has(agent) || !definition?.workspaces.includes(workspace)) {
      return { kind: 'error', text: 'Command is disabled in this workspace.' };
    }
    const makeMessage = await createMessage;
    signal?.throwIfAborted();
    // Re-check after asynchronous imports: cwd may have changed while awaiting.
    const latest = (await store.list()).commands.find((item) => item.id === id);
    signal?.throwIfAborted();
    if (disposed || !slots.has(agent) || workspaceOf(ctx, agent) !== workspace || !latest?.workspaces.includes(workspace) || ctx.commands.find(undefined, latest.name)) {
      return { kind: 'error', text: 'Command or workspace changed; retry the command.' };
    }
    const text = latest.body.replaceAll('$ARGUMENTS', () => rawInput.trim());
    agent.steer(makeMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    return { kind: 'success', text: `Queued /${definition.name} in this session.` };
  }

  function attach(agent) {
    if (disposed || !agent?.ctx || slots.has(agent)) return;
    const slot = { agent, commandCtx: null, registrations: new Map(), fiber: null };
    slots.set(agent, slot);
    try {
      slot.fiber = agent.ctx.inject(['commands'], (commandCtx) => {
        slot.commandCtx = commandCtx;
        commandCtx.effect(() => () => {
          for (const entry of slot.registrations.values()) entry.dispose();
          slot.registrations.clear();
          slot.commandCtx = null;
        }, 'toolbox.commands.agent');
        void reconcile().catch(warn);
      });
    } catch (error) { slots.delete(agent); warn(error); }
  }

  async function reconcileNow() {
    if (disposed) return [];
    const snapshot = await store.list();
    if (disposed) return [];
    diagnostics.clear();
    for (const [agent, slot] of slots) {
      if (!slot.commandCtx) continue;
      const workspace = workspaceOf(ctx, agent);
      const wanted = snapshot.commands.filter((item) => item.workspaces.includes(workspace));
      const desired = new Map(wanted.map((item) => [item.id, item]));
      for (const [id, entry] of slot.registrations) {
        const globalConflict = ctx.commands.find(undefined, desired.get(id)?.name || entry.name);
        if (!globalConflict && JSON.stringify(desired.get(id)) === entry.key) continue;
        entry.dispose(); slot.registrations.delete(id);
      }
      for (const definition of wanted) {
        if (slot.registrations.has(definition.id)) continue;
        try {
          // Scoped registrations can shadow globals; explicitly prohibit that behavior here.
          if (ctx.commands.find(agent, definition.name)) throw new Error(`/${definition.name} is already registered`);
          const dispose = slot.commandCtx.commands.register({
            name: definition.name,
            definitionId: `dsh-toolbox-ui/commands/${definition.id}`,
            description: definition.description,
            ...(definition.inputHint ? { input: { hint: definition.inputHint } } : {}),
            handler: (invocation) => invoke(definition.id, invocation),
          });
          slot.registrations.set(definition.id, { key: JSON.stringify(definition), name: definition.name, dispose });
        } catch (error) {
          const key = `${workspace}\0${definition.id}`;
          diagnostics.set(key, { workspace, id: definition.id, name: definition.name, error: String(error?.message || error) });
        }
      }
    }
    return [...diagnostics.values()];
  }
  function reconcile() {
    const next = queue.then(reconcileNow);
    queue = next.catch(warn);
    return next;
  }
  function listen(event, handler) {
    const dispose = ctx.on(event, handler);
    if (typeof dispose === 'function') listeners.push(dispose);
  }
  listen('agent/created', ({ agent }) => { attach(agent); return reconcile().catch(warn); });
  listen('agent/disposed', ({ agent }) => {
    const slot = slots.get(agent); slots.delete(agent);
    if (slot) return slot.fiber?.dispose();
  });
  listen('commands/change', () => { queueMicrotask(() => { if (!disposed) void reconcile().catch(warn); }); });
  listen('session/event', (session, event) => {
    if (event?.type === 'working-directory/change' && [...slots.keys()].some((agent) => agent.session === session)) {
      queueMicrotask(() => { if (!disposed) void reconcile().catch(warn); });
    }
  });
  for (const agent of ctx.agents.list()) attach(agent);
  const runtime = {
    ready: reconcile(),
    reconcile,
    diagnostics: () => [...diagnostics.values()],
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const dispose of listeners) dispose();
      await queue;
      const fibers = [...slots.values()].map((slot) => slot.fiber);
      slots.clear(); diagnostics.clear();
      await Promise.all(fibers.map((fiber) => fiber?.dispose()));
    },
  };
  ctx.effect(() => () => runtime.dispose(), 'toolbox.commands.runtime');
  return runtime;
}
