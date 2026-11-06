/**
 * Deterministic intent router for WorkEasy360 Knowledge Search.
 * No external AI API. All classification is rule-based with entity extraction.
 */

export type RouterIntent =
  | 'greeting'
  | 'platform_how_to'
  | 'live_data_query'
  | 'availability_query'
  | 'record_search'
  | 'navigation'
  | 'action_request'
  | 'out_of_scope'
  | 'clarification_needed';

export interface RouterEntities {
  feature?: string;
  personName?: string;
  serviceName?: string;
  date?: string;          // YYYY-MM-DD
  duration?: number;      // minutes
  price?: number;
  currency?: string;
  timeframe?: string;
  destination?: string;
  routePath?: string;
  routeTitle?: string;
  recordType?: 'customers' | 'services' | 'staff' | 'appointments';
  searchQuery?: string;
  listMode?: boolean;     // true when user wants a listing, not just a count
}

export interface IntentResult {
  intent: RouterIntent;
  confidence: number;           // 0–1
  entities: RouterEntities;
  featureCategories: string[];  // BM25 category filter
}

// ── Domain scope ──────────────────────────────────────────────────────────────

const DOMAIN_TERMS = new Set([
  'appointment', 'booking', 'schedule', 'slot', 'availability', 'reschedule', 'cancel',
  'service', 'treatment', 'offering', 'session',
  // Staff / people
  'staff', 'employee', 'team member', 'provider',
  'member', 'team', 'colleague', 'coworker', 'teammate',
  'onboard', 'invite', 'hire',
  'customer', 'client', 'patient',
  'workspace', 'location', 'branch', 'clinic',
  'resource', 'room', 'equipment',
  'dashboard', 'report', 'analytics', 'revenue', 'metrics',
  'calendar', 'timetable', 'agenda',
  'setting', 'configuration', 'preferences', 'password', 'security',
  'notification', 'reminder',
  'booking page', 'integration', 'workeasy', 'workeasy360',
  'invoice', 'billing', 'timezone', 'currency',
  // Hours and schedule exceptions
  'working hours', 'opening hours', 'business hours', 'time off', 'holiday', 'closure', 'time zone',
  'minimum notice', 'manager', 'admin', 'role', 'permission',
  // Features people ask about that are not built (answered honestly from the knowledge base, not "out of scope")
  'payment', 'pay online', 'stripe', 'paypal', 'razorpay', 'zoom', 'google meet', 'outlook', 'sms', 'whatsapp', 'email',
  // Account / auth
  'account', 'login', 'logout', 'sign in', 'sign out', 'deactivate',
  // Hindi / Hinglish
  'अपॉइंटमेंट', 'बुकिंग', 'सेवा', 'स्टाफ', 'ग्राहक', 'सेटिंग', 'रिपोर्ट',
  'kaise', 'banate', 'jodna', 'karein',
]);

// Single-word terms worth fuzzy-checking for common typos
const FUZZY_DOMAIN_WORDS = [
  'appointment', 'booking', 'schedule', 'service', 'customer', 'client',
  'staff', 'workspace', 'calendar', 'setting', 'report', 'notification',
  'reminder', 'availability', 'integration', 'resource', 'employee',
];

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const m = a.length; const n = b.length;
  const prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev.splice(0, n + 1, ...curr);
  }
  return prev[n];
}

/** Replace each word that fuzzy-matches a canonical domain term with the canonical form.
 *  Uses strict distance 1 only — prevents valid English words like "working" from mapping
 *  to domain terms like "booking" (which have distance 2).
 */
export function normalizeTypos(query: string): string {
  return query.split(/\s+/).map(word => {
    const w = word.toLowerCase().replace(/[^a-z]/g, '');
    if (w.length < 5) return word;
    for (const fw of FUZZY_DOMAIN_WORDS) {
      if (Math.abs(w.length - fw.length) > 1) continue;
      if (levenshtein(w, fw) <= 1) return fw;
    }
    return word;
  }).join(' ');
}

