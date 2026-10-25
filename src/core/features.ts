import type { AccountFeatures } from "./types.js";

/** Domain events other services publish to the bus. The ingester folds them into features. */
export type DomainEvent =
  | { type: "identity.login"; accountId: string; deviceId: string; ok: boolean; at: number }
  | { type: "servicing.contact_changed"; accountId: string; at: number }
  | { type: "money.payee_added"; accountId: string; payeeId: string; at: number }
  | { type: "money.withdrawal_completed"; accountId: string; amountCents: number; at: number }
  | { type: "account.opened"; accountId: string; at: number };

const HOUR = 60 * 60 * 1000;
const MAX_DEVICES = 20;

export function emptyFeatures(accountId: string, now: number): AccountFeatures {
  return {
    accountId,
    knownDeviceIds: [],
    failedLoginTimestamps: [],
    payeeAddedAt: {},
    withdrawalCount: 0,
    updatedAt: now,
  };
}

/**
 * Apply one event to the account's features. Pure, so it's easy to replay the
 * event history and rebuild the store (which is also how you backfill after a
 * bug in this function).
 */
export function applyEvent(f: AccountFeatures, e: DomainEvent): AccountFeatures {
  const next: AccountFeatures = {
    ...f,
    knownDeviceIds: [...f.knownDeviceIds],
    failedLoginTimestamps: [...f.failedLoginTimestamps],
    payeeAddedAt: { ...f.payeeAddedAt },
    updatedAt: Math.max(f.updatedAt, e.at),
  };

  switch (e.type) {
    case "identity.login":
      if (e.ok) {
        // A successful login makes the device "known". Only after the login
        // passed any step-up, which is why this event comes from identity, not the web app.
        if (!next.knownDeviceIds.includes(e.deviceId)) {
          next.knownDeviceIds.push(e.deviceId);
          if (next.knownDeviceIds.length > MAX_DEVICES) next.knownDeviceIds.shift();
        }
      } else {
        next.failedLoginTimestamps.push(e.at);
        // Keep only the last hour's worth, plus a hard cap.
        next.failedLoginTimestamps = next.failedLoginTimestamps
          .filter((t) => e.at - t <= HOUR)
          .slice(-50);
      }
      break;
    case "servicing.contact_changed":
      next.contactChangedAt = e.at;
      break;
    case "money.payee_added":
      next.payeeAddedAt[e.payeeId] = e.at;
      break;
    case "money.withdrawal_completed": {
      // Exponential moving average so one big withdrawal doesn't dominate.
      const prev = next.typicalWithdrawalCents;
      next.typicalWithdrawalCents =
        prev === undefined ? e.amountCents : Math.round(prev * 0.8 + e.amountCents * 0.2);
      next.withdrawalCount += 1;
      break;
    }
    case "account.opened":
      next.accountOpenedAt = e.at;
      break;
  }
  return next;
}
