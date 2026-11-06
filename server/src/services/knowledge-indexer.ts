import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import db from '../db/init';
import { chunkText, CHUNKING_VERSION } from './rag';

const KNOWLEDGE_DIR = path.join(__dirname, '../../knowledge');

const CATEGORY_MAP: Record<string, string> = {
  '00-overview':           'overview',
  '01-getting-started':    'getting-started',
  '02-appointments':       'appointments',
  '03-services':           'services',
  '04-staff':              'staff',
  '05-customers':          'customers',
  '06-workspaces':         'workspaces',
  '07-resources':          'resources',
  '08-booking-pages':      'booking-pages',
  '09-public-booking':     'public-booking',
  '10-settings':           'settings',
  '11-reports':            'reports',
  '12-notifications':      'notifications',
  '13-calendar':           'calendar',
  '14-integrations':       'integrations',
  '15-troubleshooting':    'troubleshooting',
  '16-faq':                'faq',
  '17-permissions':        'permissions',
  '18-workflows':          'workflows',
  '19-known-limitations':  'limitations',
};

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
  failed: string[];
  totalChunks: number;
}

export function indexKnowledgeDirectory(force = false): IndexStats {
  const stats: IndexStats = { totalFiles: 0, indexed: 0, skipped: 0, failed: [], totalChunks: 0 };

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
    const base = path.basename(filename, '.md');
    const category = CATEGORY_MAP[base] ?? base;
    const title = extractTitle(content, filename);
    const source = `knowledge/${filename}`;

    type DocRow = { id: string; version: string };
    const existing = db.prepare(
      `SELECT id, version FROM ai_knowledge_docs WHERE source = ? AND is_active = 1`
    ).get(source) as DocRow | undefined;

    if (existing && existing.version === version && !force) {
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
            `UPDATE ai_knowledge_docs SET title=?, version=?, last_updated=strftime('%Y-%m-%dT%H:%M:%SZ','now'), content=? WHERE id=?`
          ).run(title, version, content, existing.id);
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
        db.prepare(
          `INSERT INTO ai_knowledge_docs (id, organization_id, title, category, source, version, last_updated, access_scope, content, is_active)
           VALUES (?, NULL, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'authenticated', ?, 1)`
        ).run(docId, title, category, source, version, content);
        const chunks = chunkText(content, 600);
        const ins = db.prepare(
          `INSERT INTO ai_knowledge_chunks (id, doc_id, chunk_index, content, tokens) VALUES (?, ?, ?, ?, ?)`
        );
        for (let i = 0; i < chunks.length; i++) {
          ins.run(`kchunk-${nanoid(12)}`, docId, i, chunks[i], chunks[i].split(/\s+/).length);
        }
        stats.indexed++;
        stats.totalChunks += chunks.length;
      }
    } catch (err) {
      console.error(`[knowledge-indexer] Failed to index ${filename}:`, err);
      stats.failed.push(filename);
    }
  }

  console.log(`[knowledge-indexer] ${stats.indexed} indexed, ${stats.skipped} skipped, ${stats.failed.length} failed, ${stats.totalChunks} chunks`);
  return stats;
}

export function getKnowledgeCoverage() {
  type DocRow = { id: string; title: string; category: string; source: string; version: string; last_updated: string; is_active: number };
  const docs = db.prepare(`SELECT id, title, category, source, version, last_updated, is_active FROM ai_knowledge_docs`).all() as DocRow[];
  const activeDocs = docs.filter(d => d.is_active).length;
  const chunkCount = (db.prepare(`SELECT COUNT(*) as c FROM ai_knowledge_chunks`).get() as { c: number }).c;
  const filesOnDisk = fs.existsSync(KNOWLEDGE_DIR)
    ? fs.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.md')).length
    : 0;
  const sorted = [...docs].sort((a, b) => b.last_updated.localeCompare(a.last_updated));

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