function hasDomainTerm(lower: string): boolean {
  // Exact substring match first (fast path)
  for (const term of DOMAIN_TERMS) {
    if (lower.includes(term)) return true;
  }
  // Fuzzy match: allow edit distance 1 for words ≥5 chars, distance 2 for ≥8 chars
  const words = lower.split(/\s+/);
  for (const word of words) {
    if (word.length < 4) continue;
    const maxDist = word.length >= 6 ? 2 : 1;
    for (const fw of FUZZY_DOMAIN_WORDS) {
      if (Math.abs(word.length - fw.length) > maxDist) continue;
      if (levenshtein(word, fw) <= maxDist) return true;
    }
  }
  return false;
}

// ── Navigation route registry (verified from src/app/router.tsx) ──────────────

const ROUTE_REGISTRY: Array<{ keys: string[]; route: string; title: string }> = [
  { keys: ['new appointment', 'add appointment', 'create appointment', 'appointments/new'], route: '/appointments/new', title: 'New Appointment' },
  { keys: ['new service', 'add service', 'create service', 'services/new'],                route: '/services/new',     title: 'New Service' },
  { keys: ['new staff', 'add staff', 'staff/new', 'new member', 'add member', 'add team member', 'new team member', 'invite staff', 'invite member', 'invite team', 'onboard staff', 'onboard member'], route: '/staff/new', title: 'New Staff' },
  { keys: ['new customer', 'add customer', 'customers/new'],                               route: '/customers/new',    title: 'New Customer' },
  { keys: ['dashboard', 'home page', 'overview page', 'main page'],                        route: '/dashboard',        title: 'Dashboard' },
  { keys: ['appointments', 'my appointments', 'appointment list'],                         route: '/appointments',     title: 'Appointments' },
  { keys: ['calendar', 'schedule view'],                                                   route: '/calendar',         title: 'Calendar' },
  { keys: ['services', 'service list'],                                                    route: '/services',         title: 'Services' },
  { keys: ['staff', 'team', 'staff list', 'my team', 'manage staff', 'manage team', 'team members', 'staff members'], route: '/staff', title: 'Staff' },
  { keys: ['customers', 'customer list', 'clients'],                                       route: '/customers',        title: 'Customers' },
  { keys: ['workspaces', 'workspace list'],                                                route: '/workspaces',       title: 'Workspaces' },
  { keys: ['resources', 'resource list'],                                                  route: '/resources',        title: 'Resources' },
  { keys: ['reports', 'analytics', 'report page', 'reports page'],                        route: '/reports',          title: 'Reports' },
  { keys: ['settings', 'configuration', 'preferences', 'settings page'],                  route: '/settings',         title: 'Settings' },
  { keys: ['booking pages', 'booking-pages', 'booking page list'],                        route: '/booking-pages',    title: 'Booking Pages' },
  { keys: ['notifications'],                                                               route: '/notifications',    title: 'Notifications' },
  { keys: ['integrations', 'integration'],                                                 route: '/integrations',     title: 'Integrations' },
  { keys: ['my space', 'my-space'],                                                        route: '/my-space',         title: 'My Space' },
];

function resolveDestination(lower: string): { route: string; title: string } | undefined {
  // Match longest-key first to prefer "new appointment" over "appointment"
  const flat = ROUTE_REGISTRY.flatMap(r => r.keys.map(k => ({ key: k, route: r.route, title: r.title })))
    .sort((a, b) => b.key.length - a.key.length);
  for (const { key, route, title } of flat) {
    if (lower.includes(key)) return { route, title };
  }
  return undefined;
}

// ── Feature → BM25 category map ───────────────────────────────────────────────

const FEATURE_CATEGORY_MAP: Record<string, string[]> = {
  staff:         ['staff'],
  appointment:   ['appointments'],
  service:       ['services'],
  customer:      ['customers'],
  workspace:     ['workspaces'],
  resource:      ['resources'],
  booking:       ['booking-pages', 'public-booking'],
  settings:      ['settings'],
  report:        ['reports'],
  calendar:      ['calendar'],
  notification:  ['notifications'],
  integration:   ['integrations'],
  overview:      ['overview', 'getting-started'],
  troubleshoot:  ['troubleshooting', 'faq'],
  permissions:   ['permissions'],
};

