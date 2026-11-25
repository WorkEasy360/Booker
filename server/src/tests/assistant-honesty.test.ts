/**
 * The assistant answers from the real knowledge articles (server/knowledge and the built-in article), indexed the way
 * the server does at startup. It must describe the current product (V4: Appointments with its calendar view,
 * Availability, Customers, Settings, My Account), answer from the right article, never borrow another article's
 * steps, never present unbuilt features (online payments, reports, workspaces, video meetings) as available, and never
 * send people to screens of earlier versions. Articles of earlier versions still stored in a database are switched off
 * at startup.
 * Fresh throw-away database per file (jest.setup.js).
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import db from '../db/init';
import { localAnswer } from '../services/local-answer';
import { indexKnowledgeDirectory, categoryOf } from '../services/knowledge-indexer';
import { seedKnowledge, AI_ASSISTANT_DOC_ID } from '../services/ai-knowledge';
import { chunkText, indexDocument, CHUNKING_VERSION } from '../services/rag';

const KNOWLEDGE_DIR = path.join(__dirname, '..', '..', 'knowledge');
const FILES = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md'));

beforeAll(() => {
  seedKnowledge();
  const stats = indexKnowledgeDirectory();
  expect(stats.failed).toEqual([]);
});

const NOT_BUILT = /not available|coming soon/i;
// Addresses of screens that no longer exist.
const OLD_ROUTE = /^\/(dashboard|my-space|reports|calendar|staff|services|booking-pages|workspaces|resources|notifications|integrations)\b|^\/settings\/hours/;

async function ask(question: string) {
  const result = await localAnswer(question);
  return { result, text: [result.answer, ...(result.steps ?? [])].join('\n') };
}

function articleText(title: string): string {
  const row = db.prepare('SELECT content FROM ai_knowledge_docs WHERE title = ? AND is_active = 1').get(title) as { content: string } | undefined;
  return row?.content ?? '';
}

describe('business and staff working hours are set in Availability', () => {
  it.each([
    'How do I set business working hours?',
    'How to set business working hours?',
    'Where do I set my business opening hours?',
  ])('"%s" is answered from the business hours section of Availability', async question => {
    const { result, text } = await ask(question);
    expect(result.sources?.[0]).toBe('Availability — Guide');
    expect(text).toMatch(/\/availability/);
    expect(result.steps).toEqual(expect.arrayContaining(['In **Showing**, choose **Business hours**.', 'Click **Save Working Hours**.']));
    // Never the old business settings screen or the old staff form.
    expect(text).not.toMatch(/Settings → Working Hours|\/settings\/hours|staff form|New Staff|Edit Profile/);
  });

  it.each([
    'How do I change staff working hours?',
    'How do I set staff working hours',
    'set staff working hours',
  ])('"%s" gives the staff member steps in Availability, not the Team article', async question => {
    const { result } = await ask(question);
    expect(result.sources?.[0]).toBe('Availability — Guide');
    expect(result.steps).toEqual(expect.arrayContaining(['In **Showing**, choose the staff member.']));
  });

  it('business hours limit every staff member', () => {
    expect(articleText('Availability — Guide')).toMatch(/inside both the staff member's working hours and the business working hours/);
  });

  it('time off, holidays and special hours have a screen: Availability → Date Exceptions', async () => {
    for (const question of ['How do I add time off for a staff member?', 'How do I block a holiday?', 'How do I set different hours for one day?']) {
      const { result } = await ask(question);
      expect(result.sources?.[0]).toBe('Availability — Guide');
      expect(result.steps).toEqual(expect.arrayContaining(['Under **Date Exceptions**, click **Add Exception**.']));
    }
  });
});

describe('features that are not built', () => {
  it.each([
    ['Can customers pay online?', /online payment/i],
    ['Can I use Stripe?', /online payment/i],
    ['Does Zoom work?', /video meetings/i],
    ['What reports are available?', /reports/i],
    ['How do I add a workspace?', /workspaces/i],
    ['Can I book rooms?', /rooms/i],
    ['How do I bulk import customers from a spreadsheet?', /import/i],
  ])('"%s" says it is not available', async (question, topic) => {
    const { result, text } = await ask(question);
    expect(result.intent).not.toBe('out_of_scope');
    expect(text).toMatch(NOT_BUILT);
    expect(text).toMatch(topic);
    // No procedure from another article.
    expect(result.steps ?? []).toEqual([]);
    expect(text).not.toMatch(/Enter your email address and password|New Appointment|Save Appointment/);
  });

  it('"What integrations are available?" names the webhooks available now and the connectors coming soon', async () => {
    const { result, text } = await ask('What integrations are available?');
    expect(result.sources?.[0]).toBe('Integrations — Guide');
    expect(text).toMatch(/webhooks are available now/i);
    expect(text).toMatch(/Coming Soon/);
    expect(text).toMatch(/Google Calendar/);
  });
});

describe('built features that depend on a provider or a setting', () => {
  it.each([
    ['How do I send appointment reminders?', /Reminder 24 hours before/],
    ['How to set up email reminders?', /Reminder 24 hours before/],
    ['How do I send SMS reminders?', /SMS or WhatsApp when those channels are on/],
  ])('"%s" is answered from Notifications', async (question, topic) => {
    const { result, text } = await ask(question);
    expect(result.sources?.[0]).toBe('Notifications — Guide');
    expect(text).toMatch(topic);
    expect(text).toMatch(/\/settings\/notifications/);
  });

  it('WhatsApp and SMS need the shared WorkEasy360 connection and are charged to the Consumption Wallet', async () => {
    const { result, text } = await ask('How do I send WhatsApp messages?');
    expect(result.sources?.[0]).toBe('Notifications — Guide');
    expect(text).toMatch(/Connected/);
    expect(articleText('Notifications — Guide')).toMatch(/Consumption Wallet/);
  });

  it('Google Calendar sync is coming soon (Settings → Integrations), without invented setup steps', async () => {
    const { result, text } = await ask('How do I connect Google Calendar?');
    expect(result.sources?.[0]).toBe('Integrations — Guide');
    expect(text).toMatch(/coming soon/i);
    expect(result.steps ?? []).toEqual([]);
  });
});

describe('answers never borrow another article\'s steps', () => {
  it.each([
    'How do I set business working hours?',
    'How do I change staff working hours?',
    'How do I add a new staff member?',
    'How do I invite a staff member to sign in?',
    'How do I create an appointment?',
    'How do I reschedule an appointment?',
    'How do I cancel an appointment?',
    'How do I create a service?',
    'How do I edit a service?',
    'How do I create a booking page?',
    'How do I share my booking link?',
    'How do I add a customer?',
    'How do I change my password?',
    'How do I change the time zone?',
    'How do I block a holiday?',
  ])('every step of "%s" comes from the article the answer cites first', async question => {
    const { result } = await ask(question);
    expect(result.intent).not.toBe('out_of_scope');
    const source = articleText(result.sources?.[0] ?? '');
    expect(source).not.toBe('');
    expect(result.steps?.length ?? 0).toBeGreaterThan(0);
    for (const step of result.steps ?? []) expect(source).toContain(step);
  });

  it('a common word in the question does not outweigh the specific one', async () => {
    // "appointment" is in most articles; "cancel" and "reminders" decide which section or article answers.
    const cancel = await ask('How do I cancel an appointment?');
    expect(cancel.result.steps?.join('\n')).toMatch(/click \*\*Cancel Appointment\*\*/);
    const reminders = await ask('How do I send appointment reminders?');
    expect(reminders.result.sources?.[0]).toBe('Notifications — Guide');
  });

  it('a troubleshooting question gets the reasons, not the article\'s other procedures', async () => {
    const { result, text } = await ask('Why is my time slot not available?');
    expect(result.sources?.[0]).toBe('Troubleshooting — Guide');
    expect(text).toMatch(/business hours/i);
    expect(text).toMatch(/time off/i);
    expect(text).not.toMatch(/Save Appointment|Save Working Hours/);
    expect(result.steps ?? []).toEqual([]);
  });

  it('role answers match the permissions the server enforces', async () => {
    const manager = await ask('What can a manager do?');
    expect(manager.text).toMatch(/A manager cannot add, edit or deactivate staff members/);
    expect(manager.text).not.toMatch(/workspaces|resources|reports/i);
    const staff = await ask('What can a staff member do?');
    expect(staff.result.sources?.[0]).toBe('Roles and Permissions — Guide');
    expect(staff.text).toMatch(/only their own appointments/);
  });

  it('procedures stay in their own section ("create" and "edit" a service differ)', async () => {
    const create = await ask('How do I create a service?');
    const edit = await ask('How do I edit a service?');
    expect(create.result.steps).toContain('Click **Add Service**.');
    expect(create.result.steps).not.toContain('Click **Edit** next to the service.');
    expect(edit.result.steps).toContain('Click **Edit** next to the service.');
    expect(edit.result.steps).not.toContain('Click **Add Service**.');
  });
});

