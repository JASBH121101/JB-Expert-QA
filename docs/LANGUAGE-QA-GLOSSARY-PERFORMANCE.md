# Language QA glossary coverage and performance

The default glossary includes common product-administration terms for customers, suppliers, orders, delivery, warehouses, purchases, sales, invoices, discounts, taxes and common actions. Spanish alternatives retain common Latin-American/Nicaraguan variants where appropriate.

`LanguageLibrary` snapshots custom glossary entries and precompiles Unicode-aware word-boundary matchers per supported glossary language pair. This avoids rebuilding regular expressions for each translation key. Suggestions remain terminology hints, are not complete translations, and always require human review. Unsupported glossary language pairs still return no automatic suggestion.

`bench/glossary-matchers.js` exercises both suggestion and consistency checks with deterministic workloads of 250, 1,000 and 2,500 messages. CI runs the same harness against baseline commit `c5869b4c40218c8401e59db7b04bf6d19c5dcccd` and the candidate on the same Ubuntu runner and Node.js version. Results report mean, P95 and mean time per 1,000 messages. Timing is environment-dependent and should be interpreted as a comparative signal, not a guarantee of user-perceived speedup.

The benchmark does not measure native-speaker translation quality, retained memory, or end-to-end application rendering. Glossary suggestions are terminology hints and never auto-approve text.