interface FeatureMatch { feature: string; pattern: RegExp }

// Order matters: more specific patterns first; integration before calendar
const FEATURE_MATCHERS: FeatureMatch[] = [
  { feature: 'integration', pattern: /\b(integrations?|google\s+calendar|apple\s+calendar|outlook|ical|google\s+sync|connect.*calendar|sync.*calendar)\b/i },
  { feature: 'staff',        pattern: /\b(staff\s+member|staff|employee|team\s+member|my\s+team|member|colleague|coworker|teammate|onboard|invite|provider|therapist|doctor)\b/i },
  { feature: 'appointment',  pattern: /\b(appointment|booking|meeting|session)\b/i },
  { feature: 'service',      pattern: /\b(service|treatment|offering)\b/i },
  { feature: 'customer',     pattern: /\b(customer|client|patient)\b/i },
  { feature: 'workspace',    pattern: /\b(workspace|location|branch|clinic|office)\b/i },
  { feature: 'resource',     pattern: /\b(resource|room|equipment)\b/i },
  { feature: 'booking',      pattern: /\b(booking\s+page|public\s+booking)\b/i },
  { feature: 'settings',     pattern: /\b(setting|configuration|preferences|password|security|2fa|account|booking\s+rules?|business\s+hours|opening\s+hours|time\s*zone|currency|cancellation\s+policy|minimum\s+notice)\b/i },
  { feature: 'report',       pattern: /\b(reports?|analytics|revenue|metrics|statistics)\b/i },
  { feature: 'calendar',     pattern: /\b(calendar|schedule\s+view|agenda)\b/i },
  { feature: 'notification', pattern: /\b(notifications?|reminders?|email\s+(?:alert|reminder|notification))\b/i },
  { feature: 'permissions',  pattern: /\b(roles?|permissions?|managers?|admins?|administrators?)\b|\bcan\s+(?:a\s+)?(?:staff|managers?|admins?)\b/i },
];

/** Returns ALL matched features so BM25 can search across multiple topic categories. */
function detectAllFeatures(query: string): { primaryFeature: string | undefined; categories: string[] } {
  const seenFeatures: string[] = [];
  const categories: string[] = [];
  for (const { feature, pattern } of FEATURE_MATCHERS) {
    if (pattern.test(query)) {
      if (!seenFeatures.includes(feature)) {
        seenFeatures.push(feature);
        for (const cat of FEATURE_CATEGORY_MAP[feature] ?? []) {
          if (!categories.includes(cat)) categories.push(cat);
        }
      }
    }
  }
  return { primaryFeature: seenFeatures[0], categories };
}

// ── Entity extraction ─────────────────────────────────────────────────────────

export function extractDuration(query: string): number | undefined {
  const mMin = query.match(/(\d+)\s*[-–]?\s*min(?:ute)?s?\b/i);
  if (mMin) return parseInt(mMin[1]);
  const mHr = query.match(/(\d+)\s*(?:hour?s?|hr?s?)\b/i);
  if (mHr) return parseInt(mHr[1]) * 60;
  return undefined;
}

export function extractPrice(query: string): { price: number; currency: string } | undefined {
  const mInr = query.match(/(?:₹|rs\.?\s*|inr\s*)(\d+(?:\.\d+)?)/i)
    ?? query.match(/(\d+(?:\.\d+)?)\s*(?:₹|rupees?|inr)\b/i);
  if (mInr) return { price: parseFloat(mInr[1]), currency: 'INR' };
  const mUsd = query.match(/\$\s*(\d+(?:\.\d+)?)/i) ?? query.match(/usd\s*(\d+(?:\.\d+)?)/i);
  if (mUsd) return { price: parseFloat(mUsd[1]), currency: 'USD' };
  return undefined;
}

