
# Perfume Notes Database: perfumes, fragrance ingredients and notes (Scento)

Perfume notes and fragrance ingredients database: top, heart and base notes for 1,500+ perfumes, 160+ houses and 450+ raw materials, traced to house pages and authorized retailers. Browse it at https://www.scento.com/perfume-database or query it through the free API at https://www.scento.com/developers/perfume-api.

Scento's verified perfume database as an open dataset: perfumes, the houses that make them and the raw materials (notes) they are built from, with fragrance family, character, season, time of day and the note pyramid where one exists.

It is the same data that powers the free Scento Perfume API and its MCP server.

- Live API and docs: https://www.scento.com/developers
- Browse the database: https://www.scento.com/perfume-database
- Publisher: Scento, https://www.scento.com

## Files

| File | Rows | Contents |
|---|---|---|
| `perfumes.csv` / `perfumes.jsonl` | 1,479 | One row per perfume. The JSONL file has the same rows with list fields as arrays. |
| `houses.csv` | 160 | Perfume houses with country, founding year and a one-line portrait. |
| `materials.csv` | 420 | Raw materials, accords and notes with aliases, material family, origin and smell description. |
| `datapackage.json` | | Frictionless Data descriptor for all tables. |

The Scento Perfume API covers 1,500+ perfumes, 160+ houses and 450+ raw materials; this snapshot (29 October 2026) exports every entry that has a public page on scento.com.

## Fields

`perfumes`: `id`, `name`, `house_id`, `house`, `year`, `perfumers`, `concentration`, `family`, `secondary_family`, `character`, `seasons`, `times_of_day`, `top_notes`, `heart_notes`, `base_notes`, `notes` (all notes, flat), `description`, `popularity_rank` (1 = best known), `url`. List-valued CSV fields are separated by `; `. Year, perfumers and the pyramid are filled only where verified; empty means not recorded.

`houses`: `id`, `name`, `country`, `founded`, `type`, `portrait`, `perfume_count`, `url`.

`materials`: `id`, `name`, `aliases`, `material_family`, `origin` (natural, synthetic, both or accord), `smell`, `url`.

Every row has a `url` that points to the matching page on https://www.scento.com.

## Sources policy

Facts are taken from the perfume houses' own pages and from authorized retailers, then checked before they enter the database. Descriptions are written by Scento. No third-party text is reproduced and no source texts are included.

## License and attribution

Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/

Attribute as: **Scento — https://www.scento.com/perfume-database**

## Citation

Scento. Scento Perfume Database (2026-10-29). https://www.scento.com/perfume-database
