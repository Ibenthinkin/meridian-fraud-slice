import { deriveSignals } from "./signals.js";
import { escalate, evaluateRules, mostSevere } from "./rules.js";
import { actionForScore, type RiskModel } from "./model.js";
import type { AccountFeatures, Decision, DecisionRequest, EventType, RuleSet } from "./types.js";

/**
 * Ports the decision logic depends on. The Lambda handler wires these to
 * DynamoDB and SageMaker; tests wire them to in-memory fakes.
 */
export interface DecisionDeps {
  loadFeatures(accountId: string): Promise<AccountFeatures | null>;
  model: RiskModel;
  ruleSet: RuleSet;
  now(): number;
  newId(): string;
  /** How long to wait for the feature store before deciding without it. */
  featureTimeoutMs: number;
}

/**
 * What to do when we can't evaluate properly. Decided per event type, ahead of
 * time, not during the outage. Cheap, reversible actions fail open; money
 * leaving the building fails into a hold.
 */
export const DEGRADED_POLICY: Record<EventType, "allow" | "step_up" | "hold"> = {
  login: "step_up",
  contact_change: "step_up",
  payee_add: "step_up",
  transfer: "hold",
  withdrawal: "hold",
};

export async function decide(req: DecisionRequest, deps: DecisionDeps): Promise<Decision> {
  const now = deps.now();
  const decisionId = deps.newId();

  // 1. Features, with a timeout. A slow feature store must not stall the client.
  let features: AccountFeatures | null = null;
  let degraded: string | undefined;
  try {
    features = await withTimeout(deps.loadFeatures(req.accountId), deps.featureTimeoutMs);
  } catch (err) {
    degraded = `features_unavailable:${(err as Error).message}`;
  }

  // 2. Signals the rules and model both read.
  const signals = deriveSignals(req, features, now);

  // 3. Rules: explainable, fast to change, encode policy.
  const hits = evaluateRules(deps.ruleSet, signals);
  const ruleAction = mostSevere(hits);

  // 4. Model: catches combinations nobody wrote a rule for. Its score becomes
  //    one more input; if it fails, rules alone decide.
  let score = 0;
  let modelAction: Decision["action"] = "allow";
  try {
    score = await withTimeout(deps.model.score(signals), deps.featureTimeoutMs);
    modelAction = actionForScore(req.eventType, score);
  } catch (err) {
    degraded = (degraded ? degraded + ";" : "") + `model_unavailable:${(err as Error).message}`;
  }

  // 5. Combine. If history was missing, apply the degraded policy as a floor.
  let action = escalate(ruleAction, modelAction);
  if (signals.featuresMissing) action = escalate(action, DEGRADED_POLICY[req.eventType]);

  const reasons = hits.filter((h) => !h.shadow).map((h) => h.id);
  if (modelAction !== "allow") reasons.push(`MODEL_SCORE_${modelAction.toUpperCase()}`);
  if (signals.featuresMissing) reasons.push("HISTORY_UNAVAILABLE");

  return {
    decisionId,
    accountId: req.accountId,
    eventType: req.eventType,
    action,
    reasons,
    shadowHits: hits.filter((h) => h.shadow).map((h) => h.id),
    score,
    ruleSetVersion: deps.ruleSet.version,
    modelVersion: deps.model.version,
    signals,
    decidedAt: new Date(now).toISOString(),
    ...(degraded ? { degraded } : {}),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}