/** Dates such as "tomorrow" count from `today` (YYYY-MM-DD, the business's date) when given, else the server's date. */
export function extractDate(query: string, today?: string): string | undefined {
  const lower = query.toLowerCase();
  const now = today ? new Date(`${today}T12:00:00`) : new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  if (lower.includes('tomorrow')) {
    const d = new Date(now); d.setDate(d.getDate() + 1); return fmt(d);
  }
  if (lower.includes('today')) return fmt(now);
  if (lower.includes('next week')) {
    const d = new Date(now); d.setDate(d.getDate() + 7); return fmt(d);
  }
  // ISO date literal
  const iso = query.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  // next [weekday]
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  for (let i = 0; i < days.length; i++) {
    if (lower.includes('next ' + days[i])) {
      const d = new Date(now);
      const diff = (i - now.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + diff);
      return fmt(d);
    }
  }
  return undefined;
}

export function extractPersonName(query: string): string | undefined {
  // After "find customer|search for" etc., grab capitalized sequence
  const m = query.match(
    /(?:find\s+(?:customer|client|staff|member|employee)\s+|search\s+(?:for\s+)?|look\s+up\s+|find\s+)([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)/,
  );
  if (m) return m[1];
  // Any capitalized multi-word sequence
  const words = query.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g);
  return words?.[0];
}

export function extractServiceName(query: string): string | undefined {
  // "Create a 30-minute consultation service for ₹500"
  const m1 = query.match(/(?:create|add|make)\s+(?:a\s+)?(?:\d+[-\s]?(?:min(?:ute)?s?|hour?s?)\s+)?([a-zA-Z][a-zA-Z\s]+?)\s+service\b/i);
  if (m1) return m1[1].trim();
  // "Create consultation for ₹500"
  const m2 = query.match(/(?:create|add|make)\s+(?:a\s+)?([a-zA-Z][a-zA-Z\s]+?)\s+(?:for\s+(?:₹|\$|rs|inr|\d))/i);
  if (m2) return m2[1].trim();
  return undefined;
}

// ── Greeting / vague query detection ─────────────────────────────────────────

const VAGUE_SET = new Set([
  'who', 'what', 'where', 'when', 'why', 'how',
  'help', 'hi', 'hello', 'hey', 'ok', 'okay', 'yes', 'no',
  'test', 'ping', '?', '??', '???', 'yo', 'sup', 'hola',
]);

function isGreeting(query: string): boolean {
  const t = query.trim().toLowerCase().replace(/[?!.,]+$/, '');
  if (VAGUE_SET.has(t)) return true;
  if (t.split(/\s+/).length === 1 && t.length <= 4) return true;
  return /^(hi|hello|hey|good\s+(?:morning|afternoon|evening)|greetings|howdy)\b/i.test(query);
}

// ── Intent patterns ───────────────────────────────────────────────────────────

const NAV_PATTERNS = [
  /\b(?:go|take\s+me|navigate|bring\s+me|jump|switch)\s+to\b/i,
  /\bopen\s+(?:the\s+)?/i,
  /\bshow\s+me\s+the\s+\w+\s*(?:page|section|screen|tab)\b/i,
  /\bwhere\s+(?:is|are|can\s+i\s+find)\s+(?:the\s+|my\s+)?\w+\s*(?:page|section|screen|tab)\b/i,
  /\bnavigate\s+to\b/i,
];

const SEARCH_PATTERNS = [
  /\b(?:find|search|look\s+up|fetch)\s+(?:customer|client|staff|member|employee|service|appointment)\b/i,
  /\b(?:find|search\s+for|look\s+up)\s+[A-Z][a-z]/,  // "Find Alice Johnson"
  /\bsearch\s+customer/i,
  // "list customers", "show all staff", "get all services"
  /\b(?:list|show\s+all|get\s+all|display\s+all)\s+(?:customer|client|staff|member|employee|service)s?\b/i,
];

