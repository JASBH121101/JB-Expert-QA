<?php

namespace App\Modules\Setup\Http\Controllers;

use App\Core\Installation\DatabaseInstaller;
use App\Core\Installation\InstallationState;
use App\Core\Installation\ServerRequirements;
use App\Models\BusinessContact;
use App\Models\BusinessCurrency;
use App\Models\InstallationSettings;
use App\Models\User;
use App\Modules\Setup\Services\CountryCatalog;
use App\Modules\Setup\Services\CountryCurrencyCatalog;
use App\Modules\Setup\Services\CountryDialingCodeCatalog;
use App\Modules\Setup\Services\CurrencyCatalog;
use App\Modules\Setup\Services\LanguageCatalog;
use App\Modules\Setup\Services\TemplateCatalog;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\App;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Illuminate\View\View;
use RuntimeException;
use Throwable;

final class SetupController
{
    public function __invoke(
        Request $request,
        InstallationState $installation,
        ServerRequirements $requirements,
        TemplateCatalog $templates,
    ): View|RedirectResponse {
        if ($installation->isCompleted()) {
            return redirect()->route(Auth::check() ? 'admin.home' : 'admin.login');
        }

        $locale = $request->query('locale');

        if (!is_string($locale) || !array_key_exists($locale, LanguageCatalog::all())) {
            $locale = $request->getPreferredLanguage(array_keys(LanguageCatalog::all())) ?? 'es';
        }

        App::setLocale($locale);

        $requestedCountryCode = strtoupper((string) $request->query('country_code', ''));
        $defaultCountryCode = in_array($requestedCountryCode, CountryCatalog::codes(), true)
            ? $requestedCountryCode
            : $this->detectCountryCode($request);

        $checks = $requirements->checks();

        return view('setup.index', [
            'checks' => $checks,
            'requirementsPassed' => collect($checks)->every(
                static fn (array $check): bool => $check['passed'],
            ),
            'schemaReady' => $installation->hasSchema(),
            'databaseConnected' => (bool) (collect($checks)->firstWhere('key', 'database')['passed'] ?? false),
            'templates' => $templates->all($locale),
            'templatePreviews' => $templates->previews($locale),
            'currencies' => CurrencyCatalog::codes(),
            'countryCurrencies' => CountryCurrencyCatalog::all(),
            'countryDialingCodes' => CountryDialingCodeCatalog::all(),
            'defaultPrimaryCurrency' => CountryCurrencyCatalog::forCountry($defaultCountryCode) ?? 'USD',
            'countryCodes' => CountryCatalog::codes(),
            'languages' => LanguageCatalog::all($locale),
            'defaultLocale' => $locale,
            'installationMode' => config('nexora.installation_mode', 'production'),
            'defaultCountryCode' => $defaultCountryCode,
        ]);
    }

    public function prepareDatabase(
        Request $request,
        InstallationState $installation,
        DatabaseInstaller $databaseInstaller,
    ): RedirectResponse {
        $this->applyRequestLocale($request);

        if ($installation->isCompleted()) {
            return redirect()->route('admin.login');
        }

        try {
            $databaseInstaller->prepare($installation);
        } catch (RuntimeException $exception) {
            return back()->withErrors([
                'database' => $exception->getMessage(),
            ]);
        } catch (Throwable $exception) {
            report($exception);

            return back()->withErrors([
                'database' => __('setup.database_error'),
            ]);
        }

        return redirect()->route('setup.show', $this->setupRouteParameters($request))->with(
            'status',
            __('setup.database_prepared'),
        );
    }

    public function cancel(Request $request, InstallationState $installation): RedirectResponse
    {
        $this->applyRequestLocale($request);

        if ($installation->isCompleted()) {
            return redirect()->route('admin.login');
        }

        // No business data is written before setup.store. Discard only form/error state;
        // keep the prepared schema so the installer can be tested again safely.
        $request->session()->forget(['_old_input', 'errors']);

        return redirect()->route('setup.show', $this->setupRouteParameters($request))->with(
            'status',
            __('setup.cancelled'),
        );
    }

