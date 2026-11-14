# Local product catalog and search index

The catalog is persisted inside the Knowledge Store snapshot (schema v2), alongside but separate from the append-only evidence ledger. Fragrance and technology products are normalized by their own adapters. Product IDs are unique across both domains; evidence IDs referenced by a product must already exist in the evidence ledger.

`CatalogIndex` is a rebuildable in-memory index. It indexes the product records already stored locally; it is never an independent source of truth and requires no network. Search is case/diacritic insensitive, deterministic, domain-filtered, bounded to 50 results, and only inspects domain allowlisted fields. Exact IDs, models, names, aliases and brands rank ahead of token matches. Each result includes matched fields and an explanation.`

`findPotentialDuplicates()` only reports possible identity collisions for human review. It never merges or deletes records. To avoid accidental changes to trusted facts, the initial catalog API is append-only: existing product IDs cannot be overwritten. A future edit workflow must be explicit and evidence-aware.`

## Search usage

```js
const store = await KnowledgeStore.open({ adapter });
await store.addProduct({
  id: "s24-ultra",
  domain: "technology",
  name: "Galaxy S24 Ultra",
  brand: "Samsung",
  model: "SM-S928B",
  aliases: ["S24 Ultra"],
  deviceType: "smartphone",
  attributes: { ramGB: 12, storageGB: 256, chipset: "Snapdragon 8 Gen 3" },
  evidenceIds: {},
});
const matches = store.searchProducts({
  query: "Samsung S24 Ultra",
  domain: "technology",
  deviceType: "smartphone",
  limit: 10,
});
```

## Persistence and migration

Schema v1 snapshots migrate to v2 by adding an empty catalog without altering existing evidence. v0 snapshots migrate through v1. SQLite persists the same versioned JSON snapshot transactionally; native SQLite runtime validation still requires an Android build/device test. Backups merge new product and evidence IDs without overwriting existing records. Conflicting IDs block the entire import.
