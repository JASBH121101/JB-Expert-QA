# NEXORA Template Engine

## Scope

The template engine defines the initial category tree and the dynamic product fields for a business type. It is independent from the admin-panel presentation and the public-catalog presentation.

## Data model

- `catalog_categories` stores the product categories used by the catalogue.
- `catalog_groups.category_id` scopes a group to one category.
- A null `catalog_groups.category_id` means the group is shared by all categories. This preserves support for common attributes and legacy groups created before category scoping existed.
- `product_field_definitions` stores the typed fields in a group.
- `product_field_values` stores each product's value by field definition.

A category-specific field is available only when the product belongs to the group's category. Shared groups remain available regardless of the selected category.

## Product workflow

1. The product form receives all groups and their category relationships.
2. The category selector displays shared groups and groups assigned to the selected category.
3. The server independently calculates the allowed field keys from the submitted category. Hidden fields from another category are rejected.
4. The product write synchronizes only values belonging to shared groups and the selected category.
5. Values belonging to other category groups are retained when a product changes category. If the product is moved back later, those values are still available.
6. The public product detail and searchable-field query expose only public fields from shared groups and the product's current category.

The browser visibility logic is a convenience only; server-side validation and public-query filtering enforce the category boundary.

## Template definitions

`App\\Modules\\Setup\\Services\\TemplateCatalog` is the single source of truth for template categories and field groups. Its preview output and seed operation are generated from the same definition.

Each template defines groups under a category name. Field keys remain globally unique within the installation because `product_field_definitions.field_key` has a unique constraint. When adding fields, use stable, descriptive keys that do not collide with fields in another category of the same template.

Template version 2 introduces category-scoped groups. Newly installed templates store `configuration.templateVersion = 2`.

## Perfume classification

The Perfumes category includes a product-type field with the options:

- Original
- Inspiración
- Genérico

Inspirations have a separate optional reference-fragrance field. This is a catalogue classification; it must not be used to claim a product is authentic or affiliated with another brand. The public catalogue should display the chosen classification transparently.

Body mist and Sets have their own field groups. They do not inherit perfume-only attributes such as concentration or reference fragrance.

## Safe upgrades

The version 2 migration is additive: it adds a nullable foreign key to `catalog_groups`. Existing groups are left with null `category_id`, so they continue working as shared groups. Existing product rows, field definitions, and field values are not rewritten or deleted.

Do not implement template upgrades by truncating categories, groups, field definitions, or product values. Future template updates must use additive, idempotent operations and preserve unknown/custom fields. A category deletion is restricted while category-specific groups reference it; deactivate the category instead.

## Extension checklist

When adding or changing a template:

1. Add the category and its group/field definitions in `TemplateCatalog::definition()`.
2. Use unique stable field keys within that template.
3. Keep fields optional by default unless the domain absolutely requires them.
4. Add feature tests for category-to-group ownership, field validation, and public visibility.
5. Verify a product category change preserves values from other category groups.
6. Increment `TemplateCatalog::VERSION` only when a new template definition version is introduced.
