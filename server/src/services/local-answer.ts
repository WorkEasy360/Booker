/**
 * Local answer engine — intent-routed responses without external AI APIs.
 * Routes to: BM25 knowledge retrieval, live DB queries, navigation, record
 * search, action proposals, or clarification requests.
 *
 * Answers describe WorkEasy360 Booking V4: four menus (Appointments with its calendar view, Availability, Customers,
 * Settings) and My Account. Services have a name and a duration only; there are no prices or revenue.
 */

import { nanoid } from 'nanoid';
import db from '../db/init';
import { retrieve, queryTerms, stem, termWeights } from './rag';
import { routeIntent, extractDuration, extractPrice, extractDate, extractServiceName, normalizeTypos } from './intent-router';
import type { AuthPayload } from '../types';
import { can } from '../auth/permissions';
import { todayInTimezone, getOrgTimezone, freeTimesByStaff } from './availability';
import {
  appointmentCounts, periodRange, shiftDate, statusLabel, findCustomers, findServices, findStaff, findAppointments,
  type SummaryPeriod,
} from './ai-tools';

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

/** "Monday, December 1" for a YYYY-MM-DD date (calendar date, no time zone shift). */
function longDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// ── Synonym expansion for BM25 queries ────────────────────────────────────────

// Words people use → the word the help articles use. Expanding the other way too ("staff" → member, team, invite,
// provider…) made every staff question look like the Team article, even "staff working hours" (Availability).
const SYNONYMS: Record<string, string[]> = {
  create:       ['add', 'new', 'make', 'set up', 'build', 'configure'],
  appointment:  ['booking', 'meeting', 'schedule', 'session', 'slot', 'अपॉइंटमेंट', 'बुकिंग'],
  service:      ['treatment', 'offering', 'सेवा'],
  staff:        ['employee', 'member', 'provider', 'therapist', 'doctor', 'team member', 'colleague', 'coworker', 'teammate', 'invite', 'onboard', 'hire', 'स्टाफ'],
  customer:     ['client', 'patient', 'ग्राहक'],
  cancel:       ['delete', 'remove', 'stop', 'void', 'रद्द'],
  reschedule:   ['change time', 'move', 'shift', 'postpone'],
  settings:     ['configuration', 'preferences', 'config', 'सेटिंग'],
  password:     ['credentials', 'login details', 'पासवर्ड'],
  notification: ['reminder', 'email reminder', 'email alert', 'notify', 'sms', 'whatsapp'],
  reminder:     ['notification', 'email reminder', 'email alert'],
  integration:  ['connect', 'sync', 'webhook'],
  calendar:     ['timetable', 'agenda', 'schedule view'],
  account:      ['login', 'user account', 'my account'],
  availability: ['working hours', 'opening hours', 'business hours', 'time off', 'holiday', 'day off'],
  exception:    ['holiday', 'closure', 'time off', 'day off', 'leave', 'vacation'],
  // Hinglish
  kaise:        ['how to', 'how do i'],
  banate:       ['create', 'make', 'add'],
  karein:       ['how to', 'do'],
  karte:        ['do', 'doing'],
  hain:         ['is', 'are'],
};

// Keys whose synonyms are searched too: Hinglish words, and "create" (articles say "Adding…" and "Add Service").
const TWO_WAY = new Set(['create', 'kaise', 'banate', 'karein', 'karte', 'hain']);

function expandQuery(query: string): string {
  const lower = query.toLowerCase();
  const expansions = new Set([lower]);
  for (const [key, syns] of Object.entries(SYNONYMS)) {
    for (const syn of syns) {
      if (lower.includes(syn)) expansions.add(lower.replace(syn, key));
    }
    if (TWO_WAY.has(key) && lower.includes(key)) {
      for (const syn of syns) expansions.add(lower.replace(key, syn));
    }
  }
  return Array.from(expansions).join(' ');
}

