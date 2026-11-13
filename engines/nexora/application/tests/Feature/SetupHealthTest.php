<?php

namespace Tests\Feature;

use App\Core\Installation\InstallationState;
use App\Models\BusinessContact;
use App\Models\CatalogCategory;
use App\Models\CatalogGroup;
use App\Models\InstallationSettings;
use App\Models\LoginHelpRequest;
use App\Models\Product;
use App\Models\ProductFieldDefinition;
use App\Models\ProductFieldValue;
use App\Models\User;
use App\Modules\Setup\Services\CountryCatalog;
use App\Modules\Setup\Services\CountryDialingCodeCatalog;
use App\Modules\Setup\Services\TemplateCatalog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Route;
use Tests\TestCase;

class SetupHealthTest extends TestCase
{
    use RefreshDatabase;

    public function test_setup_page_displays_server_preflight_checks(): void
    {
        $response = $this->get('/setup');

        $response->assertOk()
            ->assertSee('Prepara tu catálogo')
            ->assertSee('Versión de PHP')
            ->assertSee('Extensiones PHP')
            ->assertSee('Conexión a la base de datos')
            ->assertSee('Permisos de escritura');
    }

    public function test_setup_page_previews_every_available_template_from_the_template_catalog(): void
    {
        $response = $this->get('/setup');

        $response->assertOk()
            ->assertSee('const templatePreviews =', false)
            ->assertSee('Plantilla seleccionada:', false)
            ->assertSee('Perfumes', false)
            ->assertSee('Body mist', false)
            ->assertSee('Sets', false)
            ->assertDontSee('Cuidado personal', false)
            ->assertDontSee('Sets y estuches', false)
            ->assertSee('Calzado', false)
            ->assertSee('Computadoras', false)
            ->assertSee('Memoria RAM', false)
            ->assertSee('Ropa deportiva', false)
            ->assertSee('Cilindraje', false)
            ->assertSee('Abarrotes', false)
            ->assertSee('"other"', false);
    }

    public function test_every_template_seeds_category_scoped_groups_with_unique_field_keys(): void
    {
        $catalog = app(TemplateCatalog::class);

        foreach (array_keys($catalog->all()) as $type) {
            ProductFieldValue::query()->delete();
            ProductFieldDefinition::query()->delete();
            CatalogGroup::query()->delete();
            CatalogCategory::query()->delete();

            $catalog->seed($type);

            $categories = CatalogCategory::query()
                ->with(['groups.fields'])
                ->orderBy('sort_order')
                ->get();

            $this->assertCount(count($catalog->previews()[$type]['categories']), $categories);

            foreach ($categories as $category) {
                $this->assertNotEmpty($category->groups);

                foreach ($category->groups as $group) {
                    $this->assertSame($category->id, $group->category_id);
                    $this->assertNotEmpty($group->fields);
                }
            }

            $fieldKeys = ProductFieldDefinition::query()->pluck('field_key');
            $this->assertCount($fieldKeys->unique()->count(), $fieldKeys);
        }
    }

    public function test_template_seed_is_idempotent_and_preserves_owner_field_customizations(): void
    {
        $catalog = app(TemplateCatalog::class);
        $catalog->seed('perfumery');

        $categoryCount = CatalogCategory::query()->count();
        $groupCount = CatalogGroup::query()->count();
        $fieldCount = ProductFieldDefinition::query()->count();

        $perfumeType = ProductFieldDefinition::query()
            ->where('field_key', 'perfume_type')
            ->firstOrFail();
        $perfumeType->forceFill(['label' => 'Clasificación comercial personalizada'])->save();

        $catalog->seed('perfumery');

        $this->assertSame($categoryCount, CatalogCategory::query()->count());
        $this->assertSame($groupCount, CatalogGroup::query()->count());
        $this->assertSame($fieldCount, ProductFieldDefinition::query()->count());
        $this->assertSame(
            'Clasificación comercial personalizada',
            $perfumeType->fresh()->label,
        );
    }

    public function test_every_template_preview_groups_fields_under_a_real_category(): void
    {
        $catalog = app(TemplateCatalog::class);

        foreach (array_keys($catalog->all()) as $type) {
            $preview = $catalog->previews()[$type];

            $this->assertNotEmpty($preview['categories']);
            $this->assertNotEmpty($preview['groups']);

            foreach ($preview['groups'] as $group) {
                $this->assertContains($group['category'], $preview['categories']);
                $this->assertNotEmpty($group['fields']);
            }
        }
    }

    public function test_setup_suggests_language_and_country_from_browser_preferences(): void
    {
        $this->withHeader('Accept-Language', 'en-US,en;q=0.9')
            ->get('/setup')
            ->assertOk()
            ->assertSee('value="en" selected', false)
            ->assertSee('data-selected-country="US"', false)
            ->assertSee('const countryDialingCodes =', false)
            ->assertSee('"NI":"+505"', false)
            ->assertSee('Código de país', false)
            ->assertSee('Número móvil', false)
            ->assertSee('country_code', false)
            ->assertSee('const countryCodes =', false);
    }

    public function test_cancelling_setup_does_not_create_any_business_records(): void
    {
        $this->post('/setup/cancel')
            ->assertRedirect(route('setup.show'))
            ->assertSessionHas('status', fn (string $message): bool => str_contains($message, 'No se creó el propietario'));

        $this->assertDatabaseCount('users', 0);
        $this->assertDatabaseCount('installation_settings', 0);
        $this->assertDatabaseCount('business_contacts', 0);
        $this->assertDatabaseCount('business_currencies', 0);
        $this->assertDatabaseCount('catalog_categories', 0);
        $this->assertDatabaseCount('catalog_groups', 0);
    }

    public function test_country_dialing_code_catalog_covers_all_installer_countries(): void
    {
        $dialingCodes = CountryDialingCodeCatalog::all();

        $this->assertCount(count(CountryCatalog::codes()), $dialingCodes);
        $this->assertSame('+505', CountryDialingCodeCatalog::forCountry('NI'));
        $this->assertSame('+1', CountryDialingCodeCatalog::forCountry('US'));
        $this->assertSame('+502', CountryDialingCodeCatalog::forCountry('GT'));
        $this->assertSame('+44', CountryDialingCodeCatalog::forCountry('GB'));
    }

