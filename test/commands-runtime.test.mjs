import test from 'node:test';
import assert from 'node:assert/strict';
import { installCommandsRuntime } from '../lib/commands-runtime.js';

function fixture() {
  let snapshot = {revision: 1,commands:[{id:'a',name:'ship-dev',description:'Ship',body:'Do $ARGUMENTS',inputHint:'[dev]',workspaces:['/project/a']}]};
  const events = new Map(), cleanups = [], registrations = new Map(), prompts = [];
  const agent = {session:{cwd:'/project/a'},steer:(message)=>prompts.push(message),ctx:{inject(_deps,apply){const ctx={commands:{find:(_agent,name)=>registrations.get(name),register(def){registrations.set(def.name,def);return ()=>registrations.delete(def.name);}},effect:(cb)=>cleanups.push(cb())};apply(ctx);return {dispose(){for(const fn of cleanups.splice(0))fn?.();registrations.clear();}};}}};
  const ctx={agents:{list:()=>[agent]},workingDirectory:{get:(session)=>session.cwd},commands:{find:(agent,name)=>agent?registrations.get(name):undefined},on(name,fn){events.set(name,fn);return ()=>events.delete(name);},effect:(cb)=>cleanups.push(cb()),logger:{warn(){}},loader:{import:async()=>({createUserMessage:(value)=>value})}};
  return {ctx,agent,events,registrations,prompts,store:{list:async()=>snapshot},setSnapshot:(value)=>{snapshot=value;}};
}

test('scoped registration, prompt substitution, cwd guard and live updates',async()=>{
 const f=fixture();const runtime=installCommandsRuntime(f.ctx,f.store);await runtime.ready;
 assert.ok(f.registrations.has('ship-dev'));
 let result=await f.registrations.get('ship-dev').handler({agent:f.agent,rawInput:' new-dev-v3',signal:new AbortController().signal});
 assert.equal(result.kind,'success');assert.equal(f.prompts[0].content[0].text,'Do new-dev-v3');
 f.agent.session.cwd='/project/b';
 result=await f.registrations.get('ship-dev').handler({agent:f.agent,rawInput:'',signal:new AbortController().signal});
 assert.equal(result.kind,'error');assert.equal(f.prompts.length,1);
 await runtime.reconcile();assert.equal(f.registrations.size,0);
 f.agent.session.cwd='/project/a';await runtime.reconcile();assert.equal(f.registrations.size,1);
 f.setSnapshot({revision:2,commands:[]});await runtime.reconcile();assert.equal(f.registrations.size,0);
 await runtime.dispose();
});
test('cancellation and current definition checks happen before steer',async()=>{
 const f=fixture();const r=installCommandsRuntime(f.ctx,f.store);await r.ready;const old=f.registrations.get('ship-dev');
 f.setSnapshot({revision:2,commands:[]});assert.equal((await old.handler({agent:f.agent,rawInput:'',signal:new AbortController().signal})).kind,'error');
 assert.equal(f.prompts.length,0);await r.dispose();
});


test('unload while the message SDK loads must not steer',async()=>{
 const f=fixture();let resolveImport;
 f.ctx.loader.import=()=>new Promise(resolve=>{resolveImport=resolve;});
 const r=installCommandsRuntime(f.ctx,f.store);await r.ready;
 const pending=f.registrations.get('ship-dev').handler({agent:f.agent,rawInput:'',signal:new AbortController().signal});
 await Promise.resolve();await r.dispose();
 resolveImport({createUserMessage:value=>value});
 assert.equal((await pending).kind,'error');assert.equal(f.prompts.length,0);
});

test('later global command reclaims its name without being shadowed',async()=>{
 const f=fixture();const originalFind=f.ctx.commands.find;
 let foreign;
 f.ctx.commands.find=(agent,name)=>agent===undefined?foreign:originalFind(agent,name)||foreign;
 const r=installCommandsRuntime(f.ctx,f.store);await r.ready;
 foreign={name:'ship-dev',description:'Official'};
 await r.reconcile();
 assert.equal(f.registrations.size,0);assert.equal(r.diagnostics().length,1);
 await r.dispose();
});
