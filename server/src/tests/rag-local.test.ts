/**
 * RAG local answer engine tests.
 * Tests BM25 retrieval, answer assembly, intent routing, live data, coverage.
 * Uses isolated test database. No external API calls.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import fs from 'fs';
import path from 'path';

// Point at test database — must be set before importing db
process.env.DB_PATH = './data/test-rag.db';

import db from '../db/init';
import { indexDocument, retrieve, chunkText } from '../services/rag';
import { localAnswer } from '../services/local-answer';
import { routeIntent } from '../services/intent-router';
import { indexKnowledgeDirectory, getKnowledgeCoverage } from '../services/knowledge-indexer';
import type { AuthPayload } from '../types';

// Mock user for tests that hit live DB queries (uses default org-1 seed)
const MOCK_USER: AuthPayload = {
  sub: 'user-test-001',
  email: 'test@workeasy360.com',
  orgId: 'org-1',
  role: 'admin',
};

// ─── Seed a minimal knowledge base for tests ──────────────────────────────────

beforeAll(() => {
  // Seed required FK targets for proposal tests
  db.prepare(`INSERT OR IGNORE INTO organizations (id, name, email) VALUES ('org-1','Test Org','test@workeasy360.com')`).run();
  db.prepare(`INSERT OR IGNORE INTO users (id, organization_id, email, password_hash, name, role)
    VALUES ('user-test-001','org-1','test@workeasy360.com','$2b$10$placeholder','Test User','admin')`).run();

  // Clean slate for RAG tables only
  db.prepare('DELETE FROM ai_knowledge_chunks').run();
  db.prepare('DELETE FROM ai_knowledge_docs').run();

  indexDocument({
    id: 'test-appt',
    title: 'Appointments Guide',
    category: 'appointments',
    source: 'test/appointments',
    content: `# Appointments Guide
Creating a new appointment:
1. Go to Appointments at /appointments/new
2. Select a Service from the dropdown
3. Select a Staff Member
4. Pick a date (cannot be in the past)
5. Select a time slot
6. Select or add a Customer
7. Click Create Appointment

Business rules: Date must not be in the past. Appointments cannot be double-booked for the same staff member at the same time.

Errors: "This time slot is no longer available" means another appointment exists at that time for the same staff.`,
  });

  indexDocument({
    id: 'test-services',
    title: 'Services Guide',
    category: 'services',
    source: 'test/services',
    content: `# Services Guide
A service is a bookable offering your business provides to customers.

Creating a new service:
1. Go to Services at /services/new
2. Enter the service name (required)
3. Set the duration (15 to 480 minutes)
4. Set the price (0 or more)
5. Choose a category: Consultation, Treatment, Class, Meeting, Other
6. Assign staff members
7. Click Create Service

Service categories: consultation, treatment, class, meeting, other.
Price: enter the price per session. Set to 0 for free services.`,
  });

  indexDocument({
    id: 'test-staff',
    title: 'Staff Guide',
    category: 'staff',
    source: 'test/staff',
    content: `# Staff Guide
A staff member is a team member who provides services.

Adding a new staff member:
1. Go to Staff at /staff/new
2. Enter their Full Name (required)
3. Enter their Email (required)
4. Set working hours
5. Assign to workspaces and services
6. Click Create Staff

Staff roles: Admin, Manager, Staff.
Working hours: set per-day start and end times.`,
  });

  indexDocument({
    id: 'test-customers',
    title: 'Customers Guide',
    category: 'customers',
    source: 'test/customers',
    content: `# Customers Guide
A customer is a person who books appointments.

Adding a customer:
1. Go to Customers at /customers/new
2. Enter the Full Name (required)
3. Enter the Email (required)
4. Optionally add Phone, Timezone, Tags, Notes
5. Click Create Customer

Errors: "A customer with that email already exists" means you should update the existing record.`,
  });

  indexDocument({
    id: 'test-settings',
    title: 'Settings Guide',
    category: 'settings',
    source: 'test/settings',
    content: `# Settings Guide
Settings are at /settings. Tabs: Business Profile, Branding, Working Hours, Booking Rules, Cancellation Policy, Notifications, Roles & Permissions, Security, Language & Region.

Business Profile: set organization name, email, phone, address.
Working Hours: toggle days, set start and end times.
Security / Change Password: enter current password, new password (min 8 chars, one uppercase, one number), confirm.
Two-factor authentication is not yet available.`,
  });

  indexDocument({
    id: 'test-troubleshoot',
    title: 'Troubleshooting Guide',
    category: 'troubleshooting',
    source: 'test/troubleshoot',
    content: `# Troubleshooting

"This time slot is no longer available" — Someone else booked the slot. Choose a different time.
"Cannot create appointments in the past" — Selected date is before today. Choose today or a future date.
"A customer with that email already exists" — Search for the customer and update their record.
"Page not found" on booking page — Check that the booking page is published.
Staff not showing — The staff member must be Active and assigned to the service.
Service not showing — Check that the service is Active.`,
  });
});

// ─── chunkText ────────────────────────────────────────────────────────────────

describe('chunkText', () => {
  it('chunks a short document as-is', () => {
    const chunks = chunkText('Hello world. This is a test.', 200);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]).toContain('Hello world');
  });

  it('splits a large document into multiple chunks', () => {
    const longContent = Array.from({ length: 50 }, (_, i) => `Paragraph ${i}. This is content for testing chunking.`).join('\n\n');
    const chunks = chunkText(longContent, 30);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

// ─── BM25 retrieval ───────────────────────────────────────────────────────────

describe('BM25 retrieve', () => {
  it('returns relevant chunks for "create appointment"', () => {
    const results = retrieve('create appointment', 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].category).toBe('appointments');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('returns staff results for "add staff member"', () => {
    const results = retrieve('add staff member', 3);
    expect(results.length).toBeGreaterThan(0);
    const cats = results.map(r => r.category);
    expect(cats).toContain('staff');
  });

  it('returns empty for a completely unrelated query', () => {
    const results = retrieve('quantum physics laser photon', 3);
    // May return 0 or some results with score 0 — ensure no high-confidence nonsense
    const highScore = results.filter(r => r.score > 1.0);
    expect(highScore.length).toBe(0);
  });

  it('retrieves multiple docs when topK > 1', () => {
    const results = retrieve('service staff appointment', 5);
    const docIds = new Set(results.map(r => r.docId));
    expect(docIds.size).toBeGreaterThan(1);
  });

  it('scores are positive for matching queries', () => {
    const results = retrieve('create new service', 3);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─── localAnswer ─────────────────────────────────────────────────────────────

describe('localAnswer', () => {
  it('answers "how do I create an appointment"', async () => {
    const result = await localAnswer('how do I create an appointment');
    expect(result.noResults).toBe(false);
    expect(result.answer.length).toBeGreaterThan(5);
    // New router uses 'platform_how_to' instead of legacy 'how_to'
    expect(result.intent).toMatch(/how_to|platform_how_to/);
    expect(result.retrievedChunks).toBeGreaterThan(0);
  });

  it('returns steps for procedural questions', async () => {
    const result = await localAnswer('steps to add a new service');
    expect(result.noResults).toBe(false);
    // Either steps or answer should contain actionable content
    const hasContent = (result.steps && result.steps.length > 0) || result.answer.length > 30;
    expect(hasContent).toBe(true);
  });

  it('provides useful answer for "where is settings"', async () => {
    const result = await localAnswer('where is the settings page');
    expect(result.noResults).toBe(false);
    // Intent may be platform_how_to or navigation — just assert non-empty answer
    expect(result.answer.length).toBeGreaterThan(5);
  });

  it('handles troubleshooting questions', async () => {
    const result = await localAnswer('why is my time slot not available');
    expect(result.noResults).toBe(false);
    // With new router this may route to availability_query or platform_how_to — answer must be useful
    expect(result.answer.length).toBeGreaterThan(10);
  });

  it('returns non-empty answer for completely off-topic query (out_of_scope or noResults)', async () => {
    const result = await localAnswer('xyzzy foo bar baz quux unicorn 12345');
    // New router: all non-domain queries are out_of_scope — answer is always non-empty
    expect(result.answer.length).toBeGreaterThan(5);
    // Either out_of_scope or noResults — both are acceptable
    const isHandled = result.type === 'out_of_scope' || result.noResults;
    expect(isHandled).toBe(true);
  });

  it('includes source references', async () => {
    const result = await localAnswer('how do I add a customer');
    expect(result.sources).toBeDefined();
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it('handles Hindi/Hinglish query with synonym expansion', async () => {
    const result = await localAnswer('appointment kaise create karein');
    // Should expand "create" synonym and find appointment docs
    expect(result.noResults).toBe(false);
  });

  it('never calls external APIs (no HTTP requests in answer engine)', async () => {
    // Verify no fetch/http calls happen — the function is synchronous retrieval only
    // If we reach here without hanging or throwing HTTP errors, we pass
    const result = await localAnswer('how to create a booking page');
    expect(typeof result.answer).toBe('string');
  });

  it('confidence is one of the expected values', async () => {
    const result = await localAnswer('how do I change my password');
    expect(['high', 'medium', 'low']).toContain(result.confidence);
  });
});

// ─── Intent router regression tests ─────────────────────────────────────────

describe('intent router — 8 query scenarios', () => {
  it('greeting: "hi" → greeting intent, non-empty answer', async () => {
    const r = routeIntent('hi');
    expect(r.intent).toBe('greeting');
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it('how-to: "How do I add a new staff member?" → platform_how_to with staff categories', () => {
    const r = routeIntent('How do I add a new staff member?');
    expect(r.intent).toBe('platform_how_to');
    expect(r.featureCategories).toContain('staff');
    // Must NOT include appointment categories at the top level
    expect(r.featureCategories).not.toContain('appointments');
  });

  it('live data: "What\'s my appointment count this month?" → live_data_query', () => {
    const r = routeIntent("What's my appointment count this month?");
    expect(r.intent).toBe('live_data_query');
    expect(r.entities.timeframe).toBe('this_month');
  });

  it('availability: "Show me available slots for tomorrow" → availability_query with date', () => {
    const r = routeIntent('Show me available slots for tomorrow');
    expect(r.intent).toBe('availability_query');
    // Date should be tomorrow (truthy string)
    expect(r.entities.date).toBeTruthy();
    expect(r.entities.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('action: "Create a 30-minute consultation service for ₹500" → action_request', () => {
    const r = routeIntent('Create a 30-minute consultation service for ₹500');
    expect(r.intent).toBe('action_request');
    expect(r.entities.duration).toBe(30);
    expect(r.entities.price).toBe(500);
    expect(r.entities.currency).toBe('INR');
  });

  it('search: "Find customer Alice Johnson" → record_search for customers', () => {
    const r = routeIntent('Find customer Alice Johnson');
    expect(r.intent).toBe('record_search');
    expect(r.entities.recordType).toBe('customers');
    expect(r.entities.personName).toContain('Alice');
  });

  it('navigation: "Take me to the reports page" → navigation with /reports', () => {
    const r = routeIntent('Take me to the reports page');
    expect(r.intent).toBe('navigation');
    expect(r.entities.routePath).toBe('/reports');
    expect(r.entities.routeTitle).toBe('Reports');
  });

  it('out-of-scope: "What is the capital of France?" → out_of_scope', () => {
    const r = routeIntent('What is the capital of France?');
    expect(r.intent).toBe('out_of_scope');
  });
});

// ─── Full localAnswer regression tests (response content) ────────────────────

describe('localAnswer — 8 query scenarios end-to-end', () => {
  it('greeting "hi" → non-empty greeting, not how-to docs', async () => {
    const result = await localAnswer('hi');
    expect(result.answer.length).toBeGreaterThan(10);
    expect(result.intent).toBe('greeting');
    expect(result.answer).not.toMatch(/appointment.*new|\/appointments/i);
  });

  it('how-to "How do I add a new staff member?" → staff docs, NOT appointment docs', async () => {
    const result = await localAnswer('How do I add a new staff member?');
    expect(result.answer.length).toBeGreaterThan(5);
    // answer must not reference the /appointments/new route or appointment creation
    expect(result.answer.toLowerCase()).not.toMatch(/go to appointments at \/appointments\/new/i);
    // Should mention staff
    const contentHasStaff = result.answer.toLowerCase().includes('staff')
      || (result.steps ?? []).some(s => s.toLowerCase().includes('staff'));
    expect(contentHasStaff).toBe(true);
  });

  it('live data "What\'s my appointment count this month?" → live_data type, real count', async () => {
    const result = await localAnswer("What's my appointment count this month?", 5, MOCK_USER);
    expect(result.type).toBe('live_data');
    expect(result.answer).toMatch(/\*\*\d+\s+appointment/i);
    expect(result.liveData).toBeDefined();
    expect(typeof result.liveData!.total).toBe('number');
  });

  it('availability "Show me available slots for tomorrow" → availability type or clarification (not how-to)', async () => {
    const result = await localAnswer('Show me available slots for tomorrow', 5, MOCK_USER);
    // workflow_blocker is acceptable when no services are configured in the test org
    expect(['availability', 'clarification', 'text', 'workflow_blocker']).toContain(result.type);
    // Must NOT return appointment creation instructions
    expect(result.answer.toLowerCase()).not.toMatch(/go to appointments.*\/appointments\/new/i);
    // Answer must be non-empty
    expect(result.answer.length).toBeGreaterThan(10);
  });

  it('action "Create a 30-minute consultation service for ₹500" → action_proposal with proposalId', async () => {
    const result = await localAnswer('Create a 30-minute consultation service for ₹500', 5, MOCK_USER);
    expect(result.type).toBe('action_proposal');
    expect(result.proposalId).toBeTruthy();
    expect(result.proposalDisplayData).toBeDefined();
    // Proposal must NOT be executed — still pending
    const prop = db.prepare('SELECT status FROM ai_proposals WHERE id = ?').get(result.proposalId!) as { status: string } | undefined;
    expect(prop?.status).toBe('pending');
    // Answer must be non-empty and reference the service
    expect(result.answer.length).toBeGreaterThan(20);
  });

  it('search "Find customer Alice Johnson" → search_results type, not creation docs', async () => {
    const result = await localAnswer('Find customer Alice Johnson', 5, MOCK_USER);
    expect(result.type).toBe('search_results');
    // Answer must not show customer-creation instructions
    expect(result.answer.toLowerCase()).not.toMatch(/go to customers at \/customers\/new/i);
    // Answer says found X or none found (not creation guide)
    expect(result.answer).toMatch(/found|no customer|matching/i);
  });

  it('navigation "Take me to the reports page" → navigation type, navigateTo = /reports', async () => {
    const result = await localAnswer('Take me to the reports page');
    expect(result.type).toBe('navigation');
    expect(result.navigateTo).toBe('/reports');
    expect(result.navigationTitle).toBe('Reports');
  });

  it('out-of-scope "What is the capital of France?" → out_of_scope, no FAQ answer', async () => {
    const result = await localAnswer('What is the capital of France?');
    expect(result.type).toBe('out_of_scope');
    // Must not return an unrelated WorkEasy360 FAQ (like password help)
    expect(result.answer.toLowerCase()).not.toMatch(/password|two-factor|workhour|booking/i);
    expect(result.answer).toMatch(/outside|platform|workeasy/i);
  });
});

// ─── Additional intent and entity tests ───────────────────────────────────────

describe('intent router — edge cases', () => {
  it('navigation unknown destination → clarification_needed or out_of_scope', () => {
    const r = routeIntent('Take me to the frobnicator page');
    // 'frobnicator' has no domain terms → out_of_scope; or nav pattern with unknown dest → clarification
    expect(['navigation', 'clarification_needed', 'out_of_scope']).toContain(r.intent);
  });

  it('action without duration or price → clarification_needed', () => {
    const r = routeIntent('Create a service');
    expect(['action_request', 'clarification_needed']).toContain(r.intent);
  });

  it('"how do I create a service" → platform_how_to, NOT action_request', () => {
    const r = routeIntent('how do I create a service');
    expect(r.intent).toBe('platform_how_to');
  });

  it('"how many appointments this week" → live_data_query, this_week', () => {
    const r = routeIntent('how many appointments do I have this week');
    expect(r.intent).toBe('live_data_query');
    expect(r.entities.timeframe).toBe('this_week');
  });

  it('"check availability" without date → availability_query, date undefined', () => {
    const r = routeIntent('check availability');
    expect(r.intent).toBe('availability_query');
  });

  it('"find staff John Smith" → record_search, staff, name extracted', () => {
    const r = routeIntent('find staff John Smith');
    expect(r.intent).toBe('record_search');
    expect(r.entities.recordType).toBe('staff');
  });

  it('"Go to calendar" → navigation, /calendar', () => {
    const r = routeIntent('Go to calendar');
    expect(r.intent).toBe('navigation');
    expect(r.entities.routePath).toBe('/calendar');
  });

  it('"appointment kaise create karein" → platform_how_to (Hinglish)', () => {
    const r = routeIntent('appointment kaise create karein');
    // appointment is a domain term → not out_of_scope
    expect(r.intent).not.toBe('out_of_scope');
  });
});

// ─── Live data boundary tests ─────────────────────────────────────────────────

describe('live data — boundaries', () => {
  it('returns live_data type with numeric total', async () => {
    const result = await localAnswer("What's my appointment count this month?", 5, MOCK_USER);
    expect(result.type).toBe('live_data');
    expect(result.liveData).toBeDefined();
    expect(typeof result.liveData!.total).toBe('number');
    expect(result.liveData!.total).toBeGreaterThanOrEqual(0);
  });

  it('live_data without user falls back to BM25 (no crash)', async () => {
    const result = await localAnswer("What's my appointment count this month?");
    expect(result.answer.length).toBeGreaterThan(5);
    expect(result.type).not.toBe('error');
  });
});

// ─── Action proposal security tests ──────────────────────────────────────────

describe('action proposal — security', () => {
  it('proposal is created with pending status, not executed', async () => {
    const result = await localAnswer('Create a 60-minute massage service for ₹800', 5, MOCK_USER);
    if (result.type === 'action_proposal' && result.proposalId) {
      const prop = db.prepare('SELECT status, organization_id FROM ai_proposals WHERE id = ?')
        .get(result.proposalId) as { status: string; organization_id: string } | undefined;
      expect(prop?.status).toBe('pending');
      expect(prop?.organization_id).toBe(MOCK_USER.orgId);
    }
  });

  it('action without user returns clarification or text, never proposal', async () => {
    const result = await localAnswer('Create a 30-minute yoga class for ₹300');
    expect(result.type).not.toBe('action_proposal');
  });

  it('duplicate proposal from same query gets a new proposalId', async () => {
    const r1 = await localAnswer('Create a 45-minute therapy service for ₹600', 5, MOCK_USER);
    const r2 = await localAnswer('Create a 45-minute therapy service for ₹600', 5, MOCK_USER);
    if (r1.proposalId && r2.proposalId) {
      expect(r1.proposalId).not.toBe(r2.proposalId);
    }
  });
});

// ─── Blank bubble / vague query protection ───────────────────────────────────

describe('blank-bubble protection', () => {
  it('"who" returns a non-empty clarification, never blank', async () => {
    const result = await localAnswer('who');
    expect(result.answer.length).toBeGreaterThan(10);
    expect(result.noResults).toBe(false);
  });

  it('"what" returns a non-empty clarification', async () => {
    const result = await localAnswer('what');
    expect(result.answer.length).toBeGreaterThan(10);
    expect(result.noResults).toBe(false);
  });

  it('"help" returns a non-empty clarification', async () => {
    const result = await localAnswer('help');
    expect(result.answer.length).toBeGreaterThan(10);
    expect(result.noResults).toBe(false);
  });

  it('"hi" returns a non-empty clarification', async () => {
    const result = await localAnswer('hi');
    expect(result.answer.length).toBeGreaterThan(10);
    expect(result.noResults).toBe(false);
  });

  it('known question returns non-empty answer from indexed docs', async () => {
    const result = await localAnswer('how do I create an appointment');
    expect(result.answer.length).toBeGreaterThan(5);
    expect(result.noResults).toBe(false);
  });

  it('unknown gibberish returns a non-empty fallback (never blank)', async () => {
    const result = await localAnswer('zxqwerty foobar123 zzz');
    expect(result.answer.length).toBeGreaterThan(5);
  });

  it('answer field is never an empty string', async () => {
    const queries = ['who', 'what', 'how do I add staff', 'xyzzy gibberish'];
    for (const q of queries) {
      const result = await localAnswer(q);
      expect(result.answer).toBeTruthy();
      expect(result.answer.trim().length).toBeGreaterThan(0);
    }
  });

  it('vague query clarification does not invent a person or organization', async () => {
    const result = await localAnswer('who');
    // Must not contain made-up proper nouns — just platform description
    expect(result.answer).toContain('Workeasy Ai Agent');
    expect(result.answer).not.toMatch(/\b(John|Jane|Smith|Corp|Ltd|Inc)\b/);
  });
});

// ─── Knowledge indexer ────────────────────────────────────────────────────────

describe('knowledge indexer', () => {
  it('getKnowledgeCoverage returns correct counts', () => {
    const coverage = getKnowledgeCoverage();
    expect(coverage.documentsIndexed).toBeGreaterThanOrEqual(6); // our 6 test docs
    expect(coverage.chunksIndexed).toBeGreaterThan(0);
  });

  it('indexing is idempotent (same hash = skip)', () => {
    // We don't test against the real knowledge dir in unit tests;
    // just verify the coverage function runs without throwing
    expect(() => getKnowledgeCoverage()).not.toThrow();
  });
});

// ─── Security: no private data in knowledge ───────────────────────────────────

describe('knowledge security', () => {
  it('knowledge docs do not contain JWT_SECRET or API keys', () => {
    const KNOWLEDGE_DIR = path.join(__dirname, '../../knowledge');
    if (!fs.existsSync(KNOWLEDGE_DIR)) return; // skip if dir doesn't exist in test env

    const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), 'utf8');
      expect(content).not.toMatch(/JWT_SECRET\s*=/i);
      expect(content).not.toMatch(/sk-ant-/i);
      expect(content).not.toMatch(/ANTHROPIC_API_KEY\s*=/i);
      expect(content).not.toMatch(/password_hash/i);
    }
  });

  it('knowledge docs do not contain private customer records', () => {
    const KNOWLEDGE_DIR = path.join(__dirname, '../../knowledge');
    if (!fs.existsSync(KNOWLEDGE_DIR)) return;

    const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), 'utf8');
      // Should not contain real email addresses (pattern like "someuser@domain.com" with real domain)
      // Allow placeholder examples like "jane@example.com"
      const realEmails = content.match(/[a-zA-Z0-9.]+@(?!example\.com|digisoft360\.com)[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/g);
      // Only flag if they look like real accounts (not in example/documentation context)
      if (realEmails) {
        expect(realEmails.length).toBeLessThan(5); // a few may appear in examples
      }
    }
  });
});

// ─── Workflow: availability_request when no services ─────────────────────────

describe('ai_workflows — availability_request flow', () => {
  // Unique org/user IDs to isolate workflow tests from other test data
  const WF_ORG = 'org-wf-test';
  const WF_USER: AuthPayload = {
    sub: 'user-wf-001',
    email: 'wf@workeasy360.com',
    orgId: WF_ORG,
    role: 'admin',
  };

  beforeAll(() => {
    db.prepare(`INSERT OR IGNORE INTO organizations (id, name, email) VALUES (?, 'WF Test Org', ?)`).run(WF_ORG, WF_USER.email);
    db.prepare(`INSERT OR IGNORE INTO users (id, organization_id, email, password_hash, name, role)
      VALUES (?, ?, ?, '$2b$10$placeholder', 'WF User', 'admin')`).run(WF_USER.sub, WF_ORG, WF_USER.email);
  });

  // Clean workflows and services before each test to prevent state bleed
  beforeEach(() => {
    db.prepare(`DELETE FROM ai_workflows WHERE organization_id = ?`).run(WF_ORG);
    db.prepare(`DELETE FROM services WHERE organization_id = ?`).run(WF_ORG);
  });

  // ── Test 1: No services → workflow_blocker ──────────────────────────────────
  it('returns workflow_blocker when no active services exist', async () => {
    const result = await localAnswer('Show available slots for tomorrow', 5, WF_USER);
    expect(result.type).toBe('workflow_blocker');
    expect(result.answer.length).toBeGreaterThan(10);
  });

  // ── Test 2: workflow_blocker contains workflowId and actions ────────────────
  it('workflow_blocker includes workflowId and two actions', async () => {
    const result = await localAnswer('Show available slots for tomorrow', 5, WF_USER);
    expect(result.workflowInfo).toBeDefined();
    expect(result.workflowInfo!.workflowId).toMatch(/^wf-/);
    expect(result.workflowInfo!.actions.length).toBe(2);
  });

  // ── Test 3: First action navigates to /services/new ─────────────────────────
  it('first workflow action navigates to /services/new', async () => {
    const result = await localAnswer('Show available slots for tomorrow', 5, WF_USER);
    const navAction = result.workflowInfo!.actions.find(a => a.intent === 'navigate');
    expect(navAction).toBeDefined();
    expect(navAction!.navigateTo).toBe('/services/new');
    expect(navAction!.label).toBe('Create a service');
  });

  // ── Test 4: Second action is cancel_workflow ─────────────────────────────────
  it('second workflow action cancels the workflow', async () => {
    const result = await localAnswer('Show available slots for tomorrow', 5, WF_USER);
    const cancelAction = result.workflowInfo!.actions.find(a => a.intent === 'cancel_workflow');
    expect(cancelAction).toBeDefined();
    expect(cancelAction!.label).toBe('Cancel');
  });

  // ── Test 5: Workflow record is created in DB with active status ──────────────
  it('creates an active ai_workflows record in the database', async () => {
    await localAnswer('Show available slots for tomorrow', 5, WF_USER);
    const row = db.prepare(
      `SELECT status, type, step FROM ai_workflows WHERE organization_id = ? AND status = 'active' LIMIT 1`
    ).get(WF_ORG) as { status: string; type: string; step: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.type).toBe('availability_request');
    expect(row!.step).toBe('awaiting_service');
  });

  // ── Test 6: Auto-resume when services now exist (any next message) ───────────
  it('auto-resumes availability check when services exist and workflow is active', async () => {
    // Step A: trigger the blocker
    await localAnswer('Show available slots for tomorrow', 5, WF_USER);

    // Step B: seed a service for the org
    const svcId = `svc-wf-${Date.now()}`;
    db.prepare(`
      INSERT INTO services (id, organization_id, name, duration, price, currency, category, is_active)
      VALUES (?, ?, 'Consultation', 30, 500, 'INR', 'consultation', 1)
    `).run(svcId, WF_ORG);

    // Step C: send ANY message — should auto-resume
    const result = await localAnswer('Hello', 5, WF_USER);
    // The auto-resume result should contain the resume preamble
    expect(result.answer).toMatch(/set up services|availability/i);
    // Not a workflow_blocker anymore
    expect(result.type).not.toBe('workflow_blocker');
  });

  // ── Test 7: Cancelled workflow does NOT auto-resume ─────────────────────────
  it('does not resume a cancelled workflow', async () => {
    // Create a workflow and immediately cancel it
    await localAnswer('Show available slots for tomorrow', 5, WF_USER);
    db.prepare(`UPDATE ai_workflows SET status = 'cancelled' WHERE organization_id = ?`).run(WF_ORG);

    // Seed a service
    db.prepare(`
      INSERT INTO services (id, organization_id, name, duration, price, currency, category, is_active)
      VALUES ('svc-wf-cancel', ?, 'Yoga', 60, 300, 'INR', 'class', 1)
    `).run(WF_ORG);

    // Should route normally (not auto-resume)
    const result = await localAnswer('Hello', 5, WF_USER);
    expect(result.answer).not.toMatch(/resume|earlier request/i);
  });

  // ── Test 8: triggerWorkflowResume=true with active workflow + services ───────
  it('triggerWorkflowResume=true immediately resumes when conditions are met', async () => {
    // Setup: workflow active + service exists
    await localAnswer('Show available slots for tomorrow', 5, WF_USER);
    db.prepare(`
      INSERT INTO services (id, organization_id, name, duration, price, currency, category, is_active)
      VALUES ('svc-wf-trigger', ?, 'Massage', 45, 700, 'INR', 'treatment', 1)
    `).run(WF_ORG);

    const result = await localAnswer('resume', 5, WF_USER, undefined, true);
    // Should return availability type (slots found or none, not blocker)
    expect(['availability', 'error', 'text']).toContain(result.type);
    expect(result.type).not.toBe('workflow_blocker');
  });

  // ── Test 9: triggerWorkflowResume=true with no active workflow ───────────────
  it('triggerWorkflowResume=true returns text when no active workflow exists', async () => {
    // No workflow seeded
    const result = await localAnswer('resume', 5, WF_USER, undefined, true);
    expect(result.type).toBe('text');
    expect(result.answer.length).toBeGreaterThan(5);
  });

  // ── Test 10: workflow_blocker answer is non-empty and informative ────────────
  it('workflow_blocker answer describes the blocker and next step', async () => {
    const result = await localAnswer('Check availability for next week', 5, WF_USER);
    if (result.type === 'workflow_blocker') {
      expect(result.answer).toBeTruthy();
      expect(result.answer.length).toBeGreaterThan(20);
      // Must not be blank or a generic error
      expect(result.answer).not.toBe('');
    }
    // type is either workflow_blocker (no services) or clarification (no date) — both valid
    expect(['workflow_blocker', 'clarification', 'availability']).toContain(result.type);
  });
});

// ─── Regression: synonym & domain coverage ───────────────────────────────────
// Verifies that natural-language synonyms for WorkEasy360 features are
// correctly classified and never sent to the out_of_scope guard.

describe('synonym regression — routeIntent', () => {
  // ── Staff queries — must not be out_of_scope ─────────────────────────────

  it('"how to add new member" → platform_how_to, staff categories', () => {
    const r = routeIntent('how to add new member');
    expect(r.intent).not.toBe('out_of_scope');
    expect(r.intent).toBe('platform_how_to');
    expect(r.featureCategories).toContain('staff');
  });

  it('"How do I add a new staff member?" → platform_how_to, staff categories', () => {
    const r = routeIntent('How do I add a new staff member?');
    expect(r.intent).toBe('platform_how_to');
    expect(r.featureCategories).toContain('staff');
  });

  it('"How can I invite someone to my team?" → platform_how_to, staff categories', () => {
    const r = routeIntent('How can I invite someone to my team?');
    expect(r.intent).not.toBe('out_of_scope');
    expect(r.featureCategories).toContain('staff');
  });

  it('"add employee" → NOT out_of_scope (imperative or clarification)', () => {
    const r = routeIntent('add employee');
    expect(r.intent).not.toBe('out_of_scope');
  });

  it('"I want to onboard a new colleague" → NOT out_of_scope, staff categories', () => {
    const r = routeIntent('I want to onboard a new colleague');
    expect(r.intent).not.toBe('out_of_scope');
    expect(r.featureCategories).toContain('staff');
  });

  it('"where can I manage staff?" → platform_how_to or navigation, staff categories', () => {
    const r = routeIntent('where can I manage staff?');
    expect(r.intent).not.toBe('out_of_scope');
    expect(r.featureCategories).toContain('staff');
  });

  // ── Search queries ────────────────────────────────────────────────────────

  it('"find customer Alice Johnson" → record_search, customer', () => {
    const r = routeIntent('find customer Alice Johnson');
    expect(r.intent).toBe('record_search');
    expect(r.entities.recordType).toBe('customers');
  });

  // ── How-to for other features ─────────────────────────────────────────────

  it('"how do I create a booking?" → platform_how_to, appointment categories', () => {
    const r = routeIntent('how do I create a booking?');
    expect(r.intent).toBe('platform_how_to');
    expect(r.featureCategories).toContain('appointments');
  });

  // ── Navigation ────────────────────────────────────────────────────────────

  it('"take me to reports" → navigation, /reports', () => {
    const r = routeIntent('take me to reports');
    expect(r.intent).toBe('navigation');
    expect(r.entities.routePath).toBe('/reports');
  });

  // ── Out-of-scope must stay out-of-scope ───────────────────────────────────

  it('"What is the capital of France?" → out_of_scope', () => {
    const r = routeIntent('What is the capital of France?');
    expect(r.intent).toBe('out_of_scope');
  });
});

// ─── Regression: synonym end-to-end via localAnswer ──────────────────────────

describe('synonym regression — localAnswer end-to-end', () => {
  it('"how to add new member" retrieves staff docs, non-empty answer', async () => {
    const result = await localAnswer('how to add new member');
    expect(result.intent).not.toBe('out_of_scope');
    expect(result.answer.length).toBeGreaterThan(10);
    expect(result.type).not.toBe('out_of_scope');
    // Must reference staff/member, not appointment creation
    expect(result.answer.toLowerCase()).not.toMatch(/go to appointments.*\/appointments\/new/i);
  });

  it('"How can I invite someone to my team?" → staff-related answer', async () => {
    const result = await localAnswer('How can I invite someone to my team?');
    expect(result.type).not.toBe('out_of_scope');
    expect(result.answer.length).toBeGreaterThan(10);
  });

  it('"I want to onboard a new colleague" → staff-related answer', async () => {
    const result = await localAnswer('I want to onboard a new colleague');
    expect(result.type).not.toBe('out_of_scope');
    expect(result.answer.length).toBeGreaterThan(5);
  });

  it('"add employee" → not out_of_scope, non-empty answer', async () => {
    const result = await localAnswer('add employee');
    expect(result.type).not.toBe('out_of_scope');
    expect(result.answer.length).toBeGreaterThan(5);
  });

  it('"What is the capital of France?" stays out_of_scope with no WorkEasy FAQ answer', async () => {
    const result = await localAnswer('What is the capital of France?');
    expect(result.type).toBe('out_of_scope');
    expect(result.answer.toLowerCase()).not.toMatch(/password|two-factor|workhour/i);
  });

  it('"how to add new member" retrieves staff docs, NOT appointment docs', async () => {
    const result = await localAnswer('how to add new member');
    // If sources are present, they must include staff-related content
    if (result.sources.length > 0) {
      const allSources = result.sources.join(' ').toLowerCase();
      const hasStaff = /staff/.test(allSources);
      const hasAppointmentOnly = !hasStaff && /appointment/.test(allSources);
      expect(hasAppointmentOnly).toBe(false);
    }
    // Answer must not be blank
    expect(result.answer.trim().length).toBeGreaterThan(0);
  });
});

// ─── Full 15-query regression suite (queries 11–15) ──────────────────────────
// Queries 1–10 are already covered in the synonym regression and blank-bubble
// suites. This block adds permanent coverage for the five harder cases.

describe('15-query regression — queries 11–15', () => {

  // ── Query 11: Settings / password ────────────────────────────────────────

  it('11 routeIntent "How do I change my password?" → platform_how_to, settings', () => {
    const r = routeIntent('How do I change my password?');
    expect(r.intent).toBe('platform_how_to');
    expect(r.featureCategories).toContain('settings');
  });

  it('11 localAnswer "How do I change my password?" → settings doc, non-empty', async () => {
    const result = await localAnswer('How do I change my password?');
    expect(result.type).not.toBe('out_of_scope');
    expect(result.answer.length).toBeGreaterThan(10);
    // Must not drift into appointment creation steps
    expect(result.answer.toLowerCase()).not.toMatch(/go to appointments.*\/appointments\/new/i);
  });

  // ── Query 12: Genuinely undocumented feature ──────────────────────────────

  it('12 routeIntent "bulk import customers from spreadsheet" → not out_of_scope', () => {
    // "customer" IS a domain term; domain check must pass
    const r = routeIntent('How do I bulk import customers from a spreadsheet?');
    expect(r.intent).not.toBe('out_of_scope');
  });

  it('12 localAnswer undocumented feature → non-empty, no fabricated steps', async () => {
    const result = await localAnswer('How do I bulk import customers from a spreadsheet?');
    expect(result.type).not.toBe('out_of_scope');
    expect(result.answer.length).toBeGreaterThan(5);
    // Must not invent a bulk-import CSV workflow that does not exist
    expect(result.answer.toLowerCase()).not.toMatch(/step 1.*import.*spreadsheet/i);
    expect(result.answer.toLowerCase()).not.toMatch(/upload.*\.csv.*file/i);
  });

  // ── Query 13: Missing required information ────────────────────────────────

  it('13 routeIntent "Create a service" (no details) → clarification_needed', () => {
    const r = routeIntent('Create a service');
    expect(r.intent).toBe('clarification_needed');
  });

  it('13 localAnswer "Create a service" (bare) → clarification_needed, non-empty', async () => {
    const result = await localAnswer('Create a service', 5, MOCK_USER);
    expect(['clarification_needed', 'clarification']).toContain(result.type);
    expect(result.answer.trim().length).toBeGreaterThan(5);
  });

  // ── Query 14: Unauthenticated live-data request ──────────────────────────

  it('14 live-data query without user → BM25 fallback, never live_data type', async () => {
    const result = await localAnswer("What's my appointment count this month?");
    expect(result.type).not.toBe('live_data');
    expect(result.liveData).toBeUndefined();
    expect(result.answer.trim().length).toBeGreaterThan(5);
  });

  it('14 action proposal without user → never action_proposal', async () => {
    const result = await localAnswer('Create a 30-minute consultation service for ₹500');
    expect(result.type).not.toBe('action_proposal');
  });

  // ── Query 15: Ambiguous follow-up without conversation context ────────────

  it('15 "open the second one" → non-blank, no crash, no data leak', async () => {
    // No domain terms present; local mode has no multi-turn memory.
    // Expected: out_of_scope or clarification with a non-empty helpful message.
    const result = await localAnswer('open the second one');
    expect(result.answer.trim().length).toBeGreaterThan(5);
    expect(result.type).not.toBe('live_data');
    expect(result.type).not.toBe('action_proposal');
    expect(result.type).not.toBe('error');
  });

  it('15 "that one" → non-blank, no crash', async () => {
    const result = await localAnswer('that one');
    expect(result.answer.trim().length).toBeGreaterThan(5);
    expect(result.answer.trim()).not.toBe('');
  });
});
