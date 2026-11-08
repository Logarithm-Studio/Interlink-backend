const test = require('node:test'), assert = require('node:assert/strict');
const { startSandbox } = require('./runtime.cjs');

test('Professional workflow failures retain identity, evidence and unfinished work', async t => {
  const s = await startSandbox({ port: 4345 }), uid = s.config.userId;
  const assistant = s.load('services/accountant/assistant.service.js');
  const model = s.load('services/ai/geminiClient.js');
  const api = async (route, body, status = 200) => {
    const r = await fetch(s.config.base + '/api/v1/accountant/assistant' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + s.config.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await r.json(); assert.equal(r.status, status, JSON.stringify(data)); return data;
  };
  const persona = name => s.db.query("UPDATE profession_profiles SET persona=$2 WHERE user_id=$1 AND mode='professional'", [uid, name]);
  const invoicePlan = () => { model.isGeminiLive = () => true; model.geminiGenerateContent = async () => ({ raw: '', functionCall: { name: 'create_invoice', args: { clientName: 'Edge QA', amount: 10 } }, model: 'fixture', latencyMs: 1 }); };
  try {
    await t.test('blank and duplicate ticket subjects cannot change an arbitrary ticket', async () => {
      const support = s.load('services/professional/support/support.service.js');
      const first = await support.createTicket(uid, { subject: 'Duplicate QA' });
      await support.createTicket(uid, { subject: 'Duplicate QA' });
      for (const subject of ['', 'Duplicate QA']) {
        const result = await support.supportVertical.executeTool({ id: uid }, 'resolve_ticket', { subject });
        assert.equal(result.ok, false);
      }
      assert.equal((await support.listTickets(uid)).find(x => x.id === first.id).status, 'open');
    });
    await t.test('offline screening never fabricates and saves a candidate score', async () => {
      const hr = s.load('services/professional/hr/hr.vertical.js');
      const candidate = await hr.createCandidate(uid, { name: 'Offline QA', role: 'Engineer', resumeText: 'Three years TypeScript.' });
      model.isGeminiLive = () => false;
      const result = await hr.hrVertical.executeTool({ id: uid }, 'screen_resume', { name: candidate.name });
      assert.equal(result.ok, false);
      const saved = (await hr.listCandidates(uid)).find(x => x.id === candidate.id);
      assert.equal(saved.score, null); assert.equal(saved.stage, 'applied');
    });
    await t.test('failed PM sources are unavailable evidence, never a clean empty contribution report', async () => {
      const github = s.load('services/pm/github.service.js'), jira = s.load('services/jira/jira.service.js');
      for (const name of ['getRecentCommits', 'getMergedPullRequests', 'getPullRequests']) github[name] = async () => { throw Error('Controlled source outage'); };
      jira.searchIssues = async () => { throw Error('Controlled source outage'); };
      const pm = s.load('services/professional/pm/pm.vertical.js');
      const result = await pm.pmVertical.executeTool({ id: uid }, 'contribution_summary', { repo: 'fixture/app' });
      assert.equal(result.ok, false); assert.match(result.message, /unavailable|failed|could not/i);
    });
    await t.test('invalid attachment corrections retain the existing review', async () => {
      await persona('finance'); invoicePlan();
      const first = await api('/command', { message: 'Create an invoice for Edge QA for ten dollars.' });
      await api('/command', { conversationId: first.conversationId, message: 'Use the attached file instead.', attachmentBase64: '@@@', attachmentMimeType: 'application/octet-stream', attachmentName: 'broken.exe' }, 400);
      const restored = (await api('/tasks/' + first.task.id)).task;
      assert.equal(restored.status, 'review'); assert.equal(restored.action.id, first.action.id);
    });
    await t.test('changing role cannot consume a proposal under another role', async () => {
      await persona('finance'); invoicePlan();
      const first = await api('/command', { message: 'Create an invoice for Role QA for ten dollars.' });
      await persona('customer_support');
      await api('/tasks/' + first.task.id + '/actions/' + first.action.id + '/execute', {}, 409);
      assert.equal((await api('/tasks/' + first.task.id)).task.status, 'review');
      const outcome = await assistant.executeAction({id:uid},'create_google_task',{title:'Must not run after a role change'},undefined,undefined,undefined,'finance');
      assert.equal(outcome.ok,false);assert.match(outcome.message,/role changed/i);
    });
    await t.test('a clarification during continuation keeps the original task unfinished', async () => {
      await persona('finance'); invoicePlan();
      const first = await api('/command', { message: 'Create an invoice for Edge QA, then send a reviewed update after I choose the recipient.' });
      assert.equal((await api('/tasks/' + first.task.id + '/actions/' + first.action.id + '/execute', {})).ok, true);
      model.geminiGenerateContent = async () => ({ raw: '', functionCall: { name: 'ask_professional_question', args: { question: 'Which recipient should receive the update?' } }, model: 'fixture', latencyMs: 1 });
      const next = await api('/tasks/' + first.task.id + '/continue', {});
      assert.equal(next.action, null); assert.equal(next.task.status, 'paused'); assert.match(next.answer, /Which recipient/);
      assert.match(next.task.goal, /Create an invoice/);
    });
    await t.test('concurrent initial commands in the same chat cannot create two live reviews', async () => {
      await persona('finance'); invoicePlan();
      const id = require('node:crypto').randomUUID();
      await s.db.query('INSERT INTO accountant_conversations(id,user_id,title) VALUES($1,$2,$3)',[id,uid,'Concurrent fixture']);
      model.geminiGenerateContent = async () => { await new Promise(resolve=>setTimeout(resolve,30)); return {raw:'',functionCall:{name:'create_invoice',args:{clientName:'Concurrent QA',amount:10}},model:'fixture',latencyMs:1}; };
      const results = await Promise.allSettled([assistant.command(uid,'Create an invoice for Concurrent QA for ten dollars.',id),assistant.command(uid,'Create an invoice for Concurrent QA for ten dollars.',id)]);
      assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
      assert.equal(results.find(result=>result.status==='rejected').reason.statusCode,409);
      assert.equal((await s.db.query("SELECT id FROM autolink_tasks WHERE conversation_id=$1 AND status='review'",[id])).rows.length,1);
    });
    await t.test('initial attachment questions and pre-write outages retain their source context', async () => {
      await persona('finance'); invoicePlan();
      const file={attachmentName:'initial.txt',attachmentMimeType:'text/plain',attachmentBase64:Buffer.from('Actual initial source brief.').toString('base64')};
      model.geminiGenerateContent=async()=>({raw:'',functionCall:{name:'ask_professional_question',args:{question:'Which client should receive this invoice?'}},model:'fixture',latencyMs:1});
      const first=await api('/command',{message:'Use the attached brief to prepare an invoice; ask me which client first.',...file});
      assert.equal(first.task.status,'paused');assert.equal(first.task.steps.length,0);
      const tasks=s.load('services/accountant/agent-task.service.js'),context=await tasks.getAgentTaskContext(uid,first.task.id);
      assert(context.sourceAttachmentDigest);assert.equal(context.persona,'finance');
      model.geminiGenerateContent=async()=>{throw Error('Controlled pre-write outage')};
      await api('/command',{message:'Use Source QA as the client.',conversationId:first.conversationId,...file},503);
      assert.equal((await tasks.getAgentTaskContext(uid,first.task.id)).sourceAttachmentDigest,context.sourceAttachmentDigest);
      await s.db.query("UPDATE autolink_tasks SET status='planning',updated_at=now()-interval '3 minutes' WHERE id=$1",[first.task.id]);
      assert.equal((await tasks.getAgentTask(uid,first.task.id)).status,'ready');
    });
    await t.test('initial prose questions become durable tasks in every Professional role',async()=>{
      for(const role of ['finance','sales','hr','product_manager','customer_support','real_estate']){
        await persona(role);let calls=0;
        model.geminiGenerateContent=async()=>++calls===1?{raw:'Which title should I use?',model:'fixture',latencyMs:1}:{raw:'',functionCall:{name:'ask_professional_question',args:{question:'Which title should I use?'}},model:'fixture',latencyMs:1};
        const response=await api('/command',{message:'Use this attached brief; ask me for a title before saving anything.',attachmentName:'brief.txt',attachmentMimeType:'text/plain',attachmentBase64:Buffer.from('Actual source with no title.').toString('base64')});
        assert.equal(response.task?.status,'paused',role+' must retain an initial prose clarification');
        assert.equal(response.action,null);assert.equal(response.task.steps.length,0);
      }
    });
  } finally { await s.close(); }
});
