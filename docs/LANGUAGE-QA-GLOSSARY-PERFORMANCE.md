# Language QA glossary coverage and performance

The default glossary includes common product-administration terms for customers, suppliers, orders, delivery, warehouses, purchases, sales, invoices, discounts, taxes and common actions. Spanish alternatives retain common Latin-American/Nicaraguan variants where appropriate.

`LanguageLibrary` snapshots custom glossary entries and precompiles Unicode-aware word-boundary matchers per supported glossary language pair. This avoids rebuilding regular expressions for each translation key. Suggestions remain terminology hints, are not complete translations, and always require human review. Unsupported glossary language pairs still return no automatic suggestion.

Performance claims are made only from repeated benchmark runs on the same Node version and runner. The checked-in benchmark is environment-dependent and its heap delta is approximate, not retained-memory profiling.
