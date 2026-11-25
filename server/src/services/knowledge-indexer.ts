import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import db from '../db/init';
import { chunkText, CHUNKING_VERSION } from './rag';

const KNOWLEDGE_DIR = path.join(__dirname, '../../knowledge');

// Category of each article (the assistant narrows its search by category). V4 articles; a file not listed here uses
// its own name without the number.
const CATEGORY_MAP: Record<string, string> = {
  '00-overview':           'overview',
  '01-getting-started':    'getting-started',
  '02-appointments':       'appointments',
  '03-availability':       'availability',
  '04-customers':          'customers',
  '05-services':           'services',
  '06-team':               'staff',
  '07-public-booking':     'public-booking',
  '08-settings':           'settings',
  '09-notifications':      'notifications',
  '10-automation':         'automation',
  '11-integrations':       'integrations',
  '12-account-and-help':   'account',
  '13-permissions':        'permissions',
  '14-workflows':          'workflows',
  '15-troubleshooting':    'troubleshooting',
  '16-faq':                'faq',
  '17-known-limitations':  'limitations',
};

export function categoryOf(filename: string): string {
  const base = path.basename(filename, '.md');
  return CATEGORY_MAP[base] ?? base.replace(/^\d+-/, '');
}

function extractTitle(content: string, filename: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : filename.replace(/^\d+-/, '').replace(/\.md$/, '').replace(/-/g, ' ');
}

function fileHash(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) h = ((h << 5) - h + content.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface IndexStats {
  totalFiles: number;
  indexed: number;
  skipped: number;
  /** Articles whose file no longer exists: taken out of answers. */
  removed: number;
  failed: string[];
  totalChunks: number;
}

/**
 * Indexes server/knowledge/*.md (at every start, and on demand). Unchanged files are skipped; an edited file replaces its
 * chunks; an article whose file was deleted or renamed is deactivated and its chunks removed, so the assistant never
 * answers from a page that no longer exists.
 */
export function indexKnowledgeDirectory(force = false): IndexStats {
  const stats: IndexStats = { totalFiles: 0, indexed: 0, skipped: 0, removed: 0, failed: [], totalChunks: 0 };

  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    console.warn(`[knowledge-indexer] Directory not found: ${KNOWLEDGE_DIR}`);
    return stats;
  }

  const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md')).sort();
  stats.totalFiles = files.length;

  for (const filename of files) {
    const filepath = path.join(KNOWLEDGE_DIR, filename);
    let content: string;
    try {
      content = fs.readFileSync(filepath, 'utf8');
    } catch {
      stats.failed.push(filename);
      continue;
    }

    const version = `${fileHash(content)}-c${CHUNKING_VERSION}`;
    const category = categoryOf(filename);
    const title = extractTitle(content, filename);
    const source = `knowledge/${filename}`;

    type DocRow = { id: string; version: string; category: string };
    const existing = db.prepare(
      `SELECT id, version, category FROM ai_knowledge_docs WHERE source = ? AND is_active = 1`
    ).get(source) as DocRow | undefined;

    if (existing && existing.version === version && existing.category === category && !force) {
      stats.skipped++;
      const cnt = (db.prepare(`SELECT COUNT(*) as c FROM ai_knowledge_chunks WHERE doc_id = ?`).get(existing.id) as { c: number }).c;
      stats.totalChunks += cnt;
      continue;
    }

    try {
      if (existing) {
        // An edited article replaces its old chunks and stays active. (It used to be deactivated here, so the
        // article vanished from answers until the next restart inserted a fresh copy.)
        const chunks = chunkText(content, 600);
        db.transaction(() => {
          db.prepare('DELETE FROM ai_knowledge_chunks WHERE doc_id = ?').run(existing.id);
          db.prepare(
            `UPDATE ai_knowledge_docs SET title=?, category=?, version=?, last_updated=strftime('%Y-%m-%dT%H:%M:%SZ','now'), content=? WHERE id=?`
          ).run(title, category, version, content, existing.id);
          const ins = db.prepare(
            `INSERT INTO ai_knowledge_chunks (id, doc_id, chunk_index, content, tokens) VALUES (?, ?, ?, ?, ?)`
          );
          for (let i = 0; i < chunks.length; i++) {
            ins.run(`kchunk-${nanoid(12)}`, existing.id, i, chunks[i], chunks[i].split(/\s+/).length);
          }
        })();
        stats.indexed++;
        stats.totalChunks += chunks.length;
      } else {
        const docId = `kdoc-${nanoid(12)}`;
        const chunks = chunkText(content, 600);
        db.transaction(() => {
          db.prepare(
            `INSERT INTO ai_knowledge_docs (id, organization_id, title, category, source, version, last_updated, access_scope, content, is_active)
             VALUES (?, NULL, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'authenticated', ?, 1)`
          ).run(docId, title, category, source, version, content);
          const ins = db.prepare(
            `INSERT INTO ai_knowledge_chunks (id, doc_id, chunk_index, content, tokens) VALUES (?, ?, ?, ?, ?)`
          );
          for (let i = 0; i < chunks.length; i++) {
            ins.run(`kchunk-${nanoid(12)}`, docId, i, chunks[i], chunks[i].split(/\s+/).length);
          }
        })();
        stats.indexed++;
        stats.totalChunks += chunks.length;
      }
    } catch (err) {
      console.error(`[knowledge-indexer] Failed to index ${filename}:`, err);
      stats.failed.push(filename);
    }
  }

  stats.removed = deactivateMissing(files.map(f => `knowledge/${f}`));

  console.log(`[knowledge-indexer] ${stats.indexed} indexed, ${stats.skipped} skipped, ${stats.removed} removed, ${stats.failed.length} failed, ${stats.totalChunks} chunks`);
  return stats;
}

