const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {startSandbox}=require('./runtime.cjs');
test('Professional workflow record identity, reviewed copy and task corrections',async t=>{
 const s=await startSandbox({port:4344}),uid=s.config.userId,user={id:uid,email:s.config.email};
 const sales=s.load('services/professional/sales/sales.service.js'),assistant=s.load('services/accountant/assistant.service.js'),tasks=s.load('services/accountant/agent-task.service.js');
 const model=s.load('services/ai/geminiClient.js');model.isGeminiLive=()=>true;
 const api=async(route,body,status=200)=>{const r=await fetch(s.config.base+'/api/v1/accountant/assistant'+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+s.config.token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data};
 try{
  await t.test('professional drafting explicitly stays in chat unless saving or delivery is requested',async()=>{
   await s.db.query("UPDATE profession_profiles SET persona='product_manager' WHERE user_id=$1 AND mode='professional'",[uid]);
   model.geminiGenerateContent=async options=>{
    assert(JSON.stringify(options).includes('return the content in chat'));
    assert(!options.tools.some(tool=>tool.name==='create_notion_note'));
    assert(options.tools.some(tool=>tool.name==='read_professional_tasks'));
    return{raw:'',functionCall:{name:'complete_professional_task',args:{answer:'Acceptance criteria: reject duplicates and queue offline submissions. QA: test successful submission, retries, duplication, permissions and recovery.'}},model:'fixture',latencyMs:1};
   };
   const plan=await api('/command',{message:'Draft acceptance criteria and a QA plan. Include offline retry and duplicate submissions.'});
   assert.equal(plan.action,null);assert.equal(plan.task,undefined);assert.match(plan.answer,/offline/);
   model.geminiGenerateContent=async options=>{
    assert(options.tools.some(tool=>tool.name==='create_notion_note'));
    return{raw:'',functionCall:{name:'create_notion_note',args:{title:'Reviewed QA draft',content:'Offline and duplicate submission criteria.'}},model:'fixture',latencyMs:1};
   };
   const saved=await api('/command',{message:'Draft acceptance criteria then save them to Notion. Do not send messages.'});
   assert.equal(saved.action?.name,'create_notion_note');assert(saved.task);
   await s.db.query("UPDATE profession_profiles SET persona='sales' WHERE user_id=$1 AND mode='professional'",[uid]);
  });
  await t.test('sales creation returns exact record IDs and retains the requested currency',async()=>{
   const contact=await sales.salesVertical.executeTool(user,'create_contact',{name:'Workflow Ada',email:'workflow-ada@sandbox.invalid'});
   assert.equal(contact.ok,true);assert.match(contact.data?.id||'',/^[0-9a-f-]{36}$/);
   const deal=await sales.salesVertical.executeTool(user,'create_deal',{title:'BDT launch',amountCents:2500050,currency:'BDT'});
   assert.equal(deal.ok,true);assert.equal(deal.data?.currency,'BDT');assert.equal((await sales.getDeal(uid,deal.data.id)).amountCents,2500050);
  });
  await t.test('duplicate deal names cannot move an arbitrary opportunity',async()=>{
   const a=await sales.createDeal(uid,{title:'Duplicate launch'}),b=await sales.createDeal(uid,{title:'Duplicate launch'});
   const ambiguous=await sales.salesVertical.executeTool(user,'advance_stage',{dealTitle:'Duplicate launch',stage:'won'});
   assert.equal(ambiguous.ok,false);assert.match(ambiguous.message,/multiple|ambiguous/i);
   assert.equal((await sales.getDeal(uid,a.id)).stage,'lead');assert.equal((await sales.getDeal(uid,b.id)).stage,'lead');
   const exact=await sales.salesVertical.executeTool(user,'advance_stage',{dealId:a.id,stage:'qualified'});
   assert.equal(exact.ok,true,exact.message);assert.equal((await sales.getDeal(uid,a.id)).stage,'qualified');assert.equal((await sales.getDeal(uid,b.id)).stage,'lead');
  });
  await t.test('follow-up drafting exposes the exact copy without sending an unreviewed email',async()=>{
   const c=await sales.createContact(uid,{name:'Copy Review QA',email:'copy-review@sandbox.invalid'});let sends=0;
   s.load('services/professional/draft.js').draftEmail=async()=>({subject:'Review launch fit',body:'The exact proposed follow-up.',isFallback:false});
   s.load('services/professional/email.js').sendProfessionalEmail=async()=>{sends++;return{}};
   const draft=await sales.salesVertical.executeTool(user,'draft_followup',{contactId:c.id,contactName:c.name,note:'Ask about launch fit.'});
   assert.equal(draft.ok,true,draft.message);assert.equal(sends,0);assert.equal(draft.data?.subject,'Review launch fit');assert.equal(draft.data?.body,'The exact proposed follow-up.');assert.equal(draft.data?.toEmail,c.email);
   s.load('services/professional/draft.js').draftEmail=async()=>({subject:'Fallback',body:'Fallback',isFallback:true});
   const unavailable=await sales.salesVertical.executeTool(user,'draft_followup',{contactId:c.id});assert.equal(unavailable.ok,false);assert.equal(sends,0);
  });
  await t.test('changing an unexecuted task preserves the goal and invalidates its old approval',async()=>{
   await s.db.query("UPDATE profession_profiles SET persona='finance' WHERE user_id=$1 AND mode='professional'",[uid]);
   let turn=0;model.geminiGenerateContent=async options=>{
    if(turn===1)assert(JSON.stringify(options.contents).includes('First client'),'Revision must carry the original business goal');
    return{raw:'',functionCall:{name:'create_invoice',args:{clientName:'First client',amount:++turn===1?75:150}},model:'fixture',latencyMs:1};
   };
   const first=await api('/command',{message:'Create an invoice for First client for 75 dollars, then prepare a summary.'});
   const changed=await api('/command',{message:'Change the invoice amount to 150 dollars instead.',conversationId:first.conversationId});
   assert.equal(changed.task.id,first.task.id,'A correction must update the same owned task');
   assert.match(changed.task.goal,/First client/);assert.match(changed.task.goal,/150/);
   await api('/tasks/'+first.task.id+'/actions/'+first.action.id+'/execute',{},409);
   assert.equal((await api('/tasks/'+changed.task.id+'/actions/'+changed.action.id+'/execute',{})).ok,true);
   const invoices=(await s.db.query('SELECT amount_cents FROM invoices WHERE user_id=$1',[uid])).rows;
   assert.equal(invoices.length,1);assert.equal(Number(invoices[0].amount_cents),15000);
  });
  await t.test('the 12-write bound still permits a final verified summary',async()=>{
   const conv=crypto.randomUUID();await s.db.query('INSERT INTO accountant_conversations(id,user_id,title) VALUES($1,$2,$3)',[conv,uid,'Twelve completed steps']);
   const taskId=await tasks.createAgentTask(uid,conv,'Create twelve fixture steps then summarize their confirmed outcomes.');
   for(let i=0;i<12;i++){
    const action={id:crypto.randomUUID(),name:'log_activity',args:{note:'Step '+i},summary:'Step '+i,needsConfirm:true};
    await tasks.saveTaskPlan(uid,taskId,{action,answer:null,conversationId:conv,isLive:true});await tasks.executeTaskProposal(uid,taskId,action.id,async()=>({ok:true,message:'Confirmed '+i}));
   }
   model.geminiGenerateContent=async()=>({raw:'',functionCall:{name:'complete_professional_task',args:{answer:'All twelve recorded steps succeeded.'}},model:'fixture',latencyMs:1});
   const done=await api('/tasks/'+taskId+'/continue',{});assert.equal(done.task.status,'answered');assert.equal(done.task.steps.length,12);
   await assert.rejects(tasks.saveTaskPlan(uid,taskId,{action:{id:crypto.randomUUID(),name:'log_activity',args:{note:'Thirteenth'},summary:'Thirteenth',needsConfirm:true},answer:null,conversationId:conv,isLive:true}),/12|limit/);
  });
  await t.test('linked opportunities, routing and meeting drafts preserve ownership without hidden sends',async()=>{
   let sends=0,meetings=0;
   s.load('services/professional/email.js').sendProfessionalEmail=async()=>{sends++;return{}};
   s.load('services/sales/calendar-sales.service.js').scheduleLeadMeeting=async()=>{meetings++;return{}};
   s.load('services/professional/draft.js').draftEmail=async()=>({subject:'Meeting recap',body:'The reviewed follow-up draft.',isFallback:false});
   const c=await sales.createContact(uid,{name:'Linked workflow QA',email:'linked@sandbox.invalid'}),rep=await sales.createRep(uid,{name:'Exact representative'});
   const opportunity=await sales.salesVertical.executeTool(user,'create_deal',{title:'Linked BDT opportunity',contactId:c.id,currency:'BDT',amountCents:500050});
   assert.equal(opportunity.ok,true,opportunity.message);assert.equal(opportunity.data.contactId,c.id);assert.equal(opportunity.data.currency,'BDT');
   assert.equal(opportunity.data.stage,'qualified');
   const routed=await sales.salesVertical.executeTool(user,'route_lead',{contactId:c.id,repId:rep.id});assert.equal(routed.ok,true,routed.message);
   assert.equal((await s.db.query('SELECT marketing_owner_rep_id FROM sales_contacts WHERE id=$1',[c.id])).rows[0].marketing_owner_rep_id,rep.id);
   assert.equal(meetings,0);assert.equal(sends,0);
   const recap=await sales.salesVertical.executeTool(user,'meeting_followup',{dealId:opportunity.data.id,summary:'Validate fit before outreach.'});assert.equal(recap.ok,true,recap.message);assert.equal(recap.data.status,'draft');
   assert.equal((await sales.getDeal(uid,opportunity.data.id)).stage,'qualified');assert.equal(sends,0);
   await sales.updateContact(uid,c.id,{marketingOptIn:true,marketingOptInSource:'email_request',marketingOptInEvidence:'Controlled QA permission'});
   const reengagement=await sales.salesVertical.executeTool(user,'reengage_deal',{dealId:opportunity.data.id});assert.equal(reengagement.ok,true,reengagement.message);assert.equal(reengagement.data.status,'draft');
   assert.equal((await sales.getDeal(uid,opportunity.data.id)).stage,'qualified');assert.equal(sends,0);
   const agreement=await sales.salesVertical.executeTool(user,'generate_contract',{dealId:opportunity.data.id,requirements:'Deliver reviewed audience research. Payment within 30 days.',signerName:c.name,signerEmail:c.email});
   assert.equal(agreement.ok,true,agreement.message);assert.equal(agreement.data.status,'draft');assert.equal(sends,0);
   const foreign=await sales.createContact(s.config.otherUserId,{name:'Private contact'});
   assert.equal((await sales.salesVertical.executeTool(user,'create_deal',{title:'Forbidden',contactId:foreign.id,currency:'BDT',amountCents:500})).ok,false);
   assert.equal((await sales.salesVertical.executeTool(user,'route_lead',{contactId:foreign.id,repId:rep.id})).ok,false);
  });
  await t.test('mixed-currency snapshots, discovery and finance receipts retain actual units and IDs',async()=>{
   const read=s.load('services/professional/marketing/assistant-workflow.service.js').readMarketingWorkspace;
   const deals=(await read(uid,{resource:'deals',query:'Linked BDT'})).data.records;assert.equal(deals.length,1);assert.equal(deals[0].currency,'BDT');assert(deals[0].contactId);
   const snapshot=await sales.salesVertical.buildSnapshot(uid);assert.match(snapshot,/BDT/);assert(snapshot.includes(deals[0].id));
   const receipt=await assistant.executeAction(user,'create_invoice',{clientName:'BDT invoice QA',amount:1234.50,currency:'BDT'});
   assert.equal(receipt.ok,true,receipt.message);assert.equal(receipt.data.currency,'BDT');assert.equal(Number(receipt.data.amountCents),123450);assert(receipt.data.invoiceId);
   const invoices=s.load('services/accountant/invoices.service.js');
   const local=await invoices.createInvoice(uid,{clientName:'Mixed currency QA',amountCents:2500,currency:'BDT',invoiceNumber:'MIX-BDT'});
   await invoices.createInvoice(uid,{clientName:'Mixed currency QA',amountCents:1000,currency:'USD',invoiceNumber:'MIX-USD'});
   model.geminiGenerateContent=async options=>{
    const context=JSON.stringify(options.contents);assert(context.includes('Mixed currency QA | outstanding 25.00 BDT'));assert(context.includes('Mixed currency QA | outstanding 10.00 USD'));assert(context.includes(local.id));
    return{raw:'Mixed currency QA owes BDT 25 and USD 10 separately. No conversion has been applied.',model:'fixture',latencyMs:1};
   };
   assert.equal((await api('/command',{message:'What does Mixed currency QA owe in each currency?'})).action,null);
  });
  await t.test('ambiguous invoice reminders and stale stage reviews fail before external work',async()=>{
   const invoices=s.load('services/accountant/invoices.service.js');
   await invoices.createInvoice(uid,{clientName:'Two invoices QA',amountCents:1000,invoiceNumber:'AMBIG-A'});await invoices.createInvoice(uid,{clientName:'Two invoices QA',amountCents:2000,invoiceNumber:'AMBIG-B'});
   const reminder=await assistant.executeAction(user,'send_reminder',{clientName:'Two invoices QA'});assert.equal(reminder.ok,false);assert.match(reminder.message,/Multiple unpaid invoices/);
   const deal=await sales.createDeal(uid,{title:'Stale review QA'});
   const reviewed=await sales.reviewSalesAction(uid,'advance_stage',{dealId:deal.id,stage:'won'});assert.equal(reviewed.reviewedStage,'lead');
   await sales.updateDeal(uid,deal.id,{stage:'proposal'});
   const stale=await sales.salesVertical.executeTool(user,'advance_stage',reviewed);assert.equal(stale.ok,false);assert.match(stale.message,/changed after review/);assert.equal((await sales.getDeal(uid,deal.id)).stage,'proposal');
   const race=await Promise.all(['negotiation','nurture'].map(stage=>sales.updateDeal(uid,deal.id,{stage,expectedStage:'proposal'})));
   assert.equal(race.filter(Boolean).length,1,'Concurrent updates must not both overwrite the reviewed stage');
  });
  await t.test('correction outages retain the changed goal and uncertain tasks cannot be rewritten',async()=>{
   model.geminiGenerateContent=async()=>({raw:'',functionCall:{name:'create_invoice',args:{clientName:'Outage client',amount:10}},model:'fixture',latencyMs:1});
   const first=await api('/command',{message:'Create an invoice for Outage client for 10 dollars.'});
   model.geminiGenerateContent=async()=>{throw Error('Controlled revision outage')};
   await api('/command',{message:'Actually use 20 dollars.',conversationId:first.conversationId},503);
   const restored=(await api('/tasks/'+first.task.id)).task;assert.equal(restored.status,'ready');assert.match(restored.goal,/20 dollars/);assert.equal(restored.steps[0].status,'cancelled');
   await s.db.query("UPDATE autolink_tasks SET status='planning',updated_at=now()-interval '3 minutes' WHERE id=$1",[first.task.id]);
   assert.equal((await tasks.getAgentTask(uid,first.task.id)).status,'ready','A crashed revision with no completed writes must release its stale planning lease');
   await api('/tasks/'+first.task.id+'/actions/'+first.action.id+'/execute',{},409);
   await s.db.query("UPDATE autolink_tasks SET status='answered' WHERE id=$1",[first.task.id]);
   const blockedId=await tasks.createAgentTask(uid,first.conversationId,'Uncertain fixture write');
   const action={id:crypto.randomUUID(),name:'create_invoice',args:{clientName:'Uncertain',amount:10},summary:'Uncertain',needsConfirm:true};
   await tasks.saveTaskPlan(uid,blockedId,{action,answer:null,conversationId:first.conversationId,isLive:true});await tasks.executeTaskProposal(uid,blockedId,action.id,async()=>({ok:false,message:'Outcome uncertain.'}));
   await api('/command',{message:'Try it with a different amount.',conversationId:first.conversationId},409);assert.equal((await tasks.getAgentTask(uid,blockedId)).status,'blocked');
  });
  await t.test('relative dates retain their original request clock across midnight',async()=>{
   const original='2026-11-07T17:59:00.000Z';
   model.geminiGenerateContent=async()=>({raw:'',functionCall:{name:'create_invoice',args:{clientName:'Clock QA',amount:10}},model:'fixture',latencyMs:1});
   const first=await api('/command',{message:'Create an invoice for Clock QA then prepare a reminder plan for tomorrow.',clientNow:original,tz:'Asia/Dhaka'});
   await api('/tasks/'+first.task.id+'/actions/'+first.action.id+'/execute',{});
   model.geminiGenerateContent=async options=>{assert(JSON.stringify(options.contents).includes(original));return{raw:'',functionCall:{name:'complete_professional_task',args:{answer:'The confirmed invoice is saved. The requested tomorrow is November 8 in Asia/Dhaka.'}},model:'fixture',latencyMs:1}};
   const done=await api('/tasks/'+first.task.id+'/continue',{clientNow:'2026-11-08T01:00:00.000Z',tz:'Asia/Dhaka'});assert.equal(done.task.status,'answered');
  });
  await t.test('a corrected upload binds the retained file and latest request clock',async()=>{
   const file={data:Buffer.from('Controlled fixture text.').toString('base64'),mimeType:'text/plain',name:'qa.txt'},clock='2026-11-08T02:00:00.000Z';
   model.geminiGenerateContent=async()=>({raw:'',functionCall:{name:'create_invoice',args:{clientName:'File QA',amount:10}},model:'fixture',latencyMs:1});
   const first=await assistant.command(uid,'Create an invoice for File QA for ten dollars.',undefined,file,{clientNow:'2026-11-07T17:59:00.000Z'});
   model.geminiGenerateContent=async()=>({raw:'',functionCall:{name:'upload_to_drive',args:{name:'qa.txt'}},model:'fixture',latencyMs:1});
   const changed=await assistant.command(uid,'Upload the same file to Drive instead.',first.conversationId,file,{clientNow:clock,tz:'Asia/Dhaka'});
   assert.equal(changed.task.id,first.task.id);assert.equal(changed.action.name,'upload_to_drive');
   const context=await tasks.getAgentTaskContext(uid,first.task.id),digest=crypto.createHash('sha256').update(Buffer.from(file.data,'base64')).digest('hex');
   assert.equal(context.clientNow,clock);assert.equal(context.sourceAttachmentDigest,digest);assert.equal(context.attachmentDigest,digest);
   let writes=0;await assert.rejects(tasks.executeTaskProposal(uid,changed.task.id,changed.action.id,async()=>{writes++;return{ok:true,message:'Must not run'}},'different-file'),/same original file/);assert.equal(writes,0);
  });
 }finally{await s.close()}
});
