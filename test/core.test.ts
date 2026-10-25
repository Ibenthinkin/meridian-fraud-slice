import { describe, expect, it } from "vitest";
import {
  DEGRADED_POLICY,
  SIGNAL_FIELDS,
  applyEvent,
  decide,
  deriveSignals,
  emptyFeatures,
  evaluateRules,
  heuristicModel,
  mostSevere,
  validateRuleSet,
  type AccountFeatures,
  type DecisionDeps,
  type RuleSet,
} from "../src/core/index.js";
import ruleSetJson from "../src/core/rules.json" with { type: "json" };

const ruleSet = ruleSetJson as RuleSet;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-21T15:00:00Z");

function established(overrides: Partial<AccountFeatures> = {}): AccountFeatures {
  return {
    accountId: "acct_1",
    knownDeviceIds: ["dev_home"],
    failedLoginTimestamps: [],
    payeeAddedAt: { bank_old: NOW - 400 * DAY },
    typicalWithdrawalCents: 150000,
    withdrawalCount: 12,
    accountOpenedAt: NOW - 2000 * DAY,
    updatedAt: NOW,
    ...overrides,
  };
}

function deps(features: AccountFeatures | null, overrides: Partial<DecisionDeps> = {}): DecisionDeps {
  let n = 0;
  return {
    loadFeatures: async () => features,
    model: heuristicModel,
    ruleSet,
    now: () => NOW,
    newId: () => `dec_${++n}`,
    featureTimeoutMs: 100,
    ...overrides,
  };
}

describe("rule set", () => {
  it("is valid on load", () => {
    expect(() => validateRuleSet(ruleSet, SIGNAL_FIELDS)).not.toThrow();
  });

  it("rejects a bad op, field, and action with every problem listed", () => {
    const bad = {
      version: "x",
      rules: [
        { id: "A", description: "", eventTypes: [], field: "nope", op: "gt", value: "1", action: "allow" },
        { id: "A", description: "", eventTypes: [], field: "amountCents", op: "like", action: "nuke" },
      ],
    } as unknown as RuleSet;
    expect(() => validateRuleSet(bad, SIGNAL_FIELDS)).toThrow(/unknown field nope.*needs a numeric.*duplicate rule id A.*unknown op like.*unknown action nuke/s);
  });

  it("shadow rules never change the action", () => {
    const hits = [
      { id: "S", action: "block" as const, shadow: true },
      { id: "L", action: "step_up" as const, shadow: false },
    ];
    expect(mostSevere(hits)).toBe("step_up");
  });
});

describe("signals", () => {
  it("marks history missing when there are no features", () => {
    const s = deriveSignals({ eventType: "login", idempotencyKey: "k", accountId: "a", deviceId: "d" }, null, NOW);
    expect(s.featuresMissing).toBe(true);
    expect(s.deviceKnown).toBe("unknown");
    expect(s.newDevice).toBe(false);
  });

  it("computes payee age, contact change age, and amount ratio", () => {
    const f = established({ payeeAddedAt: { bank_new: NOW - 1 * DAY }, contactChangedAt: NOW - 2 * DAY });
    const s = deriveSignals(
      { eventType: "withdrawal", idempotencyKey: "k", accountId: "acct_1", amountCents: 1500000, payeeId: "bank_new", deviceId: "dev_new" },
      f,
      NOW
    );
    expect(s.newDevice).toBe(true);
    expect(s.payeeAgeDays).toBeCloseTo(1);
    expect(s.contactChangedDays).toBeCloseTo(2);
    expect(s.amountVsTypical).toBeCloseTo(10);
  });

  // Leaving a field out must never make a request look safer than sending it.
  it("treats a request with no device as a new device", () => {
    const s = deriveSignals({ eventType: "login", idempotencyKey: "k", accountId: "acct_1" }, established(), NOW);
    expect(s.deviceKnown).toBe("unknown");
    expect(s.newDevice).toBe(true);
  });

  it.each(["withdrawal", "transfer"] as const)("treats a %s to a payee the account never added as brand new", (eventType) => {
    const s = deriveSignals({ eventType, idempotencyKey: "k", accountId: "acct_1", amountCents: 50000, payeeId: "bank_never_added", deviceId: "dev_home" }, established(), NOW);
    expect(s.payeeAgeDays).toBe(0);
  });

  it("treats a withdrawal that names no payee as going to a brand-new one", () => {
    const s = deriveSignals({ eventType: "withdrawal", idempotencyKey: "k", accountId: "acct_1", amountCents: 50000, deviceId: "dev_home" }, established(), NOW);
    expect(s.payeeAgeDays).toBe(0);
  });

  it("leaves payee age unknown on events that don't move money", () => {
    // A payee_add's payee is new by definition; that's what NEW_DEVICE_MONEY and the model already weigh.
    const s = deriveSignals({ eventType: "payee_add", idempotencyKey: "k", accountId: "acct_1", payeeId: "bank_never_added", deviceId: "dev_home" }, established(), NOW);
    expect(s.payeeAgeDays).toBeNull();
  });
});

