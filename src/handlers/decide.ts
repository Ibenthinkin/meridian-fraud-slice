// POST /risk/decisions
// The synchronous decision endpoint. Money-movement and identity services call
// it before acting. Everything slow or non-essential happens after the
// response, through the decision event on the bus.

import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import {
  SIGNAL_FIELDS,
  decide,
  heuristicModel,
  requestFingerprint,
  validateRuleSet,
  type AccountFeatures,
  type Decision,
  type DecisionRequest,
  type EventType,
  type RuleSet,
} from "../core/index.js";
import ruleSetJson from "../core/rules.json" with { type: "json" };

export interface Clients {
  ddb: Pick<DynamoDBDocumentClient, "send">;
  bus: Pick<EventBridgeClient, "send">;
}

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

// Clients are passed in so tests can supply in-memory ones.
export function createHandler({ ddb, bus }: Clients) {
  async function loadFeatures(accountId: string): Promise<AccountFeatures | null> {
    const res = await ddb.send(new GetCommand({ TableName: FEATURES_TABLE, Key: { accountId } }));
    return (res.Item as AccountFeatures | undefined) ?? null;
  }

  // Case management, the data lake, and notifications react to this event. A
  // decision the bus never accepted is a hold nobody reviews, so a partial
  // failure is a failure.
  async function publish(decision: Decision, idempotencyKey: string): Promise<void> {
    const res = await bus.send(
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
    if (res.FailedEntryCount) {
      throw new Error(`PutEvents rejected the decision event: ${res.Entries?.[0]?.ErrorCode ?? "unknown error"}`);
    }
    await ddb.send(
      new UpdateCommand({
        TableName: IDEMPOTENCY_TABLE,
        Key: { idempotencyKey },
        UpdateExpression: "SET published = :true",
        ExpressionAttributeValues: { ":true": true },
      })
    );
  }

  // Every path that answers from a stored record goes through here: the
  // straight replay and the race loser. Both must reject a different request
  // and both must finish a publish the first attempt didn't.
  async function replay(item: Record<string, unknown>, req: DecisionRequest, requestId: string): Promise<APIGatewayProxyResultV2> {
    if (item.requestHash !== requestFingerprint(req)) {
      return json(409, { error: "idempotency key reused with a different request", requestId });
    }
    // The first attempt decided but never got the event onto the bus (it threw
    // after claiming the key). Publish now; cases are keyed on decisionId, so
    // a duplicate can't open a second one.
    if (item.published !== true && item.decision) {
      await publish(item.decision as Decision, req.idempotencyKey);
    }
    return json(200, { ...(item.response as object), replayed: true });
  }

  return async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const requestId = event.requestContext.requestId;
    const parsed = parseRequest(event.body);
    if ("error" in parsed) return json(400, { error: parsed.error, requestId });
    const req = parsed.value;

    // 1. Idempotency: the same key returns the same decision, never a second one.
    const prior = await ddb.send(new GetCommand({ TableName: IDEMPOTENCY_TABLE, Key: { idempotencyKey: req.idempotencyKey } }));
    if (prior.Item) return replay(prior.Item, req, requestId);

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
            requestHash: requestFingerprint(req),
            response,
            decision,
            published: false,
            expiresAt: Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS,
          },
          ConditionExpression: "attribute_not_exists(idempotencyKey)",
        })
      );
    } catch (err) {
      // Lost a race with a concurrent request carrying the same key: return the winner's answer.
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
        const winner = await ddb.send(new GetCommand({ TableName: IDEMPOTENCY_TABLE, Key: { idempotencyKey: req.idempotencyKey } }));
        if (winner.Item) return replay(winner.Item, req, requestId);
      }
      throw err;
    }

    // 4. Tell everyone else. If this throws, the client retries with the same
    //    key and the replay path above publishes.
    await publish(decision, req.idempotencyKey);

    console.log(JSON.stringify({ msg: "decision", requestId, decisionId: decision.decisionId, eventType: req.eventType, action: decision.action, reasons: decision.reasons, degraded: decision.degraded ?? null }));
    return json(200, response);
  };
}

// Clients at module scope so warm invocations reuse connections.
export const handler = createHandler({
  ddb: DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }),
  bus: new EventBridgeClient({}),
});

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

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
