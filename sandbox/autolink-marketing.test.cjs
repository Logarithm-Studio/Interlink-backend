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
  assert.match(options.system, /Campaign delivery and content publication have independent lifecycles/);
  assert.match(options.system, /Do not ask for confirmation in prose/);
  assert.match(options.system, /Without verified evidence, never write/);
  assert.match(options.tools.find(tool=>tool.name==='create_marketing_content').description,/80-150 words/);
  assert(options.tools.some(tool=>tool.name==='read_marketing_workspace'));
  assert(options.tools.some(tool=>tool.name==='create_marketing_research_plan'));
  const call = phase++===0 ? {name:'read_marketing_workspace',args:{resource:'contacts'}} : phase===2 ? {name:'create_marketing_research_plan',args:{title:'Reviewed launch research',objective:'Confirm buying signals and prepare a reviewed outreach plan.',contactIds:[selected],contacts:'Forged contact label'}} : undefined;
  return {raw:'',functionCall:call??{name:'complete_professional_task',args:{answer:'Your reviewed research plan is saved in Interlink. No external copy was made.'}},model:'fixture',latencyMs:1};
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
  await t.test('native Notion and Todoist delegation uses separate owned, fingerprint-bound reviews',async()=>{
   await s.connectNative(uid,'notion');await s.connectNative(uid,'todoist');
   const plans=s.load('services/professional/marketing/research-plan.service.js');
   const saved=await plans.createResearchPlan(uid,{title:'Agent delegation QA',objective:'Review the launch audience.',contactIds:[contact.id]});
   const foreign=await plans.createResearchPlan(s.config.otherUserId,{title:'Private plan',objective:'Private',contactIds:[other.id]});
   let round=0;
   model.geminiGenerateContent=async options=>{
    if(round<2)assert(!options.tools.some(tool=>['create_todoist_task','create_notion_note','create_trello_card'].includes(tool.name)),'Pending research exports must use durable receipts');
    else if(round<4)assert(!options.tools.some(tool=>tool.name==='create_todoist_task'),'Todoist must retain its native export review until confirmed');
    const calls=[{name:'read_marketing_destinations',args:{provider:'notion',query:'Sandbox'}},{name:'export_marketing_research_plan',args:{planId:saved.id,provider:'notion',destinationId:'sandbox-parent',query:'Sandbox',destination:'Forged destination',fingerprint:'forged'}},{name:'read_marketing_destinations',args:{provider:'todoist'}},{name:'export_marketing_research_plan',args:{planId:saved.id,provider:'todoist',destinationId:'sandbox-project',contacts:'Forged contacts'}}];
    return{raw:'',functionCall:calls[round++]??{name:'complete_professional_task',args:{answer:'Both reviewed copies are saved.'}},model:'fixture',latencyMs:1};
   };
   const first=await api('/command',{message:'Export research plan Agent delegation QA to Notion Sandbox workspace, then delegate it to Todoist Sandbox marketing.'});
   assert.equal(first.action?.name,'export_marketing_research_plan','The native reviewed export tool must be available');
   assert.match(first.action.args.destination,/Sandbox workspace/);assert(!first.action.args.destination.includes('Forged'));
   assert.match(first.action.args.contacts,/Mira Research QA/);assert.equal(first.action.args.fingerprint,(await plans.previewResearchPlan(uid,saved.id)).fingerprint);
   assert.equal(s.marketing.pages.size,0);assert.equal(s.marketing.tasks.size,0,'Discovery and proposals must never export');
   const route='/tasks/'+first.task.id+'/actions/'+first.action.id+'/execute';
   assert.equal((await api(route,{})).ok,true);await api(route,{});assert.equal(s.marketing.pages.size,1);
   const next=await api('/tasks/'+first.task.id+'/continue',{});
   assert.equal(next.action.name,'export_marketing_research_plan');assert.equal(next.action.args.provider,'todoist');assert.match(next.action.args.destination,/Sandbox marketing/);
   assert.equal(s.marketing.tasks.size,0,'The second provider needs its own confirmation');
   const secondRoute='/tasks/'+first.task.id+'/actions/'+next.action.id+'/execute';
   assert.equal((await api(secondRoute,{})).ok,true);await api(secondRoute,{});assert.equal(s.marketing.tasks.size,1);
   const done=await api('/tasks/'+first.task.id+'/continue',{});assert.equal(done.task.status,'answered');
   assert.equal((await plans.listResearchExports(uid,saved.id)).filter(row=>row.status==='synced').length,2);
   model.geminiGenerateContent=async()=>({raw:'',functionCall:{name:'export_marketing_research_plan',args:{planId:foreign.id,provider:'notion',destinationId:'sandbox-parent'}},model:'fixture',latencyMs:1});
   await api('/command',{message:'Export the chosen research plan.'},404);assert.equal(s.marketing.pages.size,1);
   model.geminiGenerateContent=async()=>({raw:'',functionCall:{name:'export_marketing_research_plan',args:{planId:saved.id,provider:'notion',destinationId:'sandbox-parent'}},model:'fixture',latencyMs:1});
   const stale=await api('/command',{message:'Export Agent delegation QA to Notion.'});
   await contacts.updateContact(uid,contact.id,{company:'Changed after review'});
   const rejected=await api('/tasks/'+stale.task.id+'/actions/'+stale.action.id+'/execute',{});
   assert.equal(rejected.ok,false);assert.equal(s.marketing.pages.size,1,'A changed shortlist must not export from old review');
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
  await t.test('research export scope preserves unrelated tools and releases generic tools after a confirmed export',async()=>{
   const plans=s.load('services/professional/marketing/research-plan.service.js');
   const saved=await plans.createResearchPlan(uid,{title:'Mixed workflow QA',objective:'Review the launch.',contactIds:[contact.id]});
   let round=0;
   model.geminiGenerateContent=async options=>{
    assert(options.tools.some(tool=>tool.name==='schedule_meet'),'Research scope must preserve Calendar for mixed goals');
    assert(options.tools.some(tool=>tool.name==='create_google_task'),'Research scope must preserve unrelated task systems');
    if(round++===0){
     assert(!options.tools.some(tool=>tool.name==='create_notion_note'),'The pending Notion export must use its native receipt');
     return {raw:'',functionCall:{name:'export_marketing_research_plan',args:{planId:saved.id,provider:'notion',destinationId:'sandbox-parent'}},model:'fixture',latencyMs:1};
    }
    assert(options.tools.some(tool=>tool.name==='create_notion_note'),'After the export, a separately requested note must be available');
    return {raw:'',functionCall:{name:'schedule_meet',args:{title:'Review export',startTime:'2026-11-08T10:00:00',endTime:'2026-11-08T10:30:00',timeZone:'Asia/Dhaka'}},model:'fixture',latencyMs:1};
   };
   const first=await api('/command',{message:'Export research plan Mixed workflow QA to Notion Sandbox workspace, then schedule a Calendar review and create a separate Notion meeting note.'});
   assert.equal(first.action.name,'export_marketing_research_plan');
   assert.equal((await api('/tasks/'+first.task.id+'/actions/'+first.action.id+'/execute',{})).ok,true);
   const next=await api('/tasks/'+first.task.id+'/continue',{});
   assert.equal(next.action.name,'schedule_meet');assert.equal(next.task.status,'review');
   assert.equal(next.task.steps.filter(step=>step.status==='succeeded').length,1,'Calendar still requires its own review');
  });
  await t.test('older contacts and research plans remain discoverable by search, ID and pagination',async()=>{
   const read=s.load('services/professional/marketing/assistant-workflow.service.js').readMarketingWorkspace;
   const plans=s.load('services/professional/marketing/research-plan.service.js');
   const target=await plans.createResearchPlan(uid,{title:'Older 100% launch',objective:'Find this exact owned plan.',contactIds:[contact.id]});
   for(let i=0;i<55;i++){
    await contacts.createContact(uid,{name:'Recent prospect '+i,email:'recent'+i+'@sandbox.invalid'});
    await plans.createResearchPlan(uid,{title:'Recent plan '+i,objective:'Newer fixture.',contactIds:[contact.id]});
   }
   const match=(await read(uid,{resource:'contacts',query:'Mira Research QA'})).data;
   assert.equal(match.records.length,1);assert.equal(match.records[0].id,contact.id);
   const found=(await read(uid,{resource:'research_plans',query:'100% launch'})).data;
   assert.deepEqual(found.records.map(row=>row.id),[target.id]);
   assert.deepEqual((await read(uid,{resource:'research_plans',recordId:target.id})).data.records.map(row=>row.id),[target.id]);
   assert.equal((await read(uid,{resource:'contacts',recordId:other.id})).data.records.length,0,'Exact IDs must remain owner scoped');
   await s.db.query("UPDATE sales_contacts SET created_at='2026-11-07T12:34:56.123456Z' WHERE user_id=$1",[uid]);
   const first=(await read(uid,{resource:'contacts'})).data, second=(await read(uid,{resource:'contacts',cursor:first.nextCursor})).data;
   assert.equal(first.hasMore,true);assert.equal(first.records.length,25);assert.equal(second.records.length,25);
   assert(!first.records.some(row=>second.records.some(next=>row.id===next.id)),'Pages must be stable and disjoint');
   assert.equal((await read(uid,{resource:'research_plans',query:'%'})).data.records.length,1,'Search treats percent as literal text');
   await assert.rejects(read(uid,{resource:'contacts',recordId:'not-a-uuid'}),/UUID|uuid/);
  });
  await t.test('independent planning context loads overlap rather than serializing provider latency',async()=>{
   const vertical=s.load('services/professional/registry.js').getVertical('sales');
   const personal=s.load('services/personal-assistant/personal-assistant.service.js');
   const composio=s.load('services/composio/composio.service.js');
   const original=[vertical.buildSnapshot,personal.connectedAppsSummary,composio.getComposioToolsForUser];
   const started=new Set();let release,allStarted;
   const gate=new Promise(resolve=>{release=resolve}), ready=new Promise(resolve=>{allStarted=resolve});
   const load=async(name,value)=>{started.add(name);if(started.size===3)allStarted();await gate;return value};
   vertical.buildSnapshot=()=>load('snapshot','Owned fixture snapshot.');
   personal.connectedAppsSummary=()=>load('connections','Connected apps: none.');
   composio.getComposioToolsForUser=()=>load('tools',[]);
   model.geminiGenerateContent=async()=>({raw:'Context loaded.',model:'fixture',latencyMs:1});
   const pending=api('/command',{message:'Summarize my workspace.'});
   let timer;
   try{
    await Promise.race([ready,new Promise(resolve=>{timer=setTimeout(resolve,300)})]);
    assert.equal(started.size,3,'A slow snapshot must not delay connection or tool discovery');
   }finally{
    clearTimeout(timer);release();await pending;
    [vertical.buildSnapshot,personal.connectedAppsSummary,composio.getComposioToolsForUser]=original;
   }
  });
 } finally {await s.close()}
});
