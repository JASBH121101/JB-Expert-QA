# Language QA text encoding integrity

The semantic audit now reports deterministic signals for newly introduced Unicode replacement characters (U+FFFD) and non-whitespace control characters. It also flags a small set of common mojibake byte-decoding signatures as a heuristic review signal.

These checks compare source and target text and never rewrite content. A replacement character or control character is treated as a mechanical warning; mojibake detection is heuristic and can produce false positives. Normal accented Spanish text and emoji are not treated as corruption by these rules. All findings remain subject to human review.

Language QA still does not claim to assess native-speaker fluency, tone, meaning, or cultural suitability. Those require qualified human review or a separately approved language provider.
