/**
 * Local answer engine — intent-routed responses without external AI APIs.
 * Routes to: BM25 knowledge retrieval, live DB queries, navigation, record
 * search, action proposals, or clarification requests.
 */

import { nanoid } from 'nanoid';
import db from '../db/init';
import { retrieve, queryTerms, stem, termWeights } from './rag';
import { routeIntent, extractDuration, extractPrice, extractDate, extractPersonName, extractServiceName, normalizeTypos } from './intent-router';
import type { AuthPayload } from '../types';
import { can } from '../auth/permissions';
import { todayInTimezone, getOrgTimezone, freeTimesByStaff } from './availability';
import { DEFAULT_CURRENCY } from './business-locale';
import { CUSTOMER_BOOKING_COUNT } from './customer-bookings';

// ── Response type contract ─────────────────────────────────────────────────────

export type LocalResponseType =
  | 'text'
  | 'clarification'
  | 'search_results'
  | 'navigation'
  | 'action_proposal'
  | 'live_data'
  | 'availability'
  | 'out_of_scope'
  | 'error'
  | 'workflow_blocker';

export interface WorkflowAction {
  label: string;
  style: 'primary' | 'secondary';
  intent: 'navigate' | 'cancel_workflow';
  navigateTo?: string;
}

export interface WorkflowInfo {
  workflowId: string;
  reason: string;
  actions: WorkflowAction[];
}