describe('answers describe the current product', () => {
  it.each([
    ['How do I add a service?', '/settings/services'],
    ['How do I add a new staff member?', '/settings/team'],
    ['How do I share my booking link?', '/appointments'],
    ['How do I change my password?', '/account'],
    ['How do I block a holiday?', '/availability'],
    ['Where is the calendar?', '/appointments?view=calendar'],
  ])('"%s" points to %s', async (question, route) => {
    const { result } = await ask(question);
    expect(result.navigation).toBe(route);
  });

  it('never points to a screen of an earlier version', async () => {
    for (const question of [
      'How do I add a service?', 'How do I add a new staff member?', 'Where is the calendar?', 'Where are the reports?',
      'How do I create a booking page?', 'How do I set business working hours?', 'What happened to the dashboard?',
      'How do I send appointment reminders?', 'What integrations are available?', 'How do I add a workspace?',
    ]) {
      const { result, text } = await ask(question);
      expect({ question, navigation: OLD_ROUTE.test(result.navigation ?? '') }).toEqual({ question, navigation: false });
      expect(text).not.toMatch(/`\/(dashboard|reports|staff|services\/new|booking-pages|workspaces|resources|my-space)\b/);
    }
  });

  it('Reports and the Dashboard are explained as removed, with what replaces them', async () => {
    const reports = await ask('Where are the reports?');
    expect(reports.text).toMatch(/not available/);
    const dashboard = await ask('What happened to the dashboard?');
    expect(dashboard.text).toMatch(/Appointments/);
    const nav = await localAnswer('Take me to the reports page');
    expect([nav.type, nav.navigateTo]).toEqual(['navigation', '/appointments']);
    expect(nav.answer).toMatch(/Reports are not available/);
  });

  it('a customer needs a phone number or an email address, and services have no price', () => {
    expect(articleText('Customers — Guide')).toMatch(/a phone number or an email address/);
    expect(articleText('Services — Guide')).toMatch(/no prices/);
  });
});

describe('knowledge indexing', () => {
  it('keeps short headings when chunking (they used to be dropped, merging sections)', () => {
    const chunks = chunkText('# Guide\n\n## Editing a service\n\n1. Open it.\n\n2. Save.', 600);
    expect(chunks.join('\n')).toContain('## Editing a service');
    expect(chunks.join('\n')).toContain('2. Save.');
  });

  it('every knowledge file has its own category', () => {
    const known = new Set(['overview', 'getting-started', 'appointments', 'availability', 'customers', 'services', 'staff',
      'public-booking', 'settings', 'notifications', 'automation', 'integrations', 'account', 'permissions', 'workflows',
      'troubleshooting', 'faq', 'limitations']);
    for (const file of FILES) expect({ file, known: known.has(categoryOf(file)) }).toEqual({ file, known: true });
  });

  it('an edited article stays active and replaces its chunks instead of piling up copies', () => {
    const source = 'knowledge/08-settings.md';
    const before = db.prepare('SELECT id FROM ai_knowledge_docs WHERE source = ? AND is_active = 1').get(source) as { id: string };
    db.prepare("UPDATE ai_knowledge_docs SET version = 'stale', content = 'old text' WHERE id = ?").run(before.id);
    indexKnowledgeDirectory();
    const rows = db.prepare('SELECT id, is_active, version, content FROM ai_knowledge_docs WHERE source = ?').all(source) as Array<{ id: string; is_active: number; version: string; content: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: before.id, is_active: 1 });
    expect(rows[0].version).toMatch(new RegExp(`-c${CHUNKING_VERSION}$`));
    const content = fs.readFileSync(path.join(KNOWLEDGE_DIR, '08-settings.md'), 'utf8');
    expect(rows[0].content).toBe(content);
    const chunks = db.prepare('SELECT COUNT(*) AS n FROM ai_knowledge_chunks WHERE doc_id = ?').get(before.id) as { n: number };
    expect(chunks.n).toBe(chunkText(content, 600).length);
  });

  it('an article whose file was deleted is switched off at the next indexing (an old 11-reports.md)', async () => {
    const id = indexDocument({
      id: 'kdoc-old-reports-file', title: 'Reports & Analytics — Complete Guide', category: 'reports', source: 'knowledge/11-reports.md',
      content: '# Reports & Analytics — Complete Guide\n\n## Viewing revenue reports\n\n1. Go to Reports at `/reports`.\n2. Choose a date range.',
    });
    const stats = indexKnowledgeDirectory();
    expect(stats.removed).toBeGreaterThanOrEqual(1);
    expect(db.prepare('SELECT is_active FROM ai_knowledge_docs WHERE id = ?').pluck().get(id)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM ai_knowledge_chunks WHERE doc_id = ?').pluck().get(id)).toBe(0);
    const { result } = await ask('How do I view revenue reports?');
    expect(result.sources).not.toContain('Reports & Analytics — Complete Guide');
  });

  it('built-in articles of earlier versions are switched off when the server starts', async () => {
    indexDocument({
      id: 'kdoc-reports', title: 'Reports and Analytics', category: 'reports', source: 'WorkEasy360 Help',
      content: '# Reports in WorkEasy360\n\n## Summary Report\nShows total appointments, revenue, new customers and cancellation rate.',
    });
    indexDocument({
      id: 'kdoc-settings', title: 'Business Settings', category: 'settings', source: 'WorkEasy360 Help',
      content: '# Business Settings in WorkEasy360\n\n## Business Working Hours\nGo to Settings → Working Hours (/settings/hours).',
    });
    seedKnowledge();
    for (const id of ['kdoc-reports', 'kdoc-settings']) {
      expect(db.prepare('SELECT is_active FROM ai_knowledge_docs WHERE id = ?').pluck().get(id)).toBe(0);
      expect(db.prepare('SELECT COUNT(*) FROM ai_knowledge_chunks WHERE doc_id = ?').pluck().get(id)).toBe(0);
    }
    const { text } = await ask('How do I set business working hours?');
    expect(text).not.toMatch(/\/settings\/hours/);
  });

  it('a corrected built-in article reaches a database that holds the old text', () => {
    db.prepare("UPDATE ai_knowledge_docs SET content = 'old text', title = 'AI Operator — How to Use', version = NULL WHERE id = ?").run(AI_ASSISTANT_DOC_ID);
    db.prepare('DELETE FROM ai_knowledge_chunks WHERE doc_id = ?').run(AI_ASSISTANT_DOC_ID);
    seedKnowledge();
    expect(articleText('AI Assistant — Guide')).toMatch(/Nothing is saved until you click \*\*Confirm\*\*/);
    expect(articleText('AI Operator — How to Use')).toBe('');
    const chunks = db.prepare('SELECT content FROM ai_knowledge_chunks WHERE doc_id = ?').all(AI_ASSISTANT_DOC_ID) as Array<{ content: string }>;
    expect(chunks.map(c => c.content).join('\n')).toMatch(/How confirmation works/);
  });

  it('knowledge articles state what is not built and never describe earlier screens or hours as a fallback', () => {
    expect(fs.readFileSync(path.join(KNOWLEDGE_DIR, '17-known-limitations.md'), 'utf8')).toMatch(NOT_BUILT);
    for (const file of FILES) {
      const text = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), 'utf8');
      expect({ file, fallback: /fallback for staff|uses the business's default working hours|may use business hours/i.test(text) })
        .toEqual({ file, fallback: false });
      expect({ file, oldScreens: /`\/(dashboard|my-space|reports|calendar|staff|services|booking-pages|workspaces|resources)\b|\/settings\/hours|Create Workspace|Settings → Working Hours/.test(text) })
        .toEqual({ file, oldScreens: false });
    }
  });
});
