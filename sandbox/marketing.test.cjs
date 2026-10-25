const assert=require('node:assert/strict'),test=require('node:test');
const {startSandbox}=require('./runtime.cjs');
test('marketing workflows use simulated email, planning, CRM and analytics providers',async t=>{
  const s=await startSandbox(),{base,token,userId}=s.config;
  const m='/api/v1/marketing',sales='/api/v1/sales';let campaign,contact,followup,deal;
  async function api(url,method='GET',body,status=200){const r=await fetch(base+url,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();assert.equal(r.status,status,`${method} ${url}: ${JSON.stringify(d)}`);return d}
  async function scenario(name,fn){for(const limiter of Object.values(s.load('middleware/rateLimit.js')))if(typeof limiter?.resetKey==='function')limiter.resetKey(userId);await t.test(name,fn)}
  async function newCampaign(){return(await api(sales+'/campaigns','POST',{topic:'Sandbox calendar automation campaign',audience:'Sandbox recipients only',objective:'Test provider workflows without external effects',channels:['facebook','instagram','email','blog']})).campaign}
  async function emailDraft(){const c=await newCampaign();return(await api(sales+'/campaigns/'+c.id+'/provider-draft','POST',{audienceId:'sandbox-audience',fromName:'Sandbox QA',replyTo:'qa@sandbox.invalid'})).campaign}
  try{
    for(const p of ['mailchimp','hubspot','facebook','instagram','google_analytics','google_search_console','googleads','stripe'])s.providers.status(userId,p,'active');
    await scenario('campaign and contact fixtures use real SQL',async()=>{
      campaign=await newCampaign();assert.equal(campaign.status,'draft');
      contact=(await api(sales+'/contacts','POST',{name:'Sandbox lead',email:'lead@sandbox.invalid',company:'Sandbox'})).contact;
      followup=(await api(m+'/followups','POST',{contactId:contact.id,campaignId:campaign.id,title:'Sandbox follow-up',dueAt:new Date(Date.now()+86400000).toISOString()})).followup;
    });
    await scenario('Mailchimp audiences, draft creation and history',async()=>{
      const lists=await api(sales+'/campaigns/mailchimp/audiences');assert.equal(lists.audiences[0].subscribedCount,2);
      const d=await emailDraft();assert.equal(d.status,'provider_draft');assert.ok(d.providerCampaignId);assert.equal(s.marketing.mail.size,1);
      assert.ok((await api(sales+'/campaigns/'+d.id+'/history')).events.length>=2);
    });
    await scenario('Mailchimp schedule, unschedule, send and report sync',async()=>{
      const d=await emailDraft();const b=sales+'/campaigns/'+d.id;
      assert.equal((await api(b+'/schedule','POST',{scheduledAt:new Date(Date.now()+3600000).toISOString()})).campaign.status,'scheduled');
      assert.equal((await api(b+'/unschedule','POST',{})).campaign.status,'provider_draft');
      const sent=await api(b+'/send','POST',{});assert.equal(sent.campaign.status,'sending');assert.equal(sent.sent,0);
      const synced=await api(b+'/sync','POST',{});assert.equal(synced.campaign.status,'sent');assert.equal(synced.campaign.providerMetrics.uniqueClicks,1);
      await api(b+'/send','POST',{},409);
    });
    await scenario('Mailchimp checklist failure cannot mark campaign sent',async()=>{
      const d=await emailDraft();s.marketing.faults.set('mailchimp:GET:/campaigns/'+d.providerCampaignId+'/send-checklist','checklist');
      await api(sales+'/campaigns/'+d.id+'/send','POST',{},422);
      assert.equal((await api(sales+'/campaigns')).campaigns.find(c=>c.id===d.id).status,'provider_draft');
      assert.equal(s.marketing.mail.get(d.providerCampaignId).status,'save');
    });
    await scenario('Mailchimp ambiguous send is locked against a second send',async()=>{
      const d=await emailDraft();s.marketing.faults.set('mailchimp:POST:/campaigns/'+d.providerCampaignId+'/actions/send','timeout_after_write');
      await api(sales+'/campaigns/'+d.id+'/send','POST',{},502);
      assert.equal((await api(sales+'/campaigns')).campaigns.find(c=>c.id===d.id).status,'send_review');
      await api(sales+'/campaigns/'+d.id+'/send','POST',{},409);
      assert.equal(s.marketing.requests.filter(r=>r.endpoint==='/campaigns/'+d.providerCampaignId+'/actions/send').length,1);
    });
    await scenario('Todoist encrypted fake connection and verified project selection',async()=>{
      await s.connectNative(userId,'todoist');const projects=await api('/api/v1/todoist/projects');assert.equal(projects.projects[0].id,'sandbox-project');
      const pref=await api(m+'/todoist-project','PUT',{projectId:'sandbox-project'});assert.equal(pref.preference.projectId,'sandbox-project');
      await api(m+'/todoist-project','PUT',{projectId:'not-shared'},409);
    });
    await scenario('Todoist handoff is idempotent and completion imports into Interlink',async()=>{
      const url=m+'/followups/'+followup.id;
      const first=await api(url+'/todoist','POST',{},201);assert.equal(first.created,true);
      const again=await api(url+'/todoist','POST',{});assert.equal(again.created,false);assert.equal(first.taskId,again.taskId);assert.equal(s.marketing.tasks.size,1);
      const task=s.marketing.tasks.get(first.taskId);task.is_completed=true;task.checked=true;
      const sync=await api(url+'/todoist-sync','POST',{confirmed:true});assert.equal(sync.result.completed,true);
      assert.ok((await api(m+'/followups?status=completed')).followups.some(f=>f.id===followup.id));
    });
    await scenario('Notion schema discovery and mapped export avoid duplicate pages',async()=>{
      await s.connectNative(userId,'notion');
      const ds=await api(m+'/campaigns/'+campaign.id+'/notion-data-sources?q=Sandbox');assert.equal(ds.dataSources[0].id,'sandbox-data-source');
      const input={dataSourceId:'sandbox-data-source',databaseId:'sandbox-database',mapping:{campaignId:'Campaign ID',objective:'Objective'}};
      const first=await api(m+'/campaigns/'+campaign.id+'/notion-database','POST',input,201);assert.equal(first.export.status,'synced');
      const again=await api(m+'/campaigns/'+campaign.id+'/notion-database','POST',input,201);assert.equal(again.export.pageId,first.export.pageId);assert.equal(s.marketing.pages.size,1);
    });
    await scenario('Notion invalid marker mapping is rejected before writing',async()=>{
      const c=await newCampaign(),count=s.marketing.pages.size;
      await api(m+'/campaigns/'+c.id+'/notion-database','POST',{dataSourceId:'sandbox-data-source',databaseId:'sandbox-database',mapping:{campaignId:'Name'}},400);
      assert.equal(s.marketing.pages.size,count);
    });
    await scenario('HubSpot pipeline setup and preview do not create CRM records',async()=>{
      const setup=await api(m+'/hubspot/setup');assert.equal(setup.setup.pipelines[0].id,'sandbox-pipeline');
      await api(m+'/hubspot/setup','PUT',{pipelineId:'sandbox-pipeline',stageMappings:Object.fromEntries(['lead','qualified','proposal','negotiation','nurture','won','lost'].map(x=>[x,x])),ownerMappings:{}});
      deal=(await api(m+'/leads/'+contact.id+'/opportunities','POST',{campaignId:campaign.id,title:'Sandbox opportunity',amountCents:12500,currency:'BDT'},201)).deal;
      const preview=await api(m+'/deals/'+deal.id+'/hubspot-preview');assert.equal(preview.preview.contact.action,'create');assert.equal(preview.preview.consent,'unchanged');assert.equal(s.marketing.crm.contacts.size,0);
      await api(m+'/deals/'+deal.id+'/hubspot-sync','POST',{confirmed:true,expectedFingerprint:'0'.repeat(64)},409);assert.equal(s.marketing.crm.deals.size,0);
    });
    await scenario('HubSpot confirmed sync creates one linked contact and opportunity',async()=>{
      const p=(await api(m+'/deals/'+deal.id+'/hubspot-preview')).preview;
      await api(m+'/deals/'+deal.id+'/hubspot-sync','POST',{confirmed:true,expectedFingerprint:p.fingerprint});
      assert.equal(s.marketing.crm.contacts.size,1);assert.equal(s.marketing.crm.deals.size,1);
      const next=(await api(m+'/deals/'+deal.id+'/hubspot-preview')).preview;assert.equal(next.contact.action,'update');assert.equal(next.deal.currency,'BDT');
      const record=[...s.marketing.crm.deals.values()][0];assert.equal(record.properties.amount,'125.00');assert.equal(record.properties.deal_currency_code,'BDT');
    });
    await scenario('analytics discover selected accounts and persist actual simulated numbers',async()=>{
      const targets=(await api(m+'/performance/analytics-targets')).targets;assert.equal(targets.facebook.pages[0].ref,s.providers.targets.facebook);assert.equal(targets.ga4.properties[0].ref,'123456');
      const result=await api(m+'/performance/analytics-snapshots','POST',{facebookPageId:s.providers.targets.facebook,instagramUserId:s.providers.targets.instagram,ga4PropertyId:'123456',searchConsoleSite:'https://sandbox.invalid/',googleAdsCustomerId:'1234567890',stripeBalance:true,startDate:'2026-10-01',endDate:'2026-10-20'});
      assert.equal(result.result.failures.length,0);assert.equal(result.result.refreshed.length,6);
      const rows=(await api(m+'/performance/analytics-snapshots')).snapshots;assert.equal(rows.length,6);
      assert.ok(rows.some(x=>x.provider==='facebook_page'));assert.ok(!JSON.stringify(rows).includes('private=removed'));
      assert.equal(rows.find(x=>x.provider==='ga4').metrics.sessions,12);assert.equal(rows.find(x=>x.provider==='ga4').metrics.totalRevenue,25.5);
      assert.equal(rows.find(x=>x.provider==='google_ads_campaign').metrics.costMicros,2500000);
      assert.equal(rows.find(x=>x.provider==='stripe_balance').metrics.includedTransactions,1);
    });
    await scenario('analytics partial failure preserves other providers and previous snapshots',async()=>{
      s.providers.faults.set('FACEBOOK_GET_PAGE_INSIGHTS','denied');
      const r=await api(m+'/performance/analytics-snapshots','POST',{facebookPageId:s.providers.targets.facebook,instagramUserId:s.providers.targets.instagram,startDate:'2026-10-01',endDate:'2026-10-20'});
      assert.equal(r.result.failures.length,1);assert.ok(r.result.refreshed.includes('instagram_account'));assert.equal((await api(m+'/performance/analytics-snapshots')).snapshots.length,6);
    });
    await scenario('simulated provider effects stay local',async()=>{assert.equal(s.blockedNetwork.length,0);assert.ok(s.marketing.mail.size>0);assert.ok(s.marketing.requests.length>0)});
  }finally{await s.close();assert.equal(s.identity.size,0);assert.equal(s.marketing.mail.size,0);assert.equal(s.marketing.pages.size,0);assert.equal(s.marketing.tasks.size,0)}
});