    public function store(
        Request $request,
        InstallationState $installation,
        ServerRequirements $requirements,
        TemplateCatalog $templates,
    ): RedirectResponse {
        if ($installation->isCompleted()) {
            return redirect()->route('admin.login');
        }

        $requestedLocale = strtolower(trim((string) $request->input('locale', 'es')));
        App::setLocale(array_key_exists($requestedLocale, LanguageCatalog::all()) ? $requestedLocale : 'es');

        $checks = $requirements->checks();

        if (
            !$installation->hasSchema()
            || !collect($checks)->every(
                static fn (array $check): bool => $check['passed'],
            )
        ) {
            throw ValidationException::withMessages([
                'setup' => __('setup.setup_environment_error'),
            ]);
        }

        $request->merge([
            'owner_username' => strtolower(trim((string) $request->input('owner_username'))),
            'owner_email' => strtolower(trim((string) $request->input('owner_email'))),
            'country_code' => strtoupper(trim((string) $request->input('country_code'))),
            'locale' => strtolower(trim((string) $request->input('locale'))),
        ]);

        $phones = array_values(array_filter(
            (array) $request->input('phones', []),
            static fn ($phone): bool => is_array($phone)
                && trim((string) ($phone['number'] ?? '')) !== '',
        ));

        $request->merge(['phones' => $phones]);

        $validated = $request->validate([
            'country_code' => ['required', 'string', Rule::in(CountryCatalog::codes())],
            'locale' => ['required', 'string', Rule::in(array_keys(LanguageCatalog::all()))],
            'business_name' => ['required', 'string', 'max:120'],
            'business_type' => ['required', 'string', Rule::in(array_keys($templates->all()))],
            'owner_name' => ['required', 'string', 'max:100'],
            'owner_username' => [
                'required',
                'string',
                'min:3',
                'max:32',
                'regex:/^[a-z0-9._-]+$/',
                'unique:users,username',
            ],
            'owner_email' => ['required', 'email', 'max:255', 'unique:users,email'],
            'owner_password' => ['required', 'string', 'min:8', 'confirmed'],
            'description' => ['nullable', 'string', 'max:700'],
            'primary_color' => ['required', 'regex:/^#[0-9a-fA-F]{6}$/'],
            'primary_currency' => ['required', 'string', Rule::in(CurrencyCatalog::codes())],
            'additional_currencies' => ['sometimes', 'array', 'max:10'],
            'additional_currencies.*' => ['string', 'distinct', Rule::in(CurrencyCatalog::codes())],
            'business_hours' => ['sometimes', 'array', 'max:14'],
            'business_hours.*.day' => ['required', 'string', Rule::in([
                'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
            ])],
            'business_hours.*.open' => ['required', 'date_format:H:i'],
            'business_hours.*.close' => ['required', 'date_format:H:i'],
            'phones' => ['sometimes', 'array', 'max:5'],
            'phones.*.country_calling_code' => ['required', 'string', 'max:4', 'regex:/^\\+[1-9][0-9]{0,2}$/'],
            'phones.*.number' => ['required', 'string', 'max:20', 'regex:/^[0-9().\\-\\s]{6,20}$/'],
            'phones.*.show_public' => ['nullable', 'boolean'],
            'primary_phone' => ['nullable', 'integer', 'min:0', 'max:4'],
            'photos_enabled' => ['sometimes', 'boolean'],
            'logo' => [
                'nullable',
                'prohibited_if:photos_enabled,0',
                'image',
                'mimes:jpg,jpeg,png,webp',
                'max:2048',
                'dimensions:max_width=3000,max_height=3000',
            ],
            'cover' => [
                'nullable',
                'prohibited_if:photos_enabled,0',
                'image',
                'mimes:jpg,jpeg,png,webp',
                'max:5120',
                'dimensions:max_width=5000,max_height=3000',
            ],
        ]);

        $normalizedPhones = [];

        foreach ($validated['phones'] ?? [] as $index => $phone) {
            $callingCode = preg_replace('/\\D+/', '', $phone['country_calling_code']) ?? '';
            $nationalNumber = preg_replace('/\\D+/', '', $phone['number']) ?? '';
            $internationalNumber = $callingCode.$nationalNumber;

            if (strlen($nationalNumber) < 6 || strlen($internationalNumber) > 15) {
                throw ValidationException::withMessages([
                    "phones.{$index}.number" => __('setup.phone_length_error'),
                ]);
            }

            $normalizedPhones[] = [
                'phone' => '+'.$internationalNumber,
                'show_public' => (bool) ($phone['show_public'] ?? false),
            ];
        }

        $enabledCurrencies = array_values(array_unique(array_merge(
            [$validated['primary_currency']],
            array_filter(
                $validated['additional_currencies'] ?? [],
                static fn (string $code): bool => $code !== $validated['primary_currency'],
            ),
        )));

        $photosEnabled = (bool) ($validated['photos_enabled'] ?? true);
        $storedFiles = [];

        try {
            $owner = DB::transaction(function () use (
                $request,
                $validated,
                $enabledCurrencies,
                $photosEnabled,
                $normalizedPhones,
                $templates,
                &$storedFiles,
            ): User {
                if (User::query()->exists() || InstallationSettings::query()->exists()) {
                    throw ValidationException::withMessages([
                        'setup' => __('setup.setup_already_started'),
                    ]);
                }

                $owner = User::query()->create([
                    'name' => $validated['owner_name'],
                    'username' => $validated['owner_username'],
                    'email' => $validated['owner_email'],
                    'password' => $validated['owner_password'],
                    'role' => 'owner',
                    'is_active' => true,
                    'must_change_password' => false,
                ]);

                $logoPath = null;
                $coverPath = null;

                if ($photosEnabled && $request->hasFile('logo')) {
                    $logoPath = $request->file('logo')->store('identity', 'public');
                    $storedFiles[] = $logoPath;
                }

                if ($photosEnabled && $request->hasFile('cover')) {
                    $coverPath = $request->file('cover')->store('identity', 'public');
                    $storedFiles[] = $coverPath;
                }

                $configuration = [
                    'regional' => [
                        'countryCode' => $validated['country_code'],
                        'locale' => $validated['locale'],
                    ],
                    'identity' => [
                        'description' => $validated['description'] ?? '',
                        'primaryColor' => $validated['primary_color'],
                        'logoPath' => $logoPath,
                        'coverPath' => $coverPath,
                        'photosEnabled' => $photosEnabled,
                    ],
                    'pricing' => [
                        'primaryCurrency' => $validated['primary_currency'],
                        'enabledCurrencies' => $enabledCurrencies,
                    ],
                    'operation' => [
                        'hours' => array_values($validated['business_hours'] ?? []),
                    ],
                    'template' => $validated['business_type'],
                    'environment' => [
                        'mode' => config('nexora.installation_mode', 'production') === 'demo' ? 'demo' : 'production',
                    ],
                    'templateVersion' => $templates->version(),
                    'website' => [
                        'editorMode' => 'basic',
                        'draft' => true,
                    ],
                ];

                InstallationSettings::query()->create([
                    'id' => 1,
                    'business_name' => $validated['business_name'],
                    'business_type' => $validated['business_type'],
                    'owner_id' => $owner->id,
                    'configuration' => $configuration,
                    'setup_completed_at' => now(),
                ]);

                foreach ($enabledCurrencies as $index => $currency) {
                    BusinessCurrency::query()->create([
                        'code' => $currency,
                        'is_primary' => $currency === $validated['primary_currency'],
                        'is_enabled' => true,
                        'sort_order' => $index,
                    ]);
                }

                $phoneRows = $normalizedPhones;
                $mainPhoneIndex = isset($validated['primary_phone'])
                    ? (int) $validated['primary_phone']
                    : 0;

                foreach ($phoneRows as $index => $phone) {
                    BusinessContact::query()->create([
                        'phone' => $phone['phone'],
                        'is_primary' => $index === $mainPhoneIndex,
                        'show_public' => (bool) ($phone['show_public'] ?? false),
                        'sort_order' => $index,
                    ]);
                }

                $templates->seed($validated['business_type'], $validated['locale']);

                return $owner;
            });
        } catch (Throwable $exception) {
            foreach ($storedFiles as $path) {
                Storage::disk('public')->delete($path);
            }

            throw $exception;
        }

        Auth::login($owner);
        $request->session()->regenerate();

        $mediaMessage = $this->ensurePublicStorageLink();

        $verificationMessage = __('setup.verification_smtp_missing');

        if (config('mail.default') === 'smtp' && filled(config('mail.mailers.smtp.host'))) {
            try {
                $owner->sendEmailVerificationNotification();
                $verificationMessage = __('setup.verification_sent');
            } catch (Throwable) {
                $verificationMessage = __('setup.verification_failed');
            }
        }

        return redirect()->route('admin.home')
            ->with('status', __('setup.created'))
            ->with('verification_message', $verificationMessage)
            ->with('media_message', $mediaMessage);
    }

