/**
 * AI Operator routes.
 * All routes require authentication. User is scoped to their org via JWT.
 */

import { Router } from 'express';
import { requireAuth, requirePermission, type AuthRequest } from '../middleware/auth';
import { RULES, consume, sendRateLimited } from '../middleware/rate-limit';
import { Response } from 'express';
import db from '../db/init';
import { nanoid } from 'nanoid';
import { cancelProposal, executeConfirmedProposal, getProposal } from '../services/ai-tools';
import { localAnswer } from '../services/local-answer';
import { agentAnswer, agentConfig, AgentUnavailableError } from '../services/ai-agent';
import { getKnowledgeCoverage, indexKnowledgeDirectory } from '../services/knowledge-indexer';
import { z } from 'zod';

const router = Router();
// The assistant can search customers and appointments, so it needs the same access as those pages.
router.use(requireAuth, requirePermission('ai:use'));

// ─── Health check ─────────────────────────────────────────────────────────────

// "model" when GEMINI_API_KEY is set (services/ai-agent.ts), otherwise "local" (local retrieval, no external call).
router.get('/health', (_req: AuthRequest, res: Response) => {
  res.json({ data: { mode: agentConfig() ? 'model' : 'local' } });
});

// ─── Questions: the language model when configured, otherwise local knowledge search ──

const AskSchema = z.object({
  query: z.string().min(1).max(1000),
  topK: z.number().int().min(1).max(10).optional(),
  conversationId: z.string().optional(),
  triggerWorkflowResume: z.boolean().optional(),
});

router.post('/ask', async (req: AuthRequest, res: Response) => {
  let parsed: z.infer<typeof AskSchema>;
  try {
    parsed = AskSchema.parse(req.body);
  } catch {
    res.status(400).json({ error: 'Invalid request: query is required (1–1000 chars)' });
    return;
  }
  try {
    // The model answers when it is configured; resuming a local availability workflow stays local. If Google gives no
    // usable answer (unreachable, refused, blocked), the local engine answers instead.
    const cfg = agentConfig();
    if (cfg && !parsed.triggerWorkflowResume) {
      const limit = consume([{ rule: RULES.assistantUser, key: req.user!.sub }, { rule: RULES.assistantOrg, key: req.user!.orgId }]);
      if (!limit.allowed) { sendRateLimited(res, limit.retryAfterMs); return; }
      try {
        res.json({ data: await agentAnswer(parsed.query, req.user!, parsed.conversationId, cfg) });
        return;
      } catch (err) {
        if (!(err instanceof AgentUnavailableError)) throw err;
        console.warn(`[ai] ${err.message}; answered with the local assistant`);
      }
    }
    const result = await localAnswer(
      parsed.query,
      parsed.topK ?? 5,
      req.user!,
      parsed.conversationId,
      parsed.triggerWorkflowResume ?? false,
    );
    res.json({ data: result });
  } catch (err) {
    console.error('[ai] ask failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'The assistant could not answer right now. Please try again.' });
  }
});

// ─── Workflow management ──────────────────────────────────────────────────────

router.post('/workflows/:id/cancel', (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const result = db.prepare(`
    UPDATE ai_workflows SET status = 'cancelled'
    WHERE id = ? AND organization_id = ? AND user_id = ? AND status = 'active'
  `).run(req.params.id, user.orgId, user.sub);
  if (!result.changes) {
    res.status(404).json({ error: 'Workflow not found or already resolved' });
    return;
  }
  res.json({ data: { cancelled: true } });
});

// ─── Knowledge coverage report ────────────────────────────────────────────────

router.get('/knowledge/coverage', (_req: AuthRequest, res: Response) => {
  // The server's file system layout is not the caller's business.
  const { knowledgeDirectory: _dir, ...coverage } = getKnowledgeCoverage();
  res.json({ data: coverage });
});

// Rebuilding the index reads every knowledge file and rewrites the index: administrators only, and not too often.
router.post('/knowledge/reindex', requirePermission('ai:admin'), (req: AuthRequest, res: Response) => {
  const limit = consume([{ rule: RULES.reindexOrg, key: req.user!.orgId }]);
  if (!limit.allowed) { sendRateLimited(res, limit.retryAfterMs); return; }
  try {
    const { failed, ...stats } = indexKnowledgeDirectory(true);
    res.json({ data: { ...stats, failedCount: failed.length } });
  } catch (err) {
    console.error('[ai] reindex failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Reindex failed' });
  }
});

// ─── Conversations ────────────────────────────────────────────────────────────

router.get('/conversations', (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const rows = db.prepare(`
    SELECT id, title, created_at as createdAt, updated_at as updatedAt
    FROM ai_conversations
    WHERE organization_id = ? AND user_id = ?
    ORDER BY updated_at DESC LIMIT 50
  `).all(user.orgId, user.sub);
  res.json({ data: rows });
});

router.post('/conversations', (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const id = `conv-${nanoid(12)}`;
  const rawTitle = (req.body as { title?: unknown } | undefined)?.title;
  const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.slice(0, 100) : 'New Conversation';
  db.prepare(`
    INSERT INTO ai_conversations (id, organization_id, user_id, title) VALUES (?, ?, ?, ?)
  `).run(id, user.orgId, user.sub, title);
  const conv = db.prepare('SELECT id, title, created_at as createdAt FROM ai_conversations WHERE id = ?').get(id);
  res.status(201).json({ data: conv });
});

router.get('/conversations/:id', (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const conv = db.prepare(`
    SELECT id, title, created_at as createdAt, updated_at as updatedAt
    FROM ai_conversations WHERE id = ? AND organization_id = ? AND user_id = ?
  `).get(req.params.id, user.orgId, user.sub);

  if (!conv) { res.status(404).json({ error: 'Conversation not found' }); return; }

  const messages = db.prepare(`
    SELECT id, role, content, tool_calls as toolCalls, sources, created_at as createdAt
    FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC
  `).all(req.params.id) as Array<Record<string, string>>;

  const proposals = db.prepare(`
    SELECT id, tool_name as toolName, display_data as displayData, status, expires_at as expiresAt, created_at as createdAt
    FROM ai_proposals WHERE conversation_id = ? ORDER BY created_at DESC
  `).all(req.params.id) as Array<Record<string, string>>;

  res.json({
    data: {
      ...conv,
      messages: messages.map(m => ({
        ...m,
        toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) : [],
        sources: m.sources ? JSON.parse(m.sources) : [],
      })),
      proposals: proposals.map(p => ({
        ...p,
        displayData: p.displayData ? JSON.parse(p.displayData) : {},
      })),
    },
  });
});

router.delete('/conversations/:id', (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const result = db.prepare(
    'DELETE FROM ai_conversations WHERE id = ? AND organization_id = ? AND user_id = ?'
  ).run(req.params.id, user.orgId, user.sub);
  if (!result.changes) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ data: { deleted: true } });
});

// ─── Proposals ────────────────────────────────────────────────────────────────

router.post('/proposals/:id/confirm', (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const result = executeConfirmedProposal(req.params.id, user);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ data: { executed: true, result: result.result } });
});

router.post('/proposals/:id/cancel', (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const result = cancelProposal(req.params.id, user);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ data: { cancelled: true } });
});

router.get('/proposals/:id', (req: AuthRequest, res: Response) => {
  const user = req.user!;
  const prop = getProposal(req.params.id);
  if (!prop || prop.organizationId !== user.orgId || prop.userId !== user.sub) {
    res.status(404).json({ error: 'Proposal not found' });
    return;
  }
  res.json({ data: prop });
});

export default router;
