// Case worker. Decisions that need a person (hold, block) arrive here through
// an SQS queue fed by an EventBridge rule. It opens a case record. In a real
// firm this is where the case-management system or a vendor queue is called.

import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { Decision } from "../core/index.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const CASES_TABLE = process.env.CASES_TABLE!;

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: SQSBatchResponse["batchItemFailures"] = [];

  for (const record of event.Records) {
    try {
      const envelope = JSON.parse(record.body) as { detail: Decision; id: string };
      const d = envelope.detail;
      // Idempotent on decisionId: SQS is at-least-once, so the same decision can arrive twice.
      await ddb.send(
        new PutCommand({
          TableName: CASES_TABLE,
          Item: {
            caseId: `case_${d.decisionId}`,
            decisionId: d.decisionId,
            accountId: d.accountId,
            eventType: d.eventType,
            action: d.action,
            reasons: d.reasons,
            score: d.score,
            status: "open",
            openedAt: new Date().toISOString(),
            sourceEventId: envelope.id,
          },
          ConditionExpression: "attribute_not_exists(caseId)",
        })
      );
      console.log(JSON.stringify({ msg: "case opened", decisionId: d.decisionId, action: d.action }));
    } catch (err) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") continue; // duplicate delivery
      console.error(JSON.stringify({ msg: "case failed", messageId: record.messageId, error: String(err) }));
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  // Partial batch failure: only the failed messages go back on the queue.
  return { batchItemFailures: failures };
}