// ── Suggestions shown when a question is too vague or confidence is low ───────

const SUGGESTIONS: Record<string, string[]> = {
  staff:         ['How do I add a staff member?', 'How do I set a staff member\'s working hours?', 'How do I invite a staff member to sign in?'],
  appointment:   ['How do I create an appointment?', 'How do I reschedule an appointment?', 'How do I cancel an appointment?'],
  service:       ['How do I add a service?', 'How do I change a service\'s duration?', 'How do I choose who offers a service?'],
  customer:      ['How do I add a customer?', 'How do I find a customer?', 'How do I see a customer\'s appointment history?'],
  availability:  ['How do I set business working hours?', 'How do I block a holiday?', 'How do I add time off for a staff member?'],
  booking:       ['How do I share my booking link?', 'How do I turn online booking on or off?', 'How do customers cancel their booking?'],
  settings:      ['How do I change the business timezone?', 'How do I change my business details?', 'Where are the settings for notifications?'],
  account:       ['How do I change my password?', 'How do I turn on two-factor sign-in?', 'How do I get help from WorkEasy360 support?'],
  notification:  ['How do I send appointment reminders?', 'How do I turn on SMS or WhatsApp messages?', 'Why did a customer not get the confirmation email?'],
  integration:   ['What integrations are available?', 'How do I send booking events to a webhook?', 'Can I connect Google Calendar?'],
  permissions:   ['What can a staff member do?', 'What can an owner do?', 'How do I invite a staff member to sign in?'],
  limitations:   ['Can customers pay online?', 'Are reports available?', 'Can I add several locations?'],
};

// Article categories and router features that share a list of suggestions.
const SUGGESTION_ALIASES: Record<string, string> = {
  appointments: 'appointment', services: 'service', customers: 'customer', 'public-booking': 'booking',
  notifications: 'notification', automation: 'notification', integrations: 'integration', video: 'integration',
  report: 'limitations', data: 'limitations', workspace: 'limitations', resource: 'limitations', payment: 'limitations', dashboard: 'appointment',
};

const DEFAULT_SUGGESTIONS = [
  'How do I create an appointment?',
  'How do I set business working hours?',
  'How do I share my booking link?',
];

function suggestionsFor(key: string | undefined): string[] {
  if (!key) return DEFAULT_SUGGESTIONS;
  return SUGGESTIONS[key] ?? SUGGESTIONS[SUGGESTION_ALIASES[key] ?? ''] ?? DEFAULT_SUGGESTIONS;
}

// ── BM25 answer assembly ───────────────────────────────────────────────────────

interface RetrievedChunk { docId: string; docTitle: string; category: string; content: string; score: number }

