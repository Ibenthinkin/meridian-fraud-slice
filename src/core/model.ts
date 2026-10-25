import type { Action, EventType, Signals } from "./types.js";

/**
 * A model is anything that turns signals into a 0..1 risk score. In this slice
 * it's a transparent heuristic. In production the same interface wraps a
 * SageMaker real-time endpoint (or an in-process model), so the decision code
 * doesn't change when the model does.
 */
export interface RiskModel {
  version: string;
  score(signals: Signals): Promise<number>;
}

/** Deterministic stand-in: adds up weighted evidence and squashes it to 0..1. */
export const heuristicModel: RiskModel = {
  version: "heuristic-v1",
  async score(s) {
    let evidence = 0;
    if (s.newDevice) evidence += 1.2;
    if (s.failedLoginsLastHour >= 3) evidence += 1.0;
    if (s.payeeAgeDays !== null && s.payeeAgeDays < 3) evidence += 1.5;
    if (s.contactChangedDays !== null && s.contactChangedDays < 7) evidence += 1.0;
    if (s.amountVsTypical !== null && s.amountVsTypical > 5) evidence += 1.2;
    if (s.accountAgeDays !== null && s.accountAgeDays < 30) evidence += 0.6;
    if (s.featuresMissing) evidence += 0.4;
    // Logistic squash, centered so "no evidence" scores low.
    return round(1 / (1 + Math.exp(-(evidence - 2.5))));
  },
};

/**
 * Score thresholds per event type. The same score means different things for
 * a login and a large withdrawal, so each action has its own cutoffs.
 * These are illustrative, tuned by eye for the demo.
 *
 * A model score can escalate as far as "hold", never "block". A block needs a
 * reason a person can state to the client and to an examiner, and that is
 * what rules are for. The model's job is to get a human to look.
 */
export const THRESHOLDS: Record<EventType, { step_up: number; hold: number }> = {
  login: { step_up: 0.45, hold: 2 }, // logins never hold; hold is for money
  contact_change: { step_up: 0.35, hold: 0.75 },
  payee_add: { step_up: 0.35, hold: 0.7 },
  transfer: { step_up: 0.3, hold: 0.55 },
  withdrawal: { step_up: 0.3, hold: 0.5 },
};

export function actionForScore(eventType: EventType, score: number): Action {
  const t = THRESHOLDS[eventType];
  if (score >= t.hold) return "hold";
  if (score >= t.step_up) return "step_up";
  return "allow";
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
