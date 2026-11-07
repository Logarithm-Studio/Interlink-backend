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
  const call = phase++===0 ? {name:'read_marketing_workspace',args:{resource:'contacts'}} : phase===2 ? {name:'create_marketing_research_plan',args:{title:'Reviewed launch research',objective:'Confirm buying signals and prepare a reviewed outreach plan.',contactIds:[selected],contacts:'Forged contact label'}} : undefined;
  return {raw:call?'':'Your reviewed research plan is saved in Interlink. No external copy was made.',functionCall:call,model:'fixture',latencyMs:1};
 };
 const api=async(route,body,expected=200)=>{const r=await fetch(s.config.base+'/api/v1/accountant/assistant'+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+s.config.token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();assert.equal(r.status,expected,JSON.stringify(data));return data};
 const count=async()=>Number((await s.db.query('SELECT count(*) AS n FROM sales_marketing_research_plans WHERE user_id=$1',[uid])).rows[0].n);
 try {
  const health=await fetch(s.config.base+'/health');
  assert.match(health.headers.get('cache-control')??'',/no-store/,'deployment health must never return a cached commit');
  await t.test('planning reads real owned contacts and stops for confirmation',async()=>{
   const plan=await api('/command',{message:'Create a research plan for Mira Research QA for the launch.'});
   assert.equal(plan.action.name,'create_marketing_research_plan');assert.equal(plan.task.status,'review');assert.equal(await count(),0);
   assert.match(plan.action.args.contacts,/Mira Research QA/,'review must show contacts resolved by the server');assert(!plan.action.args.contacts.includes('Forged'),'model-supplied contact labels cannot reach review');
   const route='/tasks/'+plan.task.id+'/actions/'+plan.action.id+'/execute';
   assert.equal((await api(route,{})).ok,true);assert.equal((await api(route,{})).ok,true);assert.equal(await count(),1,'confirmation replay cannot create another plan');
   const continuation=await api('/tasks/'+plan.task.id+'/continue',{});assert.match(continuation.answer,/saved in Interlink/);
  });
  await t.test('a contact from another workspace cannot enter the plan',async()=>{
   phase=0;selected=other.id;
   await api('/command',{message:'Create another research plan for the chosen contact.'},400);
   assert.equal(await count(),1);
  });
  await t.test('an unresolved contact identifier is repaired through owned discovery before review',async()=>{
   let round=0;
   model.geminiGenerateContent=async options=>{
    round++;
    const call=round===1?{name:'create_marketing_research_plan',args:{title:'Recovered research',objective:'Review buying signals.',contactIds:['Mira Research QA']}}:round===2?{name:'read_marketing_workspace',args:{resource:'contacts'}}:{name:'create_marketing_research_plan',args:{title:'Recovered research',objective:'Review buying signals.',contactIds:[contact.id]}};
    if(round===2) assert.match(JSON.stringify(options.contents.at(-1)),/contact|identifier/i,'the invalid proposal must return a repairable tool result');
    return {raw:'',functionCall:call,model:'fixture',latencyMs:1};
   };
   const plan=await api('/command',{message:'Create a research plan for Mira Research QA.'});
   assert.equal(round,3);assert.equal(plan.task.status,'review');assert.deepEqual(plan.action.args.contactIds,[contact.id]);assert.match(plan.action.args.contacts,/Mira Research QA/);
   assert.equal(await count(),1,'repairing a proposal must never save or execute it');
  });
  await t.test('the assistant can inspect owned follow-ups and content without inventing their status',async()=>{
   const leads=s.load('services/professional/marketing/leads.service.js');
   const content=s.load('services/professional/marketing/content.service.js');
   const own=await leads.createMarketingFollowup(uid,{contactId:contact.id,title:'Review launch fit',dueAt:new Date(Date.now()+86400000)});
   const foreign=await leads.createMarketingFollowup(s.config.otherUserId,{contactId:other.id,title:'Private next step',dueAt:new Date()});
   const draft=await content.createMarketingContent(uid,{title:'Launch draft',channel:'facebook',body:'A'.repeat(3000)});
   const privateDraft=await content.createMarketingContent(s.config.otherUserId,{title:'Private draft',channel:'facebook',body:'Private'});
   const read=s.load('services/professional/marketing/assistant-workflow.service.js').readMarketingWorkspace;
   const followups=(await read(uid,{resource:'followups'})).data.records;
   assert.ok(followups.some(row=>row.id===own.id&&row.status==='open'));
   assert.ok(!followups.some(row=>row.id===foreign.id));
   const drafts=(await read(uid,{resource:'content'})).data.records;
   assert.ok(drafts.some(row=>row.id===draft.id&&row.status==='draft'&&row.body.length===2000));
   assert.ok(!drafts.some(row=>row.id===privateDraft.id));
  });
 } finally {await s.close()}
});
