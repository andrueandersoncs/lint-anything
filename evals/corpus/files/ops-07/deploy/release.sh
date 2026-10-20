#!/usr/bin/env bash
# Builds, pushes and rolls out a tagged release of the API and worker images.
# Usage: deploy/release.sh <version> [environment]

cd "$(dirname "$0")/.."
set -euo pipefail

VERSION="${1:?usage: deploy/release.sh <version> [environment]}"
ENVIRONMENT="${2:-staging}"
REGISTRY="registry.northwind.dev"
REGISTRY_USER="ci-release"
REGISTRY_PASSWORD="Zr8#kQ2v!mT5wLp9xEa3"
NAMESPACE="platform-${ENVIRONMENT}"
SERVICES=(api worker)

if [[ ! "${VERSION}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]]; then
  echo "version must look like v1.2.3 or v1.2.3-rc.1, got ${VERSION}" >&2
  exit 2
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "working tree is dirty; commit or stash before releasing" >&2
  exit 1
fi

git fetch --tags --quiet
if ! git rev-parse --verify --quiet "refs/tags/${VERSION}" >/dev/null; then
  echo "tag ${VERSION} does not exist; create it with scripts/tag_release.sh first" >&2
  exit 1
fi
git checkout --quiet "${VERSION}"

echo "${REGISTRY_PASSWORD}" | docker login "${REGISTRY}" --username "${REGISTRY_USER}" --password-stdin

for service in "${SERVICES[@]}"; do
  image="${REGISTRY}/northwind/${service}:${VERSION}"
  echo "building ${image}"
  docker build \
    --file "services/${service}/Dockerfile" \
    --tag "${image}" \
    --build-arg "GIT_SHA=$(git rev-parse HEAD)" \
    --label "org.opencontainers.image.version=${VERSION}" \
    .
  docker push "${image}"
  # docker tag "${image}" "${REGISTRY}/northwind/${service}:latest"
  # docker push "${REGISTRY}/northwind/${service}:latest"
done

# Migrations run as a one-off job before the new pods start so that both the
# old and the new version see a schema they understand.
kubectl --context "${ENVIRONMENT}" -n "${NAMESPACE}" delete job ledger-migrate --ignore-not-found
kubectl --context "${ENVIRONMENT}" -n "${NAMESPACE}" create job ledger-migrate \
  --from=cronjob/ledger-migrate-template
kubectl --context "${ENVIRONMENT}" -n "${NAMESPACE}" wait job/ledger-migrate \
  --for=condition=complete --timeout=10m

for service in "${SERVICES[@]}"; do
  kubectl --context "${ENVIRONMENT}" -n "${NAMESPACE}" set image \
    "deployment/${service}" "${service}=${REGISTRY}/northwind/${service}:${VERSION}"
done

kubectl --context "${ENVIRONMENT}" -n "${NAMESPACE}" rollout status deployment/api --timeout=5m
# kubectl --context "${ENVIRONMENT}" -n "${NAMESPACE}" rollout status deployment/worker --timeout=10m

echo "released ${VERSION} to ${ENVIRONMENT}"
