# Visual Intelligence Audit

JB Expert QA's visual audit is deterministic and local-first. The default visual pipeline does not call an AI provider and does not upload page screenshots or source code to an AI service.

## Core checks

- Interactive overlap and hit-test obstruction checks using DOM geometry, elementsFromPoint, and stacking information.
- Text clipping inside controls and clipping by ancestor containers.
- Viewport overflow and fixed-width elements on small screens.
- Container width measurements and a conservative warning for unusually constrained primary desktop content.
- Light/dark theme contrast, theme token inspection, and optional theme round-trip stability checks.
- Visible UI localization checks for high-confidence opposite-language phrases, including text, aria-label, aria-description, title, placeholder, image alt, data-tooltip, and submit/button input values.
- Axe accessibility checks and optional interaction-state exploration.
- Screenshot evidence and visual regression comparisons when a baseline is supplied.

## Suggested runs

Standard responsive matrix, both themes, Spanish interface:

    npx jb-qa-url https://example.com --matrix --language=es --format=html --output=qa-report.html

Full viewport matrix (320px through 1920px), both themes, and interaction exploration:

    npx jb-qa-url https://example.com --full-matrix --language=es --format=json --output=qa-full.json

English interface:

    npx jb-qa-url https://example.com --matrix --language=en

Preserve project-specific technical terms:

    npx jb-qa-url https://example.com --matrix --language=es --preserve-term=landing\ page

Optional emergency AI review (not used by default):

    npx jb-qa-url https://example.com --matrix --screenshots=.jb-expert-qa/evidence --ai-visual-fallback

## Localization behavior

The audit uses the document's html[lang] by default. Pass --language=es or --language=en when auditing a specific language version. High-confidence phrase markers are used to avoid classifying every English-looking word as a translation defect. The default glossary preserves established terms such as landing page; add project-specific terms with repeated --preserve-term options. Ambiguous wording is reported for human review rather than rewritten automatically.

## Theme behavior

--matrix checks light and dark themes across mobile, tablet, and desktop viewports. --full-matrix expands the viewport set to small phones, phones, tablets, laptops, desktops, and wide monitors. Theme overrides can be configured with --theme-attribute and --theme-storage-key when a project uses a custom theme switch.

## Limits

Browser automation simulates viewport sizes; it does not certify every physical device or browser. Complex gradients, images, canvas content, shadow DOM, cross-origin frames, and dynamic text may require manual review. The localization scanner is deterministic and phrase-based; it reports likely untranslated strings but does not judge all linguistic nuance or automatically translate content. A missing baseline is not a passing visual-regression result.
