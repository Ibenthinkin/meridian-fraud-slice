// Walks the classic account-takeover sequence against the deployed API and
// shows how the decision changes as the attacker's trail builds up.
//
//   npm run demo

import { randomUUID } from "node:crypto";
import { decideViaApi, loadOutputs, publish, sleep, type ApiResult } from "./shared.js";

const { ApiUrl, EventBusName } = loadOutputs();
const acct = "acct_dana";
const key = () => `demo_${randomUUID()}`;

function show(title: string, r: ApiResult) {
  const tag = String(r.action ?? (r.status >= 400 ? r.status : r.error)).toUpperCase().padEnd(8);
  console.log(`${tag} ${title}`);
  if (Array.isArray(r.reasons) && r.reasons.length) console.log(`         reasons: ${r.reasons.join(", ")}`);
  if (typeof r.score === "number") console.log(`         score: ${r.score}  rules: ${r.ruleSetVersion}  model: ${r.modelVersion}${r.degraded ? "  (degraded)" : ""}${r.replayed ? "  (replayed)" : ""}`);
  console.log();
}

console.log(`Decision API: ${ApiUrl}\n`);

// 0. Baseline: Dana's normal quarterly withdrawal from her laptop.
show("Dana withdraws $1,950 to her usual bank from her laptop",
  await decideViaApi(ApiUrl, { eventType: "withdrawal", idempotencyKey: key(), accountId: acct, amountCents: 195000, payeeId: "bank_dana_checking", deviceId: "dev_dana_laptop" }));

// 1. An attacker with her password logs in from a device she's never used.
show("Login from a brand-new device",
  await decideViaApi(ApiUrl, { eventType: "login", idempotencyKey: key(), accountId: acct, deviceId: "dev_attacker" }));

// Suppose the attacker also had her SMS code (SIM swap) and the step-up passed.
// Identity publishes the successful login; the device becomes "known".
await publish(EventBusName, [{ type: "identity.login", accountId: acct, deviceId: "dev_attacker", ok: true, at: Date.now() }]);

// 2. They change her email so alerts go to them, then add their own bank account.
show("Change contact info from the new device",
  await decideViaApi(ApiUrl, { eventType: "contact_change", idempotencyKey: key(), accountId: acct, deviceId: "dev_attacker" }));
await publish(EventBusName, [{ type: "servicing.contact_changed", accountId: acct, at: Date.now() }]);

show("Add a new linked bank account",
  await decideViaApi(ApiUrl, { eventType: "payee_add", idempotencyKey: key(), accountId: acct, payeeId: "bank_mule", deviceId: "dev_attacker" }));
await publish(EventBusName, [{ type: "money.payee_added", accountId: acct, payeeId: "bank_mule", at: Date.now() }]);
await sleep(2500); // let the ingester catch up

// 3. The cash-out. Each step so far could pass alone; together they can't.
const cashout = { eventType: "withdrawal", accountId: acct, amountCents: 2400000, payeeId: "bank_mule", deviceId: "dev_attacker" };
const k = key();
show("Withdraw $24,000 to the bank account added minutes ago",
  await decideViaApi(ApiUrl, { ...cashout, idempotencyKey: k }));

// 4. The attacker's browser retries. Same key, same answer, no second case.
show("Same request retried with the same idempotency key",
  await decideViaApi(ApiUrl, { ...cashout, idempotencyKey: k }));

// 5. Same key, different amount: a client bug or something worse. Rejected.
show("Same idempotency key, different amount",
  await decideViaApi(ApiUrl, { ...cashout, amountCents: 100, idempotencyKey: k }));

// 6. Meanwhile Dana herself, on her phone, makes her normal withdrawal. The
//    recent contact change still earns her a step-up, nothing worse.
show("Dana's own normal withdrawal from her phone, after all that",
  await decideViaApi(ApiUrl, { eventType: "withdrawal", idempotencyKey: key(), accountId: acct, amountCents: 195000, payeeId: "bank_dana_checking", deviceId: "dev_dana_phone" }));

// 7. A client with no history at all: the degraded policy applies.
show("Withdrawal for an account the feature store has never seen",
  await decideViaApi(ApiUrl, { eventType: "withdrawal", idempotencyKey: key(), accountId: "acct_unknown", amountCents: 50000, payeeId: "bank_x", deviceId: "dev_x" }));

console.log("Held decisions became cases. Check the Cases table and the lake bucket in the console, or:");
console.log("  aws dynamodb scan --table-name $(node -e \"console.log(Object.values(require('./cdk-outputs.json'))[0].CasesTableName)\") --max-items 5");
