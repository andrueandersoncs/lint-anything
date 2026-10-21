package gateway

import (
	"time"

	gatev1 "sigs.k8s.io/gateway-api/apis/v1"
)

type routeClaim struct {
	kind      string
	hostname  gatev1.Hostname
	timestamp time.Time
}

// attachedRoutes tracks which route kind owns each hostname on each listener.
type attachedRoutes map[string][]routeClaim // listenerKey → []routeClaim

func (a attachedRoutes) Claim(listenerKey, kind string, hostname gatev1.Hostname, timestamp time.Time) {
	for i, claim := range a[listenerKey] {
		if hostnamesIntersect([]gatev1.Hostname{hostname}, []gatev1.Hostname{claim.hostname}) {
			// Only claim if the timestamp is older than the existing claim to ensure the older route always wins.
			if timestamp.Before(claim.timestamp) {
				a[listenerKey][i] = routeClaim{hostname: hostname, kind: kind, timestamp: timestamp}
			}
			return
		}
	}

	a[listenerKey] = append(a[listenerKey], routeClaim{hostname: hostname, kind: kind, timestamp: timestamp})
}

func (a attachedRoutes) HasConflict(listenerKey, kind string, hostnames []gatev1.Hostname) bool {
	for _, claim := range a[listenerKey] {
		if claim.kind != kind && hostnamesIntersect(hostnames, []gatev1.Hostname{claim.hostname}) {
			return true
		}
	}

	return false
}