/** Deactivates the indexed articles of files that are no longer in the knowledge directory. Returns how many. */
function deactivateMissing(present: string[]): number {
  const keep = new Set(present);
  const stale = (db.prepare(`SELECT id, source FROM ai_knowledge_docs WHERE source LIKE 'knowledge/%' AND is_active = 1`)
    .all() as Array<{ id: string; source: string }>).filter(d => !keep.has(d.source));
  if (!stale.length) return 0;
  db.transaction(() => {
    for (const d of stale) {
      db.prepare('DELETE FROM ai_knowledge_chunks WHERE doc_id = ?').run(d.id);
      db.prepare(`UPDATE ai_knowledge_docs SET is_active = 0, last_updated = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(d.id);
    }
  })();
  return stale.length;
}

export function getKnowledgeCoverage() {
  type DocRow = { id: string; title: string; category: string; source: string; version: string; last_updated: string; is_active: number };
  const docs = db.prepare(`SELECT id, title, category, source, version, last_updated, is_active FROM ai_knowledge_docs`).all() as DocRow[];
  const activeDocs = docs.filter(d => d.is_active).length;
  const chunkCount = (db.prepare(
    `SELECT COUNT(*) as c FROM ai_knowledge_chunks c JOIN ai_knowledge_docs d ON c.doc_id = d.id WHERE d.is_active = 1`
  ).get() as { c: number }).c;
  const filesOnDisk = fs.existsSync(KNOWLEDGE_DIR)
    ? fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md')).length
    : 0;
  const sorted = [...docs].sort((a, b) => (b.last_updated ?? '').localeCompare(a.last_updated ?? ''));

  return {
    documentsOnDisk: filesOnDisk,
    documentsIndexed: activeDocs,
    documentsTotal: docs.length,
    chunksIndexed: chunkCount,
    knowledgeDirectory: KNOWLEDGE_DIR,
    lastUpdated: sorted[0]?.last_updated ?? null,
    documents: docs.map(d => ({
      title: d.title,
      category: d.category,
      source: d.source,
      lastUpdated: d.last_updated,
      isActive: !!d.is_active,
    })),
  };
}
