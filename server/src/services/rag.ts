/**
 * RAG (Retrieval-Augmented Generation) service.
 * Uses BM25-style keyword scoring for retrieval.
 * No external embedding provider required.
 */

import db from '../db/init';
import { nanoid } from 'nanoid';

interface KnowledgeDoc {
  id: string;
  title: string;
  category: string;
  source?: string;
  content: string;
  accessScope: string;
}

interface RetrievedChunk {
  docId: string;
  docTitle: string;
  category: string;
  content: string;
  score: number;
}

// Tokenise to lowercase words, strip punctuation
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

// Question words say nothing about the topic. Without dropping them, the phrasing ("how do I…" or "how to…")
// decided which article answered.
const STOPWORDS = new Set([
  'the', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'at', 'for', 'from', 'with', 'by', 'is', 'are', 'was', 'be', 'am',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'how', 'what', 'when', 'where', 'which', 'who', 'why',
  'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'this', 'that', 'there', 'please', 'want', 'need', 'about',
  'into', 'as', 'if', 'so', 'any', 'some', 'have', 'has',
]);

/** The distinct topic words of a question, each counted once (synonym expansion repeats words). */
export function queryTerms(text: string): string[] {
  return [...new Set(tokenize(text).filter(t => !STOPWORDS.has(t)))];
}

/** Crude stem so "creating"/"create", "hours"/"hour" and "reminders"/"reminder" compare equal. */
export function stem(word: string): string {
  const w = word.toLowerCase();
  const s = w.replace(/(ings|ing|ed|es|s)$/, '').replace(/e$/, '');
  return s.length >= 3 ? s : w;
}

/**
 * Inverse document frequency over the whole knowledge base: a word found in nearly every chunk ("appointment")
 * weighs little, a word found in few ("reminders", "business") decides the match.
 */
function inverseFrequency(terms: string[], chunks: Array<Set<string>>): Map<string, number> {
  const n = chunks.length;
  return new Map(terms.map(t => {
    const df = chunks.filter(c => c.has(t)).length;
    return [t, Math.log(1 + (n - df + 0.5) / (df + 0.5))] as const;
  }));
}

/** How informative each term is across all active knowledge (used to pick the section of an article that answers). */
export function termWeights(terms: string[]): Map<string, number> {
  const rows = db.prepare(
    `SELECT c.content FROM ai_knowledge_chunks c JOIN ai_knowledge_docs d ON c.doc_id = d.id WHERE d.is_active = 1`
  ).all() as Array<{ content: string }>;
  return inverseFrequency(terms, rows.map(r => new Set(tokenize(r.content))));
}

// BM25 constants
const K1 = 1.5;
const B = 0.75;

function bm25Score(docTokens: string[], queryTokens: string[], avgDocLen: number, idf: Map<string, number>): number {
  const docLen = docTokens.length;
  const freqMap: Record<string, number> = {};
  for (const t of docTokens) freqMap[t] = (freqMap[t] ?? 0) + 1;

  let score = 0;
  for (const q of queryTokens) {
    const tf = freqMap[q] ?? 0;
    if (tf === 0) continue;
    score += (idf.get(q) ?? 0) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (docLen / avgDocLen))));
  }
  return score;
}

/** Bump when chunkText changes, so stored articles are chunked again at the next start. */
export const CHUNKING_VERSION = 2;

export function chunkText(text: string, maxChunkTokens = 200): string[] {
  // Very short paragraphs are noise ("---"), except headings and steps: dropping "## Editing a service" once merged
  // its steps into the section above.
  const paragraphs = text.split(/\n{2,}/).filter(p => {
    const t = p.trim();
    return t.length > 20 || /^#{1,6}\s/.test(t) || /^\d+\.\s/.test(t);
  });
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const combined = current ? current + '\n\n' + para : para;
    if (tokenize(combined).length > maxChunkTokens && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = combined;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text.slice(0, 1000)];
}

export function indexDocument(doc: {
  id?: string;
  title: string;
  category: string;
  source?: string;
  content: string;
  accessScope?: string;
  organizationId?: string;
}): string {
  const docId = doc.id ?? `kdoc-${nanoid(10)}`;

  // Delete existing chunks if re-indexing
  const existing = db.prepare('SELECT id FROM ai_knowledge_docs WHERE id = ?').get(docId);
  if (existing) {
    db.prepare('DELETE FROM ai_knowledge_chunks WHERE doc_id = ?').run(docId);
    db.prepare(`UPDATE ai_knowledge_docs SET content = ?, last_updated = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(doc.content, docId);
  } else {
    db.prepare(`INSERT INTO ai_knowledge_docs (id, organization_id, title, category, source, access_scope, content)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(docId, doc.organizationId ?? null, doc.title, doc.category, doc.source ?? null,
          doc.accessScope ?? 'authenticated', doc.content);
  }

  const chunks = chunkText(doc.content);
  const insertChunk = db.prepare(
    'INSERT INTO ai_knowledge_chunks (id, doc_id, chunk_index, content, tokens) VALUES (?, ?, ?, ?, ?)'
  );
  for (let i = 0; i < chunks.length; i++) {
    insertChunk.run(`kchunk-${nanoid(10)}`, docId, i, chunks[i], tokenize(chunks[i]).length);
  }

  return docId;
}

export function retrieve(
  query: string,
  topK = 4,
  accessScope: 'authenticated' | 'admin' = 'authenticated',
  categories?: string[],  // optional: restrict scoring to these doc categories
): RetrievedChunk[] {
  const queryTokens = queryTerms(query);
  if (!queryTokens.length) return [];

  // Get all active chunks with their doc metadata
  const rows = db.prepare(`
    SELECT c.id, c.doc_id, c.content, c.tokens,
           d.title, d.category, d.access_scope
    FROM ai_knowledge_chunks c
    JOIN ai_knowledge_docs d ON c.doc_id = d.id
    WHERE d.is_active = 1
      AND (d.access_scope = 'authenticated' OR (? = 'admin' AND d.access_scope = 'admin'))
  `).all(accessScope) as Array<{
    id: string; doc_id: string; content: string; tokens: number;
    title: string; category: string; access_scope: string;
  }>;

  const tokenized = rows.map(r => ({ r, tokens: tokenize(r.content) }));
  const idf = inverseFrequency(queryTokens, tokenized.map(t => new Set(t.tokens)));

  // Apply category filter when the intent clearly identifies a feature
  const candidates = categories && categories.length > 0
    ? tokenized.filter(t => categories.includes(t.r.category))
    : tokenized;

  if (!candidates.length) return [];

  const avgDocLen = candidates.reduce((s, t) => s + t.tokens.length, 0) / candidates.length;

  const scored = candidates.map(({ r, tokens }) => ({
    docId: r.doc_id,
    docTitle: r.title,
    category: r.category,
    content: r.content,
    score: bm25Score(tokens, queryTokens, avgDocLen, idf),
  }));

  return scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function deleteDocument(docId: string): void {
  db.prepare('UPDATE ai_knowledge_docs SET is_active = 0 WHERE id = ?').run(docId);
}
