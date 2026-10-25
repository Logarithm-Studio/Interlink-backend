const path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto');
const {createDatabase}=require('./database.cjs');
const {createIdentity}=require('./identity.cjs');
const {createProviders}=require('./providers.cjs');
const {installNetworkGuard}=require('./isolation.cjs');
const {createMarketingProviders}=require('./marketing-providers.cjs');

async function startSandbox({port=4317,manifest}={}) {
  process.chdir(__dirname); // dotenv/config must never discover the production .env.
  for(const k of Object.keys(process.env)) if(/DATABASE|SUPABASE|SMTP|QSTASH|COMPOSIO|GEMINI|GOOGLE|OPENAI|ENCRYPTION_KEY|API_BASE_URL|ACTION_SIGNING|EMAIL_VERIFICATION_TOKEN/.test(k))delete process.env[k];
  const base='http://127.0.0.1:'+port;
  Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:'postgresql://sandbox@127.0.0.1:1/disabled',SUPABASE_URL:base,SUPABASE_SERVICE_ROLE_KEY:'sandbox-only',ENCRYPTION_KEY:crypto.randomBytes(32).toString('hex'),API_BASE_URL:base,ACTION_SIGNING_SECRET:crypto.randomBytes(32).toString('hex')});
  let simulatedFetch;
  const blockedNetwork=installNetworkGuard((url,init)=>simulatedFetch?.(url,init));
  const db=await createDatabase();
  console.log('[sandbox] disposable database ready');
  const load=name=>require(path.resolve(__dirname,'../dist',name));
  Object.assign(load('config/db.js'),db);
  const identity=createIdentity(),account=identity.create('marketing.qa@sandbox.invalid'),other=identity.create('other.qa@sandbox.invalid');
  const providers=createProviders(db,identity,base);
  const marketing=createMarketingProviders(providers);
  simulatedFetch=marketing.fetchAdapter;
  const composio=load('services/composio/composio.service.js');providers.patch(composio);
  composio.executeComposioProxy=marketing.proxy;
  console.log('[sandbox] provider adapters ready');
  const jobs=[];load('services/jobQueue.service.js').enqueueJob=async(type,payload,options)=>{jobs.push({type,payload,options});return {id:crypto.randomUUID()}};
  const auth=load('services/auth.service.js');
  auth.listGoogleAccounts=async uid=>[{id:uid,email:'calendar@sandbox.invalid',isPrimary:true,role:'personal',reauthRequired:false,expiresAt:new Date(Date.now()+3600000)}];
  const triggers=load('services/composio/composioTriggers.service.js');triggers.listEnabledAlertToolkits=async()=>[];
  const appModule=load('app.js');const app=appModule.default||appModule.app||appModule;
  console.log('[sandbox] production routes loaded');
  // Real API routes and error handling are already mounted. These local auth/provider
  // endpoints only replace external systems; no test bypass enters production source.
  identity.mount(app);
  app.get('/__sandbox/consent/:state',(req,res)=>res.type('html').send(`<meta name="viewport" content="width=device-width"><h1>Interlink sandbox consent</h1><p>This is a simulated provider. No real account is used.</p><form method="post"><button name="approved" value="yes">Authorize sandbox account</button><button name="approved" value="no">Decline</button></form>`));
  const express=require('../node_modules/express');
  app.post('/__sandbox/consent/:state',express.urlencoded({extended:false}),(req,res)=>{try{providers.complete(req.params.state,req.body.approved==='yes');res.redirect('interlinkapp://oauth/composio')}catch(e){res.status(400).send(e.message)}});
  const controlKey=crypto.randomBytes(24).toString('hex');
  app.use('/__sandbox/control',(req,res,next)=>req.headers['x-sandbox-control']===controlKey?next():res.sendStatus(403));
  app.get('/__sandbox/control',(req,res)=>res.json({sandbox:true,accounts:identity.size,posts:providers.posts.size,calls:providers.calls,jobs,blockedNetwork}));
  app.post('/__sandbox/control',async(req,res)=>{
    try {
    const b=req.body;
    if(b.connection)providers.status(account.user.id,b.connection,b.status);
    if(b.tool&&b.fault)providers.faults.set(b.tool,b.fault);
    if(b.native)await connectNative(account.user.id,b.native);
    if(b.resetLimits)for(const key of ['marketingPublishRateLimit','marketingPostStatusRateLimit'])load('middleware/rateLimit.js')[key].resetKey(account.user.id);
    res.json({ok:true});
    }catch(e){res.status(400).json({error:e.message})}
  });
  for(const a of [account,other]){
    await db.query('INSERT INTO users(id,email,full_name) VALUES($1,$2,$3)',[a.user.id,a.user.email,'Sandbox QA']);
    await db.query("INSERT INTO profession_profiles(user_id,mode,persona) VALUES($1,'professional','sales'),($1,'personal','developer')",[a.user.id]);
  }
  const server=await new Promise((resolve,reject)=>{const s=app.listen(port,'127.0.0.1',()=>resolve(s));s.once('error',reject)});
  const session=identity.session(account.user),otherSession=identity.session(other.user);
  const config={base,controlKey,email:account.user.email,password:account.password,userId:account.user.id,token:session.access_token,refreshToken:session.refresh_token,otherUserId:other.user.id,otherToken:otherSession.access_token,migrations:db.migrationCount};
  if(manifest){fs.mkdirSync(path.dirname(manifest),{recursive:true});fs.writeFileSync(manifest,JSON.stringify(config,null,2))}
  app.post('/__sandbox/control/cleanup',(req,res)=>{
    res.json({cleanupStarted:true});
    setImmediate(()=>close().then(()=>console.log('[sandbox] accounts, provider effects and database removed')).catch(e=>console.error(e.message)));
  });
  async function connectNative(uid,provider){
    if(!['todoist','notion'].includes(provider))throw Error('Unknown native sandbox provider');
    await load('services/integrations/tokenStore.js').upsertIntegration(uid,provider,{accessToken:'sandbox-native-'+uid,scopes:['sandbox']},{sandbox:true});
  }
  async function close(){identity.clear();providers.clear();marketing.clear();jobs.length=0;await new Promise(r=>server.close(r));await db.close();if(manifest&&fs.existsSync(manifest))fs.unlinkSync(manifest)}
  return {config,db,providers,marketing,identity,jobs,blockedNetwork,close,load,connectNative};
}
module.exports={startSandbox};
if(require.main===module){
 const manifest=process.argv[2]||path.join(__dirname,'.session-private.json');let runtime;
 startSandbox({manifest}).then(r=>{runtime=r;console.log(JSON.stringify({sandbox:true,base:r.config.base,migrations:r.config.migrations,accounts:r.identity.size}));}).catch(e=>{console.error(e.stack);process.exitCode=1});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(runtime)await runtime.close();process.exit(0)});
}
