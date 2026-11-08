const test = require('node:test'), assert = require('node:assert/strict');
const { startSandbox } = require('./runtime.cjs');

test('every advertised Professional native workflow traverses planning, review, execution and receipts', async t => {
  const s = await startSandbox({ port: 4346 }), uid = s.config.userId;
  const user = { id: uid, email: s.config.email }, load = s.load;
  const { VERTICALS } = load('services/professional/registry.js');
  const { AGENT_TOOLS } = load('services/ai/prompts/agentTools.js');
  const assistant = load('services/accountant/assistant.service.js'), model = load('services/ai/geminiClient.js');
  const effects = [], readings = [];
  for (const [persona, vertical] of Object.entries(VERTICALS)) {
    const execute = vertical.executeTool;
    vertical.executeTool = async (...args) => { const result = await execute(...args); readings.push({ persona, name: args[1], result }); return result; };
  }
  const api = async (route, body) => {
    const r = await fetch(s.config.base + '/api/v1/accountant/assistant' + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + s.config.token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await r.json(); assert.equal(r.status, 200, JSON.stringify(data)); return data;
  };
  try {
    const tokens = load('services/integrations/tokenStore.js'); tokens.isConnected = async () => true;
    load('services/professional/draft.js').draftEmail = async () => ({ subject: 'Exact fixture subject', body: 'Exact fixture copy from the supplied brief.', isFallback: false });
    const gmail = load('services/email/gmail.service.js');
    gmail.createGmailDraft = async value => { effects.push({ provider: 'gmail-draft', value }); return { providerDraftId: 'draft-' + effects.length }; };
    gmail.sendGmailDraft = async value => { effects.push({ provider: 'gmail-send', value }); return { messageId: 'message-' + effects.length, alreadySent: false }; };
    const ai = load('services/ai/ai.service.js');
    ai.generateDunningEmail = async () => ({ email: { subject: 'Invoice reminder QA', body: 'Please review the unpaid invoice.', escalationTone: 'friendly' }, isFallback: false });
    ai.generateTaxRequestEmail = async () => ({ data: { subject: 'Tax request QA', body: 'Please provide the requested W-9 document.' }, isFallback: false });
    ai.generateFlashReport = async ({ context }) => ({ data: { summary: 'Fixture summary of the actual supplied ledger totals.', totals: { outstandingCents: context.outstandingCents, overdueCents: context.overdueCents, collectedCents: context.collectedCents, expensesCents: context.expensesCents }, cashRunwayNote: 'No cash forecast supplied.', insights: [], recommendations: [] }, isFallback: false });
    ai.generateExpenseAudit = async () => ({ data: { findings: [] }, isFallback: false });
    const gh = load('services/pm/github.service.js'), jira = load('services/jira/jira.service.js');
    Object.assign(gh, { getRepos: async () => [{ id: 1, fullName: 'fixture/app', openIssues: 1 }], getPullRequests: async () => [{ number: 2, title: 'Open change', author: 'QA' }], getMergedPullRequests: async () => [{ number: 1, title: 'Merged retry fix', author: 'QA' }], getIssues: async () => [{ number: 3, title: 'Retry defect' }], getRecentCommits: async () => [{ sha: 'abc1234', message: 'Retry fix', author: 'QA' }], createIssue: async (_u, owner, repo, value) => { effects.push({ provider: 'github', value }); return { id: 7, number: 7, title: value.title, htmlUrl: `https://example.invalid/${owner}/${repo}/issues/7` }; } });
    Object.assign(jira, { getProjects: async () => [{ key: 'QA', name: 'Fixture project' }], searchIssues: async () => [{ key: 'QA-1', summary: 'Offline retry', status: 'Open', assignee: 'QA Engineer' }] });
    Object.assign(load('services/notion/notion.service.js'), { searchPages: async () => [{ id: '11111111-1111-4111-8111-111111111111', title: 'QA source' }], getPageContent: async () => 'Support offline retries and reject duplicate submissions.' });
    Object.assign(load('services/slack/slack.service.js'), { getChannels: async () => [{ id: 'CQA', name: 'qa', isMember: true }], getRecentMessages: async () => ['Critical duplicate submission bug.'], postMessage: async (_u, channel, text) => { effects.push({ provider: 'slack', channel, text }); return { ts: '1.1', channel }; } });
    const cards = [{ id: 'original-card', name: 'Imported matrix opportunity', listId: 'list-lead', desc: 'Fixture import.' }];
    Object.assign(load('services/pm/trello.service.js'), { getBoards: async () => [{ id: 'board-qa', name: 'QA pipeline' }], getListsForBoard: async () => ['lead', 'qualified', 'proposal', 'negotiation', 'nurture', 'won', 'lost'].map(stage => ({ id: 'list-' + stage, name: stage })), getCardsForBoard: async () => cards, createCard: async (_u, listId, value) => { const card = { id: 'card-' + cards.length, listId, ...value }; cards.push(card); effects.push({ provider: 'trello', card }); return card; }, updateCard: async (_u, id, value) => { effects.push({ provider: 'trello-update', id, value }); return { id, ...value }; } });
    Object.assign(load('services/hr/calendar-hr.service.js'), { getUpcomingInterviews: async () => [{ id: 'event-read', summary: 'Fixture interview', start: '2030-11-09T09:00:00Z' }], findFreeSlots: async () => [{ start: '2030-11-09T09:00:00Z', end: '2030-11-09T10:00:00Z' }], scheduleInterview: async (_u, value) => { effects.push({ provider: 'calendar', value }); return { id: 'event-qa', summary: 'Fixture interview', start: value.startTime, end: value.endTime }; } });
    load('services/professional/realestate/rentcast.service.js').isRentCastConfigured = () => false;
    load('services/professional/realestate/rapidListings.service.js').isRapidListingsConfigured = () => false;
    Object.assign(load('services/professional/realestate/simplyrets.service.js'), { isSimplyRetsLive: () => false, searchSimplyRets: async () => [{ address: 'Demo property', city: 'Houston', state: 'TX', priceCents: 30000000, beds: 3, baths: 2 }] });
    Object.assign(load('services/professional/realestate/census.service.js'), { isCensusConfigured: () => true, getCensusMarketStats: async zipCode => ({ zipCode, medianHomeValueCents: 30000000, medianGrossRentCents: 200000, ownerOccupiedPct: 50, source: 'Fixture Census observation' }) });

    const sales = load('services/professional/sales/sales.service.js'), hr = load('services/professional/hr/hr.vertical.js'), support = load('services/professional/support/support.service.js'), re = load('services/professional/realestate/realestate.service.js');
    const contact = await sales.createContact(uid, { name: 'Matrix contact', email: 'contact@sandbox.invalid' });
    await sales.updateContact(uid, contact.id, { marketingOptIn: true, marketingOptInSource: 'email_request', marketingOptInEvidence: 'Fixture permission only' });
    const rep = await sales.createRep(uid, { name: 'Matrix rep', email: 'rep@sandbox.invalid' });
    const deal = await sales.createMarketingOpportunity(uid, { title: 'Matrix linked deal', contactId: contact.id, amountCents: 100000, currency: 'USD' });
    const candidate = await hr.createCandidate(uid, { name: 'Matrix candidate', email: 'candidate@sandbox.invalid', role: 'Engineer', resumeText: 'Three years TypeScript; built retry queues.' });
    const ticket = await support.createTicket(uid, { subject: 'Matrix ticket', body: 'Duplicate submission after offline retry.', customerEmail: 'customer@sandbox.invalid' });
    const listing = await re.createListing(uid, { address: '12 Matrix Lane', priceCents: 30000000, beds: 3, baths: 2 });
    const lead = await re.createLead(uid, { name: 'Matrix buyer', email: 'buyer@sandbox.invalid', budgetCents: 40000000, interest: '3 bedrooms' });
    const lease = await re.createLease(uid, { property: '12 Matrix Lane lease', tenantName: 'Matrix tenant', tenantEmail: 'tenant@sandbox.invalid', endDate: '2030-12-01', rentCents: 200000 });
    const invoices = load('services/accountant/invoices.service.js');
    const invoice = await invoices.createInvoice(uid, { clientName: 'Matrix invoice client', clientEmail: 'invoice@sandbox.invalid', amountCents: 10000, invoiceNumber: 'MATRIX-1' });
    await invoices.createInvoice(uid, { clientName: 'Matrix overdue', clientEmail: 'overdue@sandbox.invalid', amountCents: 20000, dueDate: '2020-01-01', invoiceNumber: 'MATRIX-2' });
    const advisor = load('services/accountant/advisor.service.js'); await advisor.seedDemoAdvisor(uid);
    const advisoryClient = (await advisor.listClients(uid))[0];
    const tax = load('services/accountant/tax.service.js'); await tax.seedDemoContractors(uid);
    const contractor = (await tax.listContractors(uid)).find(tax.needsW9);
    const cases = {
      finance: {
        create_invoice: { clientName: 'Matrix new invoice', amount: 25, currency: 'USD' }, send_reminder: { invoiceId: invoice.id }, remind_all_overdue: {}, run_expense_audit: {}, email_flash_report: {}, pause_client: { clientName: 'Matrix overdue' }, gather_tax_docs: { contractorName: contractor.name }, prepare_meeting_packet: { clientName: advisoryClient.id }, send_client_update: { clientName: advisoryClient.id, topic: 'Portfolio review' }, resolve_compliance: { clientName: advisoryClient.id }, set_automation: { type: 'expense_audit', autonomy: 'off' },
      },
      sales: {
        create_contact: { name: 'Matrix new contact', email: 'new-contact@sandbox.invalid' }, create_deal: { title: 'Matrix new deal', amountCents: 50000, currency: 'BDT' }, advance_stage: { dealId: deal.id, stage: 'proposal' }, draft_followup: { contactId: contact.id }, draft_campaign: { topic: 'Retry-safe launch', objective: 'Research market fit' }, enrich_lead: { emailText: 'Enriched Matrix <enriched@sandbox.invalid> from Matrix Studio.' }, meeting_followup: { dealId: deal.id, summary: 'Validate retry requirements.' }, generate_contract: { dealId: deal.id, requirements: 'Deliver reviewed audience research.', signerName: contact.name, signerEmail: contact.email }, route_lead: { contactId: contact.id, repId: rep.id }, reengage_deal: { dealId: deal.id }, mark_contract_signed: { dealId: deal.id }, sync_pipeline_to_trello: { boardId: 'board-qa' }, import_from_trello: { boardId: 'board-qa' }, post_pipeline_to_slack: { channel: 'CQA' }, log_activity: { note: 'Matrix QA completed internal research.' },
      },
      hr: { add_candidate: { name: 'Matrix new candidate', role: 'Engineer', resumeText: 'Actual supplied resume.' }, screen_resume: { candidateId: candidate.id }, advance_candidate: { candidateId: candidate.id, stage: 'interview' }, draft_outreach: { candidateId: candidate.id }, view_interviews: {}, check_availability: { date: '2030-11-09' }, schedule_interview: { candidateId: candidate.id, interviewerEmail: 'interviewer@sandbox.invalid', startTime: '2030-11-09T09:00:00Z', endTime: '2030-11-09T10:00:00Z' } },
      customer_support: { triage_ticket: { ticketId: ticket.id, priority: 'high' }, draft_reply: { ticketId: ticket.id }, escalate_ticket: { ticketId: ticket.id }, resolve_ticket: { ticketId: ticket.id } },
      real_estate: { create_listing: { address: '13 Matrix Lane', priceCents: 25000000 }, draft_listing_description: { listingId: listing.id }, qualify_lead: { leadId: lead.id, stage: 'qualified' }, follow_up_lead: { leadId: lead.id }, schedule_showing: { address: listing.address, leadName: lead.name, when: '2030-11-09T09:00:00Z' }, lease_renewal: { leaseId: lease.id }, match_buyers: { leadId: lead.id }, publish_listing: { listingId: listing.id }, send_listing_to_buyer: { leadId: lead.id, listingId: listing.id }, search_market: { city: 'Houston', state: 'TX' }, market_report: { zipCode: '77001' }, transaction_tasks: { property: listing.address, closeDate: '2030-12-01' } },
      product_manager: { create_issue: { repo: 'fixture/app', title: 'Review retry edge cases', body: 'Reject duplicate submission.' }, summarize_prs: { repo: 'fixture/app' }, generate_standup: { repo: 'fixture/app' }, contribution_summary: { repo: 'fixture/app' }, prd_to_tickets: { prdText: 'Support offline retries and reject duplicate submissions.', projectKey: 'QA' }, sprint_interruption: { defect: 'Critical duplicate submissions.', projectKey: 'QA' }, release_notes: { repo: 'fixture/app' }, status_sync: { repo: 'fixture/app' }, scope_creep_check: { baselineText: 'Support offline retries.', amendmentText: 'Also prevent duplicate submissions.' } },
    };
    cases.hr.create_opening = { title: 'Matrix opening', department: 'Engineering', location: 'Remote' };
    cases.customer_support.create_ticket = { subject: 'Matrix new support ticket', body: 'Actual supplied retry defect.', customerEmail: 'new-customer@sandbox.invalid', priority: 'high' };
    cases.real_estate.create_buyer_lead = { name: 'Matrix new buyer', email: 'new-buyer@sandbox.invalid', budgetCents: 40000000, interest: '3 bedrooms' };
    for (const [persona, workflows] of Object.entries(cases)) {
      await s.db.query("UPDATE profession_profiles SET persona=$2 WHERE user_id=$1 AND mode='professional'", [uid, persona]);
      const declarations = persona === 'finance' ? AGENT_TOOLS : VERTICALS[persona].tools;
      assert.deepEqual(declarations.map(x => x.name).sort(), Object.keys(workflows).sort(), 'Every advertised persona tool must have an actual workflow case');
      for (const [name, args] of Object.entries(workflows)) {
        await t.test(persona + ': ' + name + ' rejects malformed execution arguments', async () => {
          const count = effects.length;
          const result = await assistant.executeAction(user, name, []);
          assert.equal(result.ok, false); assert.equal(effects.length, count);
        });
        for (const attached of [false, true]) await t.test(persona + ': ' + name + (attached ? ' with UTF-8 attachment' : ' without attachment') + ' follows the real executor', async () => {
          const requestedArgs = structuredClone(args);
          if (name === 'resolve_compliance') await s.db.query("UPDATE advisor_compliance_items SET status='open' WHERE user_id=$1 AND client_id=$2", [uid, advisoryClient.id]);
          if (attached && ['create_invoice', 'create_contact', 'create_deal', 'add_candidate', 'create_listing', 'create_issue', 'create_opening', 'create_ticket', 'create_buyer_lead'].includes(name)) {
            const key = name === 'create_invoice' ? 'clientName' : name === 'create_listing' ? 'address' : name === 'create_ticket' ? 'subject' : ['create_issue', 'create_deal', 'create_opening'].includes(name) ? 'title' : 'name';
            requestedArgs[key] += ' attached';
          }
          model.isGeminiLive = () => true;
          let turn = 0;
          model.geminiGenerateContent = async options => {
            if (options.json) return { raw: JSON.stringify({ score: 84, name: 'Enriched Matrix', email: 'enriched@sandbox.invalid', company: 'Matrix Studio', stories: [{ summary: 'Reject duplicates', description: 'Acceptance: a repeated submission creates one record.' }], outOfScope: ['Duplicate prevention'], estimatedExtraDays: 1, summary: 'A tentative extension beyond the supplied baseline.' }), model: 'fixture', latencyMs: 1 };
            return ++turn === 1 ? { raw: '', functionCall: { name, args: requestedArgs }, model: 'fixture', latencyMs: 1 } : { raw: 'The actual fixture lookup completed. Use its returned source data.', model: 'fixture', latencyMs: 1 };
          };
          const read = VERTICALS[persona]?.readOnlyTools?.includes(name);
          const before = effects.length;
          const plan = await api('/command', { message: 'Run the requested ' + name + ' workflow using the exact supplied fixture details.', ...(attached ? { attachmentBase64: Buffer.from('Actual source brief: support offline retries and reject duplicate submissions.').toString('base64'), attachmentMimeType: 'text/plain', attachmentName: 'brief.txt' } : {}) });
          if (read) {
            assert.equal(plan.action, null); assert(turn >= 2, 'Read tools must reach the executor and return evidence to the model');
            const execution = readings.findLast(item => item.persona === persona && item.name === name);
            assert(execution); assert.equal(execution.result.ok, true, JSON.stringify(execution.result));
            assert.equal(effects.length, before, 'Preparation must never hide provider writes');
            if (name === 'search_market') { assert.equal(execution.result.data.isDemo, true); assert.match(execution.result.message, /not verified live/); }
          } else {
            assert.equal(plan.action?.name, name, JSON.stringify(plan)); assert(plan.task);
            const result = await api('/tasks/' + plan.task.id + '/actions/' + plan.action.id + '/execute', {});
            assert.equal(result.ok, true, JSON.stringify(result));
            const effectCount = effects.length;
            const replay = await api('/tasks/' + plan.task.id + '/actions/' + plan.action.id + '/execute', {});
            assert.equal(replay.ok, true); assert.equal(effects.length, effectCount, 'A replay must return the receipt without repeating provider work');
            const receipts = (await load('services/accountant/agent-task.service.js').getAgentTaskReceipts(uid, plan.task.id));
            assert.equal(receipts.filter(receipt => receipt.status === 'succeeded').length, 1);
          }
        });
      }
    }
    assert.equal((await re.listListings(uid)).find(x => x.id === listing.id).shareSlug !== null, true);
    assert.equal((await support.listTickets(uid)).find(x => x.id === ticket.id).status, 'resolved');
    assert.equal((await hr.listCandidates(uid)).find(x => x.id === candidate.id).score, 84);
  } finally { await s.close(); }
});
