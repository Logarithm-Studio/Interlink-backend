const assert=require('node:assert/strict');
const test=require('node:test');
const {startSandbox}=require('./runtime.cjs');

test('real marketing routes against disposable SQL and simulated social providers',async t=>{
  const s=await startSandbox();
  const {base,token,otherToken,userId}=s.config;
  const b='/api/v1/marketing/content';
  const limits=s.load('middleware/rateLimit.js');
  let n=0;
  async function request(url,method='GET',body,expected=200,bearer=token){
    const r=await fetch(url.startsWith('http')?url:base+url,{method,headers:{'content-type':'application/json',...(bearer?{authorization:'Bearer '+bearer}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
    const text=await r.text();let data;try{data=JSON.parse(text)}catch{data=text}
    assert.equal(r.status,expected,`${method} ${url}: ${JSON.stringify(data)}`);return data;
  }
  function reset(){for(const name of ['marketingPublishRateLimit','marketingPostStatusRateLimit','oauthRateLimit'])limits[name]?.resetKey(userId)}
  async function scenario(name,fn){reset();await t.test(name,fn)}
  async function draft(provider,asset){return (await request(b,'POST',{title:'Sandbox '+provider+' '+(++n),channel:provider,body:'Sandbox QA only',...(asset?{assetUrl:asset}:{})})).item}
  async function approved(provider,asset){const d=await draft(provider,asset);await request(b+'/'+d.id+'/submit','POST',{});return (await request(b+'/'+d.id+'/approve','POST',{})).item}
  const publish=(d,provider,target=s.providers.targets[provider],expected=200)=>request(b+'/'+d.id+'/publish','POST',{confirmed:true,provider,targetId:target},expected);
  const status=async id=>(await request(b)).items.find(i=>i.id===id)?.status;
  try{
    await scenario('unauthenticated routes reject access',()=>request(b,'GET',undefined,401,null));
    await scenario('real login rejects invalid sandbox password',()=>request('/api/v1/auth/login','POST',{email:s.config.email,password:'incorrect-password'},401,null));
    await scenario('real login and /me use a disposable identity',async()=>{
      const login=await request('/api/v1/auth/login','POST',{email:s.config.email,password:s.config.password},200,null);assert.equal(login.user.id,userId);assert.ok(login.session.accessToken);
      const me=await request('/api/v1/auth/me');assert.equal(me.connectedAccounts.google.connected,true);assert.equal(me.user.email,s.config.email);
    });
    for(const provider of ['facebook','instagram','linkedin']){
      await scenario(provider+' disconnected, declined consent, approved consent and replay rejection',async()=>{
        await request(b+'/publish-targets?provider='+provider,'GET',undefined,409);
        let link=await request('/api/v1/composio/connect','POST',{toolkit:provider});assert.ok(link.redirectUrl.startsWith(base));
        assert.match(await request(link.redirectUrl),/simulated provider/);
        let r=await fetch(link.redirectUrl,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'approved=no',redirect:'manual'});assert.equal(r.status,302);
        assert.equal((await request('/api/v1/composio/connections')).connections.find(x=>x.toolkitSlug===provider).status,'failed');
        link=await request('/api/v1/composio/connect','POST',{toolkit:provider});
        r=await fetch(link.redirectUrl,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'approved=yes',redirect:'manual'});assert.equal(r.headers.get('location'),'interlinkapp://oauth/composio');
        await request(link.redirectUrl,'POST',{},400);
        const targets=await request(b+'/publish-targets?provider='+provider);assert.equal(targets.targets[0].id,s.providers.targets[provider]);
      });
      await scenario(provider+' requires review/approval and explicit confirmation',async()=>{
        const d=await draft(provider,provider==='instagram'?'https://media.sandbox.invalid/photo.jpg':undefined);
        await publish(d,provider,undefined,409);await request(b+'/'+d.id+'/submit','POST',{});await request(b+'/'+d.id+'/approve','POST',{});
        await request(b+'/'+d.id+'/publish','POST',{provider,targetId:s.providers.targets[provider]},400);
        await publish(d,provider,'not-this-account',400);
        assert.equal(await status(d.id),'approved');
      });
      await scenario(provider+' publishes once on double submission, persists IDs and reads back',async()=>{
        const d=await approved(provider,provider==='instagram'?'https://media.sandbox.invalid/photo.jpg':undefined),before=s.providers.posts.size;
        const url=base+b+'/'+d.id+'/publish',options={method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({confirmed:true,provider,targetId:s.providers.targets[provider]})};
        const responses=await Promise.all([fetch(url,options),fetch(url,options)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
        const result=await responses.find(r=>r.status===200).json();assert.equal(result.item.status,'published');assert.ok(result.item.providerItemId);assert.equal(result.item.providerTargetId,s.providers.targets[provider]);
        assert.equal(s.providers.posts.size-before,provider==='instagram'?2:1);
        const snap=await request(b+'/'+d.id+'/provider-check','POST',{});assert.equal(snap.snapshot.providerState,'live');
        if(provider==='facebook')assert.equal(snap.snapshot.metrics.likes,7);
        if(provider==='instagram')assert.equal(snap.snapshot.metrics.likes,9);
        if(provider==='linkedin')assert.deepEqual(snap.snapshot.metrics,{});
        assert.equal((await request(b+'/'+d.id+'/provider-checks')).snapshots.length,1);
        const history=await request(b+'/'+d.id+'/history');assert.ok(history.events.length>=4);
        await request(b+'/'+d.id+'/history','GET',undefined,200,otherToken); // Empty history must not leak another user's records.
        assert.deepEqual((await request(b+'/'+d.id+'/history','GET',undefined,200,otherToken)).events,[]);
        if(provider!=='facebook'){
          s.providers.faults.set(provider==='instagram'?'INSTAGRAM_GET_IG_MEDIA':'LINKEDIN_GET_POST_CONTENT','wrong_owner');
          await request(b+'/'+d.id+'/provider-check','POST',{},409);
          assert.equal((await request(b+'/'+d.id+'/provider-checks')).snapshots.length,1);
        }
      });
      await scenario(provider+' uncertain write locks retries until explicit review',async()=>{
        const d=await approved(provider,provider==='instagram'?'https://media.sandbox.invalid/photo.jpg':undefined);
        const tool=provider==='facebook'?'FACEBOOK_CREATE_POST':provider==='instagram'?'INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH':'LINKEDIN_CREATE_LINKED_IN_POST';
        s.providers.faults.set(tool,'timeout_after_write');await publish(d,provider,undefined,502);assert.equal(await status(d.id),'publish_review');
        const count=s.providers.posts.size;await publish(d,provider,undefined,409);assert.equal(s.providers.posts.size,count);
        await request(b+'/'+d.id+'/publish-retry','POST',{},400);
        // The fake provider did accept the write, so do not lie by confirming no post exists.
      });
      await scenario(provider+' invalid media or copy is rejected before a provider write',async()=>{
        const d=await approved(provider,provider==='instagram'?undefined:provider==='facebook'?'https://media.sandbox.invalid/file.webm':'https://media.sandbox.invalid/file.mp4');
        const before=s.providers.posts.size;await publish(d,provider,undefined,400);assert.equal(s.providers.posts.size,before);
      });
      await scenario(provider+' permission denial and expired connection cannot report success',async()=>{
        const d=await approved(provider,provider==='instagram'?'https://media.sandbox.invalid/photo.jpg':undefined);
        s.providers.faults.set(provider==='facebook'?'FACEBOOK_LIST_MANAGED_PAGES':provider==='instagram'?'INSTAGRAM_GET_USER_INFO':'LINKEDIN_GET_MY_INFO','denied');
        await publish(d,provider,undefined,502);assert.equal(await status(d.id),'approved');
        s.providers.status(userId,provider,'failed');await publish(d,provider,undefined,409);s.providers.status(userId,provider,'active');
        const targetTool=provider==='facebook'?'FACEBOOK_LIST_MANAGED_PAGES':provider==='instagram'?'INSTAGRAM_GET_USER_INFO':'LINKEDIN_GET_MY_INFO';
        s.providers.faults.set(targetTool,'rate_limit');await publish(d,provider,undefined,502);assert.equal(await status(d.id),'approved');
        await request('/api/v1/composio/connections/'+provider,'DELETE');
        assert.equal((await request('/api/v1/composio/connections')).connections.find(x=>x.toolkitSlug===provider).status,'revoked');
        await publish(d,provider,undefined,409);s.providers.status(userId,provider,'active');
      });
    }
    await scenario('Facebook photo and video use correct provider post IDs',async()=>{
      for(const ext of ['jpg','mp4']){const d=await approved('facebook','https://media.sandbox.invalid/file.'+ext);const r=await publish(d,'facebook');assert.match(r.item.providerItemId,/^1234567890_\d+$/);await request(b+'/'+d.id+'/provider-check','POST',{})}
    });
    await scenario('Instagram MP4 uses a Reels container before publishing',async()=>{
      const d=await approved('instagram','https://media.sandbox.invalid/video.mp4');await publish(d,'instagram');
      const call=s.providers.calls.filter(c=>c.slug==='INSTAGRAM_POST_IG_USER_MEDIA').at(-1);assert.equal(call.args.media_type,'REELS');assert.equal(call.args.share_to_feed,true);
    });
    await scenario('approval and scheduled job are invalidated by an edit; stale delivery skips',async()=>{
      const d=await approved('facebook');const future=new Date(Date.now()+3600000).toISOString();
      await request(b+'/'+d.id+'/schedule-publish','POST',{confirmed:true,provider:'facebook',targetId:s.providers.targets.facebook,scheduledAt:future});
      const job=s.jobs.filter(j=>j.type==='marketing-social-publish').at(-1);assert.ok(job);const e=job.payload;
      const edited=await request(b+'/'+d.id,'PATCH',{body:'Changed after approval'});assert.equal(edited.item.status,'draft');assert.equal(edited.item.scheduledAt,null);
      const worker=await s.load('services/professional/marketing/social-scheduling.service.js').runScheduledMarketingSocialPublish(e.userId,e.payload.scheduleId,e.payload.generation);assert.equal(worker.skipped,true);
    });
    await scenario('scheduled worker publishes exactly once when due and duplicate delivery skips',async()=>{
      const d=await approved('instagram','https://media.sandbox.invalid/scheduled.jpg');
      await request(b+'/'+d.id+'/schedule-publish','POST',{confirmed:true,provider:'instagram',targetId:s.providers.targets.instagram,scheduledAt:new Date(Date.now()+3600000).toISOString()});
      const e=s.jobs.filter(j=>j.type==='marketing-social-publish').at(-1).payload;
      // Move only this isolated fixture to a due time; execute the production worker unchanged.
      const due=new Date(Date.now()-1000);
      await s.db.withTransaction(async c=>{await c.query('UPDATE sales_marketing_content_items SET scheduled_at=$2 WHERE id=$1',[d.id,due]);await c.query('UPDATE sales_marketing_social_publish_schedules SET scheduled_at=$2 WHERE id=$1',[e.payload.scheduleId,due])});
      const fn=s.load('services/professional/marketing/social-scheduling.service.js').runScheduledMarketingSocialPublish;
      assert.equal((await fn(e.userId,e.payload.scheduleId,e.payload.generation)).status,'published');
      const count=s.providers.posts.size;assert.equal((await fn(e.userId,e.payload.scheduleId,e.payload.generation)).skipped,true);assert.equal(s.providers.posts.size,count);
    });
    await scenario('unscheduling cancels the waiting generation without publishing',async()=>{
      const d=await approved('facebook');await request(b+'/'+d.id+'/schedule-publish','POST',{confirmed:true,provider:'facebook',targetId:s.providers.targets.facebook,scheduledAt:new Date(Date.now()+3600000).toISOString()});
      const e=s.jobs.filter(j=>j.type==='marketing-social-publish').at(-1).payload;
      const u=await request(b+'/'+d.id+'/unschedule-publish','POST',{confirmed:true});assert.equal(u.item.status,'approved');
      assert.equal((await s.load('services/professional/marketing/social-scheduling.service.js').runScheduledMarketingSocialPublish(e.userId,e.payload.scheduleId,e.payload.generation)).skipped,true);
    });
    await scenario('publish rate limiter remains enabled in the sandbox',async()=>{
      const d=await approved('facebook');for(let i=0;i<6;i++)await request(b+'/'+d.id+'/publish','POST',{},400);await request(b+'/'+d.id+'/publish','POST',{},429);
    });
    await scenario('external network access is blocked',async()=>{
      const before=s.blockedNetwork.length;await assert.rejects(async()=>fetch('https://example.com'),/SANDBOX blocked external network/);assert.equal(s.blockedNetwork.length,before+1);
    });
  }finally{
    await s.close();assert.equal(s.identity.size,0);assert.equal(s.providers.posts.size,0);
    await assert.rejects(()=>s.db.query('SELECT 1'));
  }
});
