const test=require('node:test'),assert=require('node:assert/strict');
const {startSandbox}=require('./runtime.cjs');

test('Professional record discovery, ambiguity, evidence failures and partial writes',async t=>{
 const s=await startSandbox({port:4348}),uid=s.config.userId,load=s.load,user={id:uid,email:s.config.email};
 try{
  const support=load('services/professional/support/support.service.js'),hr=load('services/professional/hr/hr.vertical.js'),re=load('services/professional/realestate/realestate.service.js'),sales=load('services/professional/sales/sales.service.js');
  const records=load('services/professional/assistant-records.service.js');
  await t.test('property showings reject missing offsets before review and listings retain supplied floor area',async()=>{
   await assert.rejects(re.realEstateVertical.reviewAction(uid,'schedule_showing',{address:'Review time QA',when:'2030-12-01T15:00:00'}),/offset/);
   const reviewed=await re.realEstateVertical.reviewAction(uid,'schedule_showing',{address:'Review time QA',when:'2030-12-01T15:00:00+06:00'});assert.equal(reviewed.when,'2030-12-01T15:00:00+06:00');
   const listing=await re.realEstateVertical.executeTool(user,'create_listing',{address:'Floor area QA',priceCents:18000000,beds:3,baths:2,sqft:1200});assert.equal(listing.ok,true);assert.equal(listing.data.sqft,1200);
   const unsupported=await re.realEstateVertical.executeTool(user,'create_listing',{address:'Unsupported currency QA',priceCents:8235,currency:'BDT'});assert.equal(unsupported.ok,false);assert.equal((await re.listListings(uid)).filter(x=>x.address==='Unsupported currency QA').length,0);
   await assert.rejects(re.createListing(uid,{address:'Unsupported form currency QA',priceCents:8235,currency:'BDT'}),/USD only/);
  });
  await t.test('unsent Sales HR and Support copy is returned without a write approval or record mutation',async()=>{
   const contact=await sales.createContact(uid,{name:'Read draft customer',email:'draft-customer@sandbox.invalid'}),candidate=await hr.createCandidate(uid,{name:'Read draft candidate',email:'draft-candidate@sandbox.invalid',role:'Engineer'}),ticket=await support.createTicket(uid,{subject:'Read draft ticket',body:'Please investigate duplicate entries.',customerEmail:'draft-support@sandbox.invalid'});
   const model=load('services/ai/geminiClient.js'),original={generate:model.geminiGenerateContent,live:model.isGeminiLive};
   try{
    model.isGeminiLive=()=>true;
    for(const[persona,name,args,email]of[['sales','draft_followup',{contactId:contact.id},contact.email],['hr','draft_outreach',{candidateId:candidate.id},candidate.email],['customer_support','draft_reply',{ticketId:ticket.id},ticket.customerEmail]]){
     await s.db.query("UPDATE profession_profiles SET persona=$2 WHERE user_id=$1 AND mode='professional'",[uid,persona]);
     model.geminiGenerateContent=async input=>{if(input.json&&persona==='customer_support')assert.match(input.system,/Do not claim an investigation has started/);if(input.json)return{raw:JSON.stringify({subject:'Source-backed copy',body:'Actual requested unsent draft.'}),model:'fixture',latencyMs:1};const response=input.contents.flatMap(x=>x.parts).find(x=>x.functionResponse?.name===name);return response?{raw:'',functionCall:{name:'complete_professional_task',args:{answer:JSON.stringify(response.functionResponse.response.data)}},model:'fixture',latencyMs:1}:{raw:'',functionCall:{name,args},model:'fixture',latencyMs:1}};
     const result=await load('services/accountant/assistant.service.js').command(uid,'Draft the requested reply in this chat only. Do not send.');assert.equal(result.action,null);assert.equal(result.task,undefined);assert.match(result.answer,/Actual requested unsent draft/);assert(result.answer.includes(email));
    }
    assert.equal((await hr.listCandidates(uid)).find(x=>x.id===candidate.id).stage,'applied');assert.equal((await support.listTickets(uid)).find(x=>x.id===ticket.id).status,'open');assert.equal((await s.db.query('SELECT count(*)::int AS n FROM email_drafts WHERE user_id=$1',[uid])).rows[0].n,0);
   }finally{model.geminiGenerateContent=original.generate;model.isGeminiLive=original.live;await s.db.query("UPDATE profession_profiles SET persona='sales' WHERE user_id=$1 AND mode='professional'",[uid]);await s.db.query('DELETE FROM support_tickets WHERE id=$1 AND user_id=$2',[ticket.id,uid]);await s.db.query('DELETE FROM hr_candidates WHERE id=$1 AND user_id=$2',[candidate.id,uid]);await s.db.query('DELETE FROM sales_contacts WHERE id=$1 AND user_id=$2',[contact.id,uid])}
  });
  await t.test('an interview result retains a newer candidate stage and reports the actual calendar result',async()=>{
   const candidate=await hr.createCandidate(uid,{name:'Interview concurrency QA',email:'candidate@sandbox.invalid',role:'Engineer'});
   const calendar=load('services/hr/calendar-hr.service.js'),original=calendar.scheduleInterview;
   let invitations=0;calendar.scheduleInterview=async()=>{invitations++;await hr.updateCandidate(uid,candidate.id,{stage:'hired'});return{id:'confirmed-interview-qa',summary:'Confirmed calendar interview',htmlLink:'https://example.invalid/calendar/qa'}};
   try{
    const args=await hr.hrVertical.reviewAction(uid,'schedule_interview',{candidateId:candidate.id,interviewerEmail:'interviewer@sandbox.invalid',startTime:'2030-12-01T10:00:00+06:00',endTime:'2030-12-01T10:30:00+06:00'});
    const result=await hr.hrVertical.executeTool(user,'schedule_interview',args);
    assert.equal(result.ok,true);assert.equal(invitations,1);assert.equal((await hr.listCandidates(uid)).find(x=>x.id===candidate.id).stage,'hired');assert.equal(result.data.eventId,'confirmed-interview-qa');assert.match(result.message,/stage.*changed|stage.*retained/i);
   }finally{calendar.scheduleInterview=original}
  });
  await t.test('paired messages with the same timestamp retain causal order in model history',async()=>{
   const model=load('services/ai/geminiClient.js'),original={generate:model.geminiGenerateContent,live:model.isGeminiLive};
   const conv=(await s.db.query("INSERT INTO accountant_conversations(user_id,title) VALUES($1,'History ordering QA') RETURNING id",[uid])).rows[0].id;
   await s.db.query("INSERT INTO accountant_chat_messages(user_id,conversation_id,role,content,created_at) VALUES($1,$2,'user','Old support request','2020-01-01T00:00:00Z'),($1,$2,'assistant','Old support answer','2020-01-01T00:00:00Z')",[uid,conv]);
   let contents;
   try{
    model.isGeminiLive=()=>true;model.geminiGenerateContent=async input=>{contents=input.contents;return{raw:'',functionCall:{name:'complete_professional_task',args:{answer:'New Marketing answer'}},model:'fixture',latencyMs:1}};
    await load('services/accountant/assistant.service.js').command(uid,'New Marketing request',conv);
    assert.deepEqual(contents.slice(0,2).map(x=>[x.role,x.parts[0].text]),[['user','Old support request'],['model','Old support answer']]);
    assert.match(contents.at(-1).parts.at(-1).text,/New Marketing request/);
   }finally{model.geminiGenerateContent=original.generate;model.isGeminiLive=original.live}
  });
  await t.test('every record resource is owner scoped and supports bounded SQL discovery',async()=>{
   const privateTicket=await support.createTicket(s.config.otherUserId,{subject:'Private boundary QA'});
   for(const resource of records.PROFESSIONAL_RECORD_TOOL.parameters.properties.resource.enum){
    const read=await records.readProfessionalRecords(uid,{resource,recordId:privateTicket.id});assert.deepEqual(read.data.records,[]);
   }
   const oldest=await support.createTicket(uid,{subject:'Exact %_ boundary QA'});
   await s.db.query("UPDATE support_tickets SET created_at='2020-01-01T00:00:00.000001Z' WHERE id=$1",[oldest.id]);
   for(let i=0;i<31;i++)await support.createTicket(uid,{subject:'Recent boundary QA '+i});
   const found=await records.readProfessionalRecords(uid,{resource:'tickets',query:'%_'});assert.equal(found.data.records.length,1);assert.equal(found.data.records[0].id,oldest.id);
   const first=(await records.readProfessionalRecords(uid,{resource:'tickets'})).data;
   const second=(await records.readProfessionalRecords(uid,{resource:'tickets',cursor:first.nextCursor})).data;
   assert.equal(first.records.length,25);assert(first.hasMore);assert.equal(new Set([...first.records,...second.records].map(x=>x.id)).size,32);
  });
  await t.test('duplicate candidate names require exact owned IDs, including during execution',async()=>{
   const a=await hr.createCandidate(uid,{name:'Duplicate candidate QA'}),b=await hr.createCandidate(uid,{name:'Duplicate candidate QA'}),foreign=await hr.createCandidate(s.config.otherUserId,{name:'Foreign candidate QA'});
   assert.equal((await hr.hrVertical.executeTool(user,'advance_candidate',{name:a.name,stage:'offer'})).ok,false);
   assert.equal((await hr.hrVertical.executeTool(user,'advance_candidate',{candidateId:foreign.id,stage:'offer'})).ok,false);
   assert.equal((await hr.hrVertical.executeTool(user,'advance_candidate',{candidateId:a.id,stage:'offer'})).ok,true);
   assert.equal((await hr.listCandidates(uid)).find(x=>x.id===b.id).stage,'applied');
  });
  await t.test('missing and malformed screening evidence never become a default score',async()=>{
   const missing=await hr.createCandidate(uid,{name:'Missing resume QA',role:'Engineer'});
   const badScore=await hr.createCandidate(uid,{name:'Malformed score QA',role:'Engineer',resumeText:'Actual resume text.'});
   const model=load('services/ai/geminiClient.js');model.isGeminiLive=()=>true;model.geminiGenerateContent=async()=>({raw:'{"score":null}',model:'fixture',latencyMs:1});
   for(const candidate of [missing,badScore])assert.equal((await hr.hrVertical.executeTool(user,'screen_resume',{candidateId:candidate.id})).ok,false);
   assert((await hr.listCandidates(uid)).filter(x=>[missing.id,badScore.id].includes(x.id)).every(x=>x.score===null&&x.stage==='applied'));
  });
  await t.test('fallback drafts cannot send email, change support status or publish listings',async()=>{
   let sends=0;load('services/professional/email.js').sendProfessionalEmail=async()=>{sends++;throw Error('Unexpected send')};
   load('services/professional/draft.js').draftEmail=async()=>({subject:'Fallback',body:'Fallback',isFallback:true});
   const ticket=await support.createTicket(uid,{subject:'Draft boundary QA',customerEmail:'customer@sandbox.invalid'}),candidate=await hr.createCandidate(uid,{name:'Draft candidate QA',email:'candidate@sandbox.invalid'}),listing=await re.createListing(uid,{address:'Draft listing QA'}),lead=await re.createLead(uid,{name:'Draft buyer QA',email:'buyer@sandbox.invalid'});
   assert.equal((await support.supportVertical.executeTool(user,'draft_reply',{ticketId:ticket.id})).ok,false);
   assert.equal((await hr.hrVertical.executeTool(user,'draft_outreach',{candidateId:candidate.id})).ok,false);
   assert.equal((await re.realEstateVertical.executeTool(user,'draft_listing_description',{listingId:listing.id})).ok,false);
   assert.equal((await re.realEstateVertical.executeTool(user,'send_listing_to_buyer',{listingId:listing.id,leadId:lead.id})).ok,false);
   assert.equal(sends,0);assert.equal((await support.listTickets(uid)).find(x=>x.id===ticket.id).status,'open');assert.equal((await re.listListings(uid)).find(x=>x.id===listing.id).shareSlug,null);
  });
  await t.test('screening uses the supplied job requirements and explains the fit',async()=>{
   const model=load('services/ai/geminiClient.js'),candidate=await hr.createCandidate(uid,{name:'Job requirements QA',role:'Engineer',resumeText:'Three years TypeScript and PostgreSQL; no Rust production experience.'});
   const jobDescription='Must have five years of production Rust and distributed systems experience.';let submitted='';
   model.isGeminiLive=()=>true;model.geminiGenerateContent=async options=>{submitted=JSON.stringify(options.parts);return{raw:JSON.stringify({score:25,summary:'The supplied resume does not show the required production Rust experience.',matches:['Backend development'],gaps:['Five years of production Rust']})}};
   const result=await hr.hrVertical.executeTool(user,'screen_resume',{candidateId:candidate.id,jobDescription});
   assert.equal(result.ok,true);assert(submitted.includes(jobDescription),'The screening model must receive the actual supplied job requirements.');assert.match(result.message,/Rust/);assert.equal(result.data.jobDescription,jobDescription);
  });
  await t.test('real estate rejects ambiguous or foreign records, invented dates and invalid amounts',async()=>{
   const a=await re.createListing(uid,{address:'Duplicate address QA'});await re.createListing(uid,{address:a.address});
   const foreign=await re.createListing(s.config.otherUserId,{address:'Foreign listing QA'});
   for(const args of [{address:a.address},{listingId:foreign.id},{}])assert.equal((await re.realEstateVertical.executeTool(user,'publish_listing',args)).ok,false);
   for(const when of ['tomorrow','2020-01-01T10:00:00Z','2030-01-01T10:00:00'])assert.equal((await re.realEstateVertical.executeTool(user,'schedule_showing',{address:a.address,when})).ok,false);
   assert.equal((await re.realEstateVertical.executeTool(user,'transaction_tasks',{property:a.address})).ok,false);
   assert.equal((await re.realEstateVertical.executeTool(user,'create_listing',{address:'Invalid amount QA',priceCents:-1})).ok,false);
  });
  await t.test('Trello ambiguity stops before writes and partial failures retain actual counts',async()=>{
   load('services/integrations/tokenStore.js').isConnected=async()=>true;
   const trello=load('services/pm/trello.service.js'),integration=load('services/professional/sales/integrations.js');let writes=0;
   trello.getBoards=async()=>[{id:'a',name:'A'},{id:'b',name:'B'}];trello.createCard=async()=>{writes++;return{id:'card'}};
   assert.equal((await integration.syncPipelineToTrello(user)).ok,false);assert.equal(writes,0);
   trello.getBoards=async()=>[{id:'a',name:'A'}];trello.getListsForBoard=async()=>[{id:'lead-list',name:'lead'}];trello.getCardsForBoard=async()=>[];
   await sales.createDeal(uid,{title:'Partial sync one'});await sales.createDeal(uid,{title:'Partial sync two'});
   trello.createCard=async()=>{if(++writes===2)throw Error('Controlled provider rejection');return{id:'first-card'}};
   const partial=await integration.syncPipelineToTrello(user,'a');assert.equal(partial.ok,false);assert.equal(partial.data.created,1);assert.equal(partial.data.failedDealIds.length,1);
  });
  await t.test('PM source ambiguity, offline scope analysis and empty merged history do not invent results',async()=>{
   const pm=load('services/professional/pm/pm.vertical.js'),jira=load('services/jira/jira.service.js'),notion=load('services/notion/notion.service.js'),model=load('services/ai/geminiClient.js');
   jira.getProjects=async()=>[{key:'A'},{key:'B'}];notion.searchPages=async()=>[{id:'a',title:'Duplicate PRD'},{id:'b',title:'Duplicate PRD'}];
   assert.equal((await pm.pmVertical.executeTool(user,'prd_to_tickets',{prdText:'Actual brief.'})).ok,false);
   assert.equal((await pm.pmVertical.executeTool(user,'prd_to_tickets',{notionPageQuery:'Duplicate PRD',projectKey:'A'})).ok,false);
   model.isGeminiLive=()=>false;
   assert.equal((await pm.pmVertical.executeTool(user,'scope_creep_check',{baselineText:'Actual baseline.',amendmentText:'A possible change.'})).ok,false);
   load('services/pm/github.service.js').getMergedPullRequests=async()=>[];
   const release=await pm.pmVertical.executeTool(user,'release_notes',{repo:'fixture/app'});assert.equal(release.ok,false);assert.match(release.message,/No merged pull requests/);
  });
  await t.test('flash reporting never combines currencies and cache keys change with source totals',async()=>{
   const invoices=load('services/accountant/invoices.service.js'),reporting=load('services/accountant/reporting.service.js'),keys=[],contexts=[];
   await invoices.createInvoice(uid,{clientName:'USD reporting QA',currency:'USD',amountCents:9900});
   await invoices.createInvoice(uid,{clientName:'BDT reporting QA',currency:'BDT',amountCents:7304});
   load('services/ai/ai.service.js').generateFlashReport=async input=>{keys.push(input.idempotencyKey);contexts.push(input.context);return{data:{summary:'Source-backed fixture totals.',totals:{outstandingCents:input.context.outstandingCents}},isFallback:false}};
   await assert.rejects(reporting.getFlashReport(uid),/multiple currencies/);
   const report=await reporting.getFlashReport(uid,'BDT');assert.equal(contexts[0].currency,'BDT');assert.equal(contexts[0].outstandingCents,7304);assert.equal(report.currency,'BDT');
   await invoices.createInvoice(uid,{clientName:'Second BDT reporting QA',currency:'BDT',amountCents:12550});
   await reporting.getFlashReport(uid,'BDT');assert.equal(contexts[1].outstandingCents,19854);assert.notEqual(keys[0],keys[1]);
   load('services/ai/ai.service.js').generateFlashReport=async()=>({data:{summary:'Unreliable generated totals',totals:{outstandingCents:999999,overdueCents:1,collectedCents:2,expensesCents:3}},isFallback:false});
   const grounded=await reporting.getFlashReport(uid,'BDT');assert.equal(grounded.report.totals.outstandingCents,19854);assert.equal(grounded.report.totals.collectedCents,0);assert.equal(grounded.report.totals.expensesCents,0);
  });
  await t.test('all failed tax requests are a failure rather than a success with zero sends',async()=>{
   await s.db.query("UPDATE profession_profiles SET persona='finance' WHERE user_id=$1 AND mode='professional'",[uid]);
   const tax=load('services/accountant/tax.service.js');await tax.seedDemoContractors(uid);tax.sendW9Request=async()=>{throw Error('Controlled send failure')};
   const result=await load('services/accountant/assistant.service.js').executeAction(user,'gather_tax_docs',{});assert.equal(result.ok,false);assert.match(result.message,/failed|need review/);
  });
 }finally{await s.close()}
});
