// Commands are prompt text, never JavaScript: the host owns persistence and registration.
const CommandsPanel = ({ call, workspaces }) => {
  const [snapshot, setSnapshot] = useState(null);
  const [selected, setSelected] = useState('');
  const [editor, setEditor] = useState(null);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const writing = useRef(false);
  const current = useRef(null);
  const applySnapshot = (res) => { current.current = res; setSnapshot(res); };
  const load = useCallback(async () => {
    if (writing.current) return;
    const request = ++sequence.current;
    try {
      const res = await call('commandsList');
      if (!mounted.current || request !== sequence.current) return;
      if (!res?.ok) throw new Error(res?.error || t('命令加载失败'));
      current.current = res;
      setSnapshot(res);
      setError('');
      // Editor is intentionally untouched: its base revision and draft form one transaction.
    } catch (e) {
      if (mounted.current && request === sequence.current) setError(String(e?.message || e));
    }
  }, [call]);
  useEffect(() => {
    mounted.current = true;
    void load();
    const interval = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void load();
    }, 5000);
    return () => { mounted.current = false; sequence.current += 1; clearInterval(interval); };
  }, [load]);
  const rows = snapshot?.commands || [];
  const row = rows.find((item) => item.id === selected) || rows[0] || null;
  const choices = (command) => {
    const paths = new Map();
    for (const ws of Array.isArray(workspaces) ? workspaces : []) {
      const path = typeof ws === 'string' ? ws : ws?.path;
      if (path) paths.set(path, typeof ws === 'string' ? ws : ws.name || path);
    }
    // Registered workspace discovery is not the registry: never drop undiscovered paths.
    for (const path of command?.workspaces || []) if (!paths.has(path)) paths.set(path, path);
    return Array.from(paths, ([path, name]) => ({ path, name }));
  };
  const openEditor = (command) => {
    if (writing.current || !current.current) return;
    setFormError('');
    setEditor({ revision: current.current.revision, command: command
      ? { id: command.id, name: command.name, description: command.description || '', inputHint: command.inputHint || '', body: command.body || '', workspaces: [...(command.workspaces || [])] }
      : { name: '', description: '', inputHint: '', body: '', workspaces: [] } });
  };
  const change = (field, value) => setEditor((prev) => ({ ...prev, command: { ...prev.command, [field]: value } }));
  const mutate = async (method, args, editing = false) => {
    if (writing.current) return;
    writing.current = true;
    sequence.current += 1; // A pre-write list response must never restore an older revision.
    setBusy(true);
    if (editing) setFormError(''); else setError('');
    setNotice('');
    try {
      const res = await call(method, args);
      if (!mounted.current) return;
      if (!res?.ok) throw new Error(res?.error || t('命令操作失败'));
      applySnapshot(res);
      setError('');
      if (editing) setEditor(null);
      setNotice(res.live === 'failed' || res.live === 'skipped' || res.live === false
        ? t('命令已保存，但运行中会话未完全生效，请查看诊断。')
        : t('命令配置已保存'));
    } catch (e) {
      if (!mounted.current) return;
      (editing ? setFormError : setError)(String(e?.message || e));
      // Keep the editor, including its stale revision, for explicit conflict resolution.
    } finally {
      writing.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const save = () => mutate('commandsSave', { revision: editor.revision, command: editor.command }, true);
  const remove = () => {
    if (!row || writing.current) return;
    if (confirm(t('确认删除命令「{name}」？所有已启用工作区都将停用此命令。', { name: row.name })))
      return mutate('commandsRemove', { revision: current.current.revision, id: row.id });
  };
  const toggle = (workspace, enabled) => mutate('commandsSetEnabled', { revision: current.current.revision, id: row.id, workspace, enabled });
  const workspaceChecks = (command, onChange) => h('div', { className: 'dsh-mcp-check-list' },
    choices(command).map((ws) => h('label', { key: ws.path, className: 'dsh-mcp-check-row', title: ws.path },
      h('input', { type: 'checkbox', 'aria-label': ws.path, checked: command.workspaces.includes(ws.path), disabled: busy,
        onChange: (event) => onChange(ws.path, event.target.checked) }),
      h('span', { className: 'dsh-mcp-check-name' }, ws.name),
      h('span', { className: 'dsh-mcp-check-meta' }, ws.path))));
  const field = (key, label, multiline = false) => h('div', { className: 'dsh-mcp-field' },
    h('label', null, label), h(multiline ? 'textarea' : 'input', {
      'aria-label': label, value: editor.command[key], disabled: busy,
      rows: multiline ? 12 : undefined, onChange: (event) => change(key, event.target.value),
    }));
  const modal = editor ? h('div', { className: 'dsh-mcp-overlay' },
    h(Dialog, { label: (editor.command.id ? t('编辑命令') : t('新增命令')), onClose: () => { if (!writing.current) setEditor(null); } },
      h('h3', null, (editor.command.id ? t('编辑命令') : t('新增命令'))),
      field('name', t('命令名称')), field('description', t('命令说明')), field('inputHint', t('参数提示')), field('body', t('命令正文'), true),
      h('div', { className: 'dsh-mcp-source-detail' }, t('使用 $ARGUMENTS 插入调用参数；正文仅作为提示词，不执行 JavaScript 或 shell。')),
      h('div', { className: 'dsh-mcp-source-detail' }, t('正文为全局共享，修改会影响所有已启用工作区。')),
      h('div', { className: 'dsh-mcp-field' }, h('label', null, t('启用工作区')), workspaceChecks(editor.command, (path, enabled) => {
        const paths = editor.command.workspaces;
        change('workspaces', enabled ? [...new Set([...paths, path])] : paths.filter((value) => value !== path));
      })),
      formError ? h('div', { className: 'dsh-mcp-d-err', role: 'alert' }, formError) : null,
      h('div', { className: 'dsh-mcp-modal-actions' },
        h(Btn, { disabled: busy, onClick: () => setEditor(null), children: t('取消') }),
        h(Btn, { cls: 'primary', disabled: busy || !editor.command.name.trim() || !editor.command.description.trim() || !editor.command.body.trim(), onClick: save, children: t('保存') })))) : null;
  return h('div', { className: 'dsh-mcp-body' },
    modal,
    h('div', { className: 'dsh-mcp-side' },
      h('div', { className: 'dsh-mcp-filters' },
        h(Btn, { cls: 'primary', disabled: busy || !snapshot, onClick: () => openEditor(null), children: t('新增命令') }),
        h(Btn, { disabled: busy, onClick: load, children: t('刷新') })),
      h('div', { className: 'dsh-mcp-list' }, rows.length ? rows.map((item) => h('button', { key: item.id, type: 'button', className: 'dsh-mcp-item' + (row?.id === item.id ? ' sel' : ''), onClick: () => setSelected(item.id) },
        h('div', { className: 'dsh-mcp-item-main' }, h('div', { className: 'dsh-mcp-item-name' }, '/' + item.name), h('div', { className: 'dsh-mcp-item-sub' }, item.description))))
        : h('div', { className: 'dsh-mcp-d-empty' }, (snapshot ? t('暂无命令，新增后按工作区启用。') : t('正在加载命令…'))))),
    h('div', { className: 'dsh-mcp-detail' },
      h('div', { className: 'dsh-mcp-d-head' }, h('div', { className: 'dsh-mcp-d-name' }, row ? '/' + row.name : t('命令')),
        row ? h('div', { className: 'dsh-mcp-d-actions' }, h(Btn, { disabled: busy, onClick: () => openEditor(row), children: t('编辑') }), h(Btn, { disabled: busy, onClick: remove, children: t('删除') })) : null),
      h('div', { className: 'dsh-mcp-d-body' },
        error ? h('div', { className: 'dsh-mcp-d-err', role: 'alert' }, error) : null,
        notice ? h('div', { role: 'status' }, notice) : null,
        (snapshot?.diagnostics || []).map((diagnostic, index) => h('div', { key: index, className: 'dsh-mcp-d-err' }, typeof diagnostic === 'string' ? diagnostic : t('{name} · {workspace}：{error}', { name: diagnostic.name || diagnostic.id || '', workspace: diagnostic.workspace || '', error: diagnostic.message || diagnostic.error || JSON.stringify(diagnostic) }))),
        row ? h('div', null,
          h('p', null, row.description), h('p', null, row.inputHint),
          h('div', { className: 'dsh-mcp-source-detail' }, t('正文为全局共享，修改会影响所有已启用工作区。')),
          h('pre', { className: 'dsh-skills-pre' }, row.body),
          h('h4', null, t('启用工作区')), workspaceChecks(row, toggle)) : null)));
};
