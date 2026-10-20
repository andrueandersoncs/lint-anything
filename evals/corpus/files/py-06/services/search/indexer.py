"""Catalog search indexing and query service.

This module owns everything between the catalog database and the OpenSearch
cluster that powers storefront search:

* index templates, analyzers and mappings for the ``catalog-products`` family
  of indices;
* a bulk indexer that batches documents, retries throttled requests and
  reports per-document failures;
* zero-downtime full reindexing through a write alias and a read alias;
* the query builder used by the storefront API, including filters, facets,
  boosting and highlighting.

Typical use from a worker::

    indexer = CatalogIndexer.from_env()
    report = indexer.full_reindex(source=CatalogSource.from_env())
    print(report.indexed, report.failed)

and from the API layer::

    query = SearchQuery(text="trail running shoes", filters={"brand": ["Salomon"]})
    page = indexer.search(query)

Operational notes live in docs/runbooks/search-reindex.md.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Iterable, Iterator, Mapping, Sequence

import httpx
import psycopg

logger = logging.getLogger("search.indexer")

READ_ALIAS = "catalog-products"
WRITE_ALIAS = "catalog-products-write"
INDEX_PREFIX = "catalog-products-"
KEEP_PREVIOUS_INDICES = 2

DEFAULT_BULK_ACTIONS = 1_000
DEFAULT_BULK_BYTES = 8 * 1024 * 1024
MAX_RETRIES = 5
RETRYABLE_STATUS = frozenset({429, 502, 503, 504})

SEARCHABLE_FIELDS = (
    "title^4",
    "title.shingles^2",
    "brand^3",
    "category_path^1.5",
    "description",
    "attributes.value",
)
FACET_FIELDS = ("brand", "category", "color", "size", "price_band", "rating_band")
HIGHLIGHT_FIELDS = ("title", "description")
PRICE_BANDS = (
    (Decimal("0"), Decimal("25"), "under-25"),
    (Decimal("25"), Decimal("50"), "25-50"),
    (Decimal("50"), Decimal("100"), "50-100"),
    (Decimal("100"), Decimal("250"), "100-250"),
    (Decimal("250"), None, "250-plus"),
)
SORTS = {
    "relevance": ({"_score": "desc"}, {"popularity": "desc"}),
    "price_asc": ({"price": "asc"}, {"_score": "desc"}),
    "price_desc": ({"price": "desc"}, {"_score": "desc"}),
    "newest": ({"published_at": "desc"},),
    "rating": ({"rating": "desc"}, {"review_count": "desc"}),
}


class SearchIndexError(RuntimeError):
    """Raised when the cluster rejects a request after all retries."""


class BulkRejected(SearchIndexError):
    def __init__(self, failures: Sequence[Mapping[str, Any]]) -> None:
        super().__init__(f"{len(failures)} documents rejected by bulk API")
        self.failures = list(failures)


class AliasConflict(SearchIndexError):
    """Raised when an alias points at an index we did not expect."""


# ---------------------------------------------------------------------------
# Index settings and mappings
# ---------------------------------------------------------------------------


def analysis_settings(synonyms: Sequence[str] = ()) -> dict[str, Any]:
    """Analyzer configuration shared by every catalog index.

    ``synonyms`` uses Solr syntax, e.g. ``"tee, t-shirt, tshirt"``. Synonyms are
    applied at query time only so that editing them never requires a reindex.
    """
    return {
        "analysis": {
            "char_filter": {
                "strip_trademarks": {
                    "type": "pattern_replace",
                    "pattern": "[\u00ae\u2122\u00a9]",
                    "replacement": "",
                },
            },
            "filter": {
                "english_stemmer": {"type": "stemmer", "language": "light_english"},
                "english_possessive": {"type": "stemmer", "language": "possessive_english"},
                "shingle_2_3": {"type": "shingle", "min_shingle_size": 2, "max_shingle_size": 3},
                "catalog_synonyms": {
                    "type": "synonym_graph",
                    "synonyms": list(synonyms),
                    "updateable": True,
                },
            },
            "analyzer": {
                "catalog_index": {
                    "type": "custom",
                    "char_filter": ["strip_trademarks"],
                    "tokenizer": "standard",
                    "filter": ["english_possessive", "lowercase", "asciifolding", "english_stemmer"],
                },
                "catalog_search": {
                    "type": "custom",
                    "char_filter": ["strip_trademarks"],
                    "tokenizer": "standard",
                    "filter": [
                        "english_possessive",
                        "lowercase",
                        "asciifolding",
                        "catalog_synonyms",
                        "english_stemmer",
                    ],
                },
                "catalog_shingles": {
                    "type": "custom",
                    "tokenizer": "standard",
                    "filter": ["lowercase", "asciifolding", "shingle_2_3"],
                },
            },
            "normalizer": {
                "keyword_lower": {"type": "custom", "filter": ["lowercase", "asciifolding"]},
            },
        }
    }


def product_mappings() -> dict[str, Any]:
    text_field = {
        "type": "text",
        "analyzer": "catalog_index",
        "search_analyzer": "catalog_search",
    }
    return {
        "dynamic": "strict",
        "properties": {
            "product_id": {"type": "keyword"},
            "sku": {"type": "keyword", "normalizer": "keyword_lower"},
            "title": {
                **text_field,
                "fields": {
                    "shingles": {"type": "text", "analyzer": "catalog_shingles"},
                    "raw": {"type": "keyword", "normalizer": "keyword_lower"},
                },
            },
            "brand": {"type": "keyword", "normalizer": "keyword_lower", "fields": {"text": text_field}},
            "description": text_field,
            "category": {"type": "keyword"},
            "category_path": {"type": "text", "analyzer": "catalog_index"},
            "color": {"type": "keyword", "normalizer": "keyword_lower"},
            "size": {"type": "keyword"},
            "attributes": {
                "type": "nested",
                "properties": {
                    "name": {"type": "keyword"},
                    "value": {"type": "text", "analyzer": "catalog_index"},
                },
            },
            "price": {"type": "scaled_float", "scaling_factor": 100},
            "price_band": {"type": "keyword"},
            "currency": {"type": "keyword"},
            "in_stock": {"type": "boolean"},
            "rating": {"type": "half_float"},
            "rating_band": {"type": "keyword"},
            "review_count": {"type": "integer"},
            "popularity": {"type": "rank_feature"},
            "published_at": {"type": "date"},
            "updated_at": {"type": "date"},
            "seller_id": {"type": "keyword"},
            "region_ids": {"type": "keyword"},
        },
    }


def index_body(shards: int, replicas: int, synonyms: Sequence[str] = ()) -> dict[str, Any]:
    return {
        "settings": {
            "number_of_shards": shards,
            "number_of_replicas": replicas,
            "refresh_interval": "1s",
            **analysis_settings(synonyms),
        },
        "mappings": product_mappings(),
    }


# ---------------------------------------------------------------------------
# Documents
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ProductAttribute:
    name: str
    value: str


@dataclass(frozen=True)
class Product:
    product_id: str
    sku: str
    title: str
    brand: str
    description: str
    category: str
    category_path: tuple[str, ...]
    color: str | None
    size: str | None
    attributes: tuple[ProductAttribute, ...]
    price: Decimal
    currency: str
    in_stock: bool
    rating: float | None
    review_count: int
    units_sold_30d: int
    published_at: datetime
    updated_at: datetime
    seller_id: str
    region_ids: tuple[str, ...]
    deleted: bool = False


def price_band(price: Decimal) -> str:
    for low, high, label in PRICE_BANDS:
        if price >= low and (high is None or price < high):
            return label
    return PRICE_BANDS[-1][2]


def rating_band(rating: float | None) -> str:
    if rating is None:
        return "unrated"
    if rating >= 4.5:
        return "4.5-up"
    if rating >= 4.0:
        return "4-up"
    if rating >= 3.0:
        return "3-up"
    return "below-3"


_WHITESPACE = re.compile(r"\s+")
_HTML_TAG = re.compile(r"<[^>]+>")


def clean_description(html: str, limit: int = 4_000) -> str:
    # Seller descriptions are HTML from the listing editor; we only index the text.
    text = _HTML_TAG.sub(" ", html)
    text = _WHITESPACE.sub(" ", text).strip()
    return text[:limit]


def popularity_score(product: Product) -> float:
    # rank_feature fields must be strictly positive, so the floor is 1.
    reviews = max(product.review_count, 0)
    sold = max(product.units_sold_30d, 0)
    return 1.0 + sold * 0.7 + reviews * 0.3


def to_document(product: Product) -> dict[str, Any]:
    return {
        "product_id": product.product_id,
        "sku": product.sku,
        "title": product.title.strip(),
        "brand": product.brand.strip(),
        "description": clean_description(product.description),
        "category": product.category,
        "category_path": " > ".join(product.category_path),
        "color": product.color,
        "size": product.size,
        "attributes": [{"name": a.name, "value": a.value} for a in product.attributes],
        "price": float(product.price),
        "price_band": price_band(product.price),
        "currency": product.currency,
        "in_stock": product.in_stock,
        "rating": product.rating,
        "rating_band": rating_band(product.rating),
        "review_count": product.review_count,
        "popularity": popularity_score(product),
        "published_at": product.published_at.isoformat(),
        "updated_at": product.updated_at.isoformat(),
        "seller_id": product.seller_id,
        "region_ids": list(product.region_ids),
    }


def document_version(product: Product) -> int:
    # External versioning keeps a slow reindex from overwriting a newer update
    # that the change-stream consumer already wrote.
    return int(product.updated_at.timestamp() * 1000)


# ---------------------------------------------------------------------------
# Cluster transport
# ---------------------------------------------------------------------------


class ClusterClient:
    """Minimal OpenSearch REST client with retry and backoff."""

    def __init__(
        self,
        base_url: str,
        username: str | None = None,
        password: str | None = None,
        timeout: float = 30.0,
        max_retries: int = MAX_RETRIES,
    ) -> None:
        auth = (username, password) if username and password else None
        self._http = httpx.Client(base_url=base_url, auth=auth, timeout=timeout)
        self._max_retries = max_retries

    @classmethod
    def from_env(cls) -> "ClusterClient":
        return cls(
            base_url=os.environ["SEARCH_CLUSTER_URL"],
            username=os.environ.get("SEARCH_CLUSTER_USER"),
            password=os.environ.get("SEARCH_CLUSTER_PASSWORD"),
            timeout=float(os.environ.get("SEARCH_CLUSTER_TIMEOUT", "30")),
        )

    def close(self) -> None:
        self._http.close()

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        params: Mapping[str, str] | None = None,
        content: bytes | None = None,
        ok_status: frozenset[int] = frozenset({200, 201}),
    ) -> Any:
        headers = {"Content-Type": "application/x-ndjson"} if content is not None else None
        for attempt in range(1, self._max_retries + 1):
            try:
                response = self._http.request(
                    method,
                    path,
                    json=body if content is None else None,
                    content=content,
                    params=params,
                    headers=headers,
                )
            except httpx.TransportError as exc:
                if attempt == self._max_retries:
                    raise SearchIndexError(f"{method} {path} failed: {exc}") from exc
                self._sleep(attempt)
                continue
            if response.status_code in ok_status:
                return response.json() if response.content else None
            if response.status_code in RETRYABLE_STATUS and attempt < self._max_retries:
                logger.info("%s %s throttled (%d), retrying", method, path, response.status_code)
                self._sleep(attempt)
                continue
            raise SearchIndexError(f"{method} {path} returned {response.status_code}: {response.text[:500]}")
        raise SearchIndexError(f"{method} {path} exhausted {self._max_retries} attempts")

    @staticmethod
    def _sleep(attempt: int) -> None:
        # Full jitter keeps a fleet of workers from retrying in lockstep.
        time.sleep(random.uniform(0, min(30.0, 0.5 * 2 ** attempt)))


# ---------------------------------------------------------------------------
# Bulk indexing
# ---------------------------------------------------------------------------


@dataclass
class BulkReport:
    indexed: int = 0
    deleted: int = 0
    conflicts: int = 0
    failed: int = 0
    failures: list[Mapping[str, Any]] = field(default_factory=list)
    started_at: float = field(default_factory=time.monotonic)

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self.started_at

    def merge(self, other: "BulkReport") -> None:
        self.indexed += other.indexed
        self.deleted += other.deleted
        self.conflicts += other.conflicts
        self.failed += other.failed
        self.failures.extend(other.failures)


class BulkIndexer:
    """Buffers index/delete actions and sends them through the ``_bulk`` API."""

    def __init__(
        self,
        client: ClusterClient,
        index: str,
        max_actions: int = DEFAULT_BULK_ACTIONS,
        max_bytes: int = DEFAULT_BULK_BYTES,
        keep_failures: int = 100,
    ) -> None:
        self._client = client
        self._index = index
        self._max_actions = max_actions
        self._max_bytes = max_bytes
        self._keep_failures = keep_failures
        self._lines: list[bytes] = []
        self._actions = 0
        self._bytes = 0
        self.report = BulkReport()

    def __enter__(self) -> "BulkIndexer":
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        if exc_type is None:
            self.flush()

    def _append(self, *lines: Mapping[str, Any]) -> None:
        for line in lines:
            encoded = json.dumps(line, separators=(",", ":"), default=str).encode() + b"\n"
            self._lines.append(encoded)
            self._bytes += len(encoded)
        self._actions += 1
        if self._actions >= self._max_actions or self._bytes >= self._max_bytes:
            self.flush()

    def index(self, product: Product) -> None:
        if product.deleted:
            self.delete(product.product_id)
            return
        action = {
            "index": {
                "_index": self._index,
                "_id": product.product_id,
                "version": document_version(product),
                "version_type": "external_gte",
            }
        }
        self._append(action, to_document(product))

    def delete(self, product_id: str) -> None:
        self._append({"delete": {"_index": self._index, "_id": product_id}})

    def flush(self) -> BulkReport:
        if not self._lines:
            return self.report
        payload = b"".join(self._lines)
        actions = self._actions
        self._lines, self._actions, self._bytes = [], 0, 0
        response = self._client.request("POST", "/_bulk", content=payload, params={"refresh": "false"})
        self._record(response, actions)
        return self.report

    def _record(self, response: Mapping[str, Any], actions: int) -> None:
        if not response.get("errors"):
            for item in response.get("items", []):
                if "delete" in item:
                    self.report.deleted += 1
                else:
                    self.report.indexed += 1
            return
        for item in response.get("items", []):
            op, result = next(iter(item.items()))
            status = result.get("status", 500)
            if status == 409:
                # A newer version is already indexed; that is the desired outcome.
                self.report.conflicts += 1
            elif status == 404 and op == "delete":
                self.report.deleted += 1
            elif status >= 300:
                self.report.failed += 1
                if len(self.report.failures) < self._keep_failures:
                    self.report.failures.append({"id": result.get("_id"), "status": status, "error": result.get("error")})
            elif op == "delete":
                self.report.deleted += 1
            else:
                self.report.indexed += 1
        logger.warning(
            "bulk batch of %d actions had %d failures so far (%d conflicts)",
            actions,
            self.report.failed,
            self.report.conflicts,
        )


# ---------------------------------------------------------------------------
# Catalog source
# ---------------------------------------------------------------------------


PRODUCT_QUERY = """
    SELECT p.id, p.sku, p.title, b.name AS brand, p.description_html,
           c.slug AS category, c.path AS category_path, p.color, p.size,
           p.price, p.currency, (inv.available > 0) AS in_stock,
           r.average AS rating, coalesce(r.count, 0) AS review_count,
           coalesce(s.units_30d, 0) AS units_sold_30d,
           p.published_at, p.updated_at, p.seller_id, p.region_ids, p.deleted_at IS NOT NULL AS deleted
    FROM catalog.products p
    JOIN catalog.brands b ON b.id = p.brand_id
    JOIN catalog.categories c ON c.id = p.category_id
    LEFT JOIN inventory.availability inv ON inv.product_id = p.id
    LEFT JOIN reviews.product_summary r ON r.product_id = p.id
    LEFT JOIN analytics.product_sales_30d s ON s.product_id = p.id
    WHERE p.updated_at >= %(since)s AND p.id > %(after)s
    ORDER BY p.id
    LIMIT %(limit)s
