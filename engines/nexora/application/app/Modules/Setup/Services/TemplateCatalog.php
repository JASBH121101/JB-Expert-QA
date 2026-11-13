<?php

namespace App\Modules\Setup\Services;

use App\Models\CatalogCategory;
use App\Models\CatalogGroup;
use App\Models\ProductFieldDefinition;
use Illuminate\Support\Str;

final class TemplateCatalog
{
    public const VERSION = 3;

    public function all(string $locale = 'es'): array
    {
        $templates = [
            'perfumery' => 'Perfumería',
            'fashion' => 'Ropa y calzado',
            'technology' => 'Tecnología',
            'gym' => 'Gimnasio y fitness',
            'automotive' => 'Repuestos y vehículos',
            'grocery' => 'Alimentos y abarrotes',
            'other' => 'Catálogo personalizado',
        ];

        if ($locale === 'en') {
            return [
                'perfumery' => 'Perfumery',
                'fashion' => 'Clothing & footwear',
                'technology' => 'Technology',
                'gym' => 'Gym & fitness',
                'automotive' => 'Auto parts & vehicles',
                'grocery' => 'Food & groceries',
                'other' => 'Custom catalog',
            ];
        }

        return $templates;
    }

    public function version(): int
    {
        return self::VERSION;
    }

    public function previews(string $locale = 'es'): array
    {
        $previews = [];

        foreach ($this->all($locale) as $type => $label) {
            $definition = $this->definition($type, $locale);
            $groups = [];

            foreach ($definition['categories'] as $categoryName => $categoryGroups) {
                foreach ($categoryGroups as $group) {
                    $groups[] = [
                        'category' => $categoryName,
                        'name' => $group['name'],
                        'fields' => array_values(array_map(
                            static fn (array $field): string => $field['label'],
                            $group['fields'],
                        )),
                    ];
                }
            }

            $previews[$type] = [
                'label' => $label,
                'categories' => array_keys($definition['categories']),
                'groups' => $groups,
            ];
        }

        return $previews;
    }

    public function seed(string $type, string $locale = 'es'): void
    {
        $template = $this->definition($type, $locale);

        $categoryOrder = 0;

        foreach ($template['categories'] as $categoryName => $categoryGroups) {
            $category = CatalogCategory::query()->firstOrCreate(
                ['slug' => Str::slug($categoryName)],
                [
                    'name' => $categoryName,
                    'sort_order' => $categoryOrder++,
                    'is_active' => true,
                ],
            );

            foreach ($categoryGroups as $groupIndex => $groupDefinition) {
                $group = CatalogGroup::query()->firstOrCreate(
                    [
                        'category_id' => $category->id,
                        'name' => $groupDefinition['name'],
                    ],
                    ['sort_order' => $groupIndex],
                );

                foreach ($groupDefinition['fields'] as $fieldIndex => $field) {
                    if (ProductFieldDefinition::query()->where('field_key', $field['key'])->exists()) {
                        continue;
                    }

                    ProductFieldDefinition::query()->create([
                        'group_id' => $group->id,
                        'field_key' => $field['key'],
                        'label' => $field['label'],
                        'field_type' => $field['type'],
                        'options' => $field['options'] ?? null,
                        'unit_dimension' => $field['dimension'] ?? null,
                        'unit_code' => $field['unit'] ?? null,
                        'is_required' => false,
                        'is_public' => true,
                        'is_searchable' => $field['searchable'] ?? false,
                        'width' => 'half',
                        'sort_order' => $fieldIndex,
                    ]);
                }
            }
        }
    }

