const test = require('node:test'), assert = require('node:assert/strict');
const { startSandbox } = require('./runtime.cjs');
test('Autolink creates a reviewed Marketing research plan through the existing owned service', async t => {
 const s = await startSandbox({port:4342}), uid = s.config.userId;
 const contacts = s.load('services/professional/sales/sales.service.js');
 const contact = await contacts.createContact(uid,{name:'Mira Research QA',email:'mira@sandbox.invalid',company:'Launch Studio'});
 const other = await contacts.createContact(s.config.otherUserId,{name:'Other workspace'});
 const model = s.load('services/ai/geminiClient.js'); model.isGeminiLive = () => true;
 let phase=0, selected=contact.id;
 model.geminiGenerateContent = async options => {
  assert(options.tools.some(tool=>tool.name==='read_marketing_workspace'));
  assert(options.tools.some(tool=>tool.name==='create_marketing_research_plan'));
  const call = phase++===0 ? {name:'read_marketing_workspace',args:{resource:'contacts'}} : phase===2 ? {name:'create_marketing_research_plan',args:{title:'Reviewed launch research',objective:'Confirm buying signals and prepare a reviewed outreach plan.',contactIds:[selected]}} : undefined;
  return {raw:call?'':'Your reviewed research plan is saved in Interlink. No external copy was made.',functionCall:call,model:'fixture',latencyMs:1};
 };
 const api=async(route,body,expected=200)=>{const r=await fetch(s.config.base+'/api/v1/accountant/assistant'+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+s.config.token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();assert.equal(r.status,expected,JSON.stringify(data));return data};
 const count=async()=>Number((await s.db.query('SELECT count(*) AS n FROM sales_marketing_research_plans WHERE user_id=$1',[uid])).rows[0].n);
 try {
  await t.test('planning reads real owned contacts and stops for confirmation',async()=>{
   const plan=await api('/command',{message:'Create a research plan for Mira Research QA for the launch.'});
   assert.equal(plan.action.name,'create_marketing_research_plan');assert.equal(plan.task.status,'review');assert.equal(await count(),0);
   const route='/tasks/'+plan.task.id+'/actions/'+plan.action.id+'/execute';
   assert.equal((await api(route,{})).ok,true);assert.equal((await api(route,{})).ok,true);assert.equal(await count(),1,'confirmation replay cannot create another plan');
   const continuation=await api('/tasks/'+plan.task.id+'/continue',{});assert.match(continuation.answer,/saved in Interlink/);
  });
  await t.test('a contact from another workspace cannot enter the plan',async()=>{
   phase=0;selected=other.id;
   const plan=await api('/command',{message:'Create another research plan for the chosen contact.'});
   const result=await api('/tasks/'+plan.task.id+'/actions/'+plan.action.id+'/execute',{});
   assert.equal(result.ok,false);assert.equal(await count(),1);
  });
 } finally {await s.close()}
});
