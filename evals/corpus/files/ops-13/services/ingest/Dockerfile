FROM ghcr.io/astral-sh/uv:latest AS uv

FROM python:3.12-slim-bookworm AS build
COPY --from=uv /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

FROM python:3.12-slim-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends librdkafka1 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10003 --no-create-home ingest
COPY --from=build --chown=ingest:ingest /app /app
ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    INGEST_TOPIC=events.raw.v2 \
    INGEST_CONSUMER_GROUP=ingest-writer \
    KAFKA_BOOTSTRAP_SERVERS=kafka-0.kafka.internal:9093,kafka-1.kafka.internal:9093,kafka-2.kafka.internal:9093 \
    KAFKA_SECURITY_PROTOCOL=SASL_SSL \
    KAFKA_SASL_MECHANISM=SCRAM-SHA-512 \
    KAFKA_SASL_USERNAME=ingest-writer \
    KAFKA_SASL_PASSWORD=EXAMPLE_SECRET
WORKDIR /app
USER ingest
EXPOSE 9102
CMD ["python", "-m", "ingest.consumer"]