    private function applyRequestLocale(Request $request): string
    {
        $locale = strtolower(trim((string) $request->input(
            'locale',
            $request->query('locale', config('app.locale', 'es')),
        )));

        if (!array_key_exists($locale, LanguageCatalog::all())) {
            $locale = 'es';
        }

        App::setLocale($locale);

        return $locale;
    }

    private function setupRouteParameters(Request $request): array
    {
        $locale = $request->input('locale', $request->query('locale', app()->getLocale()));
        $countryCode = $request->input('country_code', $request->query('country_code'));

        return array_filter([
            'locale' => is_string($locale) ? $locale : app()->getLocale(),
            'country_code' => is_string($countryCode) ? $countryCode : null,
        ], static fn ($value): bool => filled($value));
    }

    private function detectCountryCode(Request $request): string
    {
        foreach ($request->getLanguages() as $language) {
            if (preg_match('/^[a-z]{2,3}[-_]([a-z]{2})(?:[-_].*)?$/i', $language, $matches) === 1) {
                $countryCode = strtoupper($matches[1]);

                if (in_array($countryCode, CountryCatalog::codes(), true)) {
                    return $countryCode;
                }
            }
        }

        return 'NI';
    }

    private function ensurePublicStorageLink(): ?string
    {
        if (app()->environment('testing')) {
            return null;
        }

        $link = public_path('storage');
        $target = storage_path('app/public');

        if (is_dir($target) === false) {
            if (mkdir($target, 0755, true) === false && is_dir($target) === false) {
                return __('setup.media_directory_error');
            }
        }

        if (is_link($link)) {
            return realpath($link) === realpath($target)
                ? null
                : __('setup.media_link_conflict');
        }

        if (file_exists($link)) {
            return __('setup.media_path_conflict');
        }

        try {
            $exitCode = Artisan::call('storage:link');

            if (
                $exitCode === 0
                && is_link($link)
                && realpath($link) === realpath($target)
            ) {
                return null;
            }
        } catch (Throwable $exception) {
            report($exception);
        }

        return __('setup.media_link_failed');
    }
}
