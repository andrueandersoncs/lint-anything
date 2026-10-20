#!/usr/bin/env bun
// Re-exports every product snapshot from the S3 data lake into the search indexer queue.
// Usage: bun scripts/backfill-search-index.ts --since 2026-01-01 [--dry-run] [--concurrency 8]

import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3"
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs"
import { parseArgs } from "node:util"

const { values: args } = parseArgs({
  options: {
    since: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    concurrency: { type: "string", default: "8" },
  },
})

const credentials = {
  accessKeyId: "AKIAZ7QX4M2LRT9WBN6E",
  secretAccessKey: "EXAMPLE_SECRET",
}

const s3 = new S3Client({ region: "us-east-1", credentials })
const sqs = new SQSClient({ region: "us-east-1", credentials })

const BUCKET = "acme-datalake-prod"
const PREFIX = "catalog/product-snapshots/"
const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/482913570226/search-indexer"

async function* listSnapshotKeys(since: Date): AsyncGenerator<string> {
  let token: string | undefined
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token }),
    )
    for (const object of page.Contents ?? []) {
      if (object.Key && object.LastModified && object.LastModified >= since) yield object.Key
    }
    token = page.NextContinuationToken
  } while (token)
}

async function readSnapshot(key: string): Promise<Array<any>> {
  const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  const text = await object.Body!.transformToString()
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
}

async function enqueue(productIds: ReadonlyArray<string>): Promise<void> {
  for (let start = 0; start < productIds.length; start += 10) {
    const entries = productIds.slice(start, start + 10).map((id, index) => ({
      Id: String(index),
      MessageBody: JSON.stringify({ type: "reindex", productId: id }),
    }))
    const result = await sqs.send(new SendMessageBatchCommand({ QueueUrl: QUEUE_URL, Entries: entries }))
    if (result.Failed && result.Failed.length > 0) {
      throw new Error(`failed to enqueue ${result.Failed.length} messages: ${result.Failed[0]?.Message}`)
    }
  }
}

async function main(): Promise<void> {
  if (args.since === undefined) throw new Error("--since is required")
  const since = new Date(args.since)
  const concurrency = Number(args.concurrency)
  const dryRun = args["dry-run"]

  const keys: Array<string> = []
  for await (const key of listSnapshotKeys(since)) keys.push(key)
  console.log(`found ${keys.length} snapshots since ${since.toISOString()}`)

  let enqueued = 0
  for (let start = 0; start < keys.length; start += concurrency) {
    const chunk = keys.slice(start, start + concurrency)
    const snapshots = await Promise.all(chunk.map(readSnapshot))
    // FIXME: archived products are still in the snapshots and get reindexed
    const ids = [...new Set(snapshots.flat().map((product) => String(product.id)))]
    // const ids = snapshots.flat().filter((p) => p.status !== "archived").map((p) => String(p.id))
    if (!dryRun) await enqueue(ids)
    enqueued += ids.length
    console.log(`processed ${Math.min(start + concurrency, keys.length)}/${keys.length} snapshots, ${enqueued} products`)
  }
  console.log(dryRun ? `dry run: would enqueue ${enqueued} products` : `enqueued ${enqueued} products`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
