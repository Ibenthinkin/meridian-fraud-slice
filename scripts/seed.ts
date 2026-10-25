// Builds a believable history for a demo client, "Dana", by publishing the
// domain events her real activity would have produced over the last two
// years. The ingester turns them into her feature record.
//
//   npm run seed

import { DAY, loadOutputs, publish, sleep } from "./shared.js";
import type { DomainEvent } from "../src/core/index.js";

const { EventBusName } = loadOutputs();
const now = Date.now();
const acct = "acct_dana";

const history: DomainEvent[] = [
  { type: "account.opened", accountId: acct, at: now - 730 * DAY },
  { type: "identity.login", accountId: acct, deviceId: "dev_dana_laptop", ok: true, at: now - 700 * DAY },
  { type: "identity.login", accountId: acct, deviceId: "dev_dana_phone", ok: true, at: now - 600 * DAY },
  { type: "money.payee_added", accountId: acct, payeeId: "bank_dana_checking", at: now - 650 * DAY },
  // A modest quarterly withdrawal, like a retiree drawing income.
  ...[540, 450, 360, 270, 180, 90].map<DomainEvent>((d) => ({
    type: "money.withdrawal_completed",
    accountId: acct,
    amountCents: 180000 + Math.round(Math.random() * 20000),
    at: now - d * DAY,
  })),
];

console.log(`Publishing ${history.length} events for ${acct} to ${EventBusName}...`);
await publish(EventBusName, history);
await sleep(3000);
console.log("Done. Her profile: two known devices, one old bank account, ~$1,900 typical withdrawal.");
console.log("Now run: npm run demo");
