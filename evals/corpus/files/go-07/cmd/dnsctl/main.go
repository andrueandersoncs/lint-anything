// Command dnsctl keeps a DNS zone in sync with a YAML file checked into the
// infrastructure repository.
//
//	dnsctl init  -config dns.yaml      write a starter config
//	dnsctl plan  -config dns.yaml      show the changes that apply would make
//	dnsctl apply -config dns.yaml      make the zone match the config
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/northwind/infra-tools/internal/dnsapi"
)

const sampleConfig = `# dnsctl configuration
zone: example.com
# The token needs Zone.DNS edit permission. DNSCTL_API_TOKEN overrides it.
api_token: "<your-cloudflare-api-token>"
records:
  - name: www
    type: CNAME
    content: lb.example.com
    ttl: 300
`

type config struct {
	Zone     string   `yaml:"zone"`
	APIToken string   `yaml:"api_token"`
	Records  []record `yaml:"records"`
}

type record struct {
	Name    string `yaml:"name"`
	Type    string `yaml:"type"`
	Content string `yaml:"content"`
	TTL     int    `yaml:"ttl"`
}

func (r record) key() string { return strings.ToLower(r.Type + " " + r.Name) }

type change struct {
	op       string // create, update or delete
	desired  record
	existing dnsapi.Record
}

func main() {
	if len(os.Args) < 2 {
		log.Fatal("usage: dnsctl init|plan|apply -config FILE")
	}
	cmd := os.Args[1]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	path := fs.String("config", "dns.yaml", "path to the zone config")
	if err := fs.Parse(os.Args[2:]); err != nil {
		log.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	var err error
	switch cmd {
	case "init":
		err = writeSample(*path)
	case "plan":
		err = reconcile(ctx, *path, true)
	case "apply":
		err = reconcile(ctx, *path, false)
	default:
		err = fmt.Errorf("unknown command %q", cmd)
	}
	if err != nil {
		log.Fatalf("dnsctl %s: %v", cmd, err)
	}
}

func writeSample(path string) error {
	if _, err := os.Stat(path); err == nil {
		return fmt.Errorf("%s already exists", path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.WriteFile(path, []byte(sampleConfig), 0o600)
}

func loadConfig(path string) (*config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg config
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if token := os.Getenv("DNSCTL_API_TOKEN"); token != "" {
		cfg.APIToken = token
	}
	if cfg.Zone == "" {
		return nil, fmt.Errorf("%s: zone is required", path)
	}
	for i := range cfg.Records {
		if cfg.Records[i].TTL == 0 {
			cfg.Records[i].TTL = 300
		}
	}
	return &cfg, nil
}

func reconcile(ctx context.Context, path string, dryRun bool) error {
	cfg, err := loadConfig(path)
	if err != nil {
		return err
	}
	client := dnsapi.NewClient(cfg.APIToken)

	zoneID, err := client.ZoneID(ctx, cfg.Zone)
	if err != nil {
		return fmt.Errorf("look up zone %s: %w", cfg.Zone, err)
	}
	existing, err := client.ListRecords(ctx, zoneID)
	if err != nil {
		return fmt.Errorf("list records: %w", err)
	}

	changes := diff(cfg.Records, existing)
	if len(changes) == 0 {
		fmt.Println("zone is up to date")
		return nil
	}
	return applyChanges(client, zoneID, changes, ctx, dryRun)
}

// diff compares desired records with the live zone. Records are matched on
// type and name; anything live that the config does not mention is deleted.
func diff(desired []record, live []dnsapi.Record) []change {
	byKey := make(map[string]dnsapi.Record, len(live))
	for _, r := range live {
		byKey[strings.ToLower(r.Type+" "+r.Name)] = r
	}

	var changes []change
	for _, d := range desired {
		cur, ok := byKey[d.key()]
		delete(byKey, d.key())
		switch {
		case !ok:
			changes = append(changes, change{op: "create", desired: d})
		case cur.Content != d.Content || cur.TTL != d.TTL:
			// TODO(https://github.com/northwind/infra-tools/issues/318): MX priority changes are not detected yet.
			changes = append(changes, change{op: "update", desired: d, existing: cur})
		}
	}
	// fmt.Printf("unmatched live records: %+v\n", byKey)
	for _, r := range byKey {
		changes = append(changes, change{op: "delete", existing: r})
	}

	sort.Slice(changes, func(i, j int) bool {
		return changes[i].op < changes[j].op
	})
	return changes
}

func applyChanges(client *dnsapi.Client, zoneID string, changes []change, ctx context.Context, dryRun bool) error {
	for _, c := range changes {
		switch c.op {
		case "create":
			fmt.Printf("+ %s %s -> %s (ttl %d)\n", c.desired.Type, c.desired.Name, c.desired.Content, c.desired.TTL)
		case "update":
			fmt.Printf("~ %s %s: %s -> %s\n", c.desired.Type, c.desired.Name, c.existing.Content, c.desired.Content)
		case "delete":
			fmt.Printf("- %s %s\n", c.existing.Type, c.existing.Name)
		}
		if dryRun {
			continue
		}

		var err error
		switch c.op {
		case "create":
			err = client.CreateRecord(ctx, zoneID, toAPI(c.desired))
		case "update":
			err = client.UpdateRecord(ctx, zoneID, c.existing.ID, toAPI(c.desired))
		case "delete":
			err = client.DeleteRecord(ctx, zoneID, c.existing.ID)
		}
		if err != nil {
			return fmt.Errorf("%s %s: %w", c.op, c.desired.key(), err)
		}
	}
	return nil
}

func toAPI(r record) dnsapi.Record {
	return dnsapi.Record{Name: r.Name, Type: r.Type, Content: r.Content, TTL: r.TTL}
}
