// POST /risk/decisions
// The synchronous decision endpoint. Money-movement and identity services call
// it before acting. Everything slow or non-essential happens after the
// response, through the decision event on the bus.

import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import {
  SIGNAL_FIELDS,
  decide,
  heuristicModel,
  validateRuleSet,
  type AccountFeatures,
  type DecisionRequest,
  type EventType,
  type RuleSet,
} from "../core/index.js";
import ruleSetJson from "../core/rules.json" with { type: "json" };

// Clients at module scope so warm invocations reuse connections.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const bus = new EventBridgeClient({});

const FEATURES_TABLE = env("FEATURES_TABLE");
const DECISIONS_TABLE = env("DECISIONS_TABLE");
const IDEMPOTENCY_TABLE = env("IDEMPOTENCY_TABLE");
const EVENT_BUS_NAME = env("EVENT_BUS_NAME");
const FEATURE_TIMEOUT_MS = Number(process.env.FEATURE_TIMEOUT_MS ?? "150");
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

// Validate the bundled rules once, at cold start. A bad rule set fails the
// function here, before it can make a single decision.
const ruleSet = ruleSetJson as RuleSet;
validateRuleSet(ruleSet, SIGNAL_FIELDS);

const EVENT_TYPES: EventType[] = ["login", "contact_change", "payee_add", "withdrawal", "transfer"];

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const requestId = event.requestContext.requestId;
  const parsed = parseRequest(event.body);
  if ("error" in parsed) return json(400, { error: parsed.error, requestId });
  const req = parsed.value;

  // 1. Idempotency: the same key returns the same decision, never a second one.
  const prior = await ddb.send(new GetCommand({ TableName: IDEMPOTENCY_TABLE, Key: { idempotencyKey: req.idempotencyKey } }));
  if (prior.Item) {
    if (prior.Item.requestHash !== requestHash(req)) {
      return json(409, { error: "idempotency key reused with a different request", requestId });
    }
    return json(200, { ...prior.Item.response, replayed: true });
  }

  // 2. Decide.
  const decision = await decide(req, {
    loadFeatures,
    model: heuristicModel,
    ruleSet,
    now: () => Date.now(),
    newId: () => `dec_${randomUUID()}`,
    featureTimeoutMs: FEATURE_TIMEOUT_MS,
  });

  const response = {
    decisionId: decision.decisionId,
    action: decision.action,
    reasons: decision.reasons,
    score: decision.score,
    ruleSetVersion: decision.ruleSetVersion,
    modelVersion: decision.modelVersion,
    ...(decision.degraded ? { degraded: true } : {}),
  };

  // 3. Record the decision (append-only audit trail), then claim the key.
  await ddb.send(new PutCommand({ TableName: DECISIONS_TABLE, Item: { ...decision, requestId } }));
  try {
    await ddb.send(
      new PutCommand({
        TableName: IDEMPOTENCY_TABLE,
        Item: {
          idempotencyKey: req.idempotencyKey,
          requestHash: requestHash(req),
          response,
          expiresAt: Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS,
        },
        ConditionExpression: "attribute_not_exists(idempotencyKey)",
      })
    );
  } catch (err) {
    // Lost a race with a concurrent request carrying the same key: return the winner's answer.
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      const winner = await ddb.send(new GetCommand({ TableName: IDEMPOTENCY_TABLE, Key: { idempotencyKey: req.idempotencyKey } }));
      if (winner.Item) return json(200, { ...winner.Item.response, replayed: true });
    }
    throw err;
  }

  // 4. Tell everyone else. Case management, the data lake, and notifications
  //    react to this event; none of them are on the client's critical path.
  await bus.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: EVENT_BUS_NAME,
          Source: "fraud.decisions",
          DetailType: "fraud.decision",
          Detail: JSON.stringify(decision),
        },
      ],
    })
  );

  console.log(JSON.stringify({ msg: "decision", requestId, decisionId: decision.decisionId, eventType: req.eventType, action: decision.action, reasons: decision.reasons, degraded: decision.degraded ?? null }));
  return json(200, response);
}

async function loadFeatures(accountId: string): Promise<AccountFeatures | null> {
  const res = await ddb.send(new GetCommand({ TableName: FEATURES_TABLE, Key: { accountId } }));
  return (res.Item as AccountFeatures | undefined) ?? null;
}

function parseRequest(body: string | undefined): { value: DecisionRequest } | { error: string } {
  if (!body) return { error: "missing body" };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(body);
  } catch {
    return { error: "body is not valid JSON" };
  }
  const problems: string[] = [];
  if (!EVENT_TYPES.includes(raw.eventType as EventType)) problems.push(`eventType must be one of ${EVENT_TYPES.join(", ")}`);
  if (typeof raw.idempotencyKey !== "string" || !raw.idempotencyKey) problems.push("idempotencyKey is required");
  if (typeof raw.accountId !== "string" || !raw.accountId) problems.push("accountId is required");
  if (raw.amountCents !== undefined && !(Number.isInteger(raw.amountCents) && (raw.amountCents as number) >= 0)) problems.push("amountCents must be a non-negative integer");
  for (const k of ["payeeId", "deviceId", "ipCountry", "sessionId"]) {
    if (raw[k] !== undefined && typeof raw[k] !== "string") problems.push(`${k} must be a string`);
  }
  if (problems.length) return { error: problems.join("; ") };
  return {
    value: {
      eventType: raw.eventType as EventType,
      idempotencyKey: raw.idempotencyKey as string,
      accountId: raw.accountId as string,
      amountCents: raw.amountCents as number | undefined,
      payeeId: raw.payeeId as string | undefined,
      deviceId: raw.deviceId as string | undefined,
      ipCountry: raw.ipCountry as string | undefined,
      sessionId: raw.sessionId as string | undefined,
    },
  };
}

function requestHash(req: DecisionRequest): string {
  return JSON.stringify([req.eventType, req.accountId, req.amountCents ?? null, req.payeeId ?? null, req.deviceId ?? null]);
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
