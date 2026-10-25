// Feature ingester. Subscribed to domain events on the bus (logins, contact
// changes, payees added, withdrawals completed) and folds each one into the
// account's feature record. This is the "learning path": it runs after the
// fact, never while a client waits.

import type { EventBridgeEvent } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { applyEvent, emptyFeatures, type AccountFeatures, type DomainEvent } from "../core/index.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const FEATURES_TABLE = process.env.FEATURES_TABLE!;
const MAX_ATTEMPTS = 3;

export async function handler(event: EventBridgeEvent<string, DomainEvent>): Promise<void> {
  const e = event.detail;
  if (!e || typeof e.accountId !== "string") {
    console.warn(JSON.stringify({ msg: "ignored malformed event", id: event.id }));
    return;
  }

  // Optimistic concurrency: read, apply, write only if nobody else wrote in
  // between. Two events for the same account arriving together can't clobber
  // each other's update.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const current = await ddb.send(new GetCommand({ TableName: FEATURES_TABLE, Key: { accountId: e.accountId } }));
    const before = (current.Item as (AccountFeatures & { version?: number }) | undefined) ?? { ...emptyFeatures(e.accountId, e.at), version: 0 };
    const version = before.version ?? 0;
    const after = { ...applyEvent(before, e), version: version + 1 };
    try {
      await ddb.send(
        new PutCommand({
          TableName: FEATURES_TABLE,
          Item: after,
          ConditionExpression: current.Item ? "version = :v" : "attribute_not_exists(accountId)",
          ExpressionAttributeValues: current.Item ? { ":v": version } : undefined,
        })
      );
      return;
    } catch (err) {
      if ((err as { name?: string }).name !== "ConditionalCheckFailedException" || attempt === MAX_ATTEMPTS) throw err;
    }
  }
}
