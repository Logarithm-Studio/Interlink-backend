import { Router, Request } from "express";
import { z } from "zod";
import { AuthenticatedRequest } from "../types";
import { BadRequestError } from "../utils/errors";
import { marketingCrmSyncRateLimit, marketingPublishRateLimit } from "../middleware/rateLimit";
import { SequenceInput, createEmailSequence, listEmailSequences, cancelEmailSequence } from "../services/professional/marketing/email-sequence.service";
import { AgreementInput, createAgreement, editAgreement, getAgreement, listAgreements, getAgreementAccounts, prepareAgreement, sendAgreement, refreshAgreement, reconcileAgreement, retryAgreementPreparation } from "../services/professional/marketing/agreement.service";
import { ResearchPlanInput, createResearchPlan, listResearchPlans, researchPlanDestinations, exportResearchPlan, listResearchExports, reconcileResearchExport, previewResearchPlan, retryResearchExport } from "../services/professional/marketing/research-plan.service";

const router = Router();
// Mounted only after the parent Marketing bearer middleware.
const uid = (req: Request) => (req as AuthenticatedRequest).user.id;
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new BadRequestError(result.error.issues.map(issue => issue.message).join(", ")); return result.data; }
const id = (req: Request) => parse(z.string().uuid(), req.params.id);
const provider = z.enum(["notion", "todoist"]);
const externalId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const approval = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true) });

router.get("/email-sequences", async (req,res,next) => { try { res.json({ sequences: await listEmailSequences(uid(req)) }); } catch(error) { next(error); } });
router.post("/email-sequences", marketingPublishRateLimit, async (req,res,next) => { try { res.status(201).json({ sequence: await createEmailSequence(uid(req), parse(SequenceInput,req.body)) }); } catch(error) { next(error); } });
router.post("/email-sequences/:id/cancel", async (req,res,next) => { try { await cancelEmailSequence(uid(req),id(req)); res.json({ok:true}); } catch(error) { next(error); } });

router.get("/agreements/accounts", marketingCrmSyncRateLimit, async (req,res,next) => { try { res.json({ accounts: await getAgreementAccounts(uid(req)) }); } catch(error) { next(error); } });
router.get("/agreements", async (req,res,next) => { try { res.json({ agreements: await listAgreements(uid(req)) }); } catch(error) { next(error); } });
router.post("/agreements", async (req,res,next) => { try { res.status(201).json({ agreement: await createAgreement(uid(req),parse(AgreementInput,req.body)) }); } catch(error) { next(error); } });
router.get("/agreements/:id", async (req,res,next) => { try { res.json({agreement: await getAgreement(uid(req),id(req))}); } catch(error) { next(error); } });
router.patch("/agreements/:id", async (req,res,next) => { try { const body=parse(z.object({body:z.string().trim().min(10).max(30000)}),req.body); res.json({agreement:await editAgreement(uid(req),id(req),body.body)}); } catch(error) { next(error); } });
router.post("/agreements/:id/prepare", marketingCrmSyncRateLimit, async (req,res,next) => { try { const body=parse(approval.extend({accountId:externalId}),req.body); res.json({agreement:await prepareAgreement(uid(req),id(req),body.accountId,body.fingerprint)}); } catch(error) { next(error); } });
router.post("/agreements/:id/send", marketingPublishRateLimit, async (req,res,next) => { try { const body=parse(approval,req.body); res.json({agreement:await sendAgreement(uid(req),id(req),body.fingerprint)}); } catch(error) { next(error); } });
router.post("/agreements/:id/refresh", marketingCrmSyncRateLimit, async (req,res,next) => { try { res.json({agreement:await refreshAgreement(uid(req),id(req))}); } catch(error) { next(error); } });
router.post("/agreements/:id/retry-prepare", marketingCrmSyncRateLimit, async(req,res,next)=>{try{const body=parse(approval.extend({confirmedNoEnvelope:z.literal(true)}),req.body);res.json({agreement:await retryAgreementPreparation(uid(req),id(req),body.fingerprint)});}catch(error){next(error);}});
router.post("/agreements/:id/reconcile", marketingCrmSyncRateLimit, async (req,res,next) => { try { const body=parse(z.object({envelopeId:z.string().uuid()}),req.body); res.json({agreement:await reconcileAgreement(uid(req),id(req),body.envelopeId)}); } catch(error) { next(error); } });

router.get("/research-plans/destinations", async (req,res,next) => { try { const p=parse(provider,req.query.provider); const search=parse(z.string().trim().max(100),req.query.q??""); if(p==="notion"&&search.length<2)throw new BadRequestError("Enter at least two characters to find a shared Notion page."); res.json({destinations:await researchPlanDestinations(uid(req),p,search)}); } catch(error) { next(error); } });
router.get("/research-plans", async (req,res,next) => { try { res.json({plans:await listResearchPlans(uid(req))}); } catch(error) { next(error); } });
router.post("/research-plans", async (req,res,next) => { try { res.status(201).json({plan:await createResearchPlan(uid(req),parse(ResearchPlanInput,req.body))}); } catch(error) { next(error); } });
router.get("/research-plans/:id/preview",async(req,res,next)=>{try{res.json(await previewResearchPlan(uid(req),id(req)));}catch(error){next(error);}});
router.get("/research-plans/:id/exports", async (req,res,next) => { try { res.json({exports:await listResearchExports(uid(req),id(req))}); } catch(error) { next(error); } });
router.post("/research-plans/:id/export", marketingCrmSyncRateLimit, async (req,res,next) => { try { const body=parse(approval.extend({provider,destinationId:externalId}),req.body); res.json({exports:await exportResearchPlan(uid(req),id(req),body.provider,body.destinationId,body.fingerprint)}); } catch(error) { next(error); } });
router.post("/research-exports/:id/retry",marketingCrmSyncRateLimit,async(req,res,next)=>{try{const body=parse(approval.extend({confirmedNoCopy:z.literal(true)}),req.body);res.json({exports:await retryResearchExport(uid(req),id(req),body.fingerprint)});}catch(error){next(error);}});
router.post("/research-exports/:id/reconcile", marketingCrmSyncRateLimit, async (req,res,next) => { try { const body=parse(z.object({externalId}),req.body); res.json({exports:await reconcileResearchExport(uid(req),id(req),body.externalId)}); } catch(error) { next(error); } });
export default router;
