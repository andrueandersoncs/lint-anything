import { Client } from "@elastic/elasticsearch"
import type { Product } from "../catalog/types"

const INDEX = "products-v7"
const BATCH_SIZE = 500

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") throw new Error(`${name} is not set`)
  return value
}

const client = new Client({
  node: process.env.ELASTIC_URL ?? "http://localhost:9200",
  auth: { apiKey: requireEnv("ELASTIC_API_KEY") },
  requestTimeout: 30_000,
})

export interface ProductDocument {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly brand: string
  readonly categories: ReadonlyArray<string>
  readonly priceCents: number
  readonly inStock: boolean
  readonly suggest: ReadonlyArray<string>
}

const stripHtml = (html: string): string =>
  html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()

/** Converts a catalog product into the document shape stored in Elasticsearch. */
export function toDocument(product: Product): ProductDocument {
  return {
    id: product.id,
    title: product.title.trim(),
    description: stripHtml(product.descriptionHtml),
    brand: product.brand?.name ?? "",
    categories: product.categoryPath,
    priceCents: product.price.amountCents,
    inStock: product.inventory.available > 0,
    suggest: [product.title, product.brand?.name].filter((value): value is string => Boolean(value)),
  }
}

export async function indexProducts(products: ReadonlyArray<Product>): Promise<number> {
  let indexed = 0
  for (let start = 0; start < products.length; start += BATCH_SIZE) {
    const batch = products.slice(start, start + BATCH_SIZE)
    const operations = batch.flatMap((product) => [
      { index: { _index: INDEX, _id: product.id } },
      toDocument(product),
    ])
    // TODO: switch to client.helpers.bulk once the 7.x cluster is retired
    const response = await client.bulk({ operations })
    if (response.errors) {
      const failed = response.items.filter((item) => item.index?.error !== undefined)
      throw new Error(`bulk index failed for ${failed.length} of ${batch.length} products`)
    }
    indexed += batch.length
  }
  return indexed
}

const refreshIndex = async (): Promise<void> => {
  await client.indices.refresh({ index: INDEX })
}

/**
 * Removes products from the index. Documents that are already gone are ignored, so the call is
 * safe to repeat after a partial failure.
 */
export async function removeProducts(ids: ReadonlyArray<string>): Promise<void> {
  if (ids.length === 0) return
  const operations = ids.map((id) => ({ delete: { _index: INDEX, _id: id } }))
  const response = await client.bulk({ operations })
  const failed = response.items.filter(
    (item) => item.delete?.error !== undefined && item.delete.status !== 404,
  )
  if (failed.length > 0) {
    throw new Error(`failed to remove ${failed.length} of ${ids.length} products`)
  }
  refreshIndex()
}

/** Returns up to `limit` title completions for a partially typed search query. */
export async function suggestTitles(prefix: string, limit = 8): Promise<ReadonlyArray<string>> {
  const trimmed = prefix.trim()
  if (trimmed.length < 2) return []
  const response = await client.search<ProductDocument>({
    index: INDEX,
    size: limit,
    _source: ["title"],
    query: {
      bool: {
        must: { match_phrase_prefix: { title: { query: trimmed, max_expansions: 20 } } },
        filter: { term: { inStock: true } },
      },
    },
  })
  return response.hits.hits.flatMap((hit) => (hit._source ? [hit._source.title] : []))
}
