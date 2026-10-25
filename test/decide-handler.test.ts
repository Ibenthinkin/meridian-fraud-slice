import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { PutEventsCommand, PutEventsCommandOutput } from "@aws-sdk/client-eventbridge";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The handler reads its table names at module load, so set them before importing it.
const TABLES = { FEATURES_TABLE: "features", DECISIONS_TABLE: "decisions", IDEMPOTENCY_TABLE: "idempotency" };
for (const [k, v] of Object.entries(TABLES)) vi.stubEnv(k, v);
vi.stubEnv("EVENT_BUS_NAME", "bus");

const KEY_ATTR: Record<string, string> = { features: "accountId", decisions: "decisionId", idempotency: "idempotencyKey" };

/** In-memory DynamoDB: just the Get, conditional Put, and SET-only Update the handler uses. */
class FakeDynamo {
  readonly tables = new Map<string, Map<string, Record<string, unknown>>>();

  private table(name: string) {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name)!;
  }

  async send(cmd: unknown): Promise<unknown> {
    if (cmd instanceof GetCommand) {
      const { TableName, Key } = cmd.input;
      return { Item: this.table(TableName!).get(String(Key![KEY_ATTR[TableName!]])) };
    }
    if (cmd instanceof PutCommand) {
      const { TableName, Item, ConditionExpression } = cmd.input;
      const key = String(Item![KEY_ATTR[TableName!]]);
      if (ConditionExpression?.startsWith("attribute_not_exists") && this.table(TableName!).has(key)) {
        throw Object.assign(new Error("conditional check failed"), { name: "ConditionalCheckFailedException" });
      }
      this.table(TableName!).set(key, structuredClone(Item!));
      return {};
    }
    if (cmd instanceof UpdateCommand) {
      const { TableName, Key, UpdateExpression, ExpressionAttributeValues } = cmd.input;
      const item = this.table(TableName!).get(String(Key![KEY_ATTR[TableName!]]));
      if (!item) throw new Error("update of a missing item");
      for (const [, attr, placeholder] of UpdateExpression!.matchAll(/(\w+) = (:\w+)/g)) item[attr] = ExpressionAttributeValues![placeholder];
      return {};
    }
    throw new Error(`FakeDynamo: unsupported command ${(cmd as object).constructor.name}`);
  }
}

type Outcome = "ok" | "throw" | "partial";

/** EventBridge that records what was actually accepted onto the bus. */
class FakeBus {
  readonly accepted: Array<{ action: string; decisionId: string }> = [];
  outcomes: Outcome[] = [];

  async send(cmd: PutEventsCommand): Promise<Partial<PutEventsCommandOutput>> {
    const outcome = this.outcomes.shift() ?? "ok";
    if (outcome === "throw") throw new Error("EventBridge unavailable");
    if (outcome === "partial") return { FailedEntryCount: 1, Entries: [{ ErrorCode: "InternalFailure", ErrorMessage: "try again" }] };
    for (const e of cmd.input.Entries!) this.accepted.push(JSON.parse(e.Detail!));
    return { FailedEntryCount: 0, Entries: [{ EventId: "evt_1" }] };
  }
}

// An account the feature store has never seen: the degraded policy holds a withdrawal.
const HOLD_BODY = JSON.stringify({ eventType: "withdrawal", idempotencyKey: "idem_1", accountId: "acct_unknown", amountCents: 2400000, payeeId: "bank_new", deviceId: "dev_new" });

function apiEvent(body: string, requestId = "req_1"): APIGatewayProxyEventV2 {
  return { body, requestContext: { requestId } } as unknown as APIGatewayProxyEventV2;
}

let createHandler: typeof import("../src/handlers/decide.js").createHandler;
let ddb: FakeDynamo;
let bus: FakeBus;
let handler: ReturnType<typeof createHandler>;

beforeAll(async () => {
  ({ createHandler } = await import("../src/handlers/decide.js"));
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  ddb = new FakeDynamo();
  bus = new FakeBus();
  handler = createHandler({ ddb, bus });
});

async function call(body = HOLD_BODY, requestId?: string) {
  return (await handler(apiEvent(body, requestId))) as APIGatewayProxyStructuredResultV2;
}

describe("decide handler: every decision reaches the bus", () => {
  it("publishes a hold so case management can open a case", async () => {
    const res = await call();
    expect(JSON.parse(res.body!).action).toBe("hold");
    expect(bus.accepted.map((d) => d.action)).toEqual(["hold"]);
  });

  it("fails the request when EventBridge accepts only part of the batch", async () => {
    bus.outcomes = ["partial"];
    await expect(call()).rejects.toThrow(/PutEvents/);
    expect(bus.accepted).toEqual([]);
  });

  it("publishes on the client's retry when the first publish failed", async () => {
    bus.outcomes = ["throw"];
    await expect(call()).rejects.toThrow("EventBridge unavailable");

    const retry = await call(HOLD_BODY, "req_2");
    const body = JSON.parse(retry.body!);
    expect(body).toMatchObject({ action: "hold", replayed: true });
    expect(bus.accepted).toEqual([expect.objectContaining({ action: "hold", decisionId: body.decisionId })]);
  });

  it("does not publish again on a replay once the decision is on the bus", async () => {
    await call();
    await call(HOLD_BODY, "req_2");
    expect(bus.accepted).toHaveLength(1);
  });
});
