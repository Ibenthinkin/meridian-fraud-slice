import { SEVERITY } from "./types.js";
import type { Action, Op, Rule, RuleHit, RuleSet, Signals } from "./types.js";

type Comparator = (actual: unknown, expected: unknown) => boolean;

const OPS: Record<Op, Comparator> = {
  gt: (a, b) => typeof a === "number" && typeof b === "number" && a > b,
  gte: (a, b) => typeof a === "number" && typeof b === "number" && a >= b,
  lt: (a, b) => typeof a === "number" && typeof b === "number" && a < b,
  lte: (a, b) => typeof a === "number" && typeof b === "number" && a <= b,
  eq: (a, b) => a === b,
  in: (a, b) => Array.isArray(b) && b.includes(a),
  is_null: (a) => a === null || a === undefined,
};

/**
 * Validate a rule set on load, so a typo fails at deploy time instead of at
 * decision time. Throws with every problem listed, not just the first.
 */
export function validateRuleSet(rs: RuleSet, knownFields: readonly string[]): void {
  const problems: string[] = [];
  if (!rs.version) problems.push("rule set has no version");
  const ids = new Set<string>();
  for (const r of rs.rules) {
    if (ids.has(r.id)) problems.push(`duplicate rule id ${r.id}`);
    ids.add(r.id);
    if (!(r.op in OPS)) problems.push(`${r.id}: unknown op ${String(r.op)}`);
    if (!knownFields.includes(r.field)) problems.push(`${r.id}: unknown field ${String(r.field)}`);
    if (!(r.action in SEVERITY)) problems.push(`${r.id}: unknown action ${String(r.action)}`);
    if (r.op === "in" && !Array.isArray(r.value)) problems.push(`${r.id}: 'in' needs an array value`);
    if (["gt", "gte", "lt", "lte"].includes(r.op) && typeof r.value !== "number") {
      problems.push(`${r.id}: ${r.op} needs a numeric value`);
    }
  }
  if (problems.length) throw new Error(`Invalid rule set: ${problems.join("; ")}`);
}

/** Evaluate every applicable rule. Returns hits in rule order. */
export function evaluateRules(rs: RuleSet, signals: Signals): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const rule of rs.rules) {
    if (rule.eventTypes.length && !rule.eventTypes.includes(signals.eventType)) continue;
    const actual = signals[rule.field];
    if (OPS[rule.op](actual, rule.value)) {
      hits.push({ id: rule.id, action: rule.action, shadow: rule.shadow === true });
    }
  }
  return hits;
}

/** The most severe action among live (non-shadow) hits, or "allow". */
export function mostSevere(hits: RuleHit[]): Action {
  let action: Action = "allow";
  for (const h of hits) {
    if (!h.shadow && SEVERITY[h.action] > SEVERITY[action]) action = h.action;
  }
  return action;
}

export function escalate(a: Action, b: Action): Action {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/** Exported so validateRuleSet can check field names against the Signals shape. */
export const SIGNAL_FIELDS = [
  "eventType",
  "amountCents",
  "newDevice",
  "deviceKnown",
  "failedLoginsLastHour",
  "payeeAgeDays",
  "contactChangedDays",
  "amountVsTypical",
  "accountAgeDays",
  "ipCountry",
  "featuresMissing",
] as const satisfies readonly (keyof Signals)[];

export type { Rule, RuleSet };