describe("decide", () => {
  it("allows a routine withdrawal from a known device to an old payee", async () => {
    const d = await decide(
      { eventType: "withdrawal", idempotencyKey: "k1", accountId: "acct_1", amountCents: 160000, payeeId: "bank_old", deviceId: "dev_home" },
      deps(established())
    );
    expect(d.action).toBe("allow");
    expect(d.reasons).toEqual([]);
    expect(d.ruleSetVersion).toBe(ruleSet.version);
  });

  it("holds the classic takeover: new device, new payee, large amount", async () => {
    const f = established({ payeeAddedAt: { bank_new: NOW - 2 * 60 * 60 * 1000 }, contactChangedAt: NOW - 1 * DAY });
    const d = await decide(
      { eventType: "withdrawal", idempotencyKey: "k2", accountId: "acct_1", amountCents: 2500000, payeeId: "bank_new", deviceId: "dev_attacker" },
      deps(f)
    );
    expect(d.action).toBe("hold");
    expect(d.reasons).toEqual(expect.arrayContaining(["NEW_DEVICE_MONEY", "PAYEE_UNDER_3D", "CONTACT_CHANGED_7D", "AMOUNT_10X_TYPICAL"]));
    expect(d.score).toBeGreaterThan(0.5);
  });

  it("holds a routine-sized withdrawal to a payee the account never added", async () => {
    const d = await decide(
      { eventType: "withdrawal", idempotencyKey: "k_np", accountId: "acct_1", amountCents: 160000, payeeId: "bank_never_added", deviceId: "dev_home" },
      deps(established())
    );
    expect(d.action).toBe("hold");
    expect(d.reasons).toContain("PAYEE_UNDER_3D");
  });

  it("steps up a login that leaves out the device instead of allowing it", async () => {
    const d = await decide({ eventType: "login", idempotencyKey: "k_nd", accountId: "acct_1" }, deps(established()));
    expect(d.action).toBe("step_up");
    expect(d.reasons).toContain("NEW_DEVICE_LOGIN");
  });

  it("steps up a new-device login instead of holding it", async () => {
    const d = await decide(
      { eventType: "login", idempotencyKey: "k3", accountId: "acct_1", deviceId: "dev_new" },
      deps(established())
    );
    expect(d.action).toBe("step_up");
    expect(d.reasons).toContain("NEW_DEVICE_LOGIN");
  });

  it("blocks login velocity", async () => {
    const f = established({ failedLoginTimestamps: [1, 2, 3, 4, 5].map((i) => NOW - i * 60 * 1000) });
    const d = await decide({ eventType: "login", idempotencyKey: "k4", accountId: "acct_1", deviceId: "dev_home" }, deps(f));
    expect(d.action).toBe("block");
    expect(d.reasons).toContain("LOGIN_VELOCITY");
  });

  it("records shadow hits without acting on them", async () => {
    const f = established({ accountOpenedAt: NOW - 5 * DAY, typicalWithdrawalCents: undefined, withdrawalCount: 0 });
    const d = await decide(
      { eventType: "withdrawal", idempotencyKey: "k5", accountId: "acct_1", amountCents: 1500000, payeeId: "bank_old", deviceId: "dev_home" },
      deps(f)
    );
    expect(d.shadowHits).toContain("SHADOW_NEW_ACCOUNT_LARGE");
    expect(d.reasons).not.toContain("SHADOW_NEW_ACCOUNT_LARGE");
  });

  it("falls into the degraded policy when the feature store times out", async () => {
    const slow = () => new Promise<AccountFeatures | null>((resolve) => setTimeout(() => resolve(null), 500));
    const d = await decide(
      { eventType: "withdrawal", idempotencyKey: "k6", accountId: "acct_1", amountCents: 100000, payeeId: "bank_old", deviceId: "dev_home" },
      deps(null, { loadFeatures: slow, featureTimeoutMs: 20 })
    );
    expect(d.degraded).toMatch(/features_unavailable/);
    expect(d.action).toBe(DEGRADED_POLICY.withdrawal);
    expect(d.reasons).toContain("HISTORY_UNAVAILABLE");
  });

  it("lets a login through with a challenge when history is missing", async () => {
    const d = await decide({ eventType: "login", idempotencyKey: "k7", accountId: "acct_new", deviceId: "dev_x" }, deps(null));
    expect(d.action).toBe("step_up");
  });

  it("keeps rules when the model fails", async () => {
    const broken = { version: "broken", score: async () => { throw new Error("endpoint down"); } };
    const f = established({ payeeAddedAt: { bank_new: NOW - DAY } });
    const d = await decide(
      { eventType: "withdrawal", idempotencyKey: "k8", accountId: "acct_1", amountCents: 100000, payeeId: "bank_new", deviceId: "dev_home" },
      deps(f, { model: broken })
    );
    expect(d.degraded).toMatch(/model_unavailable/);
    expect(d.action).toBe("hold");
    expect(d.reasons).toEqual(["PAYEE_UNDER_3D"]);
  });

  it("evaluates every rule, not just the first match, so decisions are explainable", () => {
    const f = established({ payeeAddedAt: { bank_new: NOW - DAY } });
    const s = deriveSignals(
      { eventType: "withdrawal", idempotencyKey: "k", accountId: "acct_1", amountCents: 30000000, payeeId: "bank_new", deviceId: "dev_x", ipCountry: "KP" },
      f,
      NOW
    );
    const ids = evaluateRules(ruleSet, s).map((h) => h.id);
    expect(ids).toEqual(["NEW_DEVICE_MONEY", "PAYEE_UNDER_3D", "AMOUNT_10X_TYPICAL", "LARGE_AMOUNT", "SANCTIONED_GEO"]);
  });
});

