// Command reindex rebuilds a product search index from a catalog export.
//
// It reads the newline-delimited JSON export produced by the catalog service,
// writes every product into a fresh, timestamped index, and then swings the
// public alias over to it so searches never see a half-built index.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/northwind/catalog/internal/search"
)

type config struct {
	exportPath string
	alias      string
	batchSize  int
	endpoint   string
	keepOld    bool
}

type product struct {
	SKU          string   `json:"sku"`
	Title        string   `json:"title"`
	Description  string   `json:"description"`
	Brand        string   `json:"brand"`
	Categories   []string `json:"categories"`
	PriceCents   int64    `json:"price_cents"`
	InStock      bool     `json:"in_stock"`
	Discontinued bool     `json:"discontinued"`
}

func main() {
	var cfg config
	flag.StringVar(&cfg.exportPath, "export", "", "path to the catalog NDJSON export")
	flag.StringVar(&cfg.alias, "alias", "products", "search alias to point at the new index")
	flag.IntVar(&cfg.batchSize, "batch", 500, "documents per bulk request")
	flag.StringVar(&cfg.endpoint, "endpoint", "https://search.internal.northwind.io", "search cluster URL")
	flag.BoolVar(&cfg.keepOld, "keep-old", false, "keep the previous index after the alias swap")
	flag.Parse()

	if cfg.exportPath == "" {
		log.Fatal("reindex: -export is required")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	if err := run(ctx, cfg); err != nil {
		log.Fatalf("reindex: %v", err)
	}
}

// indexer is the part of *search.Client that a rebuild needs; the tests
// substitute an in-memory fake.
type indexer interface {
	CreateIndex(ctx context.Context, name string, mapping search.Mapping) error
	Bulk(ctx context.Context, index string, docs []search.Document) error
	SwapAlias(ctx context.Context, alias, index string) (previous string, err error)
	DeleteIndex(ctx context.Context, name string) error
}

func run(ctx context.Context, cfg config) error {
	client, err := search.NewClient(cfg.endpoint, os.Getenv("SEARCH_API_KEY"))
	if err != nil {
		return fmt.Errorf("connect to search: %w", err)
	}
	return rebuild(ctx, client, cfg)
}

func rebuild(ctx context.Context, client indexer, cfg config) error {
	index := fmt.Sprintf("%s-%s", cfg.alias, time.Now().UTC().Format("20060102-150405"))
	if err := client.CreateIndex(ctx, index, search.ProductMapping); err != nil {
		return fmt.Errorf("create index %s: %w", index, err)
	}
	fmt.Println("created index", index)

	f, err := os.Open(cfg.exportPath)
	if err != nil {
		return fmt.Errorf("open export: %w", err)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 1<<20), 8<<20)

	batch := make([]search.Document, 0, cfg.batchSize)
	var indexed, skipped int
	for scanner.Scan() {
		var p product
		if err := json.Unmarshal(scanner.Bytes(), &p); err != nil {
			return fmt.Errorf("decode export line %d: %w", indexed+skipped+len(batch)+1, err)
		}
		if p.Discontinued {
			skipped++
			continue
		}
		batch = append(batch, toDocument(p))
		if len(batch) == cfg.batchSize {
			if err := flush(ctx, client, index, batch); err != nil {
				return err
			}
			indexed += len(batch)
			batch = batch[:0]
			fmt.Printf("indexed %d products\n", indexed)
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read export: %w", err)
	}
	if err := flush(ctx, client, index, batch); err != nil {
		return err
	}
	indexed += len(batch)

	previous, err := client.SwapAlias(ctx, cfg.alias, index)
	if err != nil {
		return fmt.Errorf("point %s at %s: %w", cfg.alias, index, err)
	}
	fmt.Println("alias", cfg.alias, "now serves", index, "with", indexed, "products,", skipped, "discontinued skipped")

	// TODO(dkowalski): keep the last two indexes instead of one so a bad export can be rolled back by hand.
	if previous != "" && !cfg.keepOld {
		if err := client.DeleteIndex(ctx, previous); err != nil {
			return fmt.Errorf("delete previous index %s: %w", previous, err)
		}
		fmt.Println("deleted", previous)
	}
	return nil
}

// flush sends one bulk request. An empty batch is a no-op so the final,
// possibly empty, remainder can be flushed unconditionally.
func flush(ctx context.Context, client indexer, index string, batch []search.Document) error {
	if len(batch) == 0 {
		return nil
	}
	if err := client.Bulk(ctx, index, batch); err != nil {
		return fmt.Errorf("bulk index into %s: %w", index, err)
	}
	return nil
}

func toDocument(p product) search.Document {
	return search.Document{
		ID: p.SKU,
		Fields: map[string]any{
			"title":       p.Title,
			"description": p.Description,
			"brand":       strings.ToLower(p.Brand),
			"categories":  p.Categories,
			"price":       float64(p.PriceCents) / 100,
			"in_stock":    p.InStock,
		},
	}
}
