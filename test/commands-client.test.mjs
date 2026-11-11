import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client/85-commands-face.js', import.meta.url), 'utf8').catch(() => '')
function harness(call, workspaces = [{path:'/one',name:'One'}]) {
  let cursor = 0; const slots = []; const effects = []; const intervals = []; let confirmed = true
  const h = (type, props, ...children) => ({type,props:props || {},children:children.length ? children : [props?.children]})
  const ctx = {h, t:(s,p={})=>s.replace(/\{(\w+)\}/g,(_,k)=>p[k]??''), Dialog:'Dialog', Btn:'Btn', confirm:()=>confirmed,
    useRef(value) { const i=cursor++; return slots[i] ||= {current:value} },
    useState(value) {const i=cursor++; if (!(i in slots)) slots[i]=typeof value==='function'?value():value; return [slots[i],v=>{slots[i]=typeof v==='function'?v(slots[i]):v}]},
    useCallback:fn=>fn, useEffect(fn,deps) {const i=cursor++; const old=slots[i]; if (!old || deps.some((v,j)=>v!==old[j])) {slots[i]=deps; effects.push(fn)}},
    setInterval(fn) {intervals.push(fn);return 1}, clearInterval() {}, document:{visibilityState:'visible'},
  }
  vm.runInNewContext(source+'\nthis.Panel = CommandsPanel;',ctx)
  return {render:()=>{cursor=0;return ctx.Panel({call,workspaces})}, effects:async()=>{for(const f of effects.splice(0))f();await new Promise(r=>setImmediate(r))},poll:async()=>{for(const f of intervals)f();await new Promise(r=>setImmediate(r))},confirm:v=>{confirmed=v}}
}
function nodes(tree, predicate, out=[]) { if (!tree || typeof tree !=='object') return out; if(Array.isArray(tree)){tree.forEach(n=>nodes(n,predicate,out));return out} if(predicate(tree))out.push(tree); nodes(tree.children,predicate,out);return out }
const byLabel=(tree,label)=>nodes(tree,n=>n.props?.['aria-label']===label)[0]
const button=(tree,label)=>nodes(tree,n=>n.type==='Btn' && (n.props.children===label || n.children.includes(label)))[0]
const snapshot=(revision='r1',body='original')=>({ok:true,revision,commands:[{id:'id1',name:'hello',description:'desc',inputHint:'args',body,workspaces:['/one','/missing']}],diagnostics:[]})
async function setup(call) {const app=harness(call);app.render();await app.effects();return app}