    private function definition(string $type, string $locale = 'es'): array
    {
        $text = static fn (string $key, string $label, bool $searchable = false): array => [
            'key' => $key, 'label' => $label, 'type' => 'text', 'searchable' => $searchable,
        ];
        $textarea = static fn (string $key, string $label): array => [
            'key' => $key, 'label' => $label, 'type' => 'textarea',
        ];
        $number = static fn (string $key, string $label, string $dimension, string $unit): array => [
            'key' => $key, 'label' => $label, 'type' => 'number',
            'dimension' => $dimension, 'unit' => $unit,
        ];
        $select = static fn (string $key, string $label, array $options): array => [
            'key' => $key, 'label' => $label, 'type' => 'select', 'options' => $options,
        ];
        $date = static fn (string $key, string $label): array => [
            'key' => $key, 'label' => $label, 'type' => 'date',
        ];

        $definition = match ($type) {
            'perfumery' => [
                'categories' => [
                    'Perfumes' => [[
                        'name' => 'Clasificación y fragancia',
                        'fields' => [
                            $select('perfume_type', 'Tipo de producto', ['Original', 'Inspiración', 'Genérico']),
                            $text('brand', 'Marca comercial', true),
                            $text('inspired_by', 'Fragancia de referencia', true),
                            $select('concentration', 'Concentración', ['EDT', 'EDP', 'Parfum', 'Extrait']),
                            $number('content', 'Contenido', 'volume', 'ml'),
                            $select('audience', 'Público', ['Mujer', 'Hombre', 'Unisex']),
                            $select('olfactory_family', 'Familia olfativa', ['Floral', 'Amaderada', 'Cítrica', 'Oriental', 'Aromática', 'Dulce', 'Fresca', 'Chipre', 'Cuero', 'Otra']),
                            $textarea('olfactory_notes', 'Notas olfativas'),
                        ],
                    ]],
                    'Body mist' => [[
                        'name' => 'Detalles del body mist',
                        'fields' => [
                            $text('body_mist_brand', 'Marca comercial', true),
                            $text('body_mist_aroma', 'Aroma', true),
                            $number('body_mist_content', 'Contenido', 'volume', 'ml'),
                            $select('body_mist_audience', 'Público', ['Mujer', 'Hombre', 'Unisex']),
                            $select('body_mist_family', 'Familia olfativa', ['Floral', 'Frutal', 'Cítrica', 'Dulce', 'Fresca', 'Amaderada', 'Otra']),
                        ],
                    ]],
                    'Sets' => [[
                        'name' => 'Contenido del set',
                        'fields' => [
                            $text('set_brand', 'Marca comercial', true),
                            $textarea('set_contents', 'Productos incluidos'),
                            $number('set_items_count', 'Cantidad de piezas', 'count', 'piezas'),
                            $select('set_audience', 'Público', ['Mujer', 'Hombre', 'Unisex']),
                        ],
                    ]],
                ],
            ],
            'fashion' => [
                'categories' => [
                    'Ropa' => [[
                        'name' => 'Detalles de la prenda',
                        'fields' => [
                            $text('brand', 'Marca', true),
                            $text('size', 'Talla', true),
                            $text('color', 'Color', true),
                            $text('material', 'Material'),
                            $select('fit', 'Corte', ['Regular', 'Slim', 'Oversize', 'Holgado']),
                        ],
                    ]],
                    'Calzado' => [[
                        'name' => 'Detalles del calzado',
                        'fields' => [
                            $text('footwear_brand', 'Marca', true),
                            $text('footwear_size', 'Talla', true),
                            $text('footwear_color', 'Color', true),
                            $text('footwear_material', 'Material'),
                            $text('footwear_type', 'Tipo de calzado'),
                        ],
                    ]],
                    'Accesorios' => [[
                        'name' => 'Detalles del accesorio',
                        'fields' => [
                            $text('fashion_accessory_brand', 'Marca', true),
                            $text('fashion_accessory_type', 'Tipo', true),
                            $text('fashion_accessory_color', 'Color', true),
                            $text('fashion_accessory_material', 'Material'),
                        ],
                    ]],
                ],
            ],
            'technology' => [
                'categories' => [
                    'Teléfonos' => [[
                        'name' => 'Especificaciones del teléfono',
                        'fields' => [
                            $text('brand', 'Marca', true),
                            $text('model', 'Modelo', true),
                            $number('ram', 'Memoria RAM', 'digital', 'GB'),
                            $number('storage', 'Almacenamiento', 'digital', 'GB'),
                            $number('screen_size', 'Tamaño de pantalla', 'length', 'pulgadas'),
                            $text('battery', 'Batería'),
                        ],
                    ]],
                    'Computadoras' => [[
                        'name' => 'Especificaciones de la computadora',
                        'fields' => [
                            $text('computer_brand', 'Marca', true),
                            $text('computer_model', 'Modelo', true),
                            $text('computer_processor', 'Procesador', true),
                            $number('computer_ram', 'Memoria RAM', 'digital', 'GB'),
                            $number('computer_storage', 'Almacenamiento', 'digital', 'GB'),
                            $text('computer_graphics', 'Gráficos'),
                        ],
                    ]],
                    'Accesorios' => [[
                        'name' => 'Compatibilidad y detalles',
                        'fields' => [
                            $text('technology_accessory_brand', 'Marca', true),
                            $text('technology_accessory_model', 'Modelo', true),
                            $text('compatibility', 'Compatibilidad', true),
                            $text('connector', 'Conector'),
                        ],
                    ]],
                ],
            ],
            'gym' => [
                'categories' => [
                    'Equipos' => [[
                        'name' => 'Detalles del equipo',
                        'fields' => [
                            $text('brand', 'Marca', true),
                            $text('material', 'Material'),
                            $number('weight', 'Peso', 'weight', 'kg'),
                            $text('dimensions', 'Dimensiones'),
                            $text('capacity', 'Capacidad'),
                        ],
                    ]],
                    'Accesorios' => [[
                        'name' => 'Detalles del accesorio',
                        'fields' => [
                            $text('fitness_accessory_brand', 'Marca', true),
                            $text('fitness_accessory_material', 'Material'),
                            $text('fitness_accessory_size', 'Tamaño'),
                            $text('fitness_accessory_color', 'Color'),
                        ],
                    ]],
                    'Ropa deportiva' => [[
                        'name' => 'Detalles de la ropa deportiva',
                        'fields' => [
                            $text('sportswear_brand', 'Marca', true),
                            $text('sportswear_size', 'Talla', true),
                            $text('sportswear_color', 'Color', true),
                            $text('sportswear_material', 'Material'),
                        ],
                    ]],
                ],
            ],
            'automotive' => [
                'categories' => [
                    'Repuestos' => [[
                        'name' => 'Identificación del repuesto',
                        'fields' => [
                            $text('part_brand', 'Marca del repuesto', true),
                            $text('part_reference', 'Referencia', true),
                            $text('part_compatibility', 'Compatibilidad', true),
                            $text('part_condition', 'Condición'),
                        ],
                    ]],
                    'Vehículos' => [[
                        'name' => 'Ficha técnica del vehículo',
                        'fields' => [
                            $text('brand', 'Marca', true),
                            $text('model', 'Modelo', true),
                            ['key' => 'year', 'label' => 'Año', 'type' => 'number'],
                            $number('engine_displacement', 'Cilindraje', 'displacement', 'cc'),
                            $text('compatibility', 'Compatibilidad'),
                            $select('fuel_type', 'Combustible', ['Gasolina', 'Diésel', 'Híbrido', 'Eléctrico', 'Otro']),
                            $select('transmission', 'Transmisión', ['Manual', 'Automática', 'CVT', 'Otra']),
                        ],
                    ]],
                    'Accesorios' => [[
                        'name' => 'Detalles del accesorio automotriz',
                        'fields' => [
                            $text('automotive_accessory_brand', 'Marca', true),
                            $text('automotive_accessory_compatibility', 'Compatibilidad', true),
                            $text('automotive_accessory_material', 'Material'),
                        ],
                    ]],
                ],
            ],
            'grocery' => [
                'categories' => [
                    'Alimentos' => [[
                        'name' => 'Detalles del alimento',
                        'fields' => [
                            $text('brand', 'Marca', true),
                            $number('net_content', 'Contenido neto', 'volume', 'ml'),
                            $text('presentation', 'Presentación'),
                            $date('expiration_date', 'Fecha de vencimiento'),
                        ],
                    ]],
                    'Bebidas' => [[
                        'name' => 'Detalles de la bebida',
                        'fields' => [
                            $text('beverage_brand', 'Marca', true),
                            $number('beverage_content', 'Contenido', 'volume', 'ml'),
                            $text('beverage_flavor', 'Sabor', true),
                            $text('beverage_presentation', 'Presentación'),
                        ],
                    ]],
                    'Abarrotes' => [[
                        'name' => 'Detalles del producto',
                        'fields' => [
                            $text('pantry_brand', 'Marca', true),
                            $number('pantry_weight', 'Peso', 'weight', 'kg'),
                            $text('pantry_unit', 'Unidad de venta'),
                            $text('pantry_presentation', 'Presentación'),
                        ],
                    ]],
                ],
            ],
            default => [
                'categories' => [
                    'General' => [[
                        'name' => 'Detalles',
                        'fields' => [
                            $text('brand', 'Marca', true),
                            $text('reference', 'Referencia', true),
                        ],
                    ]],
                ],
            ],
        };

        return $this->translateDefinition($definition, $locale);
    }

