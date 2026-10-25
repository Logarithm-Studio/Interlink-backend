const crypto = require('node:crypto');
function createProviders(db, identity, base) {
  const connections = new Map(), consent = new Map(), posts = new Map(), calls = [], faults = new Map();
  let sequence = 100000;
  const targets = { facebook: '1234567890', instagram: '7890123456', linkedin: 'urn:li:person:sandbox123' };
  const key = (uid, slug) => uid+':'+slug;
  function status(uid, slug, state) {
    connections.set(key(uid,slug), { toolkitSlug: slug, name: 'Sandbox '+slug, connectedAccountId: 'sandbox-'+slug, status: state });
  }
  const list = async uid => [...connections].filter(([k])=>k.startsWith(uid+':')).map(([,v])=>({...v}));
  async function connect(uid, slug) {
    const state = crypto.randomBytes(24).toString('hex');
    status(uid,slug,'pending'); consent.set(state,{uid,slug,expires:Date.now()+300000});
    return base+'/__sandbox/consent/'+state;
  }
  function complete(state, approved) {
    const c = consent.get(state); consent.delete(state);
    if (!c || c.expires < Date.now()) throw Error('Expired or consumed sandbox consent');
    status(c.uid,c.slug,approved?'active':'failed'); return c;
  }
  async function execute(uid, slug, args) {
    calls.push({ uid, slug, args: structuredClone(args) });
    const toolkit = slug.startsWith('GOOGLE_ANALYTICS_')?'google_analytics':slug.startsWith('GOOGLE_SEARCH_CONSOLE_')?'google_search_console':slug.split('_')[0].toLowerCase();
    if (!connections.get(key(uid,toolkit)) || connections.get(key(uid,toolkit)).status!=='active') return { ok:false, message:'Sandbox account is disconnected or expired' };
    const fault = faults.get(slug); faults.delete(slug);
    if (fault === 'denied') return {ok:false,message:'Sandbox provider denied the required permission'};
    if (fault === 'rate_limit') return {ok:false,message:'Sandbox provider rate limit'};
    const wrap = data => ({ok:true,data:{data},message:'Simulated provider response'});
    if (fault === 'malformed') return wrap({});
    switch(slug) {
      case 'FACEBOOK_LIST_MANAGED_PAGES': return wrap(fault==='no_targets'?[]:[{id:targets.facebook,name:'Sandbox Page'}]);
      case 'INSTAGRAM_GET_USER_INFO': return wrap({id:targets.instagram,username:'interlink_sandbox'});
      case 'LINKEDIN_GET_MY_INFO': return wrap({id:'sandbox123',localizedFirstName:'Sandbox',localizedLastName:'QA'});
      case 'FACEBOOK_CREATE_POST': case 'FACEBOOK_CREATE_PHOTO_POST': case 'FACEBOOK_CREATE_VIDEO_POST': {
        const id=targets.facebook+'_'+(++sequence); posts.set(id,{uid,provider:'facebook',target:args.page_id,body:args.message||args.description,live:true});
        if(fault==='timeout_after_write') return {ok:false,message:'Simulated timeout after provider accepted write'};
        return wrap(slug==='FACEBOOK_CREATE_PHOTO_POST'?{id:String(++sequence),post_id:id}:{id});
      }
      case 'INSTAGRAM_POST_IG_USER_MEDIA': {
        const id=String(++sequence); posts.set('container:'+id,{uid,provider:'instagram',target:args.ig_user_id,body:args.caption});return wrap({id});
      }
      case 'INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH': {
        const container=posts.get('container:'+args.creation_id);if(!container)return {ok:false,message:'Unknown media container'};
        const id=String(1000000000+(++sequence));posts.set(id,{...container,live:true});
        if(fault==='timeout_after_write')return {ok:false,message:'Simulated timeout after publish'};
        return wrap({id});
      }
      case 'LINKEDIN_CREATE_LINKED_IN_POST': {
        const id='urn:li:share:'+(++sequence);posts.set(id,{uid,provider:'linkedin',target:args.author,body:args.commentary,live:true});
        if(fault==='timeout_after_write')return {ok:false,message:'Simulated timeout after publish'};
        return wrap({id});
      }
      case 'FACEBOOK_GET_POST': {
        const p=posts.get(args.post_id);if(!p||p.uid!==uid)return {ok:false,message:'Sandbox post not found'};
        return wrap({id:args.post_id,is_published:p.live,created_time:new Date().toISOString(),permalink_url:'https://www.facebook.com/'+args.post_id,likes:{summary:{total_count:7}},comments:{summary:{total_count:2}},shares:{count:1}});
      }
      case 'FACEBOOK_GET_POST_INSIGHTS': return wrap([{name:'post_media_view',values:[{value:31}]},{name:'post_total_media_view_unique',values:[{value:23}]}]);
      case 'FACEBOOK_GET_PAGE_INSIGHTS': return wrap([{name:'page_media_view',values:[{value:82}]},{name:'page_post_engagements',values:[{value:11}]}]);
      case 'INSTAGRAM_GET_USER_INSIGHTS': return wrap([{name:'reach',values:[{value:64}]},{name:'views',values:[{value:91}]}]);
      case 'GOOGLE_ANALYTICS_LIST_ACCOUNT_SUMMARIES': return wrap({accountSummaries:[{propertySummaries:[{property:'properties/123456',displayName:'Sandbox GA4'}]}]});
      case 'GOOGLE_SEARCH_CONSOLE_LIST_SITES': return wrap({siteEntry:[{siteUrl:'https://sandbox.invalid/',permissionLevel:'siteOwner'}]});
      case 'GOOGLEADS_LIST_ACCESSIBLE_CUSTOMERS': return wrap({resource_names:['customers/1234567890']});
      case 'GOOGLEADS_LIST_SUB_ACCOUNTS': return wrap({sub_accounts:[]});
      case 'GOOGLEADS_SEARCH_STREAM_GAQL': return wrap({results:[{customer:{id:'1234567890',currencyCode:'USD'},campaign:{id:'campaign-1',name:'Sandbox traffic',status:'ENABLED'},metrics:{impressions:'100',clicks:'8',costMicros:'2500000',conversions:'1',conversionsValue:'10'}}]});
      case 'STRIPE_LIST_BALANCE_TRANSACTIONS': return wrap({data:[{id:'txn-sandbox',type:'charge',amount:1000,fee:30,net:970,currency:'usd',created:1790812800}],has_more:false});
      case 'GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY': return wrap({rows:[{keys:[args.dimensions?.[0]==='date'?'2026-10-01':args.dimensions?.[0]==='page'?'https://sandbox.invalid/qa?private=removed':'sandbox automation'],clicks:7,impressions:40,ctr:0.175,position:3}]});
      case 'GOOGLE_ANALYTICS_RUN_REPORT': {
        const names=(args.metrics||[]).map(x=>typeof x==='string'?x:x.name),dims=(args.dimensions||[]).map(x=>typeof x==='string'?x:x.name);
        return wrap({metricHeaders:names.map(name=>({name})),dimensionHeaders:dims.map(name=>({name})),rows:[{dimensionValues:dims.map(name=>({value:name==='date'?'20261001':name==='landingPage'?'/qa?private=removed':name==='sessionDefaultChannelGroup'?'Organic Search':name==='sessionSourceMedium'?'google / organic':'Sandbox campaign'})),metricValues:names.map(name=>({value:name.toLowerCase().includes('revenue')?'25.50':'12'}))}]});
      }
      case 'INSTAGRAM_GET_IG_MEDIA': {
        const p=posts.get(args.ig_media_id);if(!p||p.uid!==uid)return {ok:false,message:'Sandbox media not found'};
        return wrap({id:args.ig_media_id,owner:{id:fault==='wrong_owner'?'0000000000':p.target},media_type:'IMAGE',permalink:'https://www.instagram.com/p/sandbox/',timestamp:new Date().toISOString(),like_count:9,comments_count:3});
      }
      case 'LINKEDIN_GET_POST_CONTENT': {
        const p=posts.get(args.post_id);if(!p||p.uid!==uid)return {ok:false,message:'Sandbox post not found'};
        return wrap({id:args.post_id,author:fault==='wrong_owner'?'urn:li:person:other':p.target,createdAt:Date.now(),lifecycleState:p.live?'PUBLISHED':'DRAFT'});
      }
      default: throw Error('Unsupported sandbox provider tool: '+slug);
    }
  }
  function patch(composio) {
    composio.isComposioLive=()=>true; composio.listConnections=list; composio.syncConnections=list;
    composio.connectToolkit=async(uid,slug)=>({redirectUrl:await connect(uid,slug)}); composio.disconnectToolkit=async(uid,slug)=>status(uid,slug,'revoked');
    composio.executeComposioTool=execute;
    composio.executeComposioProxy=async()=>{throw Error('Unsupported sandbox provider proxy')};
    composio.getComposioToolsForUser=async()=>[];
  }
  return {patch,status,list,connect,complete,calls,posts,faults,targets,clear:()=>{connections.clear();consent.clear();posts.clear();calls.length=0;faults.clear()}};
}
module.exports={createProviders};
