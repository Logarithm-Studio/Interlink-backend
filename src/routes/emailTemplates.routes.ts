import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError, NotFoundError } from "../utils/errors";
import {
  createEmailTemplate,
  deleteEmailTemplate,
  getEffectiveDeclineTemplate,
  listEmailTemplates,
  SYSTEM_DEFAULT_TEMPLATE_ID,
  setActiveDefaultTemplate,
  updateEmailTemplate,
} from "../services/email/templates.service";

const router = Router();

router.use(authMiddleware as never);

const CreateTemplateSchema = z.object({
  name: z.string().min(1).max(120),
  subjectTemplate: z.string().min(1).max(500),
  bodyTemplate: z.string().min(1).max(10_000),
  isActiveDefault: z.boolean().optional(),
});

const UpdateTemplateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  subjectTemplate: z.string().min(1).max(500).optional(),
  bodyTemplate: z.string().min(1).max(10_000).optional(),
});

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const templates = await listEmailTemplates(user.id);
    res.json({ templates, count: templates.length });
  } catch (err) {
    next(err);
  }
});

router.get(
  "/effective-default",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const effective = await getEffectiveDeclineTemplate(user.id);
      res.json(effective);
    } catch (err) {
      next(err);
    }
  },
);

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = CreateTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(
        parsed.error.issues.map((issue) => issue.message).join(", "),
      );
    }

    const template = await createEmailTemplate({
      userId: user.id,
      name: parsed.data.name,
      subjectTemplate: parsed.data.subjectTemplate,
      bodyTemplate: parsed.data.bodyTemplate,
      isActiveDefault: parsed.data.isActiveDefault,
    });

    res.status(201).json({ message: "Template created", template });
  } catch (err) {
    next(err);
  }
});

router.patch(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (req.params.id === SYSTEM_DEFAULT_TEMPLATE_ID) {
        throw new BadRequestError("System default template cannot be edited");
      }

      const parsed = UpdateTemplateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError(
          parsed.error.issues.map((issue) => issue.message).join(", "),
        );
      }

      if (Object.keys(parsed.data).length === 0) {
        throw new BadRequestError("No fields to update");
      }

      const template = await updateEmailTemplate({
        userId: user.id,
        templateId: req.params.id,
        ...parsed.data,
      });

      if (!template) {
        throw new NotFoundError("Email template");
      }

      res.json({ message: "Template updated", template });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/:id/set-default",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const template = await setActiveDefaultTemplate(user.id, req.params.id);
      if (!template) {
        throw new NotFoundError("Email template");
      }
      res.json({ message: "Default template updated", template });
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (req.params.id === SYSTEM_DEFAULT_TEMPLATE_ID) {
        throw new BadRequestError("System default template cannot be deleted");
      }

      const deleted = await deleteEmailTemplate(user.id, req.params.id);
      if (!deleted) {
        throw new NotFoundError("Email template");
      }
      res.json({ message: "Template deleted" });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
