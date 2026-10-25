const assert=require('node:assert/strict'),test=require('node:test'),crypto=require('node:crypto');
const {startSandbox}=require('./runtime.cjs');

test('Marketing outreach, signatures and shortlist exports execute guarded provider lifecycles',async t=>{
  const s=await startSandbox({port:4319}),{base,token,otherToken,userId}=s.config;
  const m='/api/v1/marketing';let contact,deal;const mails=[],envelopes=new Map(),pages=new Map(),tasks=new Map();
  let replied=false,aliasReply=false,failRead=false,failSend=false,loseEnvelope=false,losePage=false,rejectEnvelope=false,rejectPage=false;
  const auth=s.load('services/auth.service.js');auth.resolveGoogleAccountId=async()=>userId;
  auth.getGoogleAccountSummaryById=async()=>({id:userId,email:'work@sandbox.invalid',reauthRequired:false});
  const google=s.load('services/googleApi.service.js');
  google.getGmailThreadMessages=async()=>aliasReply?[{id:'alias-reply',internalDate:String(Date.now()),labelIds:['INBOX']}]:[];
  google.getGmailMessageDetail=async({messageId})=>({id:messageId,threadId:'thread-'+messageId,to:'prospect@sandbox.invalid',labelIds:['SENT'],internalDate:String(Date.now()-3600000),messageIdHeader:'<'+messageId+'@sandbox.invalid>'});
  google.listGmailMailboxMessages=async args=>{assert.equal(args.mailbox,'all');assert.match(args.query,/-in:sent/);if(failRead)throw Error('Read failed');return{messages:replied?[{id:'reply-1'}]:[]}};
  google.sendAutomatedGmailMessage=async input=>{mails.push(input);if(failSend)throw Error('Accepted but response lost');return{id:'sent-'+mails.length,threadId:input.threadId,labelIds:['SENT']}};
  const composio=s.load('services/composio/composio.service.js');
  composio.executeComposioProxy=async(uid,provider,url,method,body)=>{
    assert.equal(uid,userId);assert.equal(provider,'docusign');
    const ok=data=>({status:200,data});
    if(url.endsWith('/oauth/userinfo'))return ok({accounts:[{account_id:'qa-account',account_name:'QA account',base_uri:'https://demo.docusign.net'},{account_id:'evil',base_uri:'https://evil.invalid'}]});
    if(method==='POST'&&url.endsWith('/envelopes')){
      if(rejectEnvelope)return{status:403,data:{message:'Simulated missing scope'}};
      assert.equal(body.status,'created');assert.match(Buffer.from(body.documents[0].documentBase64,'base64').toString(),/interlink_signature/);
      const id=crypto.randomUUID();envelopes.set(id,{id,body,status:'created',version:new Date().toISOString()});if(loseEnvelope)throw Error('Create response lost');return ok({envelopeId:id,status:'created'});
    }
    const parts=url.split('/');const id=['custom_fields','recipients'].includes(parts.at(-1))?parts.at(-2):parts.at(-1);const envelope=envelopes.get(id);
    if(!envelope)return {status:404,data:{}};
    if(url.endsWith('/custom_fields'))return ok(envelope.body.customFields);
    if(url.endsWith('/recipients'))return ok(envelope.body.recipients);
    if(method==='PUT'){assert.equal(body.status,'sent');envelope.status='sent';return ok({envelopeId:id,status:'sent'});}
    return ok({envelopeId:id,status:envelope.status,lastModifiedDateTime:envelope.version});
  };
  const notion=s.load('services/notion/notion.service.js'),todoist=s.load('services/todoist/todoist.service.js');
  notion.searchPages=async()=>[{id:'qa-parent',title:'Shared QA page'}];
  notion.assertPageAccessible=async(uid,id)=>{assert.equal(uid,userId);if(id!=='qa-parent')throw new (s.load('utils/errors.js').BadRequestError)('Notion parent unavailable');};
  notion.getPageContent=async(uid,id)=>id==='qa-parent'?'Shared root':pages.get(id)?.content??'';
  notion.createPage=async(uid,input)=>{assert.equal(uid,userId);if(rejectPage)throw Error('Simulated permission rejection');const id=crypto.randomUUID();pages.set(id,input);if(losePage)throw Error('Page response lost');return{id,url:'https://www.notion.so/'+id,title:input.title}};
  todoist.getProjects=async()=>[{id:'qa-project',name:'QA prospects'}];
  todoist.getTasks=async()=>[...tasks.values()];
  todoist.createTask=async(uid,input)=>{assert.equal(uid,userId);const id='task-'+(tasks.size+1);const task={id,...input};tasks.set(id,task);return task};
  async function api(path,method='GET',body,status=200,bearer=token){if(path.endsWith('/export')&&body&&!body.fingerprint){body={...body,fingerprint:(await api(path.replace(/\/export$/,'/preview'))).fingerprint};}const r=await fetch(base+path,{method,headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json();assert.equal(r.status,status,`${method} ${path}: ${JSON.stringify(value)}`);return value;}
  async function scenario(name,fn){for(const limiter of Object.values(s.load('middleware/rateLimit.js')))if(typeof limiter?.resetKey==='function'){limiter.resetKey(userId);limiter.resetKey('127.0.0.1');}await t.test(name,fn);}
  async function createSequence(initialMessageId,steps=[{subject:'Re: scope',body:'Reviewed first follow-up.',delayDays:1}]){return(await api(m+'/email-sequences','POST',{contactId:contact.id,initialMessageId,expectedSenderEmail:'work@sandbox.invalid',steps,confirmed:true},201)).sequence;}
  async function deliver(sequence,step=0){await s.db.query("UPDATE sales_marketing_email_sequences SET due_at=now()-interval '1 second' WHERE id=$1",[sequence.id]);await s.load('workers/processors/marketingEmailSequence.processor.js').processMarketingEmailSequence({jobType:'marketing.email.sequence',requestId:crypto.randomUUID(),idempotencyKey:'test-'+sequence.id,userId,payload:{sequenceId:sequence.id,step}},'sandbox-job');}
  async function state(sequence){return(await api(m+'/email-sequences')).sequences.find(row=>row.id===sequence.id);}
  async function agreement(){return(await api(m+'/agreements','POST',{dealId:deal.id,signerName:'QA Prospect',signerEmail:'prospect@sandbox.invalid',requirements:'Deliver a reviewed research report for the agreed deal price. Payment within 30 days.'},201)).agreement;}
  try{
    contact=(await api('/api/v1/sales/contacts','POST',{name:'QA Prospect',email:'prospect@sandbox.invalid'})).contact;
    deal=(await api('/api/v1/sales/deals','POST',{title:'QA research engagement',contactId:contact.id,contactName:contact.name,amountCents:25000,currency:'BDT'})).deal;
    await scenario('automatic outreach requires permission evidence and explicit approval',async()=>{
      await api(m+'/email-sequences','POST',{contactId:contact.id,initialMessageId:'unconsented',expectedSenderEmail:'work@sandbox.invalid',steps:[{subject:'Hello',body:'Reviewed message',delayDays:1}],confirmed:true},409);
      await api('/api/v1/sales/contacts/'+contact.id,'PATCH',{marketingOptIn:true,marketingOptInSource:'email_request',marketingOptInEvidence:'Controlled sandbox permission fixture'});
      await api(m+'/email-sequences','POST',{confirmed:false},400);
      assert.equal(mails.length,0);
    });
    await scenario('approved multi-step jobs persist IDs and ignore duplicate deliveries',async()=>{
      const sequence=await createSequence('original-two',[{subject:'Re: scope',body:'First exact follow-up',delayDays:1},{subject:'Re: scope',body:'Second exact follow-up',delayDays:2}]);
      assert.ok(s.jobs.some(job=>job.type==='marketing-email-sequence'));
      await Promise.all([deliver(sequence),deliver(sequence)]);assert.equal(mails.length,1);assert.equal((await state(sequence)).next_step,1);
      await deliver(sequence,0);assert.equal(mails.length,1);await deliver(sequence,1);assert.equal(mails.length,2);
      assert.equal((await state(sequence)).status,'completed');assert.equal((await state(sequence)).sent_message_ids.length,2);
      assert.deepEqual((await api(m+'/email-sequences','GET',undefined,200,otherToken)).sequences,[]);
    });
    await scenario('incoming replies and revoked consent stop future sends',async()=>{
      const sequence=await createSequence('original-reply');replied=true;await deliver(sequence);replied=false;assert.equal((await state(sequence)).status,'replied');assert.equal(mails.length,2);
      const alias=await createSequence('original-alias');aliasReply=true;await deliver(alias);aliasReply=false;assert.equal((await state(alias)).status,'replied');assert.equal(mails.length,2);
      const revoked=await createSequence('original-revoked');await api('/api/v1/sales/contacts/'+contact.id,'PATCH',{marketingOptIn:false});await deliver(revoked);assert.equal((await state(revoked)).status,'cancelled');assert.equal(mails.length,2);
      await api('/api/v1/sales/contacts/'+contact.id,'PATCH',{marketingOptIn:true,marketingOptInSource:'email_request',marketingOptInEvidence:'Restored controlled fixture'});
    });
    await scenario('cancellation and unknown provider delivery never blindly retry',async()=>{
      const cancelled=await createSequence('original-cancelled');await api(m+'/email-sequences/'+cancelled.id+'/cancel','POST');await deliver(cancelled);assert.equal(mails.length,2);
      const uncertain=await createSequence('original-uncertain');failSend=true;await deliver(uncertain);failSend=false;assert.equal((await state(uncertain)).status,'review');assert.equal(mails.length,3);await deliver(uncertain);assert.equal(mails.length,3);
    });
    await scenario('failed reply reads retry without sending and cross-user cancellation is denied',async()=>{
      const sequence=await createSequence('original-read');failRead=true;await assert.rejects(deliver(sequence),/Read failed/);failRead=false;assert.equal((await state(sequence)).status,'pending');assert.equal(mails.length,3);
      await api(m+'/email-sequences/'+sequence.id+'/cancel','POST',undefined,409,otherToken);await api(m+'/email-sequences/'+sequence.id+'/cancel','POST');
    });
    await scenario('contract drafting preserves supplied terms and requires current-document approval',async()=>{
      const a=await agreement();assert.match(a.body,/Payment within 30 days/);assert.equal(envelopes.size,0);
      await api(m+'/agreements/'+a.id,'GET',undefined,404,otherToken);
      const accounts=await api(m+'/agreements/accounts');assert.equal(accounts.accounts.length,1);
      const edited=(await api(m+'/agreements/'+a.id,'PATCH',{body:a.body+'\nAgreed delivery date: 15 November.'})).agreement;
      await api(m+'/agreements/'+a.id+'/prepare','POST',{accountId:'qa-account',fingerprint:a.fingerprint,confirmed:true},409);
      let prepared=(await api(m+'/agreements/'+a.id+'/prepare','POST',{accountId:'qa-account',fingerprint:edited.fingerprint,confirmed:true})).agreement;
      assert.equal(prepared.status,'prepared');assert.equal(envelopes.size,1);
      await api(m+'/agreements/'+a.id,'PATCH',{body:'Attempted change after approval.'},409);
      const sent=(await api(m+'/agreements/'+a.id+'/send','POST',{fingerprint:prepared.fingerprint,confirmed:true})).agreement;assert.equal(sent.status,'sent');
      await api(m+'/agreements/'+a.id+'/send','POST',{fingerprint:sent.fingerprint,confirmed:true},409);
      envelopes.get(sent.envelope_id).status='completed';await s.db.query("UPDATE sales_marketing_agreements SET last_checked_at=now()-interval '2 hours' WHERE id=$1",[a.id]);await s.load('services/professional/marketing/agreement.service.js').dispatchAgreementChecks();const check=s.jobs.find(job=>job.type==='marketing-agreement-check'&&job.payload.payload.agreementId===a.id);assert.ok(check);await s.load('workers/processors/marketingEmailSequence.processor.js').processMarketingAgreementCheck({...check.payload,requestId:crypto.randomUUID()},'sandbox-signature-check');
      prepared=(await api(m+'/agreements/'+a.id)).agreement;assert.equal(prepared.status,'completed');
      assert.equal((await s.db.query('SELECT status FROM sales_contracts WHERE id=$1',[a.contract_id])).rows[0].status,'signed');
      envelopes.get(sent.envelope_id).status='sent';await api(m+'/agreements/'+a.id+'/refresh','POST');assert.equal((await api(m+'/agreements/'+a.id)).agreement.status,'completed');
    });
    await scenario('uncertain DocuSign creation locks and reconciles only matching provider markers',async()=>{
      const a=await agreement();loseEnvelope=true;
      const uncertain=(await api(m+'/agreements/'+a.id+'/prepare','POST',{accountId:'qa-account',fingerprint:a.fingerprint,confirmed:true})).agreement;loseEnvelope=false;
      assert.equal(uncertain.status,'review');const count=envelopes.size;
      await api(m+'/agreements/'+a.id+'/prepare','POST',{accountId:'qa-account',fingerprint:a.fingerprint,confirmed:true},409);assert.equal(envelopes.size,count);
      const foreign=[...envelopes.values()].find(e=>e.body.transactionId!==a.id);await api(m+'/agreements/'+a.id+'/reconcile','POST',{envelopeId:foreign.id},409);
      const match=[...envelopes.values()].find(e=>e.body.transactionId===a.id);const resolved=(await api(m+'/agreements/'+a.id+'/reconcile','POST',{envelopeId:match.id})).agreement;assert.equal(resolved.status,'prepared');assert.equal(resolved.envelope_id,match.id);
    });
    await scenario('native shortlist copies retain provider IDs and prevent repeated external creates',async()=>{
      const plan=(await api(m+'/research-plans','POST',{title:'QA shortlist',objective:'Research fit, then request a discovery call.',contactIds:[contact.id]},201)).plan;
      const stale=(await api(m+'/research-plans/'+plan.id+'/preview')).fingerprint;
      await api('/api/v1/sales/contacts/'+contact.id,'PATCH',{company:'Changed after review'});
      await api(m+'/research-plans/'+plan.id+'/export','POST',{provider:'notion',destinationId:'qa-parent',fingerprint:stale,confirmed:true},409);assert.equal(pages.size,0);
      await api(m+'/research-plans/'+plan.id+'/export','POST',{provider:'todoist',destinationId:'unavailable',confirmed:true},400);
      await api(m+'/research-plans/'+plan.id+'/export','POST',{provider:'notion',destinationId:'unavailable',confirmed:true},400);assert.equal(pages.size,0);
      let result=await api(m+'/research-plans/'+plan.id+'/export','POST',{provider:'notion',destinationId:'qa-parent',confirmed:true});assert.equal(result.exports[0].status,'synced');
      await api(m+'/research-plans/'+plan.id+'/export','POST',{provider:'notion',destinationId:'qa-parent',confirmed:true});assert.equal(pages.size,1);
      result=await api(m+'/research-plans/'+plan.id+'/export','POST',{provider:'todoist',destinationId:'qa-project',confirmed:true});assert.equal(result.exports.filter(x=>x.status==='synced').length,2);
      await api(m+'/research-plans/'+plan.id+'/export','POST',{provider:'todoist',destinationId:'qa-project',confirmed:true});assert.equal(tasks.size,1);
      await api(m+'/research-plans/'+plan.id+'/exports','GET',undefined,404,otherToken);
    });
    await scenario('uncertain Notion copies reconcile by marker without duplicate pages',async()=>{
      const plan=(await api(m+'/research-plans','POST',{title:'QA uncertain export',objective:'A second reviewed shortlist',contactIds:[contact.id]},201)).plan;
      losePage=true;let result=await api(m+'/research-plans/'+plan.id+'/export','POST',{provider:'notion',destinationId:'qa-parent',confirmed:true});losePage=false;
      assert.equal(result.exports[0].status,'review');const count=pages.size;
      await api(m+'/research-plans/'+plan.id+'/export','POST',{provider:'notion',destinationId:'qa-parent',confirmed:true});assert.equal(pages.size,count);
      const exportRow=result.exports[0];const page=[...pages.entries()].find(([,value])=>value.content.includes(exportRow.id));
      result=await api(m+'/research-exports/'+exportRow.id+'/reconcile','POST',{externalId:page[0]});assert.equal(result.exports[0].status,'synced');assert.equal(pages.size,count);
    });
    await scenario('retrying a rejected envelope needs an explicit no-envelope confirmation',async()=>{
      const a=await agreement(),count=envelopes.size;rejectEnvelope=true;
      const review=(await api(m+'/agreements/'+a.id+'/prepare','POST',{accountId:'qa-account',fingerprint:a.fingerprint,confirmed:true})).agreement;rejectEnvelope=false;
      assert.equal(review.status,'review');assert.equal(envelopes.size,count);
      await api(m+'/agreements/'+a.id+'/retry-prepare','POST',{fingerprint:a.fingerprint,confirmed:true,confirmedNoEnvelope:false},400);
      const prepared=(await api(m+'/agreements/'+a.id+'/retry-prepare','POST',{fingerprint:a.fingerprint,confirmed:true,confirmedNoEnvelope:true})).agreement;
      assert.equal(prepared.status,'prepared');assert.equal(envelopes.size,count+1);
      await api(m+'/agreements/'+a.id+'/retry-prepare','POST',{fingerprint:a.fingerprint,confirmed:true,confirmedNoEnvelope:true},409);assert.equal(envelopes.size,count+1);
    });
    await scenario('a failed export can retry only after renewed preview and explicit no-copy confirmation',async()=>{
      const plan=(await api(m+'/research-plans','POST',{title:'QA retry export',objective:'A controlled retry after connection repair',contactIds:[contact.id]},201)).plan;
      const count=pages.size;rejectPage=true;const failed=(await api(m+'/research-plans/'+plan.id+'/export','POST',{provider:'notion',destinationId:'qa-parent',confirmed:true})).exports[0];rejectPage=false;
      assert.equal(failed.status,'review');assert.equal(pages.size,count);
      const fingerprint=(await api(m+'/research-plans/'+plan.id+'/preview')).fingerprint;
      await api(m+'/research-exports/'+failed.id+'/retry','POST',{fingerprint,confirmed:true,confirmedNoCopy:false},400);
      const result=await api(m+'/research-exports/'+failed.id+'/retry','POST',{fingerprint,confirmed:true,confirmedNoCopy:true});assert.equal(result.exports[0].status,'synced');assert.equal(pages.size,count+1);
      await api(m+'/research-exports/'+failed.id+'/retry','POST',{fingerprint,confirmed:true,confirmedNoCopy:true},409);assert.equal(pages.size,count+1);
    });
    await scenario('provider-side draft or signer changes invalidate a signature send',async()=>{
      for(const change of ['version','recipient']){
        const a=await agreement();const prepared=(await api(m+'/agreements/'+a.id+'/prepare','POST',{accountId:'qa-account',fingerprint:a.fingerprint,confirmed:true})).agreement;
        const remote=envelopes.get(prepared.envelope_id);
        if(change==='version')remote.version='changed-after-review';else remote.body.recipients.signers[0].email='different@sandbox.invalid';
        await api(m+'/agreements/'+a.id+'/send','POST',{fingerprint:prepared.fingerprint,confirmed:true},409);
        assert.equal(remote.status,'created');assert.equal((await api(m+'/agreements/'+a.id)).agreement.status,'review');
      }
    });
  }finally{await s.close();}
});
