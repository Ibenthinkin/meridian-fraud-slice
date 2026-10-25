import type { DecisionRequest } from "./types.js";

/**
 * What a stored idempotency record is compared against. Same key with a
 * different fingerprint is a client bug and gets a 409, not a replay.
 *
 * Every field except the key goes in, so a field added to DecisionRequest is
 * covered without anyone remembering to list it here. Leaving one out would
 * let a caller replay an earlier "allow" for a request the rules would judge
 * differently.
 */
export function requestFingerprint(req: DecisionRequest): string {
  const { idempotencyKey: _key, ...fields } = req;
  const present = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify(present);
}
