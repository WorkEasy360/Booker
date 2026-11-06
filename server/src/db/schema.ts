import type Database from 'better-sqlite3';

// Base tables as they existed before the numbered migrations in migrations.ts. Every statement is
// CREATE … IF NOT EXISTS, so running it on an existing database changes nothing.
export function createSchema(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY DEFAULT 'org-1',
    name TEXT NOT NULL DEFAULT 'My Business',
    email TEXT NOT NULL DEFAULT 'hello@example.com',
    phone TEXT,
    website TEXT,
    address TEXT,
    city TEXT,
    country TEXT DEFAULT 'US',
    timezone TEXT DEFAULT 'America/New_York',
    currency TEXT DEFAULT 'USD',
    date_format TEXT DEFAULT 'MM/DD/YYYY',
    time_format TEXT DEFAULT '12h',
    logo TEXT,
    working_hours TEXT DEFAULT '{}',
    booking_rules TEXT DEFAULT '{}',
    cancellation_policy TEXT DEFAULT '',
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    color TEXT DEFAULT '#00BF62',
    timezone TEXT DEFAULT 'America/New_York',
    address TEXT,
    phone TEXT,
    email TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    service_ids TEXT NOT NULL DEFAULT '[]',
    staff_ids TEXT NOT NULL DEFAULT '[]',
    working_hours TEXT NOT NULL DEFAULT '{}',
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    category TEXT NOT NULL DEFAULT 'consultation',
    duration INTEGER NOT NULL DEFAULT 60,
    price REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    location TEXT DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    buffer_before INTEGER NOT NULL DEFAULT 0,
    buffer_after INTEGER NOT NULL DEFAULT 0,
    min_notice INTEGER NOT NULL DEFAULT 0,
    max_advance INTEGER NOT NULL DEFAULT 30,
    cancellation_policy TEXT DEFAULT '',
    rescheduling_policy TEXT DEFAULT '',
    color TEXT DEFAULT '#00BF62',
    workspace_ids TEXT NOT NULL DEFAULT '[]',
    staff_ids TEXT NOT NULL DEFAULT '[]',
    resource_ids TEXT NOT NULL DEFAULT '[]',
    custom_fields TEXT NOT NULL DEFAULT '[]',
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS staff (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    role TEXT NOT NULL DEFAULT 'staff',
    title TEXT,
    bio TEXT,
    color TEXT DEFAULT '#00BF62',
    is_active INTEGER NOT NULL DEFAULT 1,
    workspace_ids TEXT NOT NULL DEFAULT '[]',
    service_ids TEXT NOT NULL DEFAULT '[]',
    working_hours TEXT NOT NULL DEFAULT '{}',
    booking_page_url TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS resources (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'room',
    description TEXT DEFAULT '',
    capacity INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    workspace_ids TEXT NOT NULL DEFAULT '[]',
    service_ids TEXT NOT NULL DEFAULT '[]',
    availability_rules TEXT NOT NULL DEFAULT '{}',
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    timezone TEXT,
    notes TEXT DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    total_bookings INTEGER NOT NULL DEFAULT 0,
    last_booking_date TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_org_email
    ON customers(organization_id, email);

  CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    booking_ref TEXT NOT NULL UNIQUE,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    workspace_id TEXT REFERENCES workspaces(id),
    service_id TEXT NOT NULL REFERENCES services(id),
    staff_id TEXT NOT NULL REFERENCES staff(id),
    customer_id TEXT NOT NULL REFERENCES customers(id),
    resource_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'scheduled',
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    duration INTEGER NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'America/New_York',
    price REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    location TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    internal_notes TEXT DEFAULT '',
    customer_answers TEXT NOT NULL DEFAULT '[]',
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
  CREATE INDEX IF NOT EXISTS idx_appointments_staff ON appointments(staff_id);
  CREATE INDEX IF NOT EXISTS idx_appointments_customer ON appointments(customer_id);

  CREATE TABLE IF NOT EXISTS booking_pages (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    workspace_id TEXT,
    service_id TEXT,
    staff_id TEXT,
    type TEXT NOT NULL DEFAULT 'business',
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    slug TEXT NOT NULL,
    is_published INTEGER NOT NULL DEFAULT 0,
    theme TEXT NOT NULL DEFAULT '{}',
    form_fields TEXT NOT NULL DEFAULT '[]',
    service_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_pages_slug
    ON booking_pages(organization_id, slug);

  -- ─── AI Operator tables ───────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS ai_conversations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'New Conversation',
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS ai_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls TEXT DEFAULT '[]',
    sources TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS ai_proposals (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    input_data TEXT NOT NULL,
    display_data TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    executed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS ai_audit_log (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    conversation_id TEXT,
    proposal_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    details TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS ai_knowledge_docs (
    id TEXT PRIMARY KEY,
    organization_id TEXT,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    source TEXT,
    version TEXT DEFAULT '1.0',
    last_updated TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    access_scope TEXT DEFAULT 'authenticated',
    content TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS ai_knowledge_chunks (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES ai_knowledge_docs(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    tokens INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS ai_workflows (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    original_query TEXT NOT NULL,
    step TEXT NOT NULL DEFAULT 'awaiting_service',
    context TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ai_conversations_org ON ai_conversations(organization_id);
  CREATE INDEX IF NOT EXISTS idx_ai_conversations_user ON ai_conversations(user_id);
  CREATE INDEX IF NOT EXISTS idx_ai_messages_conv ON ai_messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_ai_proposals_conv ON ai_proposals(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_ai_proposals_status ON ai_proposals(status);
  CREATE INDEX IF NOT EXISTS idx_ai_knowledge_active ON ai_knowledge_docs(is_active, access_scope);
  CREATE INDEX IF NOT EXISTS idx_ai_knowledge_chunks_doc ON ai_knowledge_chunks(doc_id);
  CREATE INDEX IF NOT EXISTS idx_ai_workflows_active ON ai_workflows(organization_id, user_id, status, expires_at);
`);
}