const ROUTE_PATTERN = /`?(\/[a-z][a-z0-9/-]*(?:\?[a-z]+=[a-z-]+)?)`?/g;
/** The first in-app address named in a text (public booking links and API paths are not screens). */
function extractRoute(text: string): string | undefined {
  const routes = [...text.matchAll(ROUTE_PATTERN)].map(m => m[1]);
  return routes.find(r => !r.startsWith('/api') && !r.startsWith('/book'));
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

// Verbs people use for the action a heading names ("add a service" → "Adding a service").
const ACTION_SYNONYMS = [['create', 'add', 'new', 'make'], ['edit', 'change', 'update', 'modify']];
const alternativesOf = (term: string): string[] =>
  [term, ...(ACTION_SYNONYMS.find(group => group.includes(term)) ?? []).filter(w => w !== term)];

/**
 * The section of an article whose heading best matches the question. Heading words are compared by stem and weighted
 * by how rare they are in the knowledge base, so "time off" outweighs "staff". Words of the article's own title
 * ("Team — Guide") say nothing about which section is meant and are left out. Ties go to a section with steps, then
 * to the earlier one.
 */
function bestSection(article: string, query: string): Section | undefined {
  return sectionMatch(article, query)?.section;
}

/**
 * The best section of an article for a question. `score` weighs the question words its heading names; `fullScore`
 * also counts those the article's title names, so articles with different titles can be compared.
 */
function sectionMatch(article: string, query: string): { section: Section; score: number; fullScore: number } | undefined {
  const sections = sectionsOf(article);
  const titleStems = stemsOf(sections.find(s => s.level === 1)?.title ?? '');
  const allTerms = queryTerms(query);
  const untitled = allTerms.filter(t => !titleStems.has(stem(t)));
  // When the question only names the article's title ("What is WorkEasy360 Booking?"), the title words pick the section.
  const terms = untitled.length ? untitled : allTerms;
  if (!terms.length) return undefined;
  const weights = termWeights(allTerms);
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
      const full = allTerms.reduce((sum, t) => sum + (titleStems.has(stem(t)) || inHeading(heading, t) ? weights.get(t) ?? 0 : 0), 0);
      return { s, i, score, covered, full, steps: extractSteps(s.body).length > 0 ? 1 : 0 };
    })
    // The heading must name part of the question, and the section must cover at least half of it:
    // "Does Zoom work?" is not answered by a section called "What does work" that never mentions Zoom.
    .filter(x => x.score > 0 && x.covered >= total / 2)
    .sort((a, b) => b.score - a.score || b.steps - a.steps || a.i - b.i)
    .map(x => ({ section: x.s, score: x.score, fullScore: x.full }))[0];
}

/**
 * The retrieved article to answer from: the best keyword match, unless another well-matching article has a section
 * whose heading (with the article's title) names more of the question. "How do I see a customer's appointment
 * history?" is answered by the Customers article, not by the Appointments article that happens to mention history
 * more often. On a tie, a "why …" question prefers Troubleshooting. The chosen article's chunks come first.
 */
function chooseArticle(chunks: RetrievedChunk[], query: string, prefer?: string): RetrievedChunk[] {
  const docIds = [...new Set(chunks.map(c => c.docId))];
  if (docIds.length < 2) return chunks;
  const top = chunks[0].score;
  const candidates = docIds
    .filter(id => Math.max(...chunks.filter(c => c.docId === id).map(c => c.score)) >= top * 0.4)
    .map(id => {
      const own = chunks.filter(c => c.docId === id);
      const match = sectionMatch(own.map(c => c.content).join('\n\n'), query);
      return { id, score: (match?.fullScore ?? 0) + (match && own[0].category === prefer ? 1e-6 : 0) };
    });
  const best = candidates.reduce((a, b) => (b.score > a.score + 1e-9 ? b : a));
  if (best.id === docIds[0]) return chunks;
  return [...chunks.filter(c => c.docId === best.id), ...chunks.filter(c => c.docId !== best.id)];
}

type LegacyIntent = 'how_to' | 'where_is' | 'what_is' | 'troubleshoot' | 'list' | 'general';

