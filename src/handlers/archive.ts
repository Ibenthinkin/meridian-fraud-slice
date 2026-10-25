// Archiver. Every event on the bus (domain events and decisions) lands in the
// data lake as one JSON object per event, partitioned by date. Training,
// audit, and replay all read from here. In production this is usually a
// Firehose delivery stream to S3 (batched, compressed, Parquet); a Lambda per
// event keeps the demo simple and free.

import type { EventBridgeEvent } from "aws-lambda";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const s3 = new S3Client({});
const BUCKET = process.env.LAKE_BUCKET!;

export async function handler(event: EventBridgeEvent<string, unknown>): Promise<void> {
  const t = new Date(event.time);
  const key = [
    "events",
    `year=${t.getUTCFullYear()}`,
    `month=${String(t.getUTCMonth() + 1).padStart(2, "0")}`,
    `day=${String(t.getUTCDate()).padStart(2, "0")}`,
    `${event["detail-type"].replace(/[^a-z0-9.]/gi, "_")}-${event.id}.json`,
  ].join("/");

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(event),
      ContentType: "application/json",
    })
  );
}