const LIVE_DATA_PATTERNS = [
  /\bhow\s+many\s+\w+\s*(do\s+i\s+have|this|today|this\s+month|this\s+week)?/i,
  /\b(?:count|total)\s+(?:of\s+)?(?:appointment|booking|customer|service|staff)/i,
  /\b(?:appointment|booking)\s+count\b/i,
  /\bwhat(?:'s|\s+is)\s+my\s+(?:appointment|booking|customer|revenue|count)\b/i,
  /\bshow\s+(?:me\s+)?my\s+(?:appointment|booking|revenue|stats?|metric)s?\b/i,
  /\bmy\s+(?:appointment|booking)\s+count\b/i,
  /\bhow\s+much\s+(?:revenue|money|income)\b/i,
  // "show my bookings tomorrow/today/for date" — list appointments for a date
  /\bshow\s+(?:me\s+)?(?:my\s+)?(?:booking|appointment)s?\s+(?:for|on|tomorrow|today|next)\b/i,
  /\bmy\s+(?:booking|appointment)s?\s+(?:for|on|tomorrow|today|next|this)\b/i,
  /\blist\s+(?:my\s+)?(?:upcoming\s+)?(?:booking|appointment)s?\b/i,
  /\bwhat(?:'s|\s+are)\s+my\s+(?:upcoming\s+)?(?:booking|appointment)s?\b/i,
];

const AVAILABILITY_PATTERNS = [
  // Require a slot/time/appointment/booking context — NOT bare "available"
  /\bavailab(?:le|ility)\s+(?:slot|time|appointment|booking)s?\b/i,
  /\bfree\s+(?:slot|time|appointment)s?\b/i,
  /\bopen\s+slots?\b/i,
  /\bshow\s+me\s+(?:available|free)\s+(?:slot|time|appointment)s?\b/i,
  /\bwhen\s+(?:can\s+i|is\s+\w+\s+available|are\s+(?:there|you))\b/i,
  /\bcheck\s+availability\b/i,
  /\bbook\s+a\s+(?:slot|time|appointment)\b/i,
  /\bslots?\s+(?:for|on|available)\b/i,
  /\bavailable\s+(?:slot|time|appointment)s?\b/i,
];

// Imperative create/add without "how do I" prefix
const IMPERATIVE_PATTERNS = [
  /^(?:please\s+)?(?:create|add|make|set\s+up|book|schedule|delete|remove|update|edit)\b/i,
  /^(?:i\s+(?:want|need|would\s+like|'d\s+like)\s+(?:to\s+)?(?:create|add|make|set\s+up|book))\b/i,
  /^(?:can\s+you\s+(?:create|add|make|set\s+up|book))\b/i,
];

const HOW_TO_PATTERNS = [
  /\bhow\s+(?:do\s+i|to|can\s+i|do\s+you|do\s+we)\b/i,
  /\bsteps?\s+(?:to|for)\b/i,
  /\bwhat(?:'s|\s+is)\s+the\s+(?:way|process|procedure)\b/i,
  /\bhow\s+(?:can|do|to)\b/i,
  /\bguide\s+(?:to|for)\b/i,
  /\binstruction/i,
];

// ── Main router ───────────────────────────────────────────────────────────────

export function routeIntent(query: string): IntentResult {
  const lower = query.toLowerCase().trim();

  // 1. Greeting / vague
  if (isGreeting(query)) {
    return { intent: 'greeting', confidence: 1.0, entities: {}, featureCategories: [] };
  }

  // 2. Out of scope — no WorkEasy360 domain term (includes fuzzy match)
  if (!hasDomainTerm(lower)) {
    return { intent: 'out_of_scope', confidence: 0.9, entities: {}, featureCategories: [] };
  }

  // Single domain word is too vague — show feature-specific suggestions
  if (lower.split(/\s+/).filter(w => w.length > 0).length === 1) {
    const normalized = normalizeTypos(lower);
    const { primaryFeature, categories } = detectAllFeatures(normalized);
    return {
      intent: 'clarification_needed',
      confidence: 0.8,
      entities: primaryFeature ? { feature: primaryFeature } : {},
      featureCategories: categories,
    };
  }

  const { primaryFeature, categories: featureCategories } = detectAllFeatures(query);
  const entities: RouterEntities = {};
  if (primaryFeature) entities.feature = primaryFeature;

  // 3. Navigation — must detect a known route destination
  if (NAV_PATTERNS.some(p => p.test(query))) {
    const dest = resolveDestination(lower);
    if (dest) {
      return {
        intent: 'navigation',
        confidence: 0.95,
        entities: { ...entities, destination: dest.route, routePath: dest.route, routeTitle: dest.title },
        featureCategories: [],
      };
    }
    // Navigation intent but unknown destination → clarify
    return { intent: 'clarification_needed', confidence: 0.8, entities, featureCategories };
  }

  // 4. Record search
  if (SEARCH_PATTERNS.some(p => p.test(query))) {
    const personName = extractPersonName(query);
    let recordType: RouterEntities['recordType'] = 'customers';
    if (/\b(staff|employee|member)\b/i.test(query)) recordType = 'staff';
    else if (/\bservice\b/i.test(query)) recordType = 'services';
    else if (/\bappointment\b/i.test(query)) recordType = 'appointments';
    const searchQuery = personName ?? query.replace(/^(find|search for|look up|fetch|list|show all|get all|display all)\s+(?:customer|client|staff|service)s?\s*/i, '').trim();
    const listMode = /\b(?:list|show\s+all|get\s+all|display\s+all)\b/i.test(query);
    return {
      intent: 'record_search',
      confidence: 0.9,
      entities: { ...entities, personName, recordType, searchQuery: listMode ? '' : searchQuery, listMode },
      featureCategories,
    };
  }

  // 5. Live data query (counts, stats, "my appointments", "how many")
  if (LIVE_DATA_PATTERNS.some(p => p.test(query))) {
    const date = extractDate(query);
    const listMode = /\bshow\b|\blist\b|\bwhat\s+are\b/i.test(lower) && !!date;
    const timeframe = date ? 'specific_date'
      : /this\s+month/i.test(lower) ? 'this_month'
      : /this\s+week/i.test(lower) ? 'this_week'
      : /today/i.test(lower) ? 'today'
      : /last\s+month/i.test(lower) ? 'last_month'
      : /7\s*d(?:ay)?s?/i.test(lower) ? '7d'
      : /3\s*months?/i.test(lower) ? '3m'
      : /year/i.test(lower) ? '1y'
      : '30d';
    return {
      intent: 'live_data_query',
      confidence: 0.9,
      entities: { ...entities, timeframe, date, listMode },
      featureCategories: [],
    };
  }

  // 6. Availability query — slots / free times (NOT bare "available")
  if (AVAILABILITY_PATTERNS.some(p => p.test(query))) {
    const date = extractDate(query);
    return {
      intent: 'availability_query',
      confidence: 0.9,
      entities: { ...entities, date },
      featureCategories: [],
    };
  }

  // 7. Action request — imperative verb + specific entity data
  //    Must NOT be a "how do I" question; only applies to bookable/creatable entities
  const ACTIONABLE_FEATURES = new Set(['service', 'appointment', 'customer', 'staff', 'workspace', 'resource']);
  const isHowTo = HOW_TO_PATTERNS.some(p => p.test(query));
  if (!isHowTo && IMPERATIVE_PATTERNS.some(p => p.test(query)) &&
      (!primaryFeature || ACTIONABLE_FEATURES.has(primaryFeature))) {
    const duration = extractDuration(query);
    const priceInfo = extractPrice(query);
    const serviceName = extractServiceName(query) ?? primaryFeature;
    // Classify as action_request only if we have extractable entity data
    if (duration !== undefined || priceInfo !== undefined) {
      return {
        intent: 'action_request',
        confidence: 0.9,
        entities: {
          ...entities,
          duration,
          price: priceInfo?.price,
          currency: priceInfo?.currency,
          serviceName,
        },
        featureCategories,
      };
    }
    // Imperative but no entity data → could still be action, ask for details
    return {
      intent: 'clarification_needed',
      confidence: 0.75,
      entities: { ...entities, serviceName },
      featureCategories,
    };
  }

  // 8. Platform how-to — documentation answer via BM25
  if (isHowTo || /\b(guide|tutorial|instructions?|explain|what\s+is|what\s+are)\b/i.test(query)) {
    return {
      intent: 'platform_how_to',
      confidence: 0.85,
      entities,
      featureCategories,
    };
  }

  // 9. Fallback: treat as how-to with BM25
  return {
    intent: 'platform_how_to',
    confidence: 0.5,
    entities,
    featureCategories,
  };
}
