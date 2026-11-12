# Recommendation benchmark

The benchmark has two layers:

1. A deterministic functional regression suite under `tests/recommendation-benchmark.test.js`.
2. A reusable ranking-metrics evaluator in `src/benchmark/ranking-metrics.js` for separately reviewed relevance labels.

## Functional scenarios currently covered

- Technology photography profile: expected camera-first candidate.
- Technology tie handling: equal candidates must return decision `tie` and no winner.
- Technology missing-data handling: low scored coverage must block a winner.
- Fragrance hot/humid profile: repeated equivalent runs must produce identical order and scores.

## Ranking metrics

`evaluateRankingBenchmark()` accepts reviewed benchmark cases containing ranked product IDs, an optional expected winner, and graded relevance labels.

- **Top-1 agreement:** proportion of cases where the top item equals the independently reviewed expected winner.
- **NDCG@K:** ranking quality against graded relevance labels, using logarithmic rank discount.
- **Evidence coverage:** mean percentage of weighted criteria supported by eligible evidence, when supplied by a case.
- **Verified coverage:** mean percentage of weighted criteria backed by verified/cross-checked evidence, when supplied by a case.
- **Slices:** separate summaries by domain and by domain/profile so fragrance cannot hide weak technology performance.

Cases with all-zero relevance are excluded from NDCG rather than being treated as a perfect ranking. A missing expected winner does not enter Top-1 agreement. Metrics describe only supplied benchmark cases; they are not population-level accuracy.

## What is still needed before certification

1. Curate real device and fragrance comparison scenarios with reviewed graded relevance labels.
2. Include multiple product families and price tiers per category.
3. Validate against independent, blind human rankings where possible.
4. Add regression sets for stale/conflicting evidence, provider outages, wrong SKU/region variants and low coverage.
5. Establish minimum sample counts per domain/profile before publishing scores.

No aggregate accuracy score should be published until the benchmark has a sufficiently broad, independently reviewed dataset. The evaluator exists; a representative reviewed dataset and its certification thresholds do not yet exist.