"""

ATTRIBUTE_QUERY = """
    SELECT product_id, name, value
    FROM catalog.product_attributes
    WHERE product_id = ANY(%(ids)s)
"""


class CatalogSource:
    """Streams products out of the catalog database in primary-key order."""

    def __init__(self, dsn: str, page_size: int = 2_000) -> None:
        self._dsn = dsn
        self._page_size = page_size

    @classmethod
    def from_env(cls) -> "CatalogSource":
        return cls(dsn=os.environ["CATALOG_DATABASE_URL"])

    def products(self, since: datetime | None = None) -> Iterator[Product]:
        since = since or datetime(1970, 1, 1, tzinfo=timezone.utc)
        after = ""
        with psycopg.connect(self._dsn, autocommit=True) as conn:
            while True:
                rows = conn.execute(PRODUCT_QUERY, {"since": since, "after": after, "limit": self._page_size}).fetchall()
                if not rows:
                    return
                attributes = self._attributes(conn, [row[0] for row in rows])
                for row in rows:
                    yield self._product(row, attributes.get(row[0], ()))
                after = rows[-1][0]

    @staticmethod
    def _attributes(conn: psycopg.Connection, ids: Sequence[str]) -> dict[str, tuple[ProductAttribute, ...]]:
        grouped: dict[str, list[ProductAttribute]] = {}
        for product_id, name, value in conn.execute(ATTRIBUTE_QUERY, {"ids": list(ids)}):
            grouped.setdefault(product_id, []).append(ProductAttribute(name=name, value=value))
        return {key: tuple(values) for key, values in grouped.items()}

    @staticmethod
    def _product(row: Sequence[Any], attributes: tuple[ProductAttribute, ...]) -> Product:
        (
            product_id, sku, title, brand, description_html, category, category_path, color, size,
            price, currency, in_stock, rating, review_count, units_sold_30d,
            published_at, updated_at, seller_id, region_ids, deleted,
        ) = row
        return Product(
            product_id=product_id,
            sku=sku,
            title=title,
            brand=brand,
            description=description_html or "",
            category=category,
            category_path=tuple(category_path or ()),
            color=color,
            size=size,
            attributes=attributes,
            price=Decimal(price),
            currency=currency,
            in_stock=bool(in_stock),
            rating=float(rating) if rating is not None else None,
            review_count=int(review_count),
            units_sold_30d=int(units_sold_30d),
            published_at=published_at,
            updated_at=updated_at,
            seller_id=seller_id,
            region_ids=tuple(region_ids or ()),
            deleted=bool(deleted),
        )


# ---------------------------------------------------------------------------
# Search queries
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SearchQuery:
    text: str = ""
    filters: Mapping[str, Sequence[str]] = field(default_factory=dict)
    price_min: Decimal | None = None
    price_max: Decimal | None = None
    in_stock_only: bool = False
    region_id: str | None = None
    sort: str = "relevance"
    page: int = 1
    page_size: int = 24
    facets: tuple[str, ...] = FACET_FIELDS
    highlight: bool = True


@dataclass(frozen=True)
class SearchHit:
    product_id: str
    score: float | None
    title: str
    brand: str
    price: float
    currency: str
    highlights: Mapping[str, Sequence[str]]


@dataclass(frozen=True)
class SearchPage:
    total: int
    hits: tuple[SearchHit, ...]
    facets: Mapping[str, Sequence[tuple[str, int]]]
    took_ms: int


def _text_clause(text: str, fields: Sequence[str] = SEARCHABLE_FIELDS) -> dict[str, Any]:
    if not text.strip():
        return {"match_all": {}}
    return {
        "bool": {
            "should": [
                {
                    "multi_match": {
                        "query": text,
                        "fields": list(fields),
                        "type": "best_fields",
                        "operator": "and",
                        "fuzziness": "AUTO:4,8",
                        "prefix_length": 1,
                    }
                },
                {
                    "match_phrase": {
                        "title": {"query": text, "slop": 2, "boost": 3},
                    }
                },
                {
                    "nested": {
                        "path": "attributes",
                        "query": {"match": {"attributes.value": {"query": text, "operator": "and"}}},
                        "score_mode": "max",
                    }
                },
            ],
            "minimum_should_match": 1,
        }
    }


def _filter_clauses(query: SearchQuery) -> list[dict[str, Any]]:
    clauses: list[dict[str, Any]] = []
    for name, values in sorted(query.filters.items()):
        if name not in FACET_FIELDS:
            raise ValueError(f"unknown filter {name!r}")
        if values:
            clauses.append({"terms": {name: list(values)}})
    if query.price_min is not None or query.price_max is not None:
        price_range: dict[str, float] = {}
        if query.price_min is not None:
            price_range["gte"] = float(query.price_min)
        if query.price_max is not None:
            price_range["lte"] = float(query.price_max)
        clauses.append({"range": {"price": price_range}})
    if query.in_stock_only:
        clauses.append({"term": {"in_stock": True}})
    if query.region_id is not None:
        clauses.append({"term": {"region_ids": query.region_id}})
    return clauses


def _facet_aggregations(query: SearchQuery, sizes: Mapping[str, int] = {}) -> dict[str, Any]:
    # Each facet is computed with every filter except its own applied, so that
    # selecting "Nike" still shows counts for the other brands.
    aggregations: dict[str, Any] = {}
    for name in query.facets:
        others = SearchQuery(
            text=query.text,
            filters={key: value for key, value in query.filters.items() if key != name},
            price_min=query.price_min,
            price_max=query.price_max,
            in_stock_only=query.in_stock_only,
            region_id=query.region_id,
        )
        aggregations[name] = {
            "filter": {"bool": {"filter": _filter_clauses(others)}},
            "aggs": {"values": {"terms": {"field": name, "size": sizes.get(name, 20)}}},
        }
    return aggregations


def build_search_body(query: SearchQuery) -> dict[str, Any]:
    if query.sort not in SORTS:
        raise ValueError(f"unknown sort {query.sort!r}")
    if not 1 <= query.page_size <= 100:
        raise ValueError("page_size must be between 1 and 100")
    body: dict[str, Any] = {
        "from": (max(query.page, 1) - 1) * query.page_size,
        "size": query.page_size,
        "track_total_hits": 10_000,
        "query": {
            "bool": {
                "must": [_text_clause(query.text)],
                "should": [{"rank_feature": {"field": "popularity", "saturation": {}, "boost": 0.5}}],
            }
        },
        # Filters go in post_filter so facet counts are not narrowed by them.
        "post_filter": {"bool": {"filter": _filter_clauses(query)}},
        "sort": list(SORTS[query.sort]),
        "_source": ["product_id", "title", "brand", "price", "currency"],
    }
    if query.facets:
        body["aggs"] = _facet_aggregations(query)
    if query.highlight and query.text.strip():
        body["highlight"] = {
            "pre_tags": ["<mark>"],
            "post_tags": ["</mark>"],
            "fields": {name: {"number_of_fragments": 2, "fragment_size": 120} for name in HIGHLIGHT_FIELDS},
        }
    return body


def parse_search_response(response: Mapping[str, Any]) -> SearchPage:
    hits = tuple(
        SearchHit(
            product_id=hit["_source"]["product_id"],
            score=hit.get("_score"),
            title=hit["_source"]["title"],
            brand=hit["_source"]["brand"],
            price=hit["_source"]["price"],
            currency=hit["_source"]["currency"],
            highlights=hit.get("highlight", {}),
        )
        for hit in response["hits"]["hits"]
    )
    facets = {
        name: tuple((bucket["key"], bucket["doc_count"]) for bucket in aggregation["values"]["buckets"])
        for name, aggregation in response.get("aggregations", {}).items()
    }
    return SearchPage(
        total=response["hits"]["total"]["value"],
        hits=hits,
        facets=facets,
        took_ms=response.get("took", 0),
    )


# ---------------------------------------------------------------------------
# Index lifecycle
# ---------------------------------------------------------------------------


def new_index_name(now: datetime | None = None) -> str:
    now = now or datetime.now(tz=timezone.utc)
    return f"{INDEX_PREFIX}{now.strftime('%Y%m%d%H%M%S')}"


class CatalogIndexer:
    def __init__(
        self,
        client: ClusterClient,
        shards: int = 6,
        replicas: int = 1,
        synonyms: Sequence[str] = (),
    ) -> None:
        self._client = client
        self._shards = shards
        self._replicas = replicas
        self._synonyms = tuple(synonyms)

    @classmethod
    def from_env(cls) -> "CatalogIndexer":
        synonyms_path = os.environ.get("SEARCH_SYNONYMS_FILE", "/etc/search/synonyms.txt")
        try:
            with open(synonyms_path, encoding="utf-8") as handle:
                synonyms = [line.strip() for line in handle if line.strip() and not line.startswith("#")]
        except FileNotFoundError:
            synonyms = []
        return cls(
            client=ClusterClient.from_env(),
            shards=int(os.environ.get("SEARCH_INDEX_SHARDS", "6")),
            replicas=int(os.environ.get("SEARCH_INDEX_REPLICAS", "1")),
            synonyms=synonyms,
        )

    # -- aliases -----------------------------------------------------------

    def alias_targets(self, alias: str) -> list[str]:
        response = self._client.request("GET", f"/_alias/{alias}", ok_status=frozenset({200, 404}))
        if not response or "error" in response:
            return []
        return sorted(response.keys())

    def create_index(self, name: str) -> None:
        body = index_body(self._shards, replicas=0, synonyms=self._synonyms)
        # Bulk loading is much faster without replicas or periodic refreshes;
        # both are restored in finalize_index once the load completes.
        body["settings"]["refresh_interval"] = "-1"
        self._client.request("PUT", f"/{name}", body=body)
        logger.info("created index %s", name)

    def finalize_index(self, name: str) -> None:
        self._client.request(
            "PUT",
            f"/{name}/_settings",
            body={"index": {"number_of_replicas": self._replicas, "refresh_interval": "1s"}},
        )
        self._client.request("POST", f"/{name}/_refresh")
        self._client.request(
            "GET",
            "/_cluster/health",
            params={"index": name, "wait_for_status": "green", "timeout": "10m"},
        )

    def swap_aliases(self, new_index: str, expected_previous: Sequence[str] | None = None) -> list[str]:
        previous = self.alias_targets(READ_ALIAS)
        if expected_previous is not None and sorted(expected_previous) != previous:
            raise AliasConflict(f"{READ_ALIAS} moved during reindex: expected {expected_previous}, found {previous}")
        actions: list[dict[str, Any]] = [{"remove": {"index": index, "alias": READ_ALIAS}} for index in previous]
        actions += [
            {"remove": {"index": index, "alias": WRITE_ALIAS}} for index in self.alias_targets(WRITE_ALIAS)
        ]
        actions += [
            {"add": {"index": new_index, "alias": READ_ALIAS}},
            {"add": {"index": new_index, "alias": WRITE_ALIAS, "is_write_index": True}},
        ]
        self._client.request("POST", "/_aliases", body={"actions": actions})
        logger.info("aliases now point at %s (previously %s)", new_index, ", ".join(previous) or "nothing")
        return previous

    def prune_old_indices(self, keep: int = KEEP_PREVIOUS_INDICES) -> list[str]:
        response = self._client.request("GET", f"/_cat/indices/{INDEX_PREFIX}*", params={"format": "json"})
        live = set(self.alias_targets(READ_ALIAS))
        names = sorted((row["index"] for row in response or []), reverse=True)
        candidates = [name for name in names if name not in live]
        doomed = candidates[keep:]
        for name in doomed:
            self._client.request("DELETE", f"/{name}")
            logger.info("deleted old index %s", name)
        return doomed

    # -- loading -----------------------------------------------------------

    def full_reindex(self, source: CatalogSource, progress_every: int = 50_000) -> BulkReport:
        previous = self.alias_targets(READ_ALIAS)
        name = new_index_name()
        self.create_index(name)
        started = datetime.now(tz=timezone.utc)
        with BulkIndexer(self._client, name) as bulk:
            for count, product in enumerate(source.products(), start=1):
                bulk.index(product)
                if count % progress_every == 0:
                    logger.info("reindex %s: %d products queued, %.0fs elapsed", name, count, bulk.report.elapsed)
        report = bulk.report
        # Catch up on anything that changed while the full scan was running.
        with BulkIndexer(self._client, name) as catch_up:
            for product in source.products(since=started):
                catch_up.index(product)
        report.merge(catch_up.report)
        if report.failed:
            raise BulkRejected(report.failures)
        self.finalize_index(name)
        self.swap_aliases(name, expected_previous=previous)
        self.prune_old_indices()
        return report

    def incremental_update(self, products: Iterable[Product]) -> BulkReport:
        with BulkIndexer(self._client, WRITE_ALIAS, max_actions=200) as bulk:
            for product in products:
                bulk.index(product)
        return bulk.report

    def reload_synonyms(self) -> None:
        # TODO(SRCH-412): push synonyms through the package API once we are on 2.12.
        self._client.request("POST", f"/{READ_ALIAS}/_reload_search_analyzers")

    # -- querying ----------------------------------------------------------

    def search(self, query: SearchQuery) -> SearchPage:
        body = build_search_body(query)
        started = time.monotonic()
        try:
            response = self._client.request("POST", f"/{READ_ALIAS}/_search", body=body)
        except SearchIndexError:
            logger.exception("search failed for %r", query.text)
            raise
        page = parse_search_response(response)
        logger.debug(
            "search %r returned %d hits in %dms (%.0fms wall)",
            query.text,
            page.total,
            page.took_ms,
            (time.monotonic() - started) * 1000,
        )
        return page

    def healthy(self) -> bool:
        try:
            health = self._client.request("GET", "/_cluster/health", params={"timeout": "2s"})
        except Exception:
            logger.warning("cluster health check failed", exc_info=True)
            return False
        return health.get("status") in ("green", "yellow")


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------


def _print_json(value: Any) -> None:
    json.dump(value, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="catalog-search", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    reindex = sub.add_parser("reindex", help="build a fresh index and swap aliases")
    reindex.add_argument("--progress-every", type=int, default=50_000)

    sub.add_parser("prune", help="delete old indices beyond the retention count")
    sub.add_parser("reload-synonyms", help="reload search-time synonyms")

    args = parser.parse_args(argv)
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    indexer = CatalogIndexer.from_env()

    if args.command == "reindex":
        report = indexer.full_reindex(CatalogSource.from_env(), progress_every=args.progress_every)
        _print_json({
            "indexed": report.indexed,
            "deleted": report.deleted,
            "conflicts": report.conflicts,
            "failed": report.failed,
            "seconds": round(report.elapsed, 1),
        })
    elif args.command == "prune":
        _print_json({"deleted": indexer.prune_old_indices()})
    elif args.command == "reload-synonyms":
        indexer.reload_synonyms()
    return 0


if __name__ == "__main__":
    sys.exit(main())
