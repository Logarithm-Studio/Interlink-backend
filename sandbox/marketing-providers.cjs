const crypto=require('node:crypto');
function createMarketingProviders(providers) {
  const mail=new Map(),crm={contacts:new Map(),deals:new Map()},tasks=new Map(),pages=new Map(),requests=[];
  const faults=new Map();let seq=0;
  const ok=data=>({status:200,data});
  const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
  async function proxy(uid,provider,endpoint,method,body={}){
    requests.push({uid,provider,endpoint,method,body:structuredClone(body)});
    if(!(await providers.list(uid)).some(c=>c.toolkitSlug===provider&&c.status==='active'))return {status:401,data:{message:'Sandbox connection expired'}};
    const fault=faults.get(provider+':'+method+':'+endpoint);faults.delete(provider+':'+method+':'+endpoint);
    if(fault==='denied')return {status:403,data:{message:'Simulated insufficient permissions'}};
    if(fault==='rate_limit')return {status:429,data:{message:'Simulated rate limit'}};
    if(provider==='mailchimp'){
      if(endpoint==='/lists')return ok({lists:[{id:'sandbox-audience',name:'Sandbox recipients only',stats:{member_count:2,unsubscribe_count:0}}]});
      if(endpoint==='/campaigns'&&method==='POST'){const id='mc-'+(++seq),c={id,uid,status:'save',...body,recipients:{...body.recipients,recipient_count:2}};mail.set(id,c);return ok(c)}
      const parts=endpoint.split('/').filter(Boolean),c=mail.get(parts[1]);
      if(c&&c.uid===uid){
        if(parts[0]==='reports')return ok({emails_sent:2,opens:2,unique_opens:1,clicks:1,unique_clicks:1,unsubscribed:0,bounces:{hard_bounces:0,soft_bounces:0},open_rate:0.5,click_rate:0.5});
        if(parts[2]==='send-checklist')return ok(fault==='checklist'?{is_ready:false,items:[{is_ready:false,heading:'Sender',details:'Verify sender'}]}:{is_ready:true,items:[]});
        if(parts[2]==='content'){c.content=body;return ok({})}
        if(parts[2]==='actions'){
          c.status=parts[3]==='send'?'sent':parts[3]==='schedule'?'schedule':'save';if(body.schedule_time)c.send_time=body.schedule_time;
          if(fault==='timeout_after_write')return {status:504,data:{message:'Simulated timeout after write'}};
          return ok({});
        }
        if(method==='PATCH')Object.assign(c,body);return ok(c);
      }
      return {status:404,data:{message:'Unknown sandbox email campaign'}};
    }
    if(provider==='hubspot'){
      if(endpoint.includes('/pipelines/'))return ok({results:[{id:'sandbox-pipeline',label:'Sandbox pipeline',stages:['lead','qualified','proposal','negotiation','nurture','won','lost'].map(id=>({id,label:id,metadata:{isClosed:['won','lost'].includes(id),probability:id==='won'?'1':id==='lost'?'0':'0.5'}}))}]});
      if(endpoint.includes('/owners/'))return ok({results:[{id:'sandbox-owner',email:'owner@sandbox.invalid',firstName:'Sandbox',lastName:'Owner'}]});
      if(endpoint.endsWith('/labels'))return ok({results:[{category:'HUBSPOT_DEFINED',typeId:3,label:null}]});
      if(endpoint.includes('/associations/'))return ok({});
      const kind=endpoint.includes('/contacts')?'contacts':endpoint.includes('/deals')?'deals':null;
      if(kind){const map=crm[kind],parts=endpoint.split('/'),last=parts.at(-1);
        if(last==='search'){const filters=body.filterGroups?.[0]?.filters||[];return ok({results:[...map.values()].filter(x=>x.uid===uid&&filters.every(f=>f.operator==='EQ'?x.properties[f.propertyName]===f.value:String(x.properties[f.propertyName]||'').includes(f.value)))})}
        if(last===kind&&method==='POST'){const record={id:'hs-'+(++seq),uid,properties:{...body.properties},updatedAt:new Date().toISOString()};map.set(record.id,record);return ok(record)}
        const record=map.get(last);if(!record||record.uid!==uid)return {status:404,data:{message:'Unknown sandbox CRM record'}};
        if(method==='PATCH'){Object.assign(record.properties,body.properties);record.updatedAt=new Date().toISOString()}return ok(record);
      }
    }
    throw Error('Unsupported sandbox proxy: '+provider+' '+method+' '+endpoint);
  }
  function fetchAdapter(url,init={}){
    if(!['api.todoist.com','api.notion.com'].includes(url.hostname))return undefined;
    const headers=new Headers(init.headers),authorization=headers.get('authorization')||'';
    if(!authorization.startsWith('Bearer sandbox-native-'))return json({message:'Invalid simulated provider token'},401);
    const uid=authorization.slice('Bearer sandbox-native-'.length),method=init.method||'GET',body=init.body?JSON.parse(init.body):{};
    requests.push({uid,provider:url.hostname,endpoint:url.pathname,method,body});
    const fault=faults.get(method+':'+url.pathname);faults.delete(method+':'+url.pathname);
    if(fault==='denied')return json({message:'Simulated provider permission denied'},403);
    if(url.hostname==='api.todoist.com'){
      const p=url.pathname.replace('/api/v1','');
      if(p==='/projects')return json({results:[{id:'sandbox-project',name:'Sandbox marketing',color:'blue',is_favorite:true}],next_cursor:null});
      if(p==='/tasks'&&method==='POST'){
        const record={id:'task-'+(++seq),uid,content:body.content,description:body.description,project_id:body.project_id||'sandbox-project',priority:body.priority,added_at:new Date().toISOString(),is_completed:false,checked:false,labels:[]};tasks.set(record.id,record);return json(record);
      }
      if(p==='/tasks'||p==='/tasks/completed/by_completion_date')return json({results:[...tasks.values()].filter(x=>x.uid===uid&&(p.includes('completed')?x.is_completed:!x.is_completed)),next_cursor:null});
      const task=tasks.get(p.split('/')[2]);if(task&&task.uid===uid){if(p.endsWith('/close')){task.is_completed=true;task.checked=true;return new Response(null,{status:204})}return json(task)}
      return json({message:'Unknown sandbox task'},404);
    }
    if(url.pathname==='/v1/search')return json({results:body.filter?.value==='data_source'?[{id:'sandbox-data-source',title:[{plain_text:'Sandbox briefs'}],parent:{database_id:'sandbox-database'},url:'https://www.notion.so/sandbox'}]:[{id:'sandbox-parent',url:'https://www.notion.so/sandbox',properties:{title:{title:[{plain_text:'Sandbox workspace'}]}},last_edited_time:new Date().toISOString()}],has_more:false});
    if(url.pathname==='/v1/data_sources/sandbox-data-source')return json({id:'sandbox-data-source',properties:{Name:{type:'title'},'Campaign ID':{type:'rich_text'},Objective:{type:'rich_text'}}});
    if(url.pathname.endsWith('/query')){const property=body.filter?.property,value=body.filter?.rich_text?.equals;return json({results:[...pages.values()].filter(x=>x.uid===uid&&x.properties?.[property]?.rich_text?.[0]?.text?.content===value),has_more:false})}
    if(url.pathname==='/v1/pages'&&method==='POST'){
      const page={id:crypto.randomUUID(),uid,url:'https://www.notion.so/sandbox-'+(++seq),properties:body.properties,parent:body.parent,last_edited_time:new Date().toISOString()};pages.set(page.id,page);
      if(fault==='timeout_after_write')throw Error('Simulated Notion timeout after create');return json(page);
    }
    return json({message:'Unsupported sandbox Notion request'},404);
  }
  return {proxy,fetchAdapter,mail,crm,tasks,pages,requests,faults,clear:()=>{mail.clear();crm.contacts.clear();crm.deals.clear();tasks.clear();pages.clear();requests.length=0;faults.clear()}};
}
module.exports={createMarketingProviders};
