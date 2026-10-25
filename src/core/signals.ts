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

  const payeeAddedAt = req.payeeId ? features.payeeAddedAt[req.payeeId] : undefined;
  const payeeAgeDays = payeeAddedAt === undefined ? null : (now - payeeAddedAt) / DAY;

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
    newDevice: deviceKnown === false,
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