describe("feature ingestion", () => {
  it("replays a history into the expected profile", () => {
    let f = emptyFeatures("acct_9", NOW - 100 * DAY);
    f = applyEvent(f, { type: "account.opened", accountId: "acct_9", at: NOW - 100 * DAY });
    f = applyEvent(f, { type: "identity.login", accountId: "acct_9", deviceId: "d1", ok: true, at: NOW - 90 * DAY });
    f = applyEvent(f, { type: "money.payee_added", accountId: "acct_9", payeeId: "b1", at: NOW - 80 * DAY });
    f = applyEvent(f, { type: "money.withdrawal_completed", accountId: "acct_9", amountCents: 100000, at: NOW - 70 * DAY });
    f = applyEvent(f, { type: "money.withdrawal_completed", accountId: "acct_9", amountCents: 200000, at: NOW - 60 * DAY });
    f = applyEvent(f, { type: "identity.login", accountId: "acct_9", deviceId: "d1", ok: false, at: NOW - 10 * 60 * 1000 });
    f = applyEvent(f, { type: "identity.login", accountId: "acct_9", deviceId: "d1", ok: false, at: NOW - 5 * 60 * 1000 });
    expect(f.knownDeviceIds).toEqual(["d1"]);
    expect(f.payeeAddedAt.b1).toBe(NOW - 80 * DAY);
    expect(f.typicalWithdrawalCents).toBe(120000);
    expect(f.withdrawalCount).toBe(2);
    expect(f.failedLoginTimestamps).toHaveLength(2);
  });

  it("drops failed logins older than an hour and never mutates its input", () => {
    const base = emptyFeatures("a", 0);
    const f1 = applyEvent(base, { type: "identity.login", accountId: "a", deviceId: "d", ok: false, at: 0 });
    const f2 = applyEvent(f1, { type: "identity.login", accountId: "a", deviceId: "d", ok: false, at: 2 * 60 * 60 * 1000 });
    expect(f2.failedLoginTimestamps).toEqual([2 * 60 * 60 * 1000]);
    expect(base.failedLoginTimestamps).toEqual([]);
    expect(f1.failedLoginTimestamps).toEqual([0]);
  });
});
