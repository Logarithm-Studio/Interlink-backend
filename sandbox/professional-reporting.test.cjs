const test=require('node:test'),assert=require('node:assert/strict');
const {startSandbox}=require('./runtime.cjs');

test('Finance reports preserve the selected currency and reviewed destination through every transport',async t=>{
 const s=await startSandbox({port:4351}),uid=s.config.userId,load=s.load;
 const reporting=load('services/accountant/reporting.service.js'),invoices=load('services/accountant/invoices.service.js');
 const api=async(route,body)=>{const r=await fetch(s.config.base+'/api/v1/accountant/reports/'+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+s.config.token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,data:await r.json()}};
 const sent=[];
 try{
  await invoices.createInvoice(uid,{clientName:'BDT report customer',amountCents:8235,currency:'BDT'});await invoices.createInvoice(uid,{clientName:'USD report customer',amountCents:12000,currency:'USD'});await invoices.createInvoice(s.config.otherUserId,{clientName:'Foreign private customer',amountCents:9900,currency:'CAD'});
  load('services/ai/ai.service.js').generateFlashReport=async({context})=>({data:{summary:'Current source-backed report.',totals:{outstandingCents:999999,overdueCents:0,collectedCents:0,expensesCents:0},cashRunwayNote:'Bank balance unavailable.',insights:[],recommendations:[]},isFallback:false});
  load('services/integrations/tokenStore.js').isConnected=async()=>true;
  Object.assign(load('services/slack/slack.service.js'),{getChannels:async()=>[{id:'CQA123',name:'reviewed-finance',isMember:true}],postMessage:async(_uid,channel,text)=>{sent.push({provider:'slack',destination:channel,text});return{ok:true}}});
  Object.assign(load('services/notion/notion.service.js'),{searchPages:async()=>[{id:'notion-parent-qa',title:'Reviewed finance parent'}],createPage:async(_uid,input)=>{sent.push({provider:'notion',destination:input.parentId,text:input.content,title:input.title});return{id:'created-page',url:'https://example.invalid/qa'}}});
  Object.assign(load('services/email/gmail.service.js'),{createGmailDraft:async input=>{sent.push({provider:'email',destination:input.recipients,text:input.body,title:input.subject});return{providerDraftId:'draft-qa'}},sendGmailDraft:async()=>({messageId:'sent-qa'})});
  await t.test('currency choices contain owned book currencies only',async()=>{
   const result=await api('currencies');assert.equal(result.status,200);assert.deepEqual(result.data.currencies,['BDT','USD']);
  });
  await t.test('a selected report uses the actual BDT totals and never combines USD',async()=>{
   const result=await api('flash?currency=BDT');assert.equal(result.status,200);assert.equal(result.data.currency,'BDT');assert.equal(result.data.report.totals.outstandingCents,8235);
   assert.equal((await api('flash')).status,400);assert.equal((await api('flash?currency=12!')).status,400);
  });
  await t.test('missing and unavailable sharing destinations cannot silently select another target',async()=>{
   for(const[route,body]of[['slack',{currency:'BDT'}],['notion',{currency:'BDT'}],['slack',{currency:'BDT',channel:'CUNKNOWN'}],['notion',{currency:'BDT',parentId:'unknown-page'}]]){
    const result=await api('flash/'+route,body);assert.equal(result.data.ok,false,JSON.stringify(result));
   }
   assert.equal(sent.length,0);
  });
  await t.test('email Slack and Notion retain currency deterministic totals and exact targets',async()=>{
   for(const[route,body]of[['email',{currency:'BDT'}],['slack',{currency:'BDT',channel:'CQA123'}],['notion',{currency:'BDT',parentId:'notion-parent-qa'}]])assert.equal((await api('flash/'+route,body)).status,200);
   assert.equal(sent.length,3);for(const item of sent){assert.match(item.text,/BDT/);assert.match(item.text,/82\.35/);assert(!/9999\.99|120\.00/.test(item.text));}
   assert.deepEqual(sent.find(x=>x.provider==='email').destination,[s.config.email]);assert.equal(sent.find(x=>x.provider==='slack').destination,'CQA123');assert.equal(sent.find(x=>x.provider==='notion').destination,'notion-parent-qa');
  });
 }finally{await s.close()}
});
