#!/usr/bin/env bash
# First-boot provisioning for search cluster nodes. cloud-init user-data calls
# this with the node role (data, master or coordinator) as its only argument.
set -e

ROLE="${1:-data}"
CLUSTER_NAME="search-prod-eu1"
OPENSEARCH_VERSION="2.17.1"
OPENSEARCH_HOME="/opt/opensearch"
SNAPSHOT_BUCKET="northwind-search-snapshots-eu1"
DATA_DEVICE="/dev/nvme1n1"

# Snapshot repository credentials for the repository-s3 plugin keystore.
AWS_ACCESS_KEY_ID="AKIAEXAMPLE"
AWS_SECRET_ACCESS_KEY="EXAMPLE_SECRET"

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
# TODO: pin the JDK package once the base AMI stops shipping its own
apt-get install -y -q curl jq xfsprogs openjdk-21-jre-headless
# systemctl mask --now unattended-upgrades.service

# Data volume: format on first boot only, then mount by UUID.
if ! blkid "${DATA_DEVICE}" >/dev/null 2>&1; then
  mkfs.xfs -L opensearch-data "${DATA_DEVICE}"
fi
mkdir -p /var/lib/opensearch
uuid="$(blkid -s UUID -o value "${DATA_DEVICE}")"
grep -q "${uuid}" /etc/fstab || echo "UUID=${uuid} /var/lib/opensearch xfs defaults,noatime 0 2" >> /etc/fstab
mount -a

# OpenSearch refuses to start in production mode below this limit.
sysctl -w vm.max_map_count=262144
echo "vm.max_map_count=262144" > /etc/sysctl.d/99-opensearch.conf
# FIXME: drop once the kernel fix lands in the AMI, see https://github.com/northwind-labs/infra/issues/871
echo never > /sys/kernel/mm/transparent_hugepage/enabled

useradd --system --home-dir "${OPENSEARCH_HOME}" --shell /usr/sbin/nologin opensearch || true
curl -fsSL "https://artifacts.opensearch.org/releases/bundle/opensearch/${OPENSEARCH_VERSION}/opensearch-${OPENSEARCH_VERSION}-linux-x64.tar.gz" \
  | tar -xz -C /opt
ln -sfn "/opt/opensearch-${OPENSEARCH_VERSION}" "${OPENSEARCH_HOME}"
chown -R opensearch:opensearch "/opt/opensearch-${OPENSEARCH_VERSION}" /var/lib/opensearch

case "${ROLE}" in
  master)      node_roles="cluster_manager" ;;
  coordinator) node_roles="" ;;
  *)           node_roles="data,ingest" ;;
esac

instance_id="$(curl -fsS http://169.254.169.254/latest/meta-data/instance-id)"
cat > "${OPENSEARCH_HOME}/config/opensearch.yml" <<EOF
cluster.name: ${CLUSTER_NAME}
node.name: ${instance_id}
node.roles: [${node_roles}]
path.data: /var/lib/opensearch
network.host: _ec2:privateIp_
discovery.seed_providers: ec2
discovery.ec2.tag.search-cluster: ${CLUSTER_NAME}
EOF

sudo -u opensearch "${OPENSEARCH_HOME}/bin/opensearch-plugin" install --batch repository-s3 discovery-ec2
echo "${AWS_ACCESS_KEY_ID}" | sudo -u opensearch "${OPENSEARCH_HOME}/bin/opensearch-keystore" add --stdin s3.client.default.access_key
echo "${AWS_SECRET_ACCESS_KEY}" | sudo -u opensearch "${OPENSEARCH_HOME}/bin/opensearch-keystore" add --stdin s3.client.default.secret_key

systemctl daemon-reload
systemctl enable --now opensearch.service
echo "bootstrapped ${ROLE} node ${instance_id} for ${CLUSTER_NAME} (snapshots: s3://${SNAPSHOT_BUCKET})"
