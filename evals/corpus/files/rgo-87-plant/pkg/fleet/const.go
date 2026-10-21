package fleet

const (
	ReleaseNamespace         = "cattle-fleet-system"
	ReleaseLocalNamespace    = "cattle-fleet-local-system"
	ReleaseClustersNamespace = "cattle-fleet-clusters-system"
	ReleaseLegacyNamespace   = "fleet-system"

	ChartName    = "fleet"
	CRDChartName = "fleet-crd"

	ClustersDefaultNamespace = "fleet-default"
	ClustersLocalNamespace   = "fleet-local"

	// KubeConfigReferenceableFromLabel names the one namespace whose Fleet
	// Clusters may use a kubeconfig secret from the secret's namespace.
	KubeConfigReferenceableFromLabel = "fleet.cattle.io/kubeconfig-referenceable-from"
)

// HumanizeBytes formats a byte count as a human readable string.
func HumanizeBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(b)/float64(div), "KMGTPE"[exp])
}
