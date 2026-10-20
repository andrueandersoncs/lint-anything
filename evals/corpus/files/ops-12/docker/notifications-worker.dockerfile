# Image for the notifications worker (Celery). Built by the worker pipeline:
#   docker build -f docker/notifications-worker.dockerfile -t notifications-worker .
#
# Base images are pinned by digest; Renovate opens a PR when a new digest is
# published for the tag noted next to it.

FROM ghcr.io/astral-sh/uv@sha256:98e414554735609c42b25288b868f5d6df87298a43a8fbd4bc7ae0d44d9ef1b1 AS uv

# python:3.12-slim-bookworm
FROM python:3.12-slim-bookworm@sha256:00d92ba955b0d83cc3f0de19c5175ade147a35bbf84a69777eea277a8e35f4bb AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends libpq5 \
 && rm -rf /var/lib/apt/lists/*

FROM base AS builder
COPY --from=uv /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /src
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project
COPY notifications ./notifications
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

FROM base AS runtime
RUN useradd --system --uid 10002 --no-create-home worker
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /src/notifications /app/notifications
ENV PATH="/opt/venv/bin:${PATH}"
WORKDIR /app
USER worker
CMD ["celery", "--app", "notifications.worker", "worker", "--loglevel", "INFO", "--concurrency", "4", "--queues", "email,push,sms"]
