/**
 * The assistant answers from the real knowledge articles (server/knowledge and the built-in articles), indexed the way
 * the server does at startup. It must answer from the right article, never borrow another article's steps, and never
 * present unbuilt features (online payments, video meetings) as available. Built features that depend on a provider
 * (SMS, WhatsApp, calendar sync) are described with where they are set up and what they need.
 * Fresh throw-away database per file (jest.setup.js).
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import db from '../db/init';
import { localAnswer } from '../services/local-answer';
import { indexKnowledgeDirectory } from '../services/knowledge-indexer';
import { seedKnowledge } from '../services/ai-knowledge';
import { chunkText, CHUNKING_VERSION } from '../services/rag';

const KNOWLEDGE_DIR = path.join(__dirname, '..', '..', 'knowledge');

beforeAll(() => {
  seedKnowledge();
  const stats = indexKnowledgeDirectory();
  expect(stats.failed).toEqual([]);
});

const NOT_BUILT = /not implemented yet|not available yet|not yet connected|not sent/i;

async function ask(question: string) {
  const result = await localAnswer(question);
  return { result, text: [result.answer, ...(result.steps ?? [])].join('\n') };
}

function articleText(title: string): string {
  const row = db.prepare('SELECT content FROM ai_knowledge_docs WHERE title = ? AND is_active = 1').get(title) as { content: string } | undefined;
  return row?.content ?? '';
}

describe('business and staff working hours', () => {
  it.each([
    'How do I set business working hours?',
    'How to set business working hours?',
    'Where do I set my business opening hours?',
  ])('"%s" is answered from the business working hours documentation', async question => {
    const { result, text } = await ask(question);
    expect(result.sources?.[0]).toMatch(/Settings/);
    expect(text).toMatch(/Settings → Working Hours|\/settings\/hours/);
    expect(text).toMatch(/limit every staff member/);
    // Never the staff form's procedure (this question used to get "Go to Staff → New Staff …").
    expect(text).not.toMatch(/staff form|New Staff|Edit Profile/);
    expect(text).not.toMatch(/fallback/i);
  });

  it('"How do I change staff working hours?" gives the staff form steps, not the business settings', async () => {
    const { result, text } = await ask('How do I change staff working hours?');
    expect(result.sources?.[0]).toMatch(/Staff/);
    expect(result.steps).toEqual(expect.arrayContaining(['Click **Edit Profile**.', 'In the staff form, scroll to **Working Hours**.']));
    expect(text).not.toMatch(/\/settings\/hours|Apply to all active days/);
  });
});

describe('features that are not built', () => {
  it.each([
    ['Can customers pay online?', /online payments/i],
    ['What integrations are available?', /not implemented yet/i],
    ['Does Zoom work?', /video meetings/i],
    ['Can I use Stripe?', /online payments/i],
  ])('"%s" says it is not available', async (question, topic) => {
    const { result, text } = await ask(question);
    expect(result.intent).not.toBe('out_of_scope');
    expect(text).toMatch(NOT_BUILT);
    expect(text).toMatch(topic);
    // No procedure from another article (the payment question once got sign-in steps, reminders got appointment steps).
    expect(result.steps ?? []).toEqual([]);
    expect(text).not.toMatch(/Enter your email address and password|New Appointment|Create Appointment/);
  });

  it('time off and closures are described as enforced but without a screen', async () => {
    const { text } = await ask('How do I add time off for a staff member?');
    expect(text).toMatch(/enforced when booking/);
    expect(text).toMatch(/no screen/);
    expect(text).not.toMatch(/Create Staff|New Staff/);
  });
});

describe('built features that depend on a provider', () => {
  it.each([
    ['How do I send appointment reminders?', 'Notifications — Guide', /Send reminder emails/],
    ['How to set up email reminders?', 'Notifications — Guide', /Reminder times/],
    ['How do I send SMS reminders?', 'Notifications — Guide', /SMS[\s\S]*connected on the Integrations page/],
    ['How do I send WhatsApp messages?', 'Notifications — Guide', /only after the business connects a provider/],
    ['How do I connect Google Calendar?', 'Integrations — Guide', /business calendar/],
  ])('"%s" says where it is set up and what it needs', async (question, source, topic) => {
    const { result, text } = await ask(question);
    expect(result.sources?.[0]).toBe(source);
    expect(text).toMatch(topic);
    expect(text).not.toMatch(/not available yet|There is no setting/i);
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
    'How do I add a customer?',
    'How do I change my password?',
    'How do I change the time zone?',
  ])('every step of "%s" comes from the article the answer cites first', async question => {
    const { result } = await ask(question);
    expect(result.intent).not.toBe('out_of_scope');
    const source = articleText(result.sources?.[0] ?? '');
    expect(source).not.toBe('');
    for (const step of result.steps ?? []) expect(source).toContain(step);
  });

  it('a common word in the question does not outweigh the specific one', async () => {
    // "appointment" is in most articles; "cancel" and "reminders" decide which section or article answers.
    const cancel = await ask('How do I cancel an appointment?');
    expect(cancel.result.steps).toContain('Click **Cancel Appointment**.');
    const reminders = await ask('How do I send appointment reminders?');
    expect(reminders.result.sources?.[0]).toBe('Notifications — Guide');
  });

  it('a troubleshooting question gets the reasons, not the article\'s other procedures', async () => {
    const { result, text } = await ask('Why is my time slot not available?');
    expect(text).toMatch(/business hours/);
    expect(text).toMatch(/time off/);
    expect(text).not.toMatch(/Availability\*\*|Create Appointment|Service & Staff card/);
    expect(result.steps ?? []).toEqual([]);
  });

  it('"add" finds the "Creating …" procedure', async () => {
    const { result } = await ask('How do I add a workspace?');
    expect(result.steps).toContain('Click **Create Workspace**.');
  });

  it('role answers match the permissions the server enforces', async () => {
    const { text } = await ask('What can a manager do?');
    expect(text).toMatch(/Manager role/);
    expect(text).toMatch(/Cannot add, edit or deactivate staff members/);
    expect(text).not.toMatch(/Manage staff, services, workspaces/);
  });

  it('procedures stay in their own section ("create" and "edit" a service differ)', async () => {
    const create = await ask('How do I create a service?');
    const edit = await ask('How do I edit a service?');
    expect(create.result.steps).toContain('Click **Create Service**.');
    expect(create.result.steps).not.toContain('Modify any fields.');
    expect(edit.result.steps).toContain('Modify any fields.');
    expect(edit.result.steps).not.toContain('Click **Create Service**.');
  });
});

describe('knowledge indexing', () => {
  it('keeps short headings when chunking (they used to be dropped, merging sections)', () => {
    const chunks = chunkText('# Guide\n\n## Editing a service\n\n1. Open it.\n\n2. Save.', 600);
    expect(chunks.join('\n')).toContain('## Editing a service');
    expect(chunks.join('\n')).toContain('2. Save.');
  });

  it('an edited article stays active and replaces its chunks instead of piling up copies', () => {
    const source = 'knowledge/10-settings.md';
    const before = db.prepare('SELECT id FROM ai_knowledge_docs WHERE source = ? AND is_active = 1').get(source) as { id: string };
    db.prepare("UPDATE ai_knowledge_docs SET version = 'stale' WHERE id = ?").run(before.id);
    indexKnowledgeDirectory();
    const rows = db.prepare('SELECT id, is_active, version FROM ai_knowledge_docs WHERE source = ?').all(source) as Array<{ id: string; is_active: number; version: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: before.id, is_active: 1 });
    expect(rows[0].version).toMatch(new RegExp(`-c${CHUNKING_VERSION}$`));
    const content = fs.readFileSync(path.join(KNOWLEDGE_DIR, '10-settings.md'), 'utf8');
    const chunks = db.prepare('SELECT COUNT(*) AS n FROM ai_knowledge_chunks WHERE doc_id = ?').get(before.id) as { n: number };
    expect(chunks.n).toBe(chunkText(content, 600).length);
  });

  it('a corrected built-in article reaches a database that holds the old text', async () => {
    db.prepare("UPDATE ai_knowledge_docs SET content = 'old text', version = NULL WHERE id = 'kdoc-settings'").run();
    db.prepare("DELETE FROM ai_knowledge_chunks WHERE doc_id = 'kdoc-settings'").run();
    seedKnowledge();
    expect(articleText('Business Settings')).toMatch(/limit every staff member/);
    const chunks = db.prepare("SELECT content FROM ai_knowledge_chunks WHERE doc_id = 'kdoc-settings'").all() as Array<{ content: string }>;
    expect(chunks.map(c => c.content).join('\n')).toMatch(/Business Working Hours/);
    const { text } = await ask('How do I set business working hours?');
    expect(text).toMatch(/limit every staff member/);
  });

  it('knowledge articles state what is not built and no longer describe hours as a fallback', () => {
    for (const file of ['12-notifications.md', '14-integrations.md']) {
      const text = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), 'utf8');
      expect(text).toMatch(NOT_BUILT);
      expect(text).not.toMatch(/Set reminder timing|Configure email templates|Follow the setup instructions/i);
    }
    for (const file of fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md'))) {
      const text = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), 'utf8');
      expect({ file, fallback: /fallback for staff|uses the business's default working hours|may use business hours/i.test(text) })
        .toEqual({ file, fallback: false });
    }
  });
});