    public function test_setup_normalizes_split_phone_fields_to_international_e164_format(): void
    {
        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));

        $contact = BusinessContact::query()->firstOrFail();

        $this->assertSame('+50588881234', $contact->phone);
        $this->assertSame('+505 8888-1234', $contact->formatted_phone);
    }

    public function test_owner_can_override_the_suggested_calling_code_for_a_contact(): void
    {
        $payload = $this->validSetupPayload();
        $payload['phones'] = [
            ['country_calling_code' => '+1', 'number' => '202 555 0123', 'show_public' => '1'],
        ];

        $this->post('/setup', $payload)->assertRedirect(route('admin.home'));

        $contact = BusinessContact::query()->firstOrFail();

        $this->assertSame('+12025550123', $contact->phone);
        $this->assertSame('+1 202 555 0123', $contact->formatted_phone);
    }

    public function test_setup_suggests_local_primary_currency_for_the_detected_country(): void
    {
        $this->withHeader('Accept-Language', 'es-NI,es;q=0.9')
            ->get('/setup')
            ->assertOk()
            ->assertSee('data-selected-country="NI"', false)
            ->assertSee('data-selected-currency="NIO"', false)
            ->assertSee('NIO', false)
            ->assertSee('"NI":"NIO"', false)
            ->assertSee('"GH":"GHS"', false);
    }

    public function test_setup_persists_primary_and_additional_currencies_and_business_hours(): void
    {
        $payload = $this->validSetupPayload();
        $payload['country_code'] = 'NI';
        $payload['primary_currency'] = 'NIO';
        $payload['additional_currencies'] = ['USD', 'EUR'];
        $payload['business_hours'] = [
            ['day' => 'monday', 'open' => '08:00', 'close' => '17:00'],
            ['day' => 'saturday', 'open' => '09:00', 'close' => '13:00'],
        ];

        $this->post('/setup', $payload)->assertRedirect(route('admin.home'));

        $settings = InstallationSettings::query()->findOrFail(1);

        $this->assertSame('NIO', data_get($settings->configuration, 'pricing.primaryCurrency'));
        $this->assertSame(['NIO', 'USD', 'EUR'], data_get($settings->configuration, 'pricing.enabledCurrencies'));
        $this->assertSame($payload['business_hours'], data_get($settings->configuration, 'operation.hours'));
    }

    public function test_setup_persists_selected_country_and_language_with_installation_settings(): void
    {
        $payload = $this->validSetupPayload();
        $payload['country_code'] = 'US';
        $payload['locale'] = 'en';

        $this->post('/setup', $payload)->assertRedirect(route('admin.home'));

        $settings = InstallationSettings::query()->findOrFail(1);

        $this->assertSame('US', data_get($settings->configuration, 'regional.countryCode'));
        $this->assertSame('en', data_get($settings->configuration, 'regional.locale'));
    }

    public function test_perfumery_template_seeds_only_perfumes_body_mist_and_sets(): void
    {
        $payload = $this->validSetupPayload();
        $payload['business_type'] = 'perfumery';

        $this->post('/setup', $payload)->assertRedirect(route('admin.home'));

        $this->assertDatabaseCount('catalog_categories', 3);
        $this->assertDatabaseHas('catalog_categories', ['name' => 'Perfumes']);
        $this->assertDatabaseHas('catalog_categories', ['name' => 'Body mist']);
        $this->assertDatabaseHas('catalog_categories', ['name' => 'Sets']);
        $this->assertDatabaseMissing('catalog_categories', ['name' => 'Cuidado personal']);
        $this->assertDatabaseMissing('catalog_categories', ['name' => 'Sets y estuches']);

        $concentration = ProductFieldDefinition::query()
            ->where('field_key', 'concentration')
            ->firstOrFail();

        $this->assertSame(['EDT', 'EDP', 'Parfum', 'Extrait'], $concentration->options);

        $perfumes = CatalogCategory::query()->where('name', 'Perfumes')->firstOrFail();
        $bodyMist = CatalogCategory::query()->where('name', 'Body mist')->firstOrFail();
        $sets = CatalogCategory::query()->where('name', 'Sets')->firstOrFail();

        $this->assertDatabaseHas('catalog_groups', [
            'category_id' => $perfumes->id,
            'name' => 'Clasificación y fragancia',
        ]);
        $this->assertDatabaseHas('catalog_groups', [
            'category_id' => $bodyMist->id,
            'name' => 'Detalles del body mist',
        ]);
        $this->assertDatabaseHas('catalog_groups', [
            'category_id' => $sets->id,
            'name' => 'Contenido del set',
        ]);
        $this->assertDatabaseHas('product_field_definitions', ['field_key' => 'perfume_type']);
        $this->assertDatabaseHas('product_field_definitions', ['field_key' => 'inspired_by']);
        $this->assertDatabaseHas('product_field_definitions', ['field_key' => 'olfactory_family']);

        $perfumeType = ProductFieldDefinition::query()->where('field_key', 'perfume_type')->firstOrFail();
        $referenceFragrance = ProductFieldDefinition::query()->where('field_key', 'inspired_by')->firstOrFail();

        $this->assertSame(['Original', 'Inspiración', 'Genérico'], $perfumeType->options);
        $this->assertTrue($referenceFragrance->is_public);
        $this->assertFalse($referenceFragrance->is_required);
        $this->assertDatabaseHas('product_field_definitions', ['field_key' => 'body_mist_aroma']);
        $this->assertDatabaseHas('product_field_definitions', ['field_key' => 'set_contents']);
        $this->assertSame(3, data_get(InstallationSettings::query()->findOrFail(1)->configuration, 'templateVersion'));
    }

    public function test_dynamic_field_groups_are_scoped_to_their_catalog_category(): void
    {
        $payload = $this->validSetupPayload();
        $payload['business_type'] = 'perfumery';

        $this->post('/setup', $payload)->assertRedirect(route('admin.home'));

        $perfumes = CatalogCategory::query()->where('name', 'Perfumes')->firstOrFail();
        $bodyMist = CatalogCategory::query()->where('name', 'Body mist')->firstOrFail();
        $sets = CatalogCategory::query()->where('name', 'Sets')->firstOrFail();

        $perfumeGroup = CatalogGroup::query()
            ->where('category_id', $perfumes->id)
            ->firstOrFail();
        $bodyMistGroup = CatalogGroup::query()
            ->where('category_id', $bodyMist->id)
            ->firstOrFail();
        $setsGroup = CatalogGroup::query()
            ->where('category_id', $sets->id)
            ->firstOrFail();

        $this->assertNotSame($perfumeGroup->id, $bodyMistGroup->id);
        $this->assertSame($perfumes->id, $perfumeGroup->category->id);
        $this->assertSame($bodyMist->id, $bodyMistGroup->category->id);
        $this->assertSame($sets->id, $setsGroup->category->id);

        $this->assertDatabaseHas('product_field_definitions', [
            'group_id' => $perfumeGroup->id,
            'field_key' => 'perfume_type',
        ]);
        $this->assertDatabaseHas('product_field_definitions', [
            'group_id' => $perfumeGroup->id,
            'field_key' => 'inspired_by',
        ]);
        $this->assertDatabaseHas('product_field_definitions', [
            'group_id' => $bodyMistGroup->id,
            'field_key' => 'body_mist_aroma',
        ]);
        $this->assertDatabaseHas('product_field_definitions', [
            'group_id' => $setsGroup->id,
            'field_key' => 'set_contents',
        ]);

        $this->get(route('admin.products.create'))
            ->assertOk()
            ->assertSee('data-field-group', false)
            ->assertSee('data-category-id="'.$perfumes->id.'"', false)
            ->assertSee('data-category-id="'.$bodyMist->id.'"', false)
            ->assertSee('product-category', false);
    }

    public function test_product_validation_rejects_fields_from_another_category(): void
    {
        $payload = $this->validSetupPayload();
        $payload['business_type'] = 'perfumery';

        $this->post('/setup', $payload)->assertRedirect(route('admin.home'));

        $perfumes = CatalogCategory::query()->where('name', 'Perfumes')->firstOrFail();

        $this->post(route('admin.products.store'), [
            'name' => 'Fragancia de inspiración',
            'category_id' => $perfumes->id,
            'description' => 'Fragancia de muestra.',
            'status' => 'draft',
            'prices' => ['USD' => '20.00', 'NIO' => ''],
            'fields' => [
                'perfume_type' => 'Inspiración',
                'brand' => 'Casa de fragancias',
                'inspired_by' => 'Referencia olfativa',
                'concentration' => 'EDP',
                'content' => '100',
                'audience' => 'Unisex',
                'olfactory_family' => 'Amaderada',
                'body_mist_aroma' => 'Campo que pertenece a Body mist',
            ],
        ])->assertSessionHasErrors('fields');

        $this->assertDatabaseMissing('products', ['name' => 'Fragancia de inspiración']);
    }

    public function test_changing_product_category_preserves_values_from_the_previous_category(): void
    {
        $payload = $this->validSetupPayload();
        $payload['business_type'] = 'perfumery';

        $this->post('/setup', $payload)->assertRedirect(route('admin.home'));

        $perfumes = CatalogCategory::query()->where('name', 'Perfumes')->firstOrFail();
        $bodyMist = CatalogCategory::query()->where('name', 'Body mist')->firstOrFail();

        $this->post(route('admin.products.store'), [
            'name' => 'Fragancia de prueba',
            'category_id' => $perfumes->id,
            'description' => 'Fragancia de muestra.',
            'status' => 'published',
            'prices' => ['USD' => '20.00', 'NIO' => ''],
            'fields' => [
                'perfume_type' => 'Inspiración',
                'brand' => 'Casa de fragancias',
                'inspired_by' => 'Referencia olfativa',
                'concentration' => 'EDP',
                'content' => '100',
                'audience' => 'Unisex',
                'olfactory_family' => 'Amaderada',
            ],
        ])->assertRedirect(route('admin.products.index'));

        $product = Product::query()->where('name', 'Fragancia de prueba')->firstOrFail();
        $oldDefinition = ProductFieldDefinition::query()->where('field_key', 'inspired_by')->firstOrFail();

        $this->put(route('admin.products.update', $product), [
            'name' => 'Fragancia de prueba',
            'category_id' => $bodyMist->id,
            'description' => 'Ahora clasificada como body mist.',
            'status' => 'published',
            'prices' => ['USD' => '18.00', 'NIO' => ''],
            'fields' => [
                'body_mist_brand' => 'Casa de fragancias',
                'body_mist_aroma' => 'Aroma fresco',
                'body_mist_content' => '200',
                'body_mist_audience' => 'Unisex',
                'body_mist_family' => 'Fresca',
            ],
        ])->assertRedirect(route('admin.products.index'));

        $product->refresh();

        $this->assertSame($bodyMist->id, $product->category_id);
        $this->assertDatabaseHas('product_field_values', [
            'product_id' => $product->id,
            'field_definition_id' => $oldDefinition->id,
        ]);
        $this->assertDatabaseHas('product_field_values', [
            'product_id' => $product->id,
            'field_definition_id' => ProductFieldDefinition::query()
                ->where('field_key', 'body_mist_aroma')
                ->value('id'),
        ]);

        $this->get(route('site.product', $product->slug))
            ->assertOk()
            ->assertSee('Aroma fresco')
            ->assertDontSee('Referencia olfativa');

        $this->get('/?q=Referencia')
            ->assertOk()
            ->assertDontSee('Fragancia de prueba')
            ->assertSee('No encontramos productos');
    }

    public function test_category_scoped_field_group_can_be_created_and_reassigned(): void
    {
        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));

        $vehicles = CatalogCategory::query()->where('name', 'Vehículos')->firstOrFail();
        $parts = CatalogCategory::query()->where('name', 'Repuestos')->firstOrFail();

        $this->post(route('admin.fields.groups.store'), [
            'name' => 'Datos de garantía',
            'category_id' => $parts->id,
        ])->assertRedirect()->assertSessionHas('status');

        $group = CatalogGroup::query()->where('name', 'Datos de garantía')->firstOrFail();

        $this->assertSame($parts->id, $group->category_id);

        $this->put(route('admin.fields.groups.update', $group), [
            'name' => 'Garantía de vehículos',
            'category_id' => $vehicles->id,
        ])->assertRedirect();

        $this->assertSame($vehicles->id, $group->fresh()->category_id);
    }

    public function test_shared_field_groups_remain_supported_for_legacy_or_common_attributes(): void
    {
        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));

        $group = CatalogGroup::query()->create([
            'category_id' => null,
            'name' => 'Datos comunes',
            'sort_order' => 99,
        ]);

        $this->assertNull($group->fresh()->category_id);
        $this->assertNull($group->category);

        ProductFieldDefinition::query()->create([
            'group_id' => $group->id,
            'field_key' => 'shared_material',
            'label' => 'Material compartido',
            'field_type' => 'text',
            'options' => null,
            'is_required' => false,
            'is_public' => true,
            'is_searchable' => false,
            'width' => 'half',
            'sort_order' => 0,
        ]);

        foreach (CatalogCategory::query()->get() as $category) {
            $this->assertContains(
                'shared_material',
                ProductFieldDefinition::query()
                    ->availableForCategory($category->id)
                    ->pluck('field_key')
                    ->all(),
            );
        }
    }

    public function test_public_site_redirects_to_setup_before_installation_is_completed(): void
    {
        $this->get('/')->assertRedirect(route('setup.show'));
    }

    public function test_setup_view_renders_its_pushed_styles_and_scripts(): void
    {
        $response = $this->get('/setup');

        $response->assertOk()
            ->assertSee('.field-grid', false)
            ->assertSee('@media(max-width:560px)', false)
            ->assertSee('const showStep =', false)
            ->assertSee('minlength="8"', false)
            ->assertSee('data-password-toggle', false)
            ->assertSee('phoneCallingCode', false)
            ->assertSee('updateDefaultPhoneCallingCodes', false)
            ->assertSee('formatPhoneNumber', false)
            ->assertSee('aria-controls="owner-password"', false)
            ->assertSee('aria-controls="owner-password-confirmation"', false);
    }

    public function test_database_schema_can_be_prepared_from_the_setup_screen(): void
    {
        Artisan::shouldReceive('call')
            ->once()
            ->with('migrate', ['--force' => true])
            ->andReturn(0);

        $this->post('/setup/prepare-database')
            ->assertRedirect(route('setup.show'))
            ->assertSessionHas('status');
    }

    public function test_database_preparation_is_blocked_after_installation_is_completed(): void
    {
        InstallationSettings::query()->create([
            'id' => 1,
            'business_name' => 'Tienda de prueba',
            'business_type' => 'other',
            'configuration' => [],
            'setup_completed_at' => now(),
        ]);

        Artisan::shouldReceive('call')->never();

        $this->post('/setup/prepare-database')
            ->assertRedirect(route('admin.login'));
    }

    public function test_completed_installation_displays_public_site_placeholder(): void
    {
        InstallationSettings::query()->create([
            'id' => 1,
            'business_name' => 'Tienda de prueba',
            'business_type' => 'other',
            'configuration' => [],
            'setup_completed_at' => now(),
        ]);

        $this->get('/')
            ->assertOk()
            ->assertSee('Tienda de prueba')
            ->assertSee('CATÁLOGO DIGITAL')
            ->assertDontSee('Versión de PHP')
            ->assertDontSee('Extensiones PHP')
            ->assertDontSee('Conexión a la base de datos')
            ->assertDontSee('Permisos de escritura');
    }

    public function test_setup_page_redirects_after_installation_is_completed(): void
    {
        InstallationSettings::query()->create([
            'id' => 1,
            'business_name' => 'Tienda de prueba',
            'business_type' => 'other',
            'configuration' => [],
            'setup_completed_at' => now(),
        ]);

        $this->get('/setup')->assertRedirect(route('admin.login'));
    }

    public function test_setup_accepts_an_owner_password_with_exactly_eight_characters(): void
    {
        $payload = $this->validSetupPayload();
        $payload['owner_password'] = 'Prueba89';
        $payload['owner_password_confirmation'] = 'Prueba89';

        $this->post('/setup', $payload)
            ->assertRedirect(route('admin.home'));

        $owner = User::query()->where('email', 'owner@example.com')->firstOrFail();

        $this->assertTrue(Hash::check('Prueba89', $owner->password));
    }

    public function test_setup_rejects_an_owner_password_shorter_than_eight_characters(): void
    {
        $payload = $this->validSetupPayload();
        $payload['owner_password'] = 'Prueba8';
        $payload['owner_password_confirmation'] = 'Prueba8';

        $this->from('/setup')
            ->post('/setup', $payload)
            ->assertRedirect('/setup')
            ->assertSessionHasErrors('owner_password');

        $this->assertDatabaseCount('users', 0);
    }

    public function test_setup_creates_one_owner_and_seeds_the_selected_template_atomically(): void
    {
        $response = $this->post('/setup', $this->validSetupPayload());

        $response->assertRedirect(route('admin.home'));
        $this->assertAuthenticated();

        $owner = User::query()->where('email', 'owner@example.com')->firstOrFail();
        $this->assertAuthenticatedAs($owner);
        $this->assertTrue(Hash::check('Strong-Password-2026!', $owner->password));
        $this->assertDatabaseCount('users', 1);
        $this->assertDatabaseHas('installation_settings', [
            'id' => 1,
            'business_name' => 'Tienda de prueba',
            'business_type' => 'automotive',
            'owner_id' => $owner->id,
        ]);

        $this->assertDatabaseCount('catalog_categories', 3);
        $this->assertDatabaseHas('product_field_definitions', [
            'field_key' => 'engine_displacement',
            'unit_dimension' => 'displacement',
            'unit_code' => 'cc',
            'unit_catalog_code' => 'cc',
        ]);
        $this->assertDatabaseHas('business_currencies', [
            'code' => 'USD',
            'is_primary' => 1,
            'is_enabled' => 1,
        ]);
        $this->assertDatabaseHas('business_currencies', [
            'code' => 'NIO',
            'is_primary' => 0,
            'is_enabled' => 1,
        ]);
        $this->assertDatabaseHas('business_contacts', [
            'phone' => '+50588881234',
            'is_primary' => 1,
            'show_public' => 1,
        ]);
    }


    public function test_template_seed_keeps_legacy_unit_labels_and_stores_canonical_unit_codes(): void
    {
        $catalog = app(TemplateCatalog::class);
        $catalog->seed('technology', 'en');

        $this->assertDatabaseHas('product_field_definitions', [
            'field_key' => 'screen_size',
            'unit_code' => 'inches',
            'unit_catalog_code' => 'in',
        ]);
    }

    public function test_second_setup_attempt_cannot_create_another_owner(): void
    {
        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));
        auth()->logout();

        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.login'));

        $this->assertDatabaseCount('users', 1);
    }

    public function test_only_the_installed_owner_can_open_the_admin_panel(): void
    {
        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));
        auth()->logout();

        $intruder = User::query()->create([
            'name' => 'Usuario ajeno',
            'email' => 'intruder@example.com',
            'password' => 'Another-Strong-Password-2026!',
        ]);

        $this->actingAs($intruder)->get('/admin')->assertForbidden();
    }

    public function test_login_help_request_is_available_without_authentication(): void
    {
        $response = $this->post('/admin/login/help', [
            'username' => 'empleado01',
            'reason' => 'forgot_password',
            'details' => 'No recuerdo la contraseña.',
        ]);

        $response->assertRedirect(route('admin.login'))
            ->assertSessionHas('status');
        $this->assertDatabaseHas('login_help_requests', [
            'username' => 'empleado01',
            'reason' => 'forgot_password',
            'status' => 'pending',
        ]);
    }

    public function test_owner_can_create_employee_with_temporary_password_required_to_change(): void
    {
        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));

        $response = $this->post('/admin/employees', [
            'name' => 'Empleado de prueba',
            'username' => 'empleado01',
            'email' => 'employee@example.com',
        ]);

        $temporaryPassword = null;

        $response->assertRedirect()->assertSessionHas(
            'employee_credentials_once',
            function (array $credentials) use (&$temporaryPassword): bool {
                $temporaryPassword = $credentials['password'] ?? null;

                return filled($temporaryPassword);
            },
        );

        $employee = User::query()->where('username', 'empleado01')->firstOrFail();
        $this->assertSame('employee', $employee->role);
        $this->assertTrue($employee->must_change_password);
        $this->assertTrue(Hash::check($temporaryPassword, $employee->password));

        $this->post('/admin/logout')->assertRedirect(route('admin.login'));

        $this->post('/admin/login', [
            'username' => 'empleado01',
            'password' => $temporaryPassword,
        ])->assertRedirect(route('admin.home'));

        $this->get('/admin')->assertRedirect(route('admin.password.change'));

        $this->post('/admin/password/change', [
            'current_password' => $temporaryPassword,
            'password' => 'Employee-New-Password-2026!',
            'password_confirmation' => 'Employee-New-Password-2026!',
        ])->assertRedirect(route('admin.home'));

        $this->assertFalse($employee->fresh()->must_change_password);
        $this->get('/admin/employees')->assertForbidden();
        $this->get('/admin/access-requests')->assertForbidden();
    }

    public function test_owner_can_assign_only_known_permissions_to_an_employee(): void
    {
        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));

        $this->post('/admin/employees', [
            'name' => 'Empleado de prueba',
            'username' => 'empleado01',
            'email' => 'employee@example.com',
        ])->assertRedirect();

        $employee = User::query()->where('username', 'empleado01')->firstOrFail();

        $this->post(route('admin.employees.permissions', $employee), [
            'permissions' => ['catalog.view', 'catalog.manage'],
        ])->assertRedirect();

        $employee = $employee->fresh();

        $this->assertSame(['catalog.view', 'catalog.manage'], $employee->permissions);
        $this->assertTrue($employee->hasPermission('catalog.view'));
        $this->assertTrue($employee->hasPermission('catalog.manage'));
        $this->assertFalse($employee->hasPermission('reports.view'));

        Route::middleware(['auth', 'permission:catalog.manage'])
            ->get('/__test/permission-check', static fn () => response('allowed'));

        $this->actingAs($employee)->get('/__test/permission-check')->assertOk();

        $owner = User::query()->where('username', 'jaredadmin')->firstOrFail();

        $this->actingAs($owner)->post(route('admin.employees.permissions', $employee), [
            'permissions' => ['owner.all'],
        ])->assertSessionHasErrors('permissions.0');

        $this->assertSame(['catalog.view', 'catalog.manage'], $employee->fresh()->permissions);
    }

    public function test_employee_cannot_assign_permissions_or_access_owner_controls(): void
    {
        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));

        $this->post('/admin/employees', [
            'name' => 'Empleado de prueba',
            'username' => 'empleado01',
            'email' => 'employee@example.com',
        ])->assertRedirect();

        $employee = User::query()->where('username', 'empleado01')->firstOrFail();
        $employee->forceFill(['must_change_password' => false])->save();

        $this->actingAs($employee);

        $this->post(route('admin.employees.permissions', $employee), [
            'permissions' => ['catalog.manage'],
        ])->assertForbidden();

        $this->get('/admin/employees')->assertForbidden();
        $this->get('/admin/access-requests')->assertForbidden();
        $this->assertEmpty($employee->fresh()->permissions ?? []);
    }

    public function test_owner_can_process_employee_access_request_with_one_time_password(): void
    {
        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));

        $this->post('/admin/employees', [
            'name' => 'Empleado de prueba',
            'username' => 'empleado01',
            'email' => 'employee@example.com',
        ])->assertRedirect();

        $employee = User::query()->where('username', 'empleado01')->firstOrFail();

        $this->post('/admin/logout')->assertRedirect(route('admin.login'));

        $this->post('/admin/login/help', [
            'username' => 'empleado01',
            'reason' => 'forgot_password',
            'details' => 'No recuerdo mi contraseña.',
        ])->assertRedirect(route('admin.login'));

        $this->post('/admin/login', [
            'username' => 'jaredadmin',
            'password' => 'Strong-Password-2026!',
        ])->assertRedirect(route('admin.home'));

        $request = LoginHelpRequest::query()->firstOrFail();
        $response = $this->post(route('admin.access-requests.temporary-password', $request));

        $temporaryPassword = null;

        $response->assertRedirect()->assertSessionHas(
            'temporary_password_once',
            function (array $credentials) use (&$temporaryPassword): bool {
                $temporaryPassword = $credentials['password'] ?? null;

                return filled($temporaryPassword);
            },
        );

        $this->assertTrue(Hash::check($temporaryPassword, $employee->fresh()->password));
        $this->assertTrue($employee->fresh()->must_change_password);
        $this->assertDatabaseHas('login_help_requests', [
            'id' => $request->id,
            'status' => 'resolved',
            'handled_by' => auth()->id(),
        ]);
    }

    public function test_owner_can_create_and_update_products_with_dynamic_fields_and_manual_prices(): void
    {
        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));

        $category = CatalogCategory::query()->where('name', 'Vehículos')->firstOrFail();

        $response = $this->post(route('admin.products.store'), [
            'name' => 'Honda Civic',
            'category_id' => $category->id,
            'description' => 'Sedán de prueba.',
            'status' => 'published',
            'is_featured' => '1',
            'prices' => [
                'USD' => '10000.00',
                'NIO' => '',
            ],
            'fields' => [
                'brand' => 'Honda',
                'model' => 'Civic',
                'year' => '2022',
                'engine_displacement' => '2000',
                'compatibility' => 'Civic 2022',
            ],
        ]);

        $response->assertRedirect(route('admin.products.index'))
            ->assertSessionHas('status');

        $product = Product::query()
            ->with(['fieldValues.definition', 'prices'])
            ->where('name', 'Honda Civic')
            ->firstOrFail();

        $this->assertSame('published', $product->status);
        $this->assertSame('honda-civic', $product->slug);
        $this->assertSame($category->id, $product->category_id);
        $this->assertCount(1, $product->prices);
        $this->assertSame('USD', $product->prices->first()->currency_code);
        $this->assertSame(10000.0, (float) $product->prices->first()->amount);

        $fieldValues = [];

        foreach ($product->fieldValues as $fieldValue) {
            $fieldValues[$fieldValue->definition->field_key] = $fieldValue->value['value'];
        }

        $this->assertSame('Honda', $fieldValues['brand']);
        $this->assertSame('2000', $fieldValues['engine_displacement']);

        $this->put(route('admin.products.update', $product), [
            'name' => 'Honda Civic Sport',
            'category_id' => $category->id,
            'description' => 'Versión actualizada.',
            'status' => 'draft',
            'prices' => [
                'USD' => '9500.00',
                'NIO' => '',
            ],
            'fields' => [
                'brand' => 'Honda',
                'model' => 'Civic Sport',
                'year' => '2023',
                'engine_displacement' => '2000',
                'compatibility' => 'Civic 2023',
            ],
        ])->assertRedirect(route('admin.products.index'));

        $updatedProduct = $product->fresh()->load('prices');

        $this->assertSame('Honda Civic Sport', $updatedProduct->name);
        $this->assertSame('honda-civic-sport', $updatedProduct->slug);
        $this->assertSame('draft', $updatedProduct->status);
        $this->assertSame(9500.0, (float) $updatedProduct->prices->first()->amount);
    }

    public function test_employee_product_access_obeys_catalog_permissions(): void
    {
        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));

        $this->post('/admin/employees', [
            'name' => 'Empleado de prueba',
            'username' => 'empleado01',
            'email' => 'employee@example.com',
        ])->assertRedirect();

        $employee = User::query()->where('username', 'empleado01')->firstOrFail();
        $employee->forceFill([
            'is_active' => true,
            'must_change_password' => false,
            'permissions' => ['catalog.view'],
        ])->save();

        $this->actingAs($employee)->get('/admin/products')->assertOk();
        $this->get('/admin/products/create')->assertForbidden();

        $employee->forceFill(['permissions' => ['catalog.manage']])->save();
        $this->actingAs($employee->fresh())->get('/admin/products')->assertOk();
        $this->get('/admin/products/create')->assertOk();
    }

    public function test_public_catalog_only_lists_published_products_and_filters_by_category(): void
    {
        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));

        $category = CatalogCategory::query()->where('name', 'Vehículos')->firstOrFail();

        Product::query()->create([
            'category_id' => $category->id,
            'name' => 'Vehículo publicado',
            'slug' => 'vehiculo-publicado',
            'description' => 'Descripción visible.',
            'status' => 'published',
        ]);

        Product::query()->create([
            'category_id' => $category->id,
            'name' => 'Producto en borrador',
            'slug' => 'producto-en-borrador',
            'description' => 'No debe aparecer.',
            'status' => 'draft',
        ]);

        $this->get('/')
            ->assertOk()
            ->assertSee('Vehículo publicado')
            ->assertDontSee('Producto en borrador');

        $this->get('/?category=vehiculos')
            ->assertOk()
            ->assertSee('Vehículo publicado');

        $this->get('/?q=No-existe')
            ->assertOk()
            ->assertSee('No encontramos productos');
    }

    public function test_public_product_detail_hides_private_dynamic_fields_and_drafts(): void
    {
        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));

        $category = CatalogCategory::query()->where('name', 'Vehículos')->firstOrFail();
        $product = Product::query()->create([
            'category_id' => $category->id,
            'name' => 'Vehículo de muestra',
            'slug' => 'vehiculo-de-muestra',
            'description' => 'Detalle público.',
            'status' => 'published',
        ]);

        $privateBrand = ProductFieldDefinition::query()->where('field_key', 'brand')->firstOrFail();
        $privateBrand->forceFill(['is_public' => false])->save();

        $publicModel = ProductFieldDefinition::query()->where('field_key', 'model')->firstOrFail();

        ProductFieldValue::query()->create([
            'product_id' => $product->id,
            'field_definition_id' => $privateBrand->id,
            'value' => ['value' => 'INTERNAL-SECRET-BRAND'],
        ]);

        ProductFieldValue::query()->create([
            'product_id' => $product->id,
            'field_definition_id' => $publicModel->id,
            'value' => ['value' => 'Civic 2023'],
        ]);

        $this->get('/producto/vehiculo-de-muestra')
            ->assertOk()
            ->assertSee('Vehículo de muestra')
            ->assertSee('Civic 2023')
            ->assertDontSee('INTERNAL-SECRET-BRAND');

        $draft = Product::query()->create([
            'category_id' => $category->id,
            'name' => 'Producto reservado',
            'slug' => 'producto-reservado',
            'description' => 'No público.',
            'status' => 'draft',
        ]);

        $this->get('/producto/'.$draft->slug)->assertNotFound();
    }

    public function test_owner_can_create_update_and_deactivate_categories(): void
    {
        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));

        $this->post(route('admin.categories.store'), [
            'name' => 'Accesorios de moto',
        ])->assertRedirect()->assertSessionHas('status');

        $category = CatalogCategory::query()
            ->where('name', 'Accesorios de moto')
            ->firstOrFail();

        $this->assertSame('accesorios-de-moto', $category->slug);
        $this->assertTrue($category->is_active);

        $this->put(route('admin.categories.update', $category), [
            'name' => 'Accesorios para motocicleta',
        ])->assertRedirect();

        $category->refresh();

        $this->assertSame('accesorios-para-motocicleta', $category->slug);

        $this->post(route('admin.categories.status', $category), [
            'is_active' => '0',
        ])->assertRedirect();

        $this->assertFalse($category->fresh()->is_active);
    }

    public function test_owner_can_create_and_configure_dynamic_fields(): void
    {
        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));

        $group = CatalogGroup::query()->firstOrFail();

        $this->post(route('admin.fields.store'), [
            'group_id' => $group->id,
            'field_key' => 'product_condition',
            'label' => 'Condición',
            'field_type' => 'select',
            'options_text' => "Nuevo\nUsado\nReacondicionado",
            'width' => 'half',
            'is_public' => '1',
            'is_searchable' => '1',
        ])->assertRedirect()->assertSessionHas('status');

        $field = ProductFieldDefinition::query()
            ->where('field_key', 'product_condition')
            ->firstOrFail();

        $this->assertSame(['Nuevo', 'Usado', 'Reacondicionado'], $field->options);
        $this->assertTrue($field->is_public);
        $this->assertTrue($field->is_searchable);

        $this->put(route('admin.fields.update', $field), [
            'group_id' => $group->id,
            'field_key' => 'condition_status',
            'label' => 'Estado del producto',
            'field_type' => 'select',
            'options_text' => "Nuevo\nUsado",
            'width' => 'full',
            'is_required' => '1',
            'unit_dimension' => 'condition',
            'unit_code' => '',
        ])->assertRedirect();

        $field->refresh();

        $this->assertSame('condition_status', $field->field_key);
        $this->assertSame('Estado del producto', $field->label);
        $this->assertSame(['Nuevo', 'Usado'], $field->options);
        $this->assertTrue($field->is_required);
        $this->assertFalse($field->is_public);
        $this->assertFalse($field->is_searchable);
        $this->assertSame('full', $field->width);
    }

    public function test_employee_catalog_configuration_requires_the_specific_permission(): void
    {
        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));

        $this->post('/admin/employees', [
            'name' => 'Empleado de prueba',
            'username' => 'empleado01',
            'email' => 'employee@example.com',
        ])->assertRedirect();

        $employee = User::query()->where('username', 'empleado01')->firstOrFail();
        $employee->forceFill([
            'is_active' => true,
            'must_change_password' => false,
            'permissions' => ['categories.manage'],
        ])->save();

        $this->actingAs($employee)->get('/admin/categories')->assertOk();
        $this->get('/admin/fields')->assertForbidden();

        $employee->forceFill(['permissions' => ['fields.manage']])->save();

        $this->actingAs($employee->fresh())->get('/admin/fields')->assertOk();
        $this->get('/admin/categories')->assertForbidden();
    }

    public function test_owner_can_log_in_again_after_logout(): void
    {
        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));
        $this->post('/admin/logout')->assertRedirect(route('admin.login'));

        $this->post('/admin/login', [
            'username' => 'jaredadmin',
            'password' => 'Strong-Password-2026!',
        ])->assertRedirect(route('admin.home'));

        $this->assertAuthenticatedAs(User::query()->where('email', 'owner@example.com')->firstOrFail());
    }

    public function test_setup_page_renders_the_entire_installer_in_english_when_selected(): void
    {
        config(['nexora.installation_mode' => 'demo']);

        $this->get('/setup?locale=en&country_code=US')
            ->assertOk()
            ->assertSee('<html lang="en">', false)
            ->assertSee('Get your catalog ready')
            ->assertSee('1. Language and country')
            ->assertSee('Primary language')
            ->assertSee('Cancel test')
            ->assertSee('DEMO ENVIRONMENT')
            ->assertDontSee('Prepara tu catálogo')
            ->assertDontSee('Cancelar prueba');
    }

    public function test_setup_validation_messages_follow_the_selected_english_language(): void
    {
        $payload = $this->validSetupPayload();
        $payload['locale'] = 'en';
        unset($payload['owner_name']);

        $this->from('/setup?locale=en&country_code=US')
            ->post('/setup?locale=en&country_code=US', $payload)
            ->assertRedirect('/setup?locale=en&country_code=US')
            ->assertSessionHasErrors('owner_name');

        $this->get('/setup?locale=en&country_code=US')
            ->assertOk()
            ->assertSee('The owner name field is required.')
            ->assertDontSee('El campo nombre del propietario es obligatorio.');
    }

    public function test_english_template_catalog_translates_all_template_preview_labels(): void
    {
        $catalog = app(TemplateCatalog::class);
        $english = $catalog->previews('en');

        $this->assertSame('Perfumery', $catalog->all('en')['perfumery']);
        $this->assertContains('Phones', $english['technology']['categories']);
        $this->assertContains('Auto parts', $english['automotive']['categories']);
        $this->assertContains('Food', $english['grocery']['categories']);
        $this->assertSame('Classification & fragrance', $english['perfumery']['groups'][0]['name']);
        $this->assertSame('Product type', $english['perfumery']['groups'][0]['fields'][0]);
    }

    public function test_english_installation_seeds_translated_template_data_and_stable_field_keys(): void
    {
        $payload = $this->validSetupPayload();
        $payload['country_code'] = 'US';
        $payload['locale'] = 'en';
        $payload['business_type'] = 'perfumery';

        $this->post('/setup', $payload)->assertRedirect(route('admin.home'));

        $settings = InstallationSettings::query()->findOrFail(1);

        $this->assertSame('en', data_get($settings->configuration, 'regional.locale'));
        $this->assertSame('production', data_get($settings->configuration, 'environment.mode'));
        $this->assertDatabaseHas('catalog_groups', ['name' => 'Classification & fragrance']);
        $this->assertDatabaseHas('product_field_definitions', [
            'field_key' => 'perfume_type',
            'label' => 'Product type',
        ]);

        $perfumeType = ProductFieldDefinition::query()->where('field_key', 'perfume_type')->firstOrFail();
        $this->assertSame(['Original', 'Inspired', 'Generic'], $perfumeType->options);

        $this->assertDatabaseHas('product_field_definitions', [
            'field_key' => 'content',
            'unit_code' => 'ml',
            'unit_catalog_code' => 'ml',
        ]);
        $this->assertDatabaseHas('product_field_definitions', [
            'field_key' => 'set_items_count',
            'unit_code' => 'pieces',
            'unit_catalog_code' => 'piece',
        ]);
    }

    public function test_demo_installation_can_be_reset_without_dropping_its_schema(): void
    {
        config(['nexora.installation_mode' => 'demo']);

        $payload = $this->validSetupPayload();
        $payload['business_type'] = 'perfumery';
        $payload['locale'] = 'en';

        $this->post('/setup', $payload)->assertRedirect(route('admin.home'));

        $settings = InstallationSettings::query()->findOrFail(1);
        $this->assertSame('demo', data_get($settings->configuration, 'environment.mode'));

        $exitCode = Artisan::call('nexora:demo:reset', [
            '--confirm' => 'RESET-DEMO-DATA',
        ]);

        $this->assertSame(0, $exitCode);
        $this->assertDatabaseCount('users', 0);
        $this->assertDatabaseCount('installation_settings', 0);
        $this->assertDatabaseCount('catalog_categories', 0);
        $this->assertDatabaseCount('catalog_groups', 0);
        $this->assertDatabaseCount('product_field_definitions', 0);
        $this->assertDatabaseCount('products', 0);
        $this->assertDatabaseCount('product_field_values', 0);
        $this->assertDatabaseCount('product_prices', 0);
        $this->assertDatabaseCount('business_contacts', 0);
        $this->assertDatabaseCount('business_currencies', 0);
        $this->assertDatabaseCount('migrations', 5);
        $this->assertTrue(app(InstallationState::class)->hasSchema());
        $this->assertFalse(app(InstallationState::class)->isCompleted());

        $this->get('/setup?locale=en')->assertOk()->assertSee('Get your catalog ready');
    }

    public function test_demo_reset_requires_the_exact_confirmation_argument(): void
    {
        config(['nexora.installation_mode' => 'demo']);

        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));

        $exitCode = Artisan::call('nexora:demo:reset');

        $this->assertSame(1, $exitCode);
        $this->assertDatabaseCount('users', 1);
        $this->assertDatabaseCount('installation_settings', 1);
    }

    public function test_demo_reset_is_blocked_in_production_even_with_confirmation(): void
    {
        config(['nexora.installation_mode' => 'production']);

        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));

        $exitCode = Artisan::call('nexora:demo:reset', [
            '--confirm' => 'RESET-DEMO-DATA',
        ]);

        $this->assertSame(1, $exitCode);
        $this->assertDatabaseCount('users', 1);
        $this->assertDatabaseCount('installation_settings', 1);
    }

    public function test_demo_reset_requires_the_persisted_installation_demo_marker(): void
    {
        config(['nexora.installation_mode' => 'demo']);

        $this->post('/setup', $this->validSetupPayload())->assertRedirect(route('admin.home'));

        $settings = InstallationSettings::query()->findOrFail(1);
        $configuration = $settings->configuration;
        $configuration['environment']['mode'] = 'production';
        $settings->forceFill(['configuration' => $configuration])->save();

        $exitCode = Artisan::call('nexora:demo:reset', [
            '--confirm' => 'RESET-DEMO-DATA',
        ]);

        $this->assertSame(1, $exitCode);
        $this->assertDatabaseCount('users', 1);
        $this->assertDatabaseCount('installation_settings', 1);
    }

    private function validSetupPayload(): array
    {
        return [
            'country_code' => 'NI',
            'locale' => 'es',
            'business_name' => 'Tienda de prueba',
            'business_type' => 'automotive',
            'owner_name' => 'Propietario de prueba',
            'owner_username' => 'jaredadmin',
            'owner_email' => 'owner@example.com',
            'owner_password' => 'Strong-Password-2026!',
            'owner_password_confirmation' => 'Strong-Password-2026!',
            'description' => 'Catálogo de repuestos y vehículos.',
            'primary_color' => '#123456',
            'primary_currency' => 'USD',
            'additional_currencies' => ['NIO'],
            'phones' => [
                ['country_calling_code' => '+505', 'number' => '8888-1234', 'show_public' => '1'],
            ],
            'primary_phone' => '0',
            'photos_enabled' => '1',
        ];
    }
}
