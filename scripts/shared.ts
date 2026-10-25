import { readFileSync } from "node:fs";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import type { DomainEvent } from "../src/core/index.js";

export interface Outputs {
  ApiUrl: string;
  EventBusName: string;
  FeaturesTableName: string;
  DecisionsTableName: string;
  CasesTableName: string;
  LakeBucketName: string;
}

/** Reads the outputs file `npm run deploy` writes. */
export function loadOutputs(): Outputs {
  let raw: Record<string, Outputs>;
  try {
    raw = JSON.parse(readFileSync("cdk-outputs.json", "utf8"));
  } catch {
    throw new Error("cdk-outputs.json not found. Run `npm run deploy` first.");
  }
  const stack = Object.values(raw)[0];
  if (!stack?.ApiUrl) throw new Error("cdk-outputs.json has no ApiUrl output.");
  return stack;
}

const bus = new EventBridgeClient({});

/** Publish domain events the way identity, servicing, and money-movement services would. */
export async function publish(busName: string, events: DomainEvent[]): Promise<void> {
  const sourceFor = (t: DomainEvent["type"]) => t.split(".")[0] === "account" ? "accounts" : t.split(".")[0];
  for (let i = 0; i < events.length; i += 10) {
    const batch = events.slice(i, i + 10);
    const res = await bus.send(
      new PutEventsCommand({
        Entries: batch.map((e) => ({ EventBusName: busName, Source: sourceFor(e.type), DetailType: e.type, Detail: JSON.stringify(e) })),
      })
    );
    if (res.FailedEntryCount) throw new Error(`EventBridge rejected ${res.FailedEntryCount} events`);
  }
}

export interface ApiResult {
  status: number;
  action?: string;
  reasons?: string[];
  score?: number;
  ruleSetVersion?: string;
  modelVersion?: string;
  degraded?: boolean;
  replayed?: boolean;
  error?: string;
}

export async function decideViaApi(apiUrl: string, body: Record<string, unknown>): Promise<ApiResult> {
  const res = await fetch(`${apiUrl}/risk/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Omit<ApiResult, "status">;
  return { status: res.status, ...json };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const DAY = 24 * 60 * 60 * 1000;