function assembleBM25Answer(
  intent: LegacyIntent,
  chunks: RetrievedChunk[],
  queryHint = '',
): { text: string; steps: string[]; navigation: string | undefined } {
  if (chunks.length === 0) {
    return {
      text: "I don't have specific information about that in the WorkEasy360 Booking help articles.",
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
      // A section without steps (for example "not available") is answered with its own words.
      if (prose.length > 0) return { text: [section.title, ...prose.slice(0, 2)].join('\n\n'), steps: [], navigation };
    }

    // No section matches the question. An article without sections is one procedure: give its steps. An article
    // with sections gets its opening instead of guessing one of its procedures.
    const chunkSteps = extractSteps(topChunk);
    if (chunkSteps.length > 0 && !sectionsOf(article).some(s => s.level >= 2)) {
      return { text: topChunk.split('\n')[0].replace(/^#+\s*/, ''), steps: chunkSteps.slice(0, 10), navigation: extractRoute(topChunk) };
    }
    // The opening prose only: never a heading line or another procedure's steps.
    return {
      text: paragraphsOf(topChunk).slice(0, 2).join('\n\n').trim() || topChunk.split('\n')[0].replace(/^#+\s*/, ''),
      steps: [], navigation: extractRoute(topChunk),
    };
  }

  const navigation = extractRoute(article);

  if (intent === 'where_is' || intent === 'what_is') {
    // The section the question names, when one matches; otherwise the article's opening.
    const section = bestSection(article, queryHint);
    if (section) {
      const sectionSteps = extractSteps(section.body);
      const sectionText = leadOf(section.body)[0] ?? paragraphsOf(section.body)[0];
      const sectionRoute = extractRoute(`${section.heading}\n${section.body}`) ?? navigation;
      const routeInfo = intent === 'where_is' && sectionRoute ? ` You can find it at \`${sectionRoute}\`.` : '';
      if (intent === 'where_is' && sectionSteps.length > 0) {
        return { text: `${section.title}.${routeInfo}`, steps: sectionSteps.slice(0, 10), navigation: sectionRoute };
      }
      if (sectionText) return { text: `${section.title}: ${sectionText}${routeInfo}`, steps: [], navigation: sectionRoute };
    }
  }

  if (intent === 'where_is') {
    const routeInfo = navigation ? ` You can find it at \`${navigation}\`.` : '';
    const para = topChunk.split('\n\n').find(p => p.length > 40 && !/^#{1,6}\s/.test(p)) ?? topChunk.slice(0, 300);
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
    const para = topChunk.split('\n\n').find(p => p.length > 40 && !/^#{1,6}\s/.test(p)) ?? topChunk.slice(0, 400);
    return { text: para.replace(/^#+\s*/gm, '').trim(), steps: [], navigation };
  }

  if (intent === 'list') {
    const bullets = article.split('\n')
      .filter(l => /^[-*•]\s/.test(l) || /^\|\s/.test(l))
      .slice(0, 15)
      .map(l => l.replace(/^[-*•]\s/, '').trim())
      .filter(l => l.length > 2 && !/^\|[-\s|]+\|$/.test(l));
    if (bullets.length > 0) {
      const para = topChunk.split('\n').find(l => !l.startsWith('#') && l.trim().length > 30) ?? '';
      return { text: para.trim(), steps: bullets, navigation };
    }
  }

  return { text: paragraphsOf(topChunk).slice(0, 2).join('\n\n').trim() || topChunk.split('\n')[0].replace(/^#+\s*/, ''), steps: [], navigation };
}

// Map new intents → legacy BM25 assembly intent
function toLegacyIntent(intent: string): LegacyIntent {
  if (intent === 'platform_how_to') return 'how_to';
  if (intent === 'troubleshoot') return 'troubleshoot';
  return 'general';
}

// ── Handler: live data query ──────────────────────────────────────────────────

const SEE_ALL_APPOINTMENTS = 'Your account can see only your own appointments. Open **Appointments** to see them.';

function handleListAppointments(date: string, user: AuthPayload): LocalAnswerResult {
  if (!can(user.role, 'appointments:read')) return makeResult({ type: 'text', answer: SEE_ALL_APPOINTMENTS, intent: 'live_data_query' });
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

  const fmt = longDate(date);

  if (!appts.length) {
    return makeResult({
      type: 'live_data',
      answer: `No appointments are booked for **${fmt}**. You can [create an appointment](/appointments/new) or check a different date.`,
      intent: 'live_data_query',
      liveData: { total: 0, date },
    });
  }

  const lines = appts.map(a =>
    `- **${a.startTime}** — ${a.customerName} · ${a.serviceName} · ${a.staffName} (${statusLabel(a.status)})`
  );
  const answer = `**${appts.length} appointment${appts.length !== 1 ? 's' : ''}** on **${fmt}**:\n\n${lines.join('\n')}`;

  return makeResult({
    type: 'live_data',
    answer,
    intent: 'live_data_query',
    liveData: { total: appts.length, date },
  });
}

/** The dates a router timeframe covers, counted from the business's today. */
function timeframeRange(timeframe: string | undefined, today: string): { from: string; to: string; label: string } {
  const named: Record<string, SummaryPeriod> = { today: 'today', this_week: 'this_week', this_month: 'this_month', '7d': 'last_7_days' };
  if (timeframe && named[timeframe]) return periodRange(named[timeframe], today);
  if (timeframe === 'last_month') {
    const lastOfPrevious = shiftDate(`${today.slice(0, 7)}-01`, -1);
    return { from: `${lastOfPrevious.slice(0, 7)}-01`, to: lastOfPrevious, label: 'last month' };
  }
  if (timeframe === '3m') return { from: shiftDate(today, -89), to: today, label: 'in the last 3 months' };
  if (timeframe === '1y') return { from: shiftDate(today, -364), to: today, label: 'in the last year' };
  return periodRange('last_30_days', today);
}

function handleLiveData(query: string, timeframe: string | undefined, date: string | undefined, listMode: boolean | undefined, user: AuthPayload): LocalAnswerResult {
  // "Tomorrow" and "today" are the business's dates, not the server's.
  const today = todayInTimezone(getOrgTimezone(user.orgId));
  const businessDate = extractDate(query, today) ?? date;

  // "show my bookings for tomorrow" → list mode with specific date
  if (listMode && businessDate) {
    return handleListAppointments(businessDate, user);
  }
  if (!can(user.role, 'appointments:read')) return makeResult({ type: 'text', answer: SEE_ALL_APPOINTMENTS, intent: 'live_data_query' });

  const range = timeframe === 'specific_date' && businessDate
    ? { from: businessDate, to: businessDate, label: `on ${longDate(businessDate)}` }
    : timeframeRange(timeframe, today);
  const counts = appointmentCounts(user.orgId, range.from, range.to);

  let answer = `You have **${counts.total} appointment${counts.total !== 1 ? 's' : ''}** ${range.label}.`;
  if (counts.total > 0) {
    const parts: string[] = [];
    if (counts.scheduled > 0) parts.push(`${counts.scheduled} scheduled`);
    if (counts.completed > 0) parts.push(`${counts.completed} completed`);
    if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`);
    if (counts.noShow > 0) parts.push(`${counts.noShow} no-show`);
    if (parts.length > 0) answer += ` (${parts.join(', ')})`;
  }
  if (/\b(revenue|money|income|earn\w*|sales)\b/i.test(query)) {
    answer += '\n\nWorkEasy360 Booking does not record prices or revenue: customers pay the business directly.';
  }

  return makeResult({
    type: 'live_data',
    answer,
    intent: 'live_data_query',
    liveData: { ...counts, from: range.from, to: range.to, period: range.label },
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
      answer: 'Which date would you like to check? For example: "Show me available slots for tomorrow" or "Check availability for 2026-10-25".',
      intent: 'availability_query',
      clarificationQuestion: 'Which date would you like to check?',
    });
  }

  const today = todayInTimezone(getOrgTimezone(user.orgId));
  if (date < today) {
    return makeResult({
      type: 'error',
      answer: `I can't check free times for past dates. Please choose today (${today}) or a later date.`,
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
      answer: "I can't show free times yet because there is no active service. Add one in **Settings → Services** (a name and a duration), then ask again.",
      intent: 'availability_query',
      workflowInfo: {
        workflowId,
        reason: 'no_services',
        actions: [
          { label: 'Add a service', style: 'primary', intent: 'navigate', navigateTo: '/settings/services' },
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

  const fmt = longDate(date);
  if (!allSlots.length) {
    return makeResult({
      type: 'availability',
      answer: `No free times on **${fmt}**. The business may be closed, the staff may be off or fully booked. Try another date, or check the working hours and date exceptions in **Availability**.`,
      intent: 'availability_query',
      slots: [],
    });
  }

  const lines = allSlots.map(s => `**${s.staffName}**: ${s.times.slice(0, 8).join(', ')}${s.times.length > 8 ? ` (+${s.times.length - 8} more)` : ''}`);
  const answer = `Free times on **${fmt}**:\n\n${lines.join('\n')}`;

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
  const allowed = recordType === 'customers' ? can(user.role, 'customers:read')
    : recordType === 'appointments' ? can(user.role, 'appointments:read')
    : can(user.role, 'catalog:read');
  const label = recordType === 'customers' ? 'customer' : recordType === 'staff' ? 'staff member'
    : recordType === 'services' ? 'service' : 'appointment';
  if (!allowed) {
    return makeResult({ type: 'text', answer: `Your account cannot look up ${label}s.`, intent: 'record_search' });
  }

  const results = recordType === 'customers' ? findCustomers(user.orgId, searchQuery)
    : recordType === 'staff' ? findStaff(user.orgId, searchQuery)
    : recordType === 'services' ? findServices(user.orgId, searchQuery)
    : findAppointments(user.orgId, searchQuery);

  if (!results.length) {
    const emptyMsg = searchQuery
      ? `No ${label}s found matching **"${searchQuery}"**. Try a different name or check the spelling.`
      : `No ${label}s found in your business yet.`;
    return makeResult({
      type: 'search_results',
      answer: emptyMsg,
      intent: 'record_search',
      searchResults: [],
    });
  }

  // Build human-readable answer
  const lines = results.map(r => {
    if (recordType === 'customers') {
      const contact = [r.phone, r.email].filter(Boolean).join(' · ') || 'no contact details';
      return `- **${r.name}** — ${contact}`;
    }
    if (recordType === 'staff') return `- **${r.name}**${r.email ? ` — ${r.email}` : ''}${r.isActive ? '' : ' (inactive)'}`;
    if (recordType === 'services') return `- **${r.name}** — ${r.duration} min${r.isActive ? '' : ' (inactive)'}`;
    return `- **${r.customerName}** — ${r.serviceName} with ${r.staffName} on ${r.date} at ${r.startTime} (${r.status})`;
  });
  const countLabel = searchQuery
    ? `Found **${results.length} ${label}${results.length !== 1 ? 's' : ''}** matching "${searchQuery}":`
    : `**${results.length} ${label}${results.length !== 1 ? 's' : ''}** in your business:`;
  const answer = `${countLabel}\n\n${lines.join('\n')}`;

  return makeResult({
    type: 'search_results',
    answer,
    intent: 'record_search',
    searchResults: results,
  });
}

// ── Handler: action request (service creation proposal) ───────────────────────

const SERVICE_EXAMPLE = 'For example: "Create a 30-minute consultation service".';

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
      answer: 'Your account does not have permission to add services. Ask the owner of your business to do it in **Settings → Services**.',
      intent: 'action_request',
    });
  }

  // The local assistant prepares services only; appointments and customers are added on their own screens.
  if (feature !== 'service' && !/(service|treatment|offering)/i.test(query)) {
    return makeResult({
      type: 'clarification',
      answer: `I can prepare a new service for you to confirm: tell me its name and duration. ${SERVICE_EXAMPLE} `
        + 'To book an appointment, use **New Appointment** on Appointments; to add a customer, use **Add Customer** on Customers.',
      intent: 'action_request',
      clarificationQuestion: 'What is the name and duration of the service?',
    });
  }

  const duration = entities.duration as number | undefined ?? extractDuration(query);
  const serviceName = toTitleCase((entities.serviceName as string | undefined ?? extractServiceName(query) ?? 'New Service').trim());
  const priceGiven = typeof entities.price === 'number' || !!extractPrice(query);

  if (!duration) {
    return makeResult({
      type: 'clarification',
      answer: `To create the **${serviceName}** service, I need its duration. How long is each appointment? (for example 30 minutes or 1 hour)`,
      intent: 'action_request',
      clarificationQuestion: 'What is the duration (in minutes)?',
    });
  }
  if (!Number.isInteger(duration) || duration < 5 || duration > 1440) {
    return makeResult({
      type: 'clarification',
      answer: 'A service lasts between 5 and 1440 whole minutes. What duration should it have?',
      intent: 'action_request',
      clarificationQuestion: 'What is the duration (in minutes)?',
    });
  }
  if (db.prepare('SELECT 1 FROM services WHERE organization_id = ? AND LOWER(name) = LOWER(?)').get(user.orgId, serviceName)) {
    return makeResult({
      type: 'text',
      answer: `A service called **${serviceName}** already exists. You can change it in **Settings → Services** with **Edit**.`,
      intent: 'action_request',
      navigation: '/settings/services',
    });
  }

  const displayData = {
    type: 'Create Service',
    fields: [
      { label: 'Name', value: serviceName },
      { label: 'Duration', value: `${duration} minutes` },
      { label: 'Offered by', value: 'Every active team member' },
    ] as Array<{ label: string; value: unknown }>,
  };

  const inputData = { name: serviceName, duration };

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

  const answer = `I've prepared a new service. Review the details below and **Confirm** to create it, or **Cancel** to discard.\n\n`
    + `**${serviceName}** · ${duration} minutes · offered by every active team member (change this in **Settings → Team**).`
    + (priceGiven ? '\n\nServices in WorkEasy360 Booking have no price: customers pay the business directly, so the price was left out.' : '');

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
  result.answer = `You have set up services now. Here is the availability for your earlier request.\n\n${result.answer}`;
  return result;
}

// ── Main entry point ──────────────────────────────────────────────────────────

const GREETING = "Hi! I'm Workeasy Ai Agent. Ask me about appointments, availability, customers, services, your team, "
  + 'your booking link or settings, or ask me to find a customer, show free times or open a screen.';

const OUT_OF_SCOPE = 'That question is outside my WorkEasy360 knowledge. I can help with appointments, availability, customers, '
  + 'services, your team, notifications and settings.\n\nTry asking:\n- How do I add a staff member?\n- How do I block a holiday?\n- How do I send appointment reminders?';

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

  const { intent, entities, featureCategories } = routeIntent(query);

  // Greeting / vague
  if (intent === 'greeting') {
    return makeResult({ type: 'text', answer: GREETING, intent: 'greeting', confidence: 'high' });
  }

  // Out of scope
  if (intent === 'out_of_scope') {
    return makeResult({ type: 'out_of_scope', answer: OUT_OF_SCOPE, intent: 'out_of_scope', confidence: 'high' });
  }

  // Navigation (no auth needed). A screen of an earlier version opens the screen that replaces it, with a note.
  if (intent === 'navigation' && entities.routePath) {
    const opening = `Taking you to **${entities.routeTitle}**…`;
    return makeResult({
      type: 'navigation',
      answer: entities.routeNote ? `${entities.routeNote}\n\n${opening}` : opening,
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
    const hint = feature && SUGGESTIONS[feature] ? ` about ${feature === 'staff' ? 'your team' : `${feature}s`}` : '';
    const suggestionList = suggestionsFor(feature).map(s => `- ${s}`).join('\n');
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
        answer: "I don't have information about that in the WorkEasy360 Booking help articles. Try rephrasing your question.",
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
    const suggestionList = suggestionsFor(chunks[0]?.category).map(s => `- ${s}`).join('\n');
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
    if (/\blist\b/i.test(query)) return 'list' as LegacyIntent;
    return toLegacyIntent(intent);
  })();

  chunks = chooseArticle(chunks, query, legacyIntent === 'troubleshoot' ? 'troubleshooting' : undefined);
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