export interface LocalAnswerResult {
  type: LocalResponseType;
  answer: string;
  steps?: string[];
  navigation?: string;      // legacy alias kept for backward compat
  sources: string[];
  confidence: 'high' | 'medium' | 'low';
  intent: string;
  retrievedChunks: number;
  noResults: boolean;
  // search_results
  searchResults?: Array<Record<string, unknown>>;
  // navigation
  navigateTo?: string;
  navigationTitle?: string;
  // action_proposal
  proposalId?: string;
  proposalDisplayData?: { type: string; fields: Array<{ label: string; value: unknown }> };
  proposalToolName?: string;
  // live_data
  liveData?: Record<string, unknown>;
  // availability
  slots?: Array<{ staffName: string; times: string[] }>;
  // clarification
  clarificationQuestion?: string;
  // workflow_blocker
  workflowInfo?: WorkflowInfo;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeResult(partial: Partial<LocalAnswerResult> & { answer: string }): LocalAnswerResult {
  return {
    type: 'text',
    sources: [],
    confidence: 'high',
    intent: 'general',
    retrievedChunks: 0,
    noResults: false,
    ...partial,
  };
}

// ── Synonym expansion for BM25 queries ────────────────────────────────────────

const SYNONYMS: Record<string, string[]> = {
  create:       ['add', 'new', 'make', 'set up', 'build', 'configure'],
  appointment:  ['booking', 'meeting', 'schedule', 'session', 'slot', 'अपॉइंटमेंट', 'बुकिंग'],
  service:      ['treatment', 'offering', 'सेवा'],
  staff:        ['employee', 'member', 'provider', 'therapist', 'doctor', 'team member', 'colleague', 'coworker', 'teammate', 'invite', 'onboard', 'hire', 'स्टाफ'],
  customer:     ['client', 'patient', 'ग्राहक'],
  workspace:    ['location', 'branch', 'clinic', 'office'],
  resource:     ['room', 'equipment', 'asset'],
  cancel:       ['delete', 'remove', 'stop', 'void', 'रद्द'],
  reschedule:   ['change time', 'move', 'shift', 'postpone'],
  settings:     ['configuration', 'preferences', 'config', 'सेटिंग'],
  report:       ['analytics', 'statistics', 'metrics', 'रिपोर्ट'],
  dashboard:    ['home', 'overview', 'main page'],
  password:     ['credentials', 'login details', 'पासवर्ड'],
  notification: ['reminder', 'email reminder', 'email alert', 'notify', 'sms'],
  reminder:     ['notification', 'email reminder', 'email alert'],
  integration:  ['connect', 'sync', 'google calendar', 'google sync'],
  calendar:     ['timetable', 'agenda', 'schedule view'],
  account:      ['login', 'user account', 'my account', 'deactivate'],
  // Hinglish
  kaise:        ['how to', 'how do i'],
  banate:       ['create', 'make', 'add'],
  karein:       ['how to', 'do'],
  karte:        ['do', 'doing'],
  hain:         ['is', 'are'],
};

function expandQuery(query: string): string {
  const lower = query.toLowerCase();
  const expansions = new Set([lower]);
  for (const [key, syns] of Object.entries(SYNONYMS)) {
    for (const syn of syns) {
      if (lower.includes(syn)) expansions.add(lower.replace(syn, key));
    }
    if (lower.includes(key)) {
      for (const syn of syns) expansions.add(lower.replace(key, syn));
    }
  }
  return Array.from(expansions).join(' ');
}

// ── Suggestions shown when confidence is low ──────────────────────────────────

const FEATURE_SUGGESTIONS: Record<string, string[]> = {
  staff:        ['How do I add a new staff member?', 'How to set staff working hours?', 'How to assign staff to services?'],
  appointment:  ['How do I create an appointment?', 'How to reschedule an appointment?', 'How to cancel an appointment?'],
  service:      ['How do I create a service?', 'How to set service duration and price?', 'How to assign staff to a service?'],
  customer:     ['How do I add a customer?', 'How to find a customer?', 'How to view customer bookings?'],
  settings:     ['How to change my password?', 'How to set business working hours?', 'How to configure notifications?'],
  report:       ['What reports are available?', 'How to view revenue reports?', 'How to check appointment stats?'],
  notification: ['How to set up email reminders?', 'How to configure notifications?', 'What notification types are available?'],
  integration:  ['How to connect Google Calendar?', 'What integrations are available?', 'How to set up calendar sync?'],
  workspace:    ['How do I create a workspace?', 'How to invite team members to a workspace?', 'How to set workspace hours?'],
};

const DEFAULT_SUGGESTIONS = [
  'How do I create an appointment?',
  'How do I add a staff member?',
  'What reports are available?',
];

// ── BM25 answer assembly ───────────────────────────────────────────────────────

interface RetrievedChunk { docId: string; docTitle: string; category: string; content: string; score: number }

const ROUTE_PATTERN = /`?(\/[a-z][a-z0-9/-]*)`?/g;
function extractRoute(text: string): string | undefined {
  const matches = text.match(ROUTE_PATTERN);
  if (!matches) return undefined;
  return matches.find(m => !m.startsWith('/api') && !m.startsWith('/book')) ?? matches[0];
}

function extractSteps(text: string): string[] {
  return text.split('\n')
    .map(l => l.match(/^\s*(\d+)\.\s+(.+)/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(m => m[2].trim());
}

interface Section { title: string; level: number; heading: string; body: string }

/**
 * Splits markdown into sections. A section runs until the next heading of the same or a higher level, so a
 * "## Working Hours" section keeps the steps under its "### How to configure" sub-heading.
 */
function sectionsOf(text: string): Section[] {
  const lines = text.split('\n');
  const heads = lines.flatMap((line, i) => {
    const m = line.match(/^(#{1,6})\s+(.+)/);
    return m ? [{ i, level: m[1].length, title: m[2].trim() }] : [];
  });
  return heads.map((h, k) => {
    const next = heads.slice(k + 1).find(n => n.level <= h.level);
    return { title: h.title, level: h.level, heading: lines[h.i], body: lines.slice(h.i + 1, next ? next.i : lines.length).join('\n').trim() };
  });
}

/** Prose paragraphs of a text (headings and numbered steps left out). */
function paragraphsOf(text: string): string[] {
  return text.split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 30 && !/^#{1,6}\s/.test(p) && !/^\s*\d+\.\s/.test(p));
}

/** The introduction of a section: its prose before the first step or sub-heading. */
function leadOf(body: string): string[] {
  const lines = body.split('\n');
  const end = lines.findIndex(l => /^\s*\d+\.\s/.test(l) || /^#{1,6}\s/.test(l));
  return paragraphsOf(lines.slice(0, end === -1 ? lines.length : end).join('\n'));
}

const stemsOf = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem));

// Verbs people use for the action a heading names ("add a workspace" → "Creating a workspace").
const ACTION_SYNONYMS = [['create', 'add', 'new', 'make'], ['edit', 'change', 'update', 'modify']];
const alternativesOf = (term: string): string[] =>
  [term, ...(ACTION_SYNONYMS.find(group => group.includes(term)) ?? []).filter(w => w !== term)];

/**
 * The section of an article whose heading best matches the question. Heading words are compared by stem and weighted
 * by how rare they are in the knowledge base, so "time off" outweighs "staff". Words of the article's own title
 * ("Staff — Complete Guide") say nothing about which section is meant and are left out. Ties go to a section with
 * steps, then to the earlier one.
 */
function bestSection(article: string, query: string): Section | undefined {
  const sections = sectionsOf(article);
  const titleStems = stemsOf(sections.find(s => s.level === 1)?.title ?? '');
  const terms = queryTerms(query).filter(t => !titleStems.has(stem(t)));
  if (!terms.length) return undefined;
  const weights = termWeights(terms);
  const total = terms.reduce((sum, t) => sum + (weights.get(t) ?? 0), 0);
  // Action synonyms only for "how do I …" questions: "Can staff change appointment status?" is not about editing.
  const procedural = /^\s*how\b/i.test(query);
  const inHeading = (heading: Set<string>, t: string) => (procedural ? alternativesOf(t) : [t]).some(word => {
    const s = stem(word);
    // "cancelling" → "cancell" still matches "cancel"; short stems must match exactly ("time" is not "timezone").
    return heading.has(s) || [...heading].some(h => Math.min(h.length, s.length) >= 5 && (h.startsWith(s) || s.startsWith(h)));
  });
  return sections
    .filter(s => s.level >= 2)
    .map((s, i) => {
      const heading = stemsOf(s.title);
      const all = stemsOf(`${s.title}\n${s.body}`);
      const score = terms.reduce((sum, t) => sum + (inHeading(heading, t) ? weights.get(t) ?? 0 : 0), 0);
      const covered = terms.reduce((sum, t) => sum + (inHeading(all, t) ? weights.get(t) ?? 0 : 0), 0);
      return { s, i, score, covered, steps: extractSteps(s.body).length > 0 ? 1 : 0 };
    })
    // The heading must name part of the question, and the section must cover at least half of it:
    // "Does Zoom work?" is not answered by a section called "What does work" that never mentions Zoom.
    .filter(x => x.score > 0 && x.covered >= total / 2)
    .sort((a, b) => b.score - a.score || b.steps - a.steps || a.i - b.i)[0]?.s;
}

type LegacyIntent = 'how_to' | 'where_is' | 'what_is' | 'troubleshoot' | 'list' | 'general';

function assembleBM25Answer(
  intent: LegacyIntent,
  chunks: RetrievedChunk[],
  queryHint = '',
): { text: string; steps: string[]; navigation: string | undefined } {
  if (chunks.length === 0) {
    return {
      text: "I don't have specific information about that in the WorkEasy360 knowledge base.",
      steps: [],
      navigation: undefined,
    };
  }

  // Everything in an answer comes from the best-matching article. Another retrieved article's steps are never
  // borrowed: "set business working hours" once got the staff form's steps that way.
  const top = chunks[0];
  const topChunk = top.content;
  const article = chunks.filter(c => c.docId === top.docId).map(c => c.content).join('\n\n');
  const steps = extractSteps(article);

  if (intent === 'how_to' || intent === 'general') {
    const section = bestSection(article, queryHint);
    if (section) {
      const sectionSteps = extractSteps(section.body);
      const prose = paragraphsOf(section.body);
      const navigation = extractRoute(`${section.heading}\n${section.body}`) ?? extractRoute(article);
      if (sectionSteps.length > 0) {
        return { text: [section.title, ...leadOf(section.body).slice(0, 1)].join('\n\n'), steps: sectionSteps.slice(0, 10), navigation };
      }
      // A section without steps (for example "not available yet") is answered with its own words.
      if (prose.length > 0) return { text: [section.title, ...prose.slice(0, 2)].join('\n\n'), steps: [], navigation };
    }

    // No section matches the question. An article without sections is one procedure: give its steps. An article
    // with sections gets its opening instead of guessing one of its procedures.
    const chunkSteps = extractSteps(topChunk);
    if (chunkSteps.length > 0 && !sectionsOf(article).some(s => s.level >= 2)) {
      return { text: topChunk.split('\n')[0].replace(/^#+\s*/, ''), steps: chunkSteps.slice(0, 10), navigation: extractRoute(topChunk) };
    }
    const paras = topChunk.split('\n\n').filter(p => p.trim().length > 30);
    return {
      text: paras.slice(0, 2).join('\n\n').replace(/^#+\s*/gm, '').trim(),
      steps: [], navigation: extractRoute(topChunk),
    };
  }

  const navigation = extractRoute(article);

  if (intent === 'where_is' || intent === 'what_is') {
    // The section the question names, when one matches; otherwise the article's opening.
    const section = bestSection(article, queryHint);
    const sectionText = section ? paragraphsOf(section.body)[0] : undefined;
    if (section && sectionText) {
      const sectionRoute = extractRoute(`${section.heading}\n${section.body}`) ?? navigation;
      const routeInfo = intent === 'where_is' && sectionRoute ? ` You can find it at \`${sectionRoute}\`.` : '';
      return { text: `${section.title}: ${sectionText}${routeInfo}`, steps: [], navigation: sectionRoute };
    }
  }

  if (intent === 'where_is') {
    const routeInfo = navigation ? ` You can find it at \`${navigation}\`.` : '';
    const para = topChunk.split('\n\n').find(p => p.length > 40) ?? topChunk.slice(0, 300);
    return { text: para.replace(/^#+\s*/gm, '').trim() + routeInfo, steps: [], navigation };
  }

  if (intent === 'troubleshoot') {
    // Only the section about this problem; the article's other procedures are not troubleshooting steps.
    const section = bestSection(article, queryHint);
    if (section) {
      const sectionSteps = extractSteps(section.body);
      const sectionRoute = extractRoute(`${section.heading}\n${section.body}`) ?? navigation;
      if (sectionSteps.length > 0) return { text: section.title, steps: sectionSteps.slice(0, 8), navigation: sectionRoute };
      const prose = paragraphsOf(section.body);
      if (prose.length > 0) return { text: [section.title, ...prose.slice(0, 2)].join('\n\n'), steps: [], navigation: sectionRoute };
    }
    if (steps.length > 0 && !sectionsOf(article).some(s => s.level >= 2)) {
      return { text: 'Here are the troubleshooting steps:', steps: steps.slice(0, 8), navigation };
    }
    const paras = article.split('\n\n').filter(p => p.trim().length > 30);
    return { text: paras.slice(0, 3).join('\n\n').replace(/^#+\s*/gm, '').trim(), steps: [], navigation };
  }

  if (intent === 'what_is') {
    const para = topChunk.split('\n\n').find(p => p.length > 40) ?? topChunk.slice(0, 400);
    return { text: para.replace(/^#+\s*/gm, '').trim(), steps: [], navigation };
  }

  if (intent === 'list') {
    const bullets = article.split('\n')
      .filter(l => /^[-*•]\s/.test(l) || /^\|\s/.test(l))
      .slice(0, 15)
      .map(l => l.replace(/^[-*•]\s/, '').trim())
      .filter(l => l.length > 2);
    if (bullets.length > 0) {
      const para = topChunk.split('\n').find(l => !l.startsWith('#') && l.trim().length > 30) ?? '';
      return { text: para.trim(), steps: bullets, navigation };
    }
  }

  const paras = topChunk.split('\n\n').filter(p => p.trim().length > 30);
  return { text: paras.slice(0, 2).join('\n\n').replace(/^#+\s*/gm, '').trim(), steps: [], navigation };
}

// Map new intents → legacy BM25 assembly intent
function toLegacyIntent(intent: string): LegacyIntent {
  if (intent === 'platform_how_to') return 'how_to';
  if (intent === 'troubleshoot') return 'troubleshoot';
  return 'general';
}

// ── Handler: live data query ──────────────────────────────────────────────────

function handleListAppointments(date: string, user: AuthPayload): LocalAnswerResult {
  type ApptRow = { bookingRef: string; startTime: string; status: string; serviceName: string; staffName: string; customerName: string };
  const appts = db.prepare(`
    SELECT a.booking_ref AS bookingRef, a.start_time AS startTime, a.status,
           s.name AS serviceName, st.name AS staffName, c.name AS customerName
    FROM appointments a
    JOIN services s  ON a.service_id  = s.id
    JOIN staff   st  ON a.staff_id    = st.id
    JOIN customers c ON a.customer_id = c.id
    WHERE a.organization_id = ? AND a.date = ?
      AND a.status NOT IN ('cancelled','no_show')
    ORDER BY a.start_time LIMIT 20
  `).all(user.orgId, date) as ApptRow[];

  const d = new Date(date + 'T00:00:00');
  const fmt = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  if (!appts.length) {
    return makeResult({
      type: 'live_data',
      answer: `No appointments scheduled for **${fmt}**. You can [create an appointment](/appointments/new) or check a different date.`,
      intent: 'live_data_query',
      liveData: { total: 0, date },
    });
  }

  const lines = appts.map(a =>
    `- **${a.startTime}** — ${a.serviceName} · ${a.staffName} · ${a.customerName} [${a.status}]`
  );
  const answer = `**${appts.length} appointment${appts.length !== 1 ? 's' : ''}** on **${fmt}**:\n\n${lines.join('\n')}`;

  return makeResult({
    type: 'live_data',
    answer,
    intent: 'live_data_query',
    liveData: { total: appts.length, date },
  });
}

function handleLiveData(query: string, timeframe: string | undefined, date: string | undefined, listMode: boolean | undefined, user: AuthPayload): LocalAnswerResult {
  // "show my bookings for tomorrow" → list mode with specific date
  if (listMode && date) {
    return handleListAppointments(date, user);
  }

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');

  let dateStart: string;
  let dateEnd: string;
  let periodLabel: string;

  if (timeframe === 'this_month') {
    dateStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    dateEnd = `${nextMonth.getFullYear()}-${pad(nextMonth.getMonth() + 1)}-01`;
    periodLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  } else if (timeframe === 'this_week') {
    const monday = new Date(now);
    monday.setDate(now.getDate() - (now.getDay() || 7) + 1);
    dateStart = `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 7);
    dateEnd = `${sunday.getFullYear()}-${pad(sunday.getMonth() + 1)}-${pad(sunday.getDate())}`;
    periodLabel = 'this week';
  } else if (timeframe === 'today' || timeframe === 'specific_date') {
    const targetDate = date ?? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const tomorrow = new Date(targetDate + 'T00:00:00'); tomorrow.setDate(tomorrow.getDate() + 1);
    dateStart = targetDate;
    dateEnd = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
    periodLabel = timeframe === 'today' ? 'today' : new Date(targetDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  } else {
    // Default to last 30 days
    const days = timeframe === '7d' ? 7 : timeframe === '3m' ? 90 : timeframe === '1y' ? 365 : 30;
    const since = new Date(now.getTime() - days * 86_400_000);
    dateStart = `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())}`;
    dateEnd = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate() + 1)}`;
    periodLabel = `last ${days} days`;
  }

  type Row = { total: number; scheduled: number; completed: number; cancelled: number; revenue: number };
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) as scheduled,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
      SUM(CASE WHEN status != 'cancelled' THEN price ELSE 0 END) as revenue
    FROM appointments
    WHERE organization_id = ? AND date >= ? AND date < ?
  `).get(user.orgId, dateStart, dateEnd) as Row;

  const total = stats.total ?? 0;
  const scheduled = stats.scheduled ?? 0;
  const completed = stats.completed ?? 0;
  const cancelled = stats.cancelled ?? 0;
  const revenue = stats.revenue ?? 0;

  let answer = `You have **${total} appointment${total !== 1 ? 's' : ''}** ${periodLabel}.`;
  if (total > 0) {
    const parts: string[] = [];
    if (scheduled > 0) parts.push(`${scheduled} scheduled`);
    if (completed > 0) parts.push(`${completed} completed`);
    if (cancelled > 0) parts.push(`${cancelled} cancelled`);
    if (parts.length > 0) answer += ` (${parts.join(', ')})`;
    if (revenue > 0) {
      const orgRow = db.prepare('SELECT currency FROM organizations WHERE id = ?').get(user.orgId) as { currency?: string } | undefined;
      const cur = orgRow?.currency ?? DEFAULT_CURRENCY;
      answer += `. Revenue: **${cur} ${revenue.toFixed(2)}**.`;
    }
  }

  return makeResult({
    type: 'live_data',
    answer,
    intent: 'live_data_query',
    liveData: { total, scheduled, completed, cancelled, revenue, period: periodLabel },
  });
}

// ── Handler: availability query ───────────────────────────────────────────────

function handleAvailability(
  date: string | undefined,
  user: AuthPayload,
  query?: string,
  conversationId?: string,
): LocalAnswerResult {
  if (!date) {
    return makeResult({
      type: 'clarification',
      answer: 'Which date would you like to check availability for? For example: "Show me available slots for tomorrow" or "Check availability for 2026-10-25".',
      intent: 'availability_query',
      clarificationQuestion: 'Which date would you like to check?',
    });
  }

  const today = todayInTimezone(getOrgTimezone(user.orgId));
  if (date < today) {
    return makeResult({
      type: 'error',
      answer: `I can't check availability for past dates. Please choose today (${today}) or a future date.`,
      intent: 'availability_query',
    });
  }

  // Get active services for this org
  const services = db.prepare(
    'SELECT id, name, duration FROM services WHERE organization_id = ? AND is_active = 1 ORDER BY name LIMIT 3'
  ).all(user.orgId) as Array<{ id: string; name: string; duration: number }>;

  if (!services.length) {
    // Auto-create a conversation for the workflow FK if needed
    let convId = conversationId;
    if (!convId) {
      convId = `conv-local-${nanoid(12)}`;
      db.prepare(`
        INSERT INTO ai_conversations (id, organization_id, user_id, title)
        VALUES (?, ?, ?, ?)
      `).run(convId, user.orgId, user.sub, (query ?? 'Availability check').slice(0, 60));
    }

    const workflowId = `wf-${nanoid(12)}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    db.prepare(`
      INSERT INTO ai_workflows
        (id, organization_id, user_id, conversation_id, type, original_query, step, context, status, expires_at)
      VALUES (?, ?, ?, ?, 'availability_request', ?, 'awaiting_service', ?, 'active', ?)
    `).run(
      workflowId,
      user.orgId,
      user.sub,
      convId,
      query ?? 'Show available slots',
      JSON.stringify({ date }),
      expiresAt,
    );

    return makeResult({
      type: 'workflow_blocker',
      answer: "I can't check availability yet because no active services are configured. I can help you create one first.",
      intent: 'availability_query',
      workflowInfo: {
        workflowId,
        reason: 'no_services',
        actions: [
          { label: 'Create a service', style: 'primary', intent: 'navigate', navigateTo: '/services/new' },
          { label: 'Cancel', style: 'secondary', intent: 'cancel_workflow' },
        ],
      },
    });
  }

  // The same rules as the New Appointment form (staff and business hours, breaks, time off, closures, buffers), for
  // the staff assigned to each service, so the assistant never lists a time the server would refuse.
  const allSlots: Array<{ staffName: string; times: string[] }> = [];
  for (const svc of services) {
    for (const staff of freeTimesByStaff(user.orgId, svc.id, date)) {
      const existing = allSlots.find(s => s.staffName === staff.staffName);
      if (!existing) { allSlots.push({ staffName: staff.staffName, times: [...staff.times] }); continue; }
      for (const t of staff.times) if (!existing.times.includes(t)) existing.times.push(t);
      existing.times.sort();
    }
  }

  if (!allSlots.length) {
    const d = new Date(date + 'T00:00:00');
    const fmt = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    return makeResult({
      type: 'availability',
      answer: `No available slots found for **${fmt}**. All staff may be unavailable or fully booked on that day. Try checking a different date or adding more staff.`,
      intent: 'availability_query',
      slots: [],
    });
  }

  const d = new Date(date + 'T00:00:00');
  const fmt = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const lines = allSlots.map(s => `**${s.staffName}**: ${s.times.slice(0, 8).join(', ')}${s.times.length > 8 ? ` (+${s.times.length - 8} more)` : ''}`);
  const answer = `Available slots for **${fmt}**:\n\n${lines.join('\n')}`;

  return makeResult({
    type: 'availability',
    answer,
    intent: 'availability_query',
    slots: allSlots,
  });
}

// ── Handler: record search ─────────────────────────────────────────────────────

function handleRecordSearch(
  recordType: 'customers' | 'services' | 'staff' | 'appointments',
  searchQuery: string,
  user: AuthPayload,
): LocalAnswerResult {
  const q = searchQuery.toLowerCase().trim();
  let results: Array<Record<string, unknown>> = [];

  if (recordType === 'customers') {
    results = q
      ? db.prepare(`SELECT id, name, email, phone, ${CUSTOMER_BOOKING_COUNT} as totalBookings FROM customers WHERE organization_id = ? AND (LOWER(name) LIKE ? OR LOWER(email) LIKE ?) ORDER BY name LIMIT 10`).all(user.orgId, `%${q}%`, `%${q}%`) as typeof results
      : db.prepare(`SELECT id, name, email, phone, ${CUSTOMER_BOOKING_COUNT} as totalBookings FROM customers WHERE organization_id = ? ORDER BY name LIMIT 10`).all(user.orgId) as typeof results;
  } else if (recordType === 'staff') {
    results = q
      ? db.prepare(`SELECT id, name, email, role, title, is_active as isActive FROM staff WHERE organization_id = ? AND (LOWER(name) LIKE ? OR LOWER(email) LIKE ?) ORDER BY name LIMIT 10`).all(user.orgId, `%${q}%`, `%${q}%`) as typeof results
      : db.prepare(`SELECT id, name, email, role, title, is_active as isActive FROM staff WHERE organization_id = ? ORDER BY name LIMIT 10`).all(user.orgId) as typeof results;
  } else if (recordType === 'services') {
    results = q
      ? db.prepare(`SELECT id, name, duration, price, currency, category FROM services WHERE organization_id = ? AND LOWER(name) LIKE ? ORDER BY name LIMIT 10`).all(user.orgId, `%${q}%`) as typeof results
      : db.prepare(`SELECT id, name, duration, price, currency, category FROM services WHERE organization_id = ? ORDER BY name LIMIT 10`).all(user.orgId) as typeof results;
  } else if (recordType === 'appointments') {
    results = db.prepare(`
      SELECT a.id, a.booking_ref as bookingRef, a.date, a.start_time as startTime,
             a.status, s.name as serviceName, st.name as staffName, c.name as customerName
      FROM appointments a
      JOIN services s ON a.service_id = s.id
      JOIN staff st ON a.staff_id = st.id
      JOIN customers c ON a.customer_id = c.id
      WHERE a.organization_id = ?
        AND (LOWER(c.name) LIKE ? OR LOWER(s.name) LIKE ? OR a.booking_ref LIKE ?)
      ORDER BY a.date DESC LIMIT 10
    `).all(user.orgId, `%${q}%`, `%${q}%`, `%${q}%`) as typeof results;
  }

  const label = recordType === 'customers' ? 'customer' : recordType === 'staff' ? 'staff member'
    : recordType === 'services' ? 'service' : 'appointment';

  if (!results.length) {
    const emptyMsg = searchQuery
      ? `No ${label}s found matching **"${searchQuery}"** in your organization. Try a different name or check the spelling.`
      : `No ${label}s found in your organization.`;
    return makeResult({
      type: 'search_results',
      answer: emptyMsg,
      intent: 'record_search',
      searchResults: [],
    });
  }

  // Build human-readable answer
  const lines = results.map(r => {
    if (recordType === 'customers') return `- **${r.name}** — ${r.email}${r.phone ? ` · ${r.phone}` : ''}`;
    if (recordType === 'staff') return `- **${r.name}** (${r.role})${r.title ? ` — ${r.title}` : ''}`;
    if (recordType === 'services') return `- **${r.name}** — ${r.duration} min, ${r.currency} ${r.price}`;
    return `- **${r.customerName}** — ${r.serviceName} on ${r.date} at ${r.startTime} [${r.status}]`;
  });
  const countLabel = searchQuery
    ? `Found **${results.length} ${label}${results.length !== 1 ? 's' : ''}** matching "${searchQuery}":`
    : `**${results.length} ${label}${results.length !== 1 ? 's' : ''}** in your organization:`;
  const answer = `${countLabel}\n\n${lines.join('\n')}`;

  return makeResult({
    type: 'search_results',
    answer,
    intent: 'record_search',
    searchResults: results,
  });
}

// ── Handler: action request (service creation proposal) ───────────────────────

function handleActionRequest(
  query: string,
  entities: Record<string, unknown>,
  user: AuthPayload,
  conversationId: string | null,
): LocalAnswerResult {
  const feature = entities.feature as string | undefined;

  if (!can(user.role, 'services:write')) {
    return makeResult({
      type: 'text',
      answer: 'Your account does not have permission to create services. Ask an administrator of your business to do it.',
      intent: 'action_request',
    });
  }

  // Currently supports: create service
  if (feature !== 'service' && !/(service|treatment|offering)/i.test(query)) {
    return makeResult({
      type: 'clarification',
      answer: 'I can prepare creation proposals for services. What would you like to create? Please provide the name, duration, and price.',
      intent: 'action_request',
      clarificationQuestion: 'What would you like to create? (name, duration, price)',
    });
  }

  const duration = entities.duration as number | undefined ?? extractDuration(query);
  const priceInfo = typeof entities.price === 'number' ? { price: entities.price as number, currency: (entities.currency as string) ?? DEFAULT_CURRENCY } : extractPrice(query);
  const serviceName = entities.serviceName as string | undefined ?? extractServiceName(query) ?? 'New Service';

  if (!duration) {
    return makeResult({
      type: 'clarification',
      answer: `To create the **${serviceName}** service, I need the duration. How long should each session be? (e.g., 30 minutes, 1 hour)`,
      intent: 'action_request',
      clarificationQuestion: 'What is the duration (in minutes)?',
    });
  }

  if (!priceInfo) {
    return makeResult({
      type: 'clarification',
      answer: `To create the **${serviceName}** service (${duration} min), what is the price per session? (e.g., ₹500, $50, or 0 for free)`,
      intent: 'action_request',
      clarificationQuestion: 'What is the price?',
    });
  }

  // Detect category from service name
  const catMap: Record<string, string> = {
    consultation: 'consultation', consult: 'consultation',
    class: 'class', session: 'session', workshop: 'workshop',
    tour: 'tour', rental: 'rental',
  };
  const lowerName = serviceName.toLowerCase();
  const category = Object.keys(catMap).find(k => lowerName.includes(k))
    ? catMap[Object.keys(catMap).find(k => lowerName.includes(k))!]
    : 'consultation';

  const displayData = {
    type: 'Create Service',
    fields: [
      { label: 'Name', value: toTitleCase(serviceName) },
      { label: 'Duration', value: `${duration} minutes` },
      { label: 'Price', value: `${priceInfo.currency} ${priceInfo.price}` },
      { label: 'Category', value: category },
    ] as Array<{ label: string; value: unknown }>,
  };

  const inputData = {
    name: toTitleCase(serviceName),
    duration,
    price: priceInfo.price,
    category,
    currency: priceInfo.currency,
  };

  // Ensure we have a valid conversation_id (the schema enforces NOT NULL + FK)
  let convId = conversationId;
  if (!convId) {
    convId = `conv-local-${nanoid(12)}`;
    db.prepare(`
      INSERT INTO ai_conversations (id, organization_id, user_id, title)
      VALUES (?, ?, ?, ?)
    `).run(convId, user.orgId, user.sub, query.slice(0, 60));
  }

  const proposalId = `prop-${nanoid(12)}`;
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  db.prepare(`
    INSERT INTO ai_proposals
      (id, conversation_id, organization_id, user_id, tool_name, input_data, display_data, status, expires_at)
    VALUES (?, ?, ?, ?, 'propose_create_service', ?, ?, 'pending', ?)
  `).run(
    proposalId,
    convId,
    user.orgId,
    user.sub,
    JSON.stringify(inputData),
    JSON.stringify(displayData),
    expiresAt,
  );

  // Audit log
  db.prepare(`
    INSERT INTO ai_audit_log (id, organization_id, user_id, conversation_id, proposal_id, action, resource_type, details)
    VALUES (?, ?, ?, ?, ?, 'proposal_created', 'propose_create_service', ?)
  `).run(`audit-${nanoid(10)}`, user.orgId, user.sub, convId, proposalId, JSON.stringify(inputData));

  const priceStr = priceInfo.currency === 'INR' ? `₹${priceInfo.price}` : `${priceInfo.currency} ${priceInfo.price}`;
  const answer = `I've prepared a service creation request. Review the details below and **Confirm** to create it, or **Cancel** to discard.\n\n`
    + `**${toTitleCase(serviceName)}** · ${duration} minutes · ${priceStr}`;

  return makeResult({
    type: 'action_proposal',
    answer,
    intent: 'action_request',
    proposalId,
    proposalDisplayData: displayData,
    proposalToolName: 'propose_create_service',
  });
}

function toTitleCase(s: string): string {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

// ── Workflow: check for a pending availability workflow that can be resumed ────

function checkAndResumeWorkflow(user: AuthPayload): LocalAnswerResult | null {
  const now = new Date().toISOString();
  const pending = db.prepare(`
    SELECT id, original_query, context FROM ai_workflows
    WHERE organization_id = ? AND user_id = ? AND type = 'availability_request'
      AND status = 'active' AND expires_at > ?
    ORDER BY created_at DESC LIMIT 1
  `).get(user.orgId, user.sub, now) as { id: string; original_query: string; context: string } | undefined;

  if (!pending) return null;

  const serviceCount = (db.prepare(
    'SELECT COUNT(*) as c FROM services WHERE organization_id = ? AND is_active = 1'
  ).get(user.orgId) as { c: number }).c;

  if (serviceCount === 0) return null;

  // Services now exist — complete the workflow and resume availability check
  db.prepare('UPDATE ai_workflows SET status = ? WHERE id = ?').run('completed', pending.id);

  const ctx = JSON.parse(pending.context) as { date?: string };
  const result = handleAvailability(ctx.date, user);
  result.answer = `I noticed you've set up services! Let me resume checking availability for your earlier request.\n\n${result.answer}`;
  return result;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function localAnswer(
  query: string,
  topK = 5,
  user?: AuthPayload,
  conversationId?: string,
  triggerWorkflowResume = false,
): Promise<LocalAnswerResult> {
  // When called explicitly to resume a workflow (e.g., after service creation via proposal)
  if (triggerWorkflowResume && user) {
    const resumed = checkAndResumeWorkflow(user);
    return resumed ?? makeResult({
      type: 'text',
      answer: 'No pending availability request to resume.',
      intent: 'availability_query',
    });
  }

  // Auto-resume a pending workflow when services have been set up since the blocker
  if (user) {
    const resumed = checkAndResumeWorkflow(user);
    if (resumed) return resumed;
  }

  const { intent, entities, featureCategories, confidence } = routeIntent(query);

  // Greeting / vague
  if (intent === 'greeting') {
    return makeResult({
      type: 'text',
      answer: "Hi! I'm Workeasy Ai Agent. Ask me anything about appointments, services, staff, customers, settings, or reports.",
      intent: 'greeting',
      confidence: 'high',
    });
  }

  // Out of scope
  if (intent === 'out_of_scope') {
    return makeResult({
      type: 'out_of_scope',
      answer: "That question is outside my WorkEasy360 knowledge. I can help with appointments, services, staff, customers, settings, reports, or integrations.\n\nTry asking:\n- How do I add a staff member?\n- What reports are available?\n- How to set up email reminders?",
      intent: 'out_of_scope',
      confidence: 'high',
    });
  }

  // Navigation (no auth needed)
  if (intent === 'navigation' && entities.routePath) {
    return makeResult({
      type: 'navigation',
      answer: `Taking you to **${entities.routeTitle}**…`,
      intent: 'navigation',
      navigateTo: entities.routePath,
      navigationTitle: entities.routeTitle,
    });
  }

  // Intents that require authenticated user
  if (intent === 'live_data_query' || intent === 'record_search' || intent === 'action_request' || intent === 'availability_query') {
    if (!user) {
      // Fall back to BM25 documentation answer
      return bm25Answer(query, topK, 'general', featureCategories);
    }

    if (intent === 'live_data_query') {
      return handleLiveData(query, entities.timeframe, entities.date, entities.listMode, user);
    }

    if (intent === 'record_search') {
      const recordType = entities.recordType ?? 'customers';
      const searchQuery = entities.searchQuery ?? '';
      return handleRecordSearch(recordType, searchQuery, user);
    }

    if (intent === 'availability_query') {
      // "Tomorrow" means the business's tomorrow, not the server's.
      const date = extractDate(query, todayInTimezone(getOrgTimezone(user.orgId))) ?? entities.date;
      return handleAvailability(date, user, query, conversationId);
    }

    if (intent === 'action_request') {
      return handleActionRequest(query, entities as Record<string, unknown>, user, conversationId ?? null);
    }
  }

  // Clarification needed
  if (intent === 'clarification_needed') {
    const feature = entities.feature;
    const hint = feature ? ` about ${feature}` : '';
    const suggestions = feature && FEATURE_SUGGESTIONS[feature]
      ? FEATURE_SUGGESTIONS[feature]
      : DEFAULT_SUGGESTIONS;
    const suggestionList = suggestions.map(s => `- ${s}`).join('\n');
    return makeResult({
      type: 'clarification',
      answer: `Could you be more specific${hint}? Here are some things I can help with:\n\n${suggestionList}`,
      intent: 'clarification_needed',
    });
  }

  // Platform how-to — BM25 with optional feature filter
  return bm25Answer(query, topK, 'platform_how_to', featureCategories);
}

// ── BM25 documentation retrieval ──────────────────────────────────────────────

function bm25Answer(
  query: string,
  topK: number,
  intent: string,
  featureCategories: string[],
): LocalAnswerResult {
  const expandedQuery = expandQuery(normalizeTypos(query));
  const chunks = retrieve(expandedQuery, topK, 'authenticated', featureCategories.length > 0 ? featureCategories : undefined);

  if (chunks.length === 0) {
    // If feature filter returned nothing, try without it
    const fallback = featureCategories.length > 0 ? retrieve(expandedQuery, topK, 'authenticated') : [];
    if (!fallback.length) {
      return makeResult({
        type: 'text',
        answer: "I don't have information about that in the WorkEasy360 knowledge base. Try rephrasing your question.",
        intent,
        noResults: true,
        confidence: 'low',
      });
    }
    return bm25FromChunks(query, intent, fallback, topK);
  }

  return bm25FromChunks(query, intent, chunks, topK);
}

function bm25FromChunks(
  query: string,
  intent: string,
  chunks: RetrievedChunk[],
  _topK: number,
): LocalAnswerResult {
  const topScore = chunks[0].score;
  const confidence: 'high' | 'medium' | 'low' = topScore >= 1.5 ? 'high' : topScore >= 0.5 ? 'medium' : 'low';

  // Low confidence: don't dump a potentially wrong guide — suggest related topics instead
  if (confidence === 'low') {
    const primaryCategory = chunks[0]?.category;
    const suggestions = primaryCategory && FEATURE_SUGGESTIONS[primaryCategory]
      ? FEATURE_SUGGESTIONS[primaryCategory]
      : DEFAULT_SUGGESTIONS;
    const suggestionList = suggestions.map(s => `- ${s}`).join('\n');
    return makeResult({
      type: 'text',
      answer: `I don't have specific information about that. Here are some related topics that might help:\n\n${suggestionList}`,
      sources: [],
      confidence: 'low',
      intent,
      retrievedChunks: chunks.length,
      noResults: false,
    });
  }

  // Map to legacy intent for assembly
  const legacyIntent = (() => {
    if (/\bwhere\b/i.test(query)) return 'where_is' as LegacyIntent;
    if (/\bwhy\b|\bnot\s+working\b|\berror\b/i.test(query)) return 'troubleshoot' as LegacyIntent;
    if (/\bwhat\s+is\b|\bwhat\s+are\b/i.test(query)) return 'what_is' as LegacyIntent;
    if (/\blist\b|\ball\b/i.test(query)) return 'list' as LegacyIntent;
    return toLegacyIntent(intent);
  })();

  const { text, steps, navigation } = assembleBM25Answer(legacyIntent, chunks, query);

  // Deduplicate sources
  const seenDocs = new Set<string>();
  const sources: string[] = [];
  for (const chunk of chunks) {
    if (!seenDocs.has(chunk.docId)) {
      seenDocs.add(chunk.docId);
      sources.push(chunk.docTitle);
    }
  }

  return {
    type: 'text',
    answer: text,
    steps: steps.length > 0 ? steps : undefined,
    navigation,
    sources,
    confidence,
    intent,
    retrievedChunks: chunks.length,
    noResults: false,
  };
}

