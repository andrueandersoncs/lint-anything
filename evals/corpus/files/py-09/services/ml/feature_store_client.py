"""Thin client for the online feature store used by the ranking service.

Usage::

    client = FeatureStoreClient(base_url="https://features.internal", api_key="<your-api-key>")
    vectors = client.get_features("user", ["u_1842", "u_2291"], features=("ltv_90d", "sessions_7d"))
    client.close()

In production the key comes from ``FEATURE_STORE_API_KEY``; see
``FeatureStoreClient.from_env``.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Mapping, Sequence

import httpx

logger = logging.getLogger(__name__)

DEFAULT_FEATURES = ("ltv_90d", "sessions_7d", "days_since_signup")
RETRYABLE_STATUS = frozenset({429, 502, 503, 504})


@dataclass(frozen=True)
class FeatureVector:
    entity_id: str
    values: Mapping[str, float | None]
    fetched_at: float


class FeatureStoreError(RuntimeError):
    pass


class FeatureStoreClient:
    def __init__(self, base_url: str, api_key: str, timeout: float = 0.25, max_attempts: int = 3) -> None:
        self._http = httpx.Client(
            base_url=base_url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout,
        )
        self._max_attempts = max_attempts

    @classmethod
    def from_env(cls) -> "FeatureStoreClient":
        return cls(
            base_url=os.environ.get("FEATURE_STORE_URL", "https://features.internal"),
            api_key=os.environ["FEATURE_STORE_API_KEY"],
        )

    def _post(self, path: str, payload: Mapping[str, object]) -> Mapping[str, object]:
        delay = 0.02
        for attempt in range(1, self._max_attempts + 1):
            try:
                response = self._http.post(path, json=payload)
            except httpx.TimeoutException:
                # Ranking has a 50ms budget per request; a timeout is retried at most twice.
                if attempt == self._max_attempts:
                    raise FeatureStoreError(f"{path} timed out after {attempt} attempts")
                time.sleep(delay)
                delay *= 2
                continue
            if response.status_code in RETRYABLE_STATUS and attempt < self._max_attempts:
                time.sleep(delay)
                delay *= 2
                continue
            response.raise_for_status()
            return response.json()
        raise FeatureStoreError(f"{path} exhausted retries")

    def get_features(
        self,
        entity: str,
        entity_ids: Sequence[str],
        features: Sequence[str] = DEFAULT_FEATURES,
        as_of: float | None = None,
    ) -> list[FeatureVector]:
        payload = {"entity": entity, "ids": list(entity_ids), "features": list(features)}
        if as_of is not None:
            payload["as_of"] = as_of
        try:
            body = self._post("/v1/features:batchGet", payload)
        except Exception:
            logger.exception("feature lookup failed for %d %s ids", len(entity_ids), entity)
            raise
        fetched_at = time.time()
        return [
            FeatureVector(entity_id=row["id"], values=row["values"], fetched_at=fetched_at)
            for row in body.get("rows", [])
        ]

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "FeatureStoreClient":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()
