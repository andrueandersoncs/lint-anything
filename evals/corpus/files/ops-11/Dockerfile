# Ledger service: static Go binary on a minimal Alpine runtime.

FROM golang:1.23-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
ARG VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -trimpath \
      -ldflags="-s -w -X main.version=${VERSION}" \
      -o /out/ledger ./cmd/ledger

FROM alpine
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -H -u 10001 ledger
COPY --from=build /out/ledger /usr/local/bin/ledger
COPY migrations /etc/ledger/migrations
ENV LEDGER_HTTP_ADDR=:8080 \
    LEDGER_MIGRATIONS_DIR=/etc/ledger/migrations \
    LEDGER_LOG_FORMAT=json \
    DATABASE_URL=postgres://ledger_app:Hq4vN8wZt2Lr6mXc@ledger-primary.db.internal:5432/ledger?sslmode=require
USER 10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/ledger"]
CMD ["serve"]