test('Commands face and shell/build registration exist', async()=>{
 assert.match(source,/const CommandsPanel/)
 const shell=await readFile(new URL('../lib/client/70-shell.js',import.meta.url),'utf8')
 assert.match(shell,/h\(CommandsPanel, \{ call, workspaces \}\)/)
 const skills=await readFile(new URL('../lib/client/80-skills-face.js',import.meta.url),'utf8')
 assert.match(skills, /id: 'commands'/)
 const build=await readFile(new URL('../scripts/build-client.mjs',import.meta.url),'utf8')
 assert.match(build,/'85-commands-face.js'/)
})
test('save uses editor revision, preserves unlisted paths and retains failed form',async()=>{
 const calls=[];let revision='r1'
 const app=await setup(async(m,p)=>{calls.push([m,p]);return m==='commandsSave'?{ok:false,error:'conflict'}:snapshot(revision)})
 let tree=app.render();button(tree,'编辑').props.onClick(); tree=app.render()
 byLabel(tree,'命令正文').props.onChange({target:{value:'draft $ARGUMENTS'}})
 revision='r2';await app.poll();tree=app.render()
 assert.equal(byLabel(tree,'命令正文').props.value,'draft $ARGUMENTS')
 await button(tree,'保存').props.onClick();tree=app.render()
 const save=calls.find(([m])=>m==='commandsSave')[1]
 assert.equal(save.revision,'r1');assert.equal(save.command.body,'draft $ARGUMENTS')
 assert.deepEqual(Array.from(save.command.workspaces),['/one','/missing'])
 assert.equal(byLabel(tree,'命令正文').props.value,'draft $ARGUMENTS')
 assert.ok(nodes(tree,n=>n.children?.includes('conflict')).length)
})
test('workspace toggle and confirmed remove send current revision',async()=>{
 const calls=[];const app=await setup(async(m,p)=>{calls.push([m,p]);return snapshot(m==='commandsSetEnabled'?'r2':'r1')})
 let tree=app.render(); await byLabel(tree,'/one').props.onChange({target:{checked:false}})
 const toggle=calls.find(([m])=>m==='commandsSetEnabled')[1]
 assert.equal(toggle.revision,'r1');assert.equal(toggle.workspace,'/one');assert.equal(toggle.enabled,false)
 tree=app.render();app.confirm(false);await button(tree,'删除').props.onClick();assert.equal(calls.filter(([m])=>m==='commandsRemove').length,0)
 app.confirm(true);await button(tree,'删除').props.onClick();assert.equal(calls.find(([m])=>m==='commandsRemove')[1].revision,'r2')
})
test('new command starts disabled and closes only after successful save',async()=>{
 const calls=[];const app=await setup(async(m,p)=>{calls.push([m,p]);return snapshot()})
 let tree=app.render();button(tree,'新增命令').props.onClick();tree=app.render()
 assert.equal(byLabel(tree,'/one').props.checked,false)
 byLabel(tree,'命令名称').props.onChange({target:{value:'new-command'}})
 tree=app.render();byLabel(tree,'命令正文').props.onChange({target:{value:'prompt'}})
 tree=app.render();await button(tree,'保存').props.onClick();tree=app.render()
 assert.deepEqual(Array.from(calls.find(([m])=>m==='commandsSave')[1].command.workspaces),[])
 assert.equal(byLabel(tree,'命令正文'),undefined)
})
test('persisted writes with registration diagnostics are not reported as save failures',async()=>{
 const app=await setup(async m=>m==='commandsSave'?{...snapshot('r2'),persisted:true,live:false,diagnostics:[{workspace:'/one',id:'id1',name:'hello',error:'occupied'}]}:snapshot())
 let tree=app.render();button(tree,'编辑').props.onClick();tree=app.render();await button(tree,'保存').props.onClick();tree=app.render()
 assert.equal(byLabel(tree,'命令正文'),undefined)
 assert.ok(nodes(tree,n=>n.children?.includes('命令已保存，但运行中会话未完全生效，请查看诊断。')).length)
 assert.ok(nodes(tree,n=>n.children?.includes('hello · /one：occupied')).length)
})
test('thrown save errors retain the edited form',async()=>{
 const app=await setup(async m=>{if(m==='commandsSave')throw new Error('offline');return snapshot()})
 let tree=app.render();button(tree,'编辑').props.onClick();tree=app.render();byLabel(tree,'命令正文').props.onChange({target:{value:'draft'}})
 tree=app.render();await button(tree,'保存').props.onClick();tree=app.render();assert.equal(byLabel(tree,'命令正文').props.value,'draft')
 assert.ok(nodes(tree,n=>n.children?.includes('offline')).length)
})
test('Commands list uses the shared sidebar layout',()=>{
 const app=harness(async()=>snapshot());const tree=app.render()
 assert.equal(nodes(tree,n=>n.props.className==='dsh-mcp-side').length,1)
})
test('late poll response cannot overwrite a completed mutation',async()=>{
 let resolvePoll;let count=0
 const app=await setup(async m=>{if(m==='commandsSetEnabled')return snapshot('r2','new body');if(++count===1)return snapshot();return new Promise(r=>{resolvePoll=r})})
 const pending=app.poll();let tree=app.render();await byLabel(tree,'/one').props.onChange({target:{checked:false}})
 resolvePoll(snapshot('r1','stale body'));await pending;tree=app.render()
 assert.ok(nodes(tree,n=>n.type==='pre' && n.children.includes('new body')).length)
})