    /**
     * Translate presentation labels only. Stable field keys and data types
     * keep the template contract identical in Spanish and English.
     */
    private function translateDefinition(array $definition, string $locale): array
    {
        if ($locale !== 'en') {
            return $definition;
        }

        $translations = [
            'Perfumes' => 'Perfumes', 'Body mist' => 'Body mist', 'Sets' => 'Sets',
            'Ropa' => 'Clothing', 'Calzado' => 'Footwear', 'Accesorios' => 'Accessories',
            'Teléfonos' => 'Phones', 'Computadoras' => 'Computers', 'Equipos' => 'Equipment',
            'Ropa deportiva' => 'Sportswear', 'Repuestos' => 'Auto parts', 'Vehículos' => 'Vehicles',
            'Alimentos' => 'Food', 'Bebidas' => 'Drinks', 'Abarrotes' => 'Groceries',
            'General' => 'General',
            'Clasificación y fragancia' => 'Classification & fragrance',
            'Detalles del body mist' => 'Body mist details',
            'Contenido del set' => 'Set contents',
            'Detalles de la prenda' => 'Clothing details',
            'Detalles del calzado' => 'Footwear details',
            'Detalles del accesorio' => 'Accessory details',
            'Especificaciones del teléfono' => 'Phone specifications',
            'Especificaciones de la computadora' => 'Computer specifications',
            'Compatibilidad y detalles' => 'Compatibility & details',
            'Detalles del equipo' => 'Equipment details',
            'Detalles del accesorio automotriz' => 'Automotive accessory details',
            'Identificación del repuesto' => 'Auto part identification',
            'Ficha técnica del vehículo' => 'Vehicle specifications',
            'Detalles del alimento' => 'Food details',
            'Detalles de la bebida' => 'Drink details',
            'Detalles del producto' => 'Product details',
            'Detalles' => 'Details',
            'Tipo de producto' => 'Product type',
            'Marca comercial' => 'Brand',
            'Fragancia de referencia' => 'Inspired-by fragrance',
            'Concentración' => 'Concentration',
            'Contenido' => 'Volume',
            'Público' => 'Audience',
            'Familia olfativa' => 'Fragrance family',
            'Notas olfativas' => 'Fragrance notes',
            'Aroma' => 'Scent',
            'Productos incluidos' => 'Included products',
            'Cantidad de piezas' => 'Number of pieces',
            'Marca' => 'Brand',
            'Talla' => 'Size',
            'Color' => 'Color',
            'Material' => 'Material',
            'Corte' => 'Fit',
            'Tipo de calzado' => 'Footwear type',
            'Tipo' => 'Type',
            'Modelo' => 'Model',
            'Memoria RAM' => 'RAM',
            'Almacenamiento' => 'Storage',
            'Tamaño de pantalla' => 'Screen size',
            'Batería' => 'Battery',
            'Procesador' => 'Processor',
            'Gráficos' => 'Graphics',
            'Compatibilidad' => 'Compatibility',
            'Conector' => 'Connector',
            'Peso' => 'Weight',
            'Dimensiones' => 'Dimensions',
            'Capacidad' => 'Capacity',
            'Tamaño' => 'Size',
            'Marca del repuesto' => 'Part brand',
            'Referencia' => 'Reference',
            'Condición' => 'Condition',
            'Año' => 'Year',
            'Cilindraje' => 'Engine displacement',
            'Combustible' => 'Fuel',
            'Transmisión' => 'Transmission',
            'Contenido neto' => 'Net content',
            'Presentación' => 'Packaging',
            'Fecha de vencimiento' => 'Expiration date',
            'Sabor' => 'Flavor',
            'Unidad de venta' => 'Sales unit',
            'Original' => 'Original', 'Inspiración' => 'Inspired', 'Genérico' => 'Generic',
            'Mujer' => 'Women', 'Hombre' => 'Men', 'Unisex' => 'Unisex',
            'Floral' => 'Floral', 'Amaderada' => 'Woody', 'Cítrica' => 'Citrus',
            'Oriental' => 'Oriental', 'Aromática' => 'Aromatic', 'Dulce' => 'Sweet',
            'Fresca' => 'Fresh', 'Chipre' => 'Chypre', 'Cuero' => 'Leather',
            'Otra' => 'Other', 'Frutal' => 'Fruity',
            'Regular' => 'Regular', 'Slim' => 'Slim', 'Oversize' => 'Oversized',
            'Holgado' => 'Loose', 'Gasolina' => 'Gasoline', 'Diésel' => 'Diesel',
            'Híbrido' => 'Hybrid', 'Eléctrico' => 'Electric', 'Manual' => 'Manual',
            'Automática' => 'Automatic', 'CVT' => 'CVT', 'Otro' => 'Other',
            'piezas' => 'pieces', 'pulgadas' => 'inches',
        ];

        $translate = static fn (string $value): string => $translations[$value] ?? $value;
        $translatedCategories = [];

        foreach ($definition['categories'] as $categoryName => $groups) {
            $translatedGroups = [];

            foreach ($groups as $group) {
                $group['name'] = $translate($group['name']);

                foreach ($group['fields'] as $index => $field) {
                    $field['label'] = $translate($field['label']);

                    if (isset($field['options']) && is_array($field['options'])) {
                        $field['options'] = array_map($translate, $field['options']);
                    }

                    if (isset($field['unit'])) {
                        $field['unit'] = $translate($field['unit']);
                    }

                    $group['fields'][$index] = $field;
                }

                $translatedGroups[] = $group;
            }

            $translatedCategories[$translate($categoryName)] = $translatedGroups;
        }

        $definition['categories'] = $translatedCategories;

        return $definition;
    }
}
