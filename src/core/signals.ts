import type { AccountFeatures, DecisionRequest, Signals } from "./types.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Turn a request plus the account's stored history into the flat signals the
 * rules and model read. Pure function: same inputs, same output.
 */
export function deriveSignals(
  req: DecisionRequest,
  features: AccountFeatures | null,
  now: number
): Signals {
  const amountCents = req.amountCents ?? 0;
  const ipCountry = req.ipCountry ?? null;

  if (!features) {
    return {
      eventType: req.eventType,
      amountCents,
      newDevice: false,
      deviceKnown: "unknown",
      failedLoginsLastHour: 0,
      payeeAgeDays: null,
      contactChangedDays: null,
      amountVsTypical: null,
      accountAgeDays: null,
      ipCountry,
      featuresMissing: true,
    };
  }

  const deviceKnown = req.deviceId
    ? features.knownDeviceIds.includes(req.deviceId)
    : "unknown";

  const failedLoginsLastHour = features.failedLoginTimestamps.filter(
    (t) => now - t <= HOUR
  ).length;

  // Money going to a payee with no history (or to no named payee) is treated as
  // going to one added just now. Left as null, the age rules would skip it and
  // an unknown payee would look safer than one added yesterday.
  const movesMoney = req.eventType === "withdrawal" || req.eventType === "transfer";
  // Own keys only: payeeId comes from the caller, and on a plain object a name
  // like "constructor" would otherwise resolve to Object.prototype and give NaN.
  const stored =
    req.payeeId && Object.hasOwn(features.payeeAddedAt, req.payeeId) ? features.payeeAddedAt[req.payeeId] : undefined;
  const payeeAddedAt = typeof stored === "number" && Number.isFinite(stored) ? stored : undefined;
  const payeeAgeDays =
    payeeAddedAt !== undefined ? (now - payeeAddedAt) / DAY : movesMoney ? 0 : null;

  const contactChangedDays =
    features.contactChangedAt === undefined ? null : (now - features.contactChangedAt) / DAY;

  const amountVsTypical =
    features.typicalWithdrawalCents && features.typicalWithdrawalCents > 0 && amountCents > 0
      ? amountCents / features.typicalWithdrawalCents
      : null;

  const accountAgeDays =
    features.accountOpenedAt === undefined ? null : (now - features.accountOpenedAt) / DAY;

  return {
    eventType: req.eventType,
    amountCents,
    // A request that doesn't say which device it came from gets the same
    // scrutiny as one from a device we've never seen.
    newDevice: deviceKnown !== true,
    deviceKnown,
    failedLoginsLastHour,
    payeeAgeDays,
    contactChangedDays,
    amountVsTypical,
    accountAgeDays,
    ipCountry,
    featuresMissing: false,
  };
}
