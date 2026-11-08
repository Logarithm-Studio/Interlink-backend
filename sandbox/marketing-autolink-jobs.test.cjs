const test=require('node:test'),assert=require('node:assert/strict');
const {startSandbox}=require('./runtime.cjs');
test('Marketing customer jobs reuse the owned CRM, research, content and follow-up workflows',async t=>{
 const s=await startSandbox({port:4350}),uid=s.config.userId,load=s.load;
 const marketing=load('services/professional/marketing/assistant-workflow.service.js'),model=load('services/ai/geminiClient.js');
 const api=async(route,body)=>{const r=await fetch(s.config.base+'/api/v1/accountant/assistant'+route,{method:'POST',headers:{Authorization:'Bearer '+s.config.token,'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data};
 const call=(name,args)=>({raw:'',functionCall:{name,args},model:'fixture',latencyMs:1});
 let crmReads=0;
 load('services/composio/composio.service.js').executeComposioTool=async(_uid,name)=>{assert.equal(name,'HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA');crmReads++;return{ok:true,message:'CRM source returned one match',data:{results:[{id:'crm-prospect-73',properties:{firstname:'Customer',lastname:'Prospect',email:'customer-prospect@sandbox.invalid',company:'Source Studio',jobtitle:'Founder'}}]}}};
 model.isGeminiLive=()=>true;
 try{
  await t.test('the core customer workflows are available to Marketing Autolink',()=>{
   const names=marketing.MARKETING_TOOLS.map(x=>x.name);for(const name of ['search_marketing_prospects','read_marketing_performance','import_marketing_prospect','create_marketing_followup','create_marketing_content'])assert(names.includes(name),name+' must be available without connector guessing');
  });
  for(const attached of [false,true])await t.test('CRM -> reviewed import -> research -> draft content -> local follow-up '+(attached?'with source file':'without attachment'),async()=>{
   const suffix=attached?' attached':'',file=attached?{attachmentName:'customer-brief.txt',attachmentMimeType:'text/plain',attachmentBase64:Buffer.from('Actual customer brief CP-73: help founders evaluate retry-safe software. No outreach authorization.').toString('base64')}:{};
   let turn=0,preview;
   model.geminiGenerateContent=async options=>{
    if(++turn===1)return call('search_marketing_prospects',{provider:'hubspot',query:'Customer Prospect'});
    preview=options.contents.at(-1).parts.find(x=>x.functionResponse?.name==='search_marketing_prospects').functionResponse.response.data.prospects[0];
    return call('import_marketing_prospect',{importToken:preview.importToken});
   };
   let plan=await api('/command',{message:'Find Customer Prospect in HubSpot and import that exact result, save a research plan, a LinkedIn draft and one local follow-up for 2030-12-01T10:00:00+06:00. Review each change; do not send or publish.',...file});
   assert.equal(plan.action.name,'import_marketing_prospect');assert.equal(plan.action.args.contactName,'Customer Prospect');assert.match(plan.action.args.marketingPermission,/Not granted/);
   let result=await api('/tasks/'+plan.task.id+'/actions/'+plan.action.id+'/execute',{});
   assert.equal(result.ok,true);const contact=result.data.contact;assert.equal(contact.marketingOptIn,false);
   const taskId=plan.task.id;
   for(const[name,args]of[
    ['create_marketing_research_plan',{title:'Customer research'+suffix,objective:'CP-73: validate retry-safe software needs without outreach.',contactIds:[contact.id]}],
    ['create_marketing_content',{title:'Customer launch draft'+suffix,channel:'linkedin',body:'CP-73: How retry-safe software helps founders avoid duplicate work.',status:'published',scheduledAt:'2030-12-01T10:00:00Z'}],
    ['create_marketing_followup',{contactId:contact.id,title:'Review customer research'+suffix,dueAt:'2030-12-01T10:00:00+06:00',notes:'Review the CP-73 research and draft before any outreach.'}],
   ]){
    model.geminiGenerateContent=async()=>call(name,args);
    plan=await api('/tasks/'+taskId+'/continue',file);assert.equal(plan.action.name,name);
    result=await api('/tasks/'+taskId+'/actions/'+plan.action.id+'/execute',{});assert.equal(result.ok,true,JSON.stringify(result));
    if(name==='create_marketing_content'){assert.equal(result.data.status,'draft');assert.equal(result.data.providerItemId,null);assert.equal(result.data.scheduledAt,null);assert.match(result.data.body,/CP-73/)}
    if(name==='create_marketing_followup'){assert.equal(result.data.contactId,contact.id);assert.equal(result.data.todoistTaskId,null);assert.equal(new Date(result.data.dueAt).toISOString(),'2030-12-01T04:00:00.000Z')}
   }
   const before=(await s.db.query('SELECT count(*)::int AS n FROM sales_marketing_followups WHERE user_id=$1',[uid])).rows[0].n;
   assert.equal((await api('/tasks/'+taskId+'/actions/'+plan.action.id+'/execute',{})).ok,true);
   assert.equal((await s.db.query('SELECT count(*)::int AS n FROM sales_marketing_followups WHERE user_id=$1',[uid])).rows[0].n,before);
   model.geminiGenerateContent=async()=>call('complete_professional_task',{answer:'Saved the exact imported contact, research, content draft and local follow-up. No outreach or publication occurred.'});
   assert.equal((await api('/tasks/'+taskId+'/continue',file)).task.status,'answered');
   await assert.rejects(marketing.reviewMarketingWorkAction(s.config.otherUserId,'import_marketing_prospect',{importToken:preview.importToken}),/expired|changed/);
  });
  await t.test('invalid records, dates and empty copy cannot become reviewed writes',async()=>{
   const sales=load('services/professional/sales/sales.service.js'),foreign=await sales.createContact(s.config.otherUserId,{name:'Foreign Marketing contact'});
   for(const[name,args]of[['create_marketing_followup',{contactId:foreign.id,title:'Must not save',dueAt:'2030-12-01T10:00:00Z'}],['create_marketing_followup',{contactId:foreign.id,title:'Past date',dueAt:'2020-01-01T10:00:00Z'}],['create_marketing_content',{title:'Empty copy',channel:'linkedin',body:' '}],['import_marketing_prospect',{importToken:'changed-token'}]]){
    const result=await marketing.executeMarketingWorkAction(uid,name,args);assert.equal(result.ok,false,name);
   }
  });
  assert.equal(crmReads,2);
  await t.test('performance answers expose actual source dates and keep unsynced metrics unavailable',async()=>{
   const row=(await s.db.query("INSERT INTO sales_marketing_campaigns(user_id,topic,subject,body) VALUES($1,'Customer results','Customer subject','Source copy') RETURNING id",[uid])).rows[0];
   const result=await marketing.readMarketingPerformance(uid,{campaignId:row.id});assert.equal(result.data.campaigns.length,1);assert.match(result.data.campaigns[0].email.providerMetrics,/Unavailable/);assert.equal(result.data.campaigns[0].email.uniqueOpens,undefined);assert.equal(result.data.workspaceTotals,undefined);
   await assert.rejects(marketing.readMarketingPerformance(s.config.otherUserId,{campaignId:row.id}),/Choose a campaign/);
  });
 }finally{await s.close()}
});
