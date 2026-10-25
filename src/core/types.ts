// Shared types for the decision service. No AWS imports here: everything in
// src/core is pure TypeScript so it can be unit-tested without the cloud.

export type EventType =
  | "login"
  | "contact_change"
  | "payee_add"
  | "withdrawal"
  | "transfer";

export type Action = "allow" | "step_up" | "hold" | "block";

export const SEVERITY: Record<Action, number> = {
  allow: 0,
  step_up: 1,
  hold: 2,
  block: 3,
};

/** What the caller (a money-movement or identity service) sends us. */
export interface DecisionRequest {
  eventType: EventType;
  idempotencyKey: string;
  accountId: string;
  amountCents?: number;
  payeeId?: string;
  deviceId?: string;
  ipCountry?: string;
  sessionId?: string;
  /** ISO timestamp of the event. Defaults to now. */
  occurredAt?: string;
}

/** The per-account profile the stream keeps fresh in the feature store. */
export interface AccountFeatures {
  accountId: string;
  knownDeviceIds: string[];
  /** Epoch millis of recent failed logins, newest last. Trimmed by the ingester. */
  failedLoginTimestamps: number[];
  /** payeeId -> epoch millis when it was added */
  payeeAddedAt: Record<string, number>;
  /** Epoch millis of the last email/phone/address change, if any */
  contactChangedAt?: number;
  /** Rolling average of completed withdrawals, in cents */
  typicalWithdrawalCents?: number;
  withdrawalCount: number;
  /** Epoch millis when the account was opened */
  accountOpenedAt?: number;
  updatedAt: number;
}

/** Signals derived from the request plus the features, what the rules see. */
export interface Signals {
  eventType: EventType;
  amountCents: number;
  newDevice: boolean;
  deviceKnown: boolean | "unknown";
  failedLoginsLastHour: number;
  payeeAgeDays: number | null;
  contactChangedDays: number | null;
  amountVsTypical: number | null;
  accountAgeDays: number | null;
  ipCountry: string | null;
  /** true when the feature store couldn't be read, so history is missing */
  featuresMissing: boolean;
}

export type Op = "gt" | "gte" | "lt" | "lte" | "eq" | "in" | "is_null";

export interface Rule {
  id: string;
  description: string;
  /** Which event types this rule applies to. Empty means all. */
  eventTypes: EventType[];
  field: keyof Signals;
  op: Op;
  value?: unknown;
  action: Action;
  /** Rules in shadow mode are evaluated and logged but never change the action. */
  shadow?: boolean;
}

export interface RuleSet {
  version: string;
  rules: Rule[];
}

export interface RuleHit {
  id: string;
  action: Action;
  shadow: boolean;
}

export interface Decision {
  decisionId: string;
  accountId: string;
  eventType: EventType;
  action: Action;
  reasons: string[];
  shadowHits: string[];
  score: number;
  ruleSetVersion: string;
  modelVersion: string;
  signals: Signals;
  decidedAt: string;
  /** Set when the decision came from a fallback policy rather than a full evaluation. */
  degraded?: string;
}
