/**
 * Built-in knowledge articles (indexed at startup next to server/knowledge/*.md, idempotent by stable id).
 *
 * The product itself is documented in server/knowledge. Only the assistant's own article lives here, because it
 * describes what the assistant's code can do (its tools, confirmation and expiry). Articles that described earlier
 * versions of the product (Dashboard, Calendar menu, Workspaces, Resources, Booking Pages, Reports, prices) are retired:
 * they are switched off in existing databases so the assistant never answers from them again.
 */

import { indexDocument, CHUNKING_VERSION } from './rag';
import db from '../db/init';

export const AI_ASSISTANT_DOC_ID = 'kdoc-ai-operator';

const KNOWLEDGE_DOCS = [
  {
    id: AI_ASSISTANT_DOC_ID,
    title: 'AI Assistant — Guide',
    category: 'ai',
    source: 'WorkEasy360 Help',
    accessScope: 'authenticated' as const,
    content: `# AI Assistant — Guide

The AI Assistant (Workeasy Ai Agent) is built into WorkEasy360 Booking for the owner and managers. Open it with the round button at the bottom right of the screen, or from the Help menu with **Ask the AI Assistant**.

## What the AI Assistant can do

- Answer questions about WorkEasy360 Booking: appointments, availability, customers, services, the team, the booking link, notifications, integrations and My Account.
- Open the right screen, for example Availability, the calendar view or Settings → Services.
- Find customers, services, staff members and appointments of your business.
- Count appointments for today, this week or this month, list a day's bookings and show free times.
- Prepare a new service, customer or appointment for you to confirm.

## What the AI Assistant cannot do

- Save anything without your **Confirm**.
- Edit, reschedule or cancel appointments, change availability or settings, send messages or take payments. It tells you where to do it and can open that screen.
- See another business's data, or answer questions that are not about WorkEasy360 Booking.

## How confirmation works

When you ask for a new service, customer or appointment, the assistant prepares it and shows the details with **Confirm** and **Cancel**. Nothing is saved until you click **Confirm**. A prepared change expires after 10 minutes, and your permission is checked again when you confirm. The same rules apply as in the app: no double bookings, no times outside availability and no dates in the past.

## Examples of things you can ask

- How do I block a holiday?
- Show me available slots for tomorrow
- Create a 30-minute consultation service
- Find customer Asha
- How many appointments do I have this week?
- Go to the calendar
- Mujhe naya service banana hai, consultation 30 min

## Tips

- Give names, dates and durations: services need only a name and a duration in minutes.
- If the assistant asks a question, answer it briefly.
- You can always click **Cancel** on a prepared change, and keep working in the app while the panel is open.`,
  },
];

/** Built-in articles of earlier versions; deactivated wherever they are still stored. */
const RETIRED_BUILTIN_IDS = [
  'kdoc-appointments', 'kdoc-services', 'kdoc-staff', 'kdoc-customers', 'kdoc-calendar', 'kdoc-dashboard',
  'kdoc-settings', 'kdoc-booking-pages', 'kdoc-workspaces', 'kdoc-resources', 'kdoc-reports',
];

/**
 * Adds the built-in articles and re-indexes any whose text or chunking has changed since, so corrections reach
 * existing databases. Retired built-in articles are switched off and their chunks removed.
 */
export function seedKnowledge(): void {
  const current = db.prepare('SELECT content, version, is_active FROM ai_knowledge_docs WHERE id = ?');
  const setVersion = db.prepare('UPDATE ai_knowledge_docs SET version = ? WHERE id = ?');
  const version = `builtin-c${CHUNKING_VERSION}`;
  let written = 0;
  for (const doc of KNOWLEDGE_DOCS) {
    const row = current.get(doc.id) as { content: string; version: string | null; is_active: number } | undefined;
    if (row?.content === doc.content && row.version === version && row.is_active === 1) continue;
    indexDocument(doc);
    setVersion.run(version, doc.id);
    written++;
  }
  let retired = 0;
  db.transaction(() => {
    for (const id of RETIRED_BUILTIN_IDS) {
      db.prepare('DELETE FROM ai_knowledge_chunks WHERE doc_id = ?').run(id);
      retired += db.prepare('UPDATE ai_knowledge_docs SET is_active = 0 WHERE id = ? AND is_active = 1').run(id).changes;
    }
  })();
  if (written) console.log(`[AI] Indexed ${written} built-in knowledge document(s).`);
  if (retired) console.log(`[AI] Retired ${retired} outdated built-in knowledge document(s).`);
}
