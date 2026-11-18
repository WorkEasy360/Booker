import { describe, it, expect } from '@jest/globals';
import { EntitlementCache, type AnswerStore, type EntitlementSource } from '../workeasy360/entitlements';
import { Workeasy360Error, type EntitlementAnswer } from '../workeasy360/client';

// The entitlement cache on its own, with a clock the test moves: WorkEasy360 is asked on its advertised schedule,
// an outage never denies, a denial never lapses into access, and a refusal of this product's client fails closed.

const ORG = '0b4f8a2e-7d0e-4c55-9a7a-2f6a7d1c9e01';

function memoryStore(): AnswerStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return { rows, get: async k => rows.get(k) ?? null, set: async (k, v) => { rows.set(k, v); } };
}

function scripted(): EntitlementSource & { answers: Array<EntitlementAnswer | Workeasy360Error>; asked: number } {
  const source = {
    answers: [] as Array<EntitlementAnswer | Workeasy360Error>,
    asked: 0,
    async verifyEntitlement(): Promise<EntitlementAnswer> {
      source.asked += 1;
      const next = source.answers.shift();
      if (!next) throw new Error('no scripted answer');
      if (next instanceof Workeasy360Error) throw next;
      return next;
    },
  };
  return source;
}

const allow = (revalidateAfter = 900, writeAllowed = true): EntitlementAnswer => ({ decision: 'allow', reason: 'entitled', writeAllowed, revalidateAfter });
const deny = (reason = 'expired'): EntitlementAnswer => ({ decision: 'deny', reason, writeAllowed: false, revalidateAfter: 900 });

describe('WorkEasy360 entitlement cache', () => {
  it('trusts an allow for revalidate_after (at most 900 s, at least 30 s), then asks again', async () => {
    let now = 1_000_000;
    const source = scripted();
    const cache = new EntitlementCache(source, memoryStore(), undefined, () => now);
    source.answers.push(allow(120), allow(5000), allow(1));
    expect((await cache.check(ORG)).allowed).toBe(true);
    now += 119_000;
    await cache.check(ORG);
    expect(source.asked).toBe(1);
    now += 2_000;
    await cache.check(ORG);
    expect(source.asked).toBe(2);
    now += 899_000; // 5000 s advertised: capped at 900 s
    await cache.check(ORG);
    expect(source.asked).toBe(2);
    now += 2_000;
    await cache.check(ORG);
    expect(source.asked).toBe(3);
    now += 29_000; // 1 s advertised: at least 30 s
    await cache.check(ORG);
    expect(source.asked).toBe(3);
  });

  it('re-asks a denial after 60 s and never lets an outage turn it back into access', async () => {
    let now = 2_000_000;
    const source = scripted();
    const store = memoryStore();
    const cache = new EntitlementCache(source, store, undefined, () => now);
    source.answers.push(deny('suspended'));
    expect(await cache.check(ORG)).toMatchObject({ allowed: false, reason: 'suspended', status: 'deny' });
    now += 59_000;
    expect((await cache.check(ORG)).allowed).toBe(false);
    expect(source.asked).toBe(1);
    now += 2_000;
    source.answers.push(new Workeasy360Error('provider_unavailable', 'entitlement endpoint 503'));
    expect((await cache.check(ORG)).allowed).toBe(false);
    // A restart (a new process, nothing in memory) still reads the denial from the shared store.
    const restarted = new EntitlementCache(source, store, undefined, () => now);
    source.answers.push(new Workeasy360Error('provider_unavailable', 'timeout'));
    expect((await restarted.check(ORG)).allowed).toBe(false);
  });

  it('keeps access through an outage: the last allow stands, and with no answer yet access continues', async () => {
    let now = 3_000_000;
    const source = scripted();
    const cache = new EntitlementCache(source, memoryStore(), undefined, () => now);
    source.answers.push(new Workeasy360Error('provider_unavailable', 'unreachable'));
    expect(await cache.check(ORG)).toMatchObject({ allowed: true, status: 'unchecked' });
    now += 61_000;
    source.answers.push(allow(900, false), new Workeasy360Error('rate_limited', '429'));
    expect(await cache.check(ORG)).toMatchObject({ allowed: true, writeAllowed: false });
    now += 901_000;
    expect(await cache.check(ORG)).toMatchObject({ allowed: true, writeAllowed: false, status: 'allow' });
  });

  it('fails closed for the whole client for 60 s when WorkEasy360 refuses it, and counts a 429 soon after as a refusal', async () => {
    let now = 4_000_000;
    const source = scripted();
    const store = memoryStore();
    const cache = new EntitlementCache(source, store, undefined, () => now);
    const other = '6d1e0c55-3b8f-4f8a-9a52-0c3d1f2b7e44';
    source.answers.push(allow());
    await cache.check(other);
    source.answers.push(new Workeasy360Error('provider_refused', 'entitlement endpoint 401'));
    expect(await cache.check(ORG, { fresh: true })).toMatchObject({ allowed: false, status: 'refused' });
    // Every question, even one with a fresh allow on record, fails closed without asking.
    expect(await cache.check(other)).toMatchObject({ allowed: false, status: 'refused' });
    expect(source.asked).toBe(2);
    // Another instance learns of it from the shared store.
    const instanceB = new EntitlementCache(source, store, undefined, () => now);
    expect((await instanceB.check(other)).status).toBe('refused');
    now += 61_000;
    source.answers.push(new Workeasy360Error('rate_limited', 'entitlement endpoint 429'));
    expect((await cache.check(ORG)).status).toBe('refused');
    now += 61_000;
    source.answers.push(allow());
    expect((await cache.check(ORG)).status).toBe('allow');
  });

  it('asks per person when a subject is given, so removing someone reaches their session', async () => {
    const now = 5_000_000;
    const source = scripted();
    const cache = new EntitlementCache(source, memoryStore(), undefined, () => now);
    source.answers.push(allow(), deny('membership_inactive'));
    expect((await cache.check(ORG, { subject: 'person-1' })).allowed).toBe(true);
    expect(await cache.check(ORG, { subject: 'person-2' })).toMatchObject({ allowed: false, reason: 'membership_inactive' });
    expect(source.asked).toBe(2);
  });
});
