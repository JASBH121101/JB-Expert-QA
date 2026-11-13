@extends('layouts.app')

@section('title', __('setup.page_title'))

@section('content')
    <section class="panel">
        <p class="muted" style="margin:0;font-size:12px;font-weight:800;letter-spacing:.12em">NEXORA SETUP ENGINE</p>
        <h1>{{ __('setup.heading') }}</h1>
        @if ($installationMode === 'demo')
            <div class="note" role="status" style="margin-top:12px;border:1px solid #e7d7a8;background:#fff8e6;color:#775b17;font-weight:700">
                {{ __('setup.demo_notice') }}
            </div>
        @endif
        <p class="muted">{{ __('setup.intro') }}</p>

        <div class="checks">
            @foreach ($checks as $check)
                <div class="check">
                    <div>
                        <strong>{{ $check['label'] }}</strong>
                        <small>{{ $check['detail'] }}</small>
                    </div>
                    <span class="status {{ $check['passed'] ? 'ok' : 'fail' }}">
                        {{ $check['passed'] ? __('setup.correct') : __('setup.review') }}
                    </span>
                </div>
            @endforeach
        </div>

        @if (session('status'))
            <div class="note" style="background:#edf7ed;color:#286536" role="status">{{ session('status') }}</div>
        @endif

        @if (! $schemaReady)
            @if ($errors->has('database'))
                <div class="note" style="background:#fff0ee;color:#963b32" role="alert">
                    {{ $errors->first('database') }}
                </div>
            @endif
            @if ($databaseConnected)
                <div class="note">
                    {{ __('setup.database_ready') }}
                </div>
                <form method="POST" action="{{ route('setup.prepare-database', ['locale' => $defaultLocale, 'country_code' => $defaultCountryCode]) }}">
                    @csrf
                    <button class="primary-button" type="submit">{{ __('setup.database_prepare') }}</button>
                </form>
            @else
                <div class="note">
                    {{ __('setup.database_setup_help') }}
                </div>
            @endif
        @elseif (! $requirementsPassed)
            <div class="note">{{ __('setup.requirements_blocked') }}</div>
        @else
            @if ($errors->any())
                <div class="note" style="background:#fff0ee;color:#963b32">
                    <strong>{{ __('setup.validation_heading') }}</strong>
                    <ul>@foreach ($errors->all() as $error)<li>{{ $error }}</li>@endforeach</ul>
                </div>
            @endif

            <form id="nexora-setup-form" method="POST" action="{{ route('setup.store', ['locale' => $defaultLocale, 'country_code' => old('country_code', $defaultCountryCode)]) }}" enctype="multipart/form-data" novalidate>
                @csrf
                <div class="wizard-progress">
                    <span class="wizard-current" id="wizard-current">{{ __('setup.wizard_step', ['current' => 1, 'total' => 5]) }}</span>
                    <div class="wizard-track"><span id="wizard-progress-bar"></span></div>
                </div>

                <section class="wizard-step" data-step="0" aria-labelledby="regional-step-title">
                    <h2 id="regional-step-title">{{ __('setup.step_1_title') }}</h2>
                    <p class="muted">{{ __('setup.step_1_description') }}</p>
                    <div class="field-grid">
                        <label>{{ __('setup.primary_language') }}
                            <select id="setup-locale" name="locale" required>
                                @foreach ($languages as $code => $label)
                                    <option value="{{ $code }}" @selected(old('locale', $defaultLocale) === $code)>{{ $label }} ({{ $code }})</option>
                                @endforeach
                            </select>
                        </label>
                        <label>{{ __('setup.business_country') }}
                            <select id="country-code" name="country_code" required data-selected-country="{{ old('country_code', $defaultCountryCode) }}">
                                <option value="">{{ __('setup.select_country') }}</option>
                            </select>
                        </label>
                    </div>
                    <p class="muted small">{{ __('setup.country_iso_note') }}</p>
                </section>

                <section class="wizard-step" data-step="1">
                    <h2>{{ __('setup.step_2_title') }}</h2>
                    <label>{{ __('setup.business_name') }}
                        <input name="business_name" maxlength="120" required value="{{ old('business_name') }}" placeholder="{{ __('setup.business_name_placeholder') }}">
                    </label>
                    <label>{{ __('setup.business_type') }}
                        <select name="business_type" required>
                            <option value="">{{ __('setup.select_template') }}</option>
                            @foreach ($templates as $key => $label)
                                <option value="{{ $key }}" @selected(old('business_type') === $key)>{{ $label }}</option>
                            @endforeach
                        </select>
                    </label>
                    <label>{{ __('setup.owner_name') }}
                        <input name="owner_name" maxlength="100" required value="{{ old('owner_name') }}" autocomplete="name">
                    </label>
                    <label>{{ __('setup.username') }}
                        <input name="owner_username" minlength="3" maxlength="32" pattern="[A-Za-z0-9._-]+" required value="{{ old('owner_username') }}" autocomplete="username">
                    </label>
                    <label>{{ __('setup.owner_email') }}

                        <input name="owner_email" type="email" maxlength="255" required value="{{ old('owner_email') }}" autocomplete="email">
                    </label>
                    <div class="field-grid">
                        <label>{{ __('setup.password') }}
                            <div class="password-control">
                                <input id="owner-password" name="owner_password" type="password" minlength="8" required autocomplete="new-password">
                                <button type="button" class="password-toggle" data-password-toggle aria-controls="owner-password" aria-label="{{ __('setup.show_password_button_aria') }}" aria-pressed="false">{{ __('setup.show_password_button') }}</button>
                            </div>
                        </label>
                        <label>{{ __('setup.confirm_password') }}
                            <div class="password-control">
                                <input id="owner-password-confirmation" name="owner_password_confirmation" type="password" minlength="8" required autocomplete="new-password">
                                <button type="button" class="password-toggle" data-password-toggle aria-controls="owner-password-confirmation" aria-label="{{ __('setup.show_password_button_aria') }}" aria-pressed="false">{{ __('setup.show_password_button') }}</button>
                            </div>
                        </label>
                    </div>
                    <p class="muted small">{{ __('setup.password_help') }}</p>
                </section>

                <section class="wizard-step" data-step="2" hidden>
                    <h2>{{ __('setup.step_3_title') }}</h2>
                    <label>{{ __('setup.business_description') }}
                        <textarea name="description" maxlength="700" rows="3" placeholder="{{ __('setup.business_description_placeholder') }}">{{ old('description') }}</textarea>
                    </label>
                    <div class="field-grid">
                        <label>{{ __('setup.primary_color') }}
                            <input name="primary_color" type="color" required value="{{ old('primary_color', '#89a92f') }}">
                        </label>
                        <label>{{ __('setup.primary_currency') }}
                            <select id="primary-currency" name="primary_currency" required data-selected-currency="{{ old('primary_currency', $defaultPrimaryCurrency) }}">
                                @foreach ($currencies as $currency)
                                    <option value="{{ $currency }}" @selected(old('primary_currency', $defaultPrimaryCurrency) === $currency)>{{ $currency }}</option>
                                @endforeach
                            </select>
                        </label>
                    </div>
                    <p class="muted small">{{ __('setup.currency_help') }}</p>
                    <div class="currency-add-row">
                        <label for="additional-currency-picker">{{ __('setup.add_currency') }}
                            <select id="additional-currency-picker">
                                <option value="">{{ __('setup.select_currency') }}</option>
                            </select>
                        </label>
                        <button type="button" class="secondary-button" id="add-currency">{{ __('setup.add') }}</button>
                    </div>
                    <div id="additional-currency-list" class="selected-currencies" aria-live="polite"></div>

                    <div class="section-separator">
                        <div class="section-heading">
                            <div><h3>{{ __('setup.business_contacts') }}</h3><p class="muted small">{{ __('setup.contact_help') }}</p></div>
                            <button type="button" class="secondary-button" id="add-phone">{{ __('setup.add_phone') }}</button>
                        </div>
                        <div id="phone-list"></div>
                    </div>
                    <div class="section-separator">
                        <div class="section-heading">
                            <div><h3>{{ __('setup.business_hours') }}</h3><p class="muted small">{{ __('setup.hours_help') }}</p></div>
                            <button type="button" class="secondary-button" id="add-business-hours">{{ __('setup.add_hours') }}</button>
                        </div>
                        <div id="business-hours-list" class="business-hours-list"></div>
                    </div>
                    <input type="hidden" name="photos_enabled" value="0">
                    <label class="toggle-row"><input type="checkbox" name="photos_enabled" value="1" checked> {{ __('setup.allow_photos') }}</label>
                    <div class="field-grid">
                        <label>{{ __('setup.logo') }}
                            <input type="file" name="logo" accept="image/png,image/jpeg,image/webp">
                        </label>
                        <label>{{ __('setup.cover') }}
                            <input type="file" name="cover" accept="image/png,image/jpeg,image/webp">
                        </label>
                    </div>
                    <p class="muted small">{{ __('setup.photos_help') }}</p>
                </section>

                <section class="wizard-step" data-step="3" hidden>
                    <h2>{{ __('setup.step_4_title') }}</h2>
                    <p class="muted">{{ __('setup.template_description') }}</p>
                    <div class="template-summary" id="template-summary" aria-live="polite">{{ __('setup.template_empty') }}</div>
                    <div class="note">{{ __('setup.template_note') }}</div>
                </section>

                <section class="wizard-step" data-step="4" hidden>
                    <h2>{{ __('setup.step_5_title') }}</h2>
                    <div class="review-list" id="setup-review"></div>
                    <div class="note">{{ __('setup.final_note') }}</div>
                </section>

            </form>
            <div class="wizard-cancel-row">
                <form id="nexora-cancel-form" method="POST" action="{{ route('setup.cancel', ['locale' => $defaultLocale, 'country_code' => old('country_code', $defaultCountryCode)]) }}">
                    @csrf
                    <button type="submit" class="cancel-button" id="wizard-cancel">{{ __('setup.cancel') }}</button>
                </form>
                <span class="muted small">{{ __('setup.cancel_note') }}</span>
            </div>
            <div class="wizard-actions">
                <button type="button" class="secondary-button" id="wizard-prev" hidden>{{ __('setup.back') }}</button>
                <button type="button" class="primary-button" id="wizard-next">{{ __('setup.continue') }}</button>
                <button type="submit" class="primary-button" id="wizard-submit" form="nexora-setup-form" hidden>{{ __('setup.create_installation') }}</button>
            </div>
        @endif
    </section>
@endsection

@push('head')
<style>
    label{display:grid;gap:7px;margin:13px 0;font-size:13px;font-weight:650}
    input,select,textarea{width:100%;min-width:0;border:1px solid #dfe5d8;border-radius:10px;padding:11px 12px;background:#fff;color:#20271f;font:inherit}
    input:focus,select:focus,textarea:focus{outline:2px solid #c7d89b;outline-offset:1px}
    input[type=color]{height:44px;padding:4px}input[type=checkbox],input[type=radio]{width:16px;height:16px;accent-color:#6c8d28}
    .field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    .currency-add-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:9px;margin-top:9px}.currency-add-row label{margin:0}.currency-add-row button{min-height:41px}
    .selected-currencies{display:flex;flex-wrap:wrap;gap:7px;margin-top:9px}.currency-chip{display:inline-flex;align-items:center;gap:7px;padding:5px 8px;border:1px solid #e1e6da;border-radius:999px;background:#f7f8f4;font-size:12px}.currency-chip button{border:0;background:transparent;color:#7a453e;font:inherit;font-weight:800;cursor:pointer}
    .business-hours-list{display:grid;gap:7px;margin-top:8px}.business-hours-row{display:grid;grid-template-columns:minmax(100px,1.1fr) 1fr 1fr auto;align-items:end;gap:8px;padding:8px 9px;border:1px solid #e7ebdf;border-radius:9px}.business-hours-row label{margin:0;font-size:11px}.business-hours-row input,.business-hours-row select{padding:8px 9px;font-size:12px}.business-hours-remove{height:35px;padding:0 9px;border:0;border-radius:8px;background:#f8eeee;color:#8b3939;font:inherit;font-size:12px;font-weight:750;cursor:pointer}.empty-hours{margin:0;color:#7a8374;font-size:12px;padding:8px 0}.password-control{display:flex;align-items:center;gap:8px}.password-control input{flex:1;min-width:0}.password-toggle{flex:none;min-height:42px;padding:0 12px;border:1px solid #dfe5d8;border-radius:10px;background:#f4f6ef;color:#35402b;font:inherit;font-size:12px;font-weight:750;cursor:pointer}.password-toggle:focus-visible{outline:2px solid #89a92f;outline-offset:2px}.small{font-size:12px}.wizard-progress{margin:22px 0}.wizard-current{font-size:12px;font-weight:800}.wizard-track{height:5px;margin-top:9px;border-radius:10px;background:#e9eee2;overflow:hidden}.wizard-track span{display:block;width:25%;height:100%;background:#89a92f;transition:width .2s}
    .wizard-step h2{margin:8px 0 15px}.wizard-step[hidden]{display:none}.wizard-actions{display:flex;justify-content:space-between;gap:10px;margin-top:14px}.wizard-cancel-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:20px}.cancel-button{padding:7px 0;border:0;background:transparent;color:#7a453e;font:inherit;font-size:12px;font-weight:800;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
    .primary-button,.secondary-button{min-height:42px;padding:0 17px;border:0;border-radius:10px;font:inherit;font-weight:750;cursor:pointer}.primary-button{background:#20271f;color:#fff}.secondary-button{background:#eef1e9;color:#35402b}
    .currency-options{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.currency-options label,.toggle-row{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid #e7ebdf;border-radius:9px}.currency-options input,.toggle-row input{width:16px;height:16px}
    .section-separator{margin-top:22px;padding-top:17px;border-top:1px solid #edf0e9}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:10px}.section-heading h3{margin:0;font-size:15px}.section-heading p{margin:5px 0}.phone-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:center;padding:11px 0;border-bottom:1px solid #edf0e9}.phone-row label{margin:4px 0}.phone-input-grid{display:grid;grid-template-columns:minmax(105px,.36fr) minmax(0,1fr);gap:9px}.phone-input-grid label{min-width:0;font-size:11px}.phone-input-grid input{font-variant-numeric:tabular-nums;letter-spacing:.035em}.phone-options{display:flex;gap:12px;flex-wrap:wrap;font-size:12px}.phone-options label{display:flex;align-items:center;gap:6px}
    .template-summary,.review-list{padding:15px;border-radius:11px;background:#f4f6ef;font-size:13px;line-height:1.7}.template-summary{display:grid;gap:12px}.template-summary__section{display:grid;gap:7px;padding-top:10px;border-top:1px solid #e2e8d9}.template-summary__items{display:flex;flex-wrap:wrap;gap:7px}.template-summary__chip{padding:4px 9px;border:1px solid #e0e7d6;border-radius:999px;background:#fff;font-size:12px}.template-summary__fields{color:#4e5846}.review-list div{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #e7ebdf}.review-list div:last-child{border:0}
    .section-heading .secondary-button{white-space:nowrap}
    @media(max-width:560px){.field-grid{grid-template-columns:1fr;gap:0}.phone-row{grid-template-columns:1fr}.wizard-actions button{flex:1}.wizard-cancel-row{align-items:flex-start;flex-direction:column;gap:4px}.section-heading{align-items:flex-start;flex-direction:column}.currency-add-row{grid-template-columns:minmax(0,1fr) auto}.business-hours-row{grid-template-columns:1fr 1fr;align-items:center}.business-hours-row label:first-child{grid-column:1/-1}.business-hours-remove{grid-column:1/-1;width:100%}}
</style>
@endpush

@push('scripts')
<script>
(() => {
    const form = document.getElementById('nexora-setup-form');
    if (!form) return;
    const steps = [...form.querySelectorAll('[data-step]')];
    const prev = document.getElementById('wizard-prev');
    const next = document.getElementById('wizard-next');
    const submit = document.getElementById('wizard-submit');
    const counter = document.getElementById('wizard-current');
    const progress = document.getElementById('wizard-progress-bar');
    const phoneList = document.getElementById('phone-list');
    const cancel = document.getElementById('wizard-cancel');
    const localeSelect = document.getElementById('setup-locale');
    const countrySelect = document.getElementById('country-code');
    const countryCodes = @json($countryCodes);
    const countryCurrencies = @json($countryCurrencies);
    const countryDialingCodes = @json($countryDialingCodes);
    const currencies = @json($currencies);
    const preferredCountry = countrySelect.dataset.selectedCountry || 'NI';
    const currencySelect = document.getElementById('primary-currency');
    const currencyPicker = document.getElementById('additional-currency-picker');
    const addCurrencyButton = document.getElementById('add-currency');
    const currencyList = document.getElementById('additional-currency-list');
    const hoursList = document.getElementById('business-hours-list');
    const initialAdditionalCurrencies = @json(old('additional_currencies', []));
    const initialBusinessHours = @json(old('business_hours', []));
    const initialPhones = @json(old('phones', []));
    const selectedAdditionalCurrencies = [];
    let businessHours = [];
    let current = 0;

    const currencyLabel = (code) => {
        try {
            const names = new Intl.DisplayNames([localeSelect.value || 'es'], { type: 'currency' });
            const name = names.of(code);

            return name && name !== code ? code + ' — ' + name : code;
        } catch (error) {
            return code;
        }
    };

    const renderCurrencyOptions = () => {
        const selected = currencySelect.value || currencySelect.dataset.selectedCurrency || 'USD';
        currencySelect.replaceChildren(...currencies.map((code) => {
            const option = document.createElement('option');
            option.value = code;
            option.textContent = currencyLabel(code);
            return option;
        }));
        currencySelect.value = currencies.includes(selected) ? selected : 'USD';

        const available = currencies.filter((code) =>
            code !== currencySelect.value && !selectedAdditionalCurrencies.includes(code)
        );
        currencyPicker.replaceChildren();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = copy.empty_currency_option;
        currencyPicker.append(placeholder);
        available.forEach((code) => {
            const option = document.createElement('option');
            option.value = code;
            option.textContent = currencyLabel(code);
            currencyPicker.append(option);
        });
        addCurrencyButton.disabled = available.length === 0;
    };

    const renderAdditionalCurrencies = () => {
        currencyList.replaceChildren();
        selectedAdditionalCurrencies.forEach((code) => {
            const chip = document.createElement('span');
            chip.className = 'currency-chip';
            const label = document.createElement('span');
            label.textContent = currencyLabel(code);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = copy.remove;
            remove.setAttribute('aria-label', copy.remove_currency.replace(':code', code));
            remove.addEventListener('click', () => {
                const index = selectedAdditionalCurrencies.indexOf(code);
                if (index !== -1) selectedAdditionalCurrencies.splice(index, 1);
                renderAdditionalCurrencies();
            });
            const hidden = document.createElement('input');
            hidden.type = 'hidden';
            hidden.name = 'additional_currencies[]';
            hidden.value = code;
            chip.append(label, remove, hidden);
            currencyList.append(chip);
        });
        renderCurrencyOptions();
    };

    const applyCountryCurrency = () => {
        const suggested = countryCurrencies[countrySelect.value];
        if (suggested && currencies.includes(suggested)) {
            currencySelect.value = suggested;
            const index = selectedAdditionalCurrencies.indexOf(suggested);
            if (index !== -1) selectedAdditionalCurrencies.splice(index, 1);
        }
        renderAdditionalCurrencies();
    };

    const dayLabels = @json(__('setup.days'));
    const copy = @json(__('setup.javascript'));
    const weekDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

    const renderBusinessHours = () => {
        hoursList.replaceChildren();
        if (businessHours.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'empty-hours';
            empty.textContent = copy.empty_hours;
            hoursList.append(empty);
            return;
        }

        businessHours.forEach((hours, index) => {
            const row = document.createElement('div');
            row.className = 'business-hours-row';
            const addField = (labelText, input) => {
                const label = document.createElement('label');
                label.append(document.createTextNode(labelText), input);
                row.append(label);
            };
            const day = document.createElement('select');
            day.name = 'business_hours[' + index + '][day]';
            day.setAttribute('aria-label', copy.day);
            weekDays.forEach((key) => {
                const option = document.createElement('option');
                option.value = key;
                option.textContent = (dayLabels[localeSelect.value] || dayLabels.es)[key];
                day.append(option);
            });
            day.value = hours.day || weekDays[index % weekDays.length];

            const opens = document.createElement('input');
            opens.type = 'time';
            opens.name = 'business_hours[' + index + '][open]';
            opens.required = true;
            opens.value = hours.open || '09:00';

            const closes = document.createElement('input');
            closes.type = 'time';
            closes.name = 'business_hours[' + index + '][close]';
            closes.required = true;
            closes.value = hours.close || '18:00';

            addField(copy.day, day);
            addField(copy.opens, opens);
            addField(copy.closes, closes);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'business-hours-remove';
            remove.textContent = copy.remove;
            remove.addEventListener('click', () => {
                businessHours.splice(index, 1);
                renderBusinessHours();
            });
            row.append(remove);
            hoursList.append(row);
            day.addEventListener('change', () => { hours.day = day.value; });
            opens.addEventListener('change', () => { hours.open = opens.value; });
            closes.addEventListener('change', () => { hours.close = closes.value; });
        });
    };

    initialAdditionalCurrencies.forEach((code) => {
        if (currencies.includes(code) && code !== currencySelect.value && !selectedAdditionalCurrencies.includes(code)) {
            selectedAdditionalCurrencies.push(code);
        }
    });
    businessHours = Array.isArray(initialBusinessHours) ? initialBusinessHours.map((entry) => ({ ...entry })) : [];
    renderCurrencyOptions();
    renderAdditionalCurrencies();
    renderBusinessHours();

    const renderCountryOptions = () => {
        const locale = localeSelect.value || 'es';
        let displayNames = null;

        try {
            displayNames = typeof Intl !== 'undefined' && Intl.DisplayNames
                ? new Intl.DisplayNames([locale], { type: 'region' })
                : null;
        } catch (error) {
            displayNames = null;
        }

        const options = countryCodes.map((code) => ({
            code,
            label: displayNames?.of(code) || code,
        })).sort((a, b) => a.label.localeCompare(b.label, locale));

        const selected = countrySelect.value || preferredCountry;
        countrySelect.replaceChildren(...options.map(({ code, label }) => {
            const option = document.createElement('option');
            option.value = code;
            option.textContent = label + ' (' + code + ')';
            return option;
        }));

        countrySelect.value = countryCodes.includes(selected) ? selected : 'NI';
    };

    renderCountryOptions();
    const syncSetupUrl = () => {
        const url = new URL(window.location.href);
        url.searchParams.set('locale', localeSelect.value);
        url.searchParams.set('country_code', countrySelect.value || preferredCountry);
        window.history.replaceState({}, '', url.toString());
        const query = '?locale=' + encodeURIComponent(localeSelect.value)
            + '&country_code=' + encodeURIComponent(countrySelect.value || preferredCountry);
        form.action = '/setup' + query;
        const cancelForm = document.getElementById('nexora-cancel-form');
        if (cancelForm) cancelForm.action = '/setup/cancel' + query;
    };

    localeSelect.addEventListener('change', () => {
        const url = new URL(window.location.href);
        url.searchParams.set('locale', localeSelect.value);
        url.searchParams.set('country_code', countrySelect.value || preferredCountry);
        window.location.assign(url.toString());
    });
    countrySelect.addEventListener('change', () => {
        applyCountryCurrency();
        updateDefaultPhoneCallingCodes();
        syncSetupUrl();
    });
    currencySelect.addEventListener('change', () => {
        const index = selectedAdditionalCurrencies.indexOf(currencySelect.value);
        if (index !== -1) selectedAdditionalCurrencies.splice(index, 1);
        renderAdditionalCurrencies();
    });
    addCurrencyButton.addEventListener('click', () => {
        const code = currencyPicker.value;
        if (!code || selectedAdditionalCurrencies.includes(code)) return;
        if (selectedAdditionalCurrencies.length >= 10) {
            window.alert(copy.max_additional_currencies);
            return;
        }
        selectedAdditionalCurrencies.push(code);
        renderAdditionalCurrencies();
    });
    document.getElementById('add-business-hours').addEventListener('click', () => {
        if (businessHours.length >= 14) return;
        businessHours.push({ day: weekDays[businessHours.length % weekDays.length], open: '09:00', close: '18:00' });
        renderBusinessHours();
    });

    cancel.addEventListener('click', (event) => {
        if (!window.confirm(copy.cancel_confirm)) {
            event.preventDefault();
        }
    });

    form.querySelectorAll('[data-password-toggle]').forEach((button) => {
        button.addEventListener('click', () => {
            const input = document.getElementById(button.getAttribute('aria-controls'));

            if (!input) return;

            const shouldShow = input.type === 'password';
            input.type = shouldShow ? 'text' : 'password';
            button.textContent = shouldShow ? copy.hide_password : copy.show_password;
            button.setAttribute('aria-label', shouldShow ? (button.getAttribute('aria-controls') === 'owner-password-confirmation' ? copy.hide_password_confirmation_aria : copy.hide_password_aria) : (button.getAttribute('aria-controls') === 'owner-password-confirmation' ? copy.show_password_confirmation_aria : copy.show_password_aria));
            button.setAttribute('aria-pressed', String(shouldShow));
        });
    });

    const showStep = (index) => {
        current = index;
        steps.forEach((step, i) => { step.hidden = i !== index; });
        prev.hidden = index === 0;
        next.hidden = index === steps.length - 1;
        submit.hidden = index !== steps.length - 1;
        counter.textContent = copy.wizard_step.replace(':current', String(index + 1)).replace(':total', String(steps.length));
        progress.style.width = (((index + 1) / steps.length) * 100) + '%';
        if (index === 3) renderTemplate();
        if (index === 4) renderReview();
    };

    const validationMessage = (field) => {
        if (field.validity.valueMissing) return copy.validation.required;
        if (field.validity.typeMismatch && field.type === 'email') return copy.validation.email;
        if (field.validity.tooShort) return copy.validation.min_length.replace(':min', String(field.minLength));
        if (field.validity.tooLong) return copy.validation.max_length.replace(':max', String(field.maxLength));
        if (field.validity.patternMismatch) return copy.validation.pattern;

        return copy.validation.invalid;
    };

    const validateStep = () => {
        for (const field of steps[current].querySelectorAll('input,select,textarea')) {
            if (field.type === 'hidden' || field.disabled) continue;
            field.setCustomValidity('');

            if (!field.checkValidity()) {
                field.setCustomValidity(validationMessage(field));
                field.reportValidity();
                return false;
            }
        }

        return true;
    };

    const clearCustomValidation = (event) => {
        if (event.target && typeof event.target.setCustomValidity === 'function') {
            event.target.setCustomValidity('');
        }
    };

    form.addEventListener('input', clearCustomValidation);
    form.addEventListener('change', clearCustomValidation);

    const defaultPhoneCallingCode = () => countryDialingCodes[countrySelect.value] || '';

    const formatPhoneNumber = (value) => {
        const digits = String(value || '').replace(/\D/g, '').slice(0, 15);

        if (digits.length <= 4) return digits;
        if (digits.length <= 8) return digits.slice(0, 4) + '-' + digits.slice(4);
        if (digits.length === 9) {
            return digits.slice(0, 3) + ' ' + digits.slice(3, 6) + ' ' + digits.slice(6);
        }
        if (digits.length >= 10) {
            return digits.slice(0, 3) + ' ' + digits.slice(3, 6) + ' ' + digits.slice(6);
        }

        return digits;
    };

    const reindexPhones = () => {
        [...phoneList.querySelectorAll('[data-phone-row]')].forEach((row, index) => {
            row.querySelector('[data-phone-calling-code]').name = 'phones[' + index + '][country_calling_code]';
            row.querySelector('[data-phone-number]').name = 'phones[' + index + '][number]';
            row.querySelector('[data-phone-show-hidden]').name = 'phones[' + index + '][show_public]';
            row.querySelector('[data-phone-show]').name = 'phones[' + index + '][show_public]';
            row.querySelector('[data-phone-primary]').value = String(index);
        });
    };

    const addPhoneRow = (initial = {}) => {
        const rows = phoneList.querySelectorAll('[data-phone-row]');
        if (rows.length >= 5) return;

        const row = document.createElement('div');
        row.className = 'phone-row';
        row.dataset.phoneRow = '';

        const details = document.createElement('div');
        const phoneInputs = document.createElement('div');
        phoneInputs.className = 'phone-input-grid';

        const codeLabel = document.createElement('label');
        codeLabel.append(document.createTextNode(copy.country_calling_code));
        const codeInput = document.createElement('input');
        codeInput.dataset.phoneCallingCode = '';
        codeInput.type = 'tel';
        codeInput.inputMode = 'tel';
        codeInput.maxLength = 4;
        codeInput.pattern = '\\+[1-9][0-9]{0,2}';
        codeInput.placeholder = '+505';
        codeInput.required = true;
        const suggestedCode = defaultPhoneCallingCode();
        codeInput.value = initial.country_calling_code || suggestedCode;
        codeInput.dataset.manual = initial.country_calling_code && initial.country_calling_code !== suggestedCode ? 'true' : 'false';
        codeInput.addEventListener('input', () => {
            codeInput.dataset.manual = 'true';
            codeInput.value = codeInput.value.replace(/[^+0-9]/g, '').replace(/(?!^)\+/g, '').slice(0, 4);
        });
        codeLabel.append(codeInput);

        const numberLabel = document.createElement('label');
        numberLabel.append(document.createTextNode(copy.mobile_number));
        const phoneInput = document.createElement('input');
        phoneInput.dataset.phoneNumber = '';
        phoneInput.type = 'tel';
        phoneInput.inputMode = 'numeric';
        phoneInput.maxLength = 22;
        phoneInput.placeholder = '8888-8888';
        phoneInput.required = true;
        phoneInput.value = formatPhoneNumber(initial.number || '');
        phoneInput.addEventListener('input', () => {
            phoneInput.value = formatPhoneNumber(phoneInput.value);
        });
        numberLabel.append(phoneInput);

        phoneInputs.append(codeLabel, numberLabel);
        details.append(phoneInputs);

        const phoneOptions = document.createElement('div');
        phoneOptions.className = 'phone-options';

        const primaryLabel = document.createElement('label');
        const primaryInput = document.createElement('input');
        primaryInput.dataset.phonePrimary = '';
        primaryInput.type = 'radio';
        primaryInput.name = 'primary_phone';
        primaryInput.value = '0';
        primaryInput.checked = initial.primary === true || (!initial.primary && rows.length === 0);
        primaryLabel.append(primaryInput, document.createTextNode(' ' + copy.primary));

        const publicLabel = document.createElement('label');
        const hiddenVisibilityInput = document.createElement('input');
        hiddenVisibilityInput.dataset.phoneShowHidden = '';
        hiddenVisibilityInput.type = 'hidden';
        hiddenVisibilityInput.value = '0';

        const publicVisibilityInput = document.createElement('input');
        publicVisibilityInput.dataset.phoneShow = '';
        publicVisibilityInput.type = 'checkbox';
        publicVisibilityInput.value = '1';
        publicVisibilityInput.checked = initial.show_public === undefined ? true : Boolean(Number(initial.show_public));
        publicLabel.append(
            hiddenVisibilityInput,
            publicVisibilityInput,
            document.createTextNode(' ' + copy.show_publicly),
        );

        phoneOptions.append(primaryLabel, publicLabel);

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'secondary-button';
        removeButton.dataset.removePhone = '';
        removeButton.textContent = copy.remove_phone;
        removeButton.addEventListener('click', () => {
            row.remove();
            reindexPhones();
        });

        row.append(details, phoneOptions, removeButton);
        phoneList.append(row);
        reindexPhones();
    };

    const updateDefaultPhoneCallingCodes = () => {
        const suggestedCode = defaultPhoneCallingCode();

        if (!suggestedCode) return;

        phoneList.querySelectorAll('[data-phone-row]').forEach((row) => {
            const codeInput = row.querySelector('[data-phone-calling-code]');

            if (codeInput.dataset.manual !== 'true') {
                codeInput.value = suggestedCode;
            }
        });
    };

    document.getElementById('add-phone').addEventListener('click', () => addPhoneRow());
    initialPhones.forEach((phone) => addPhoneRow(phone));

    const getValue = (name) => form.elements.namedItem(name)?.value || '';
    const templatePreviews = @json($templatePreviews);
    const renderTemplate = () => {
        const container = document.getElementById('template-summary');
        const preview = templatePreviews[getValue('business_type')];
        container.replaceChildren();

        if (!preview) {
            container.textContent = copy.template_select_prompt;
            return;
        }

        const title = document.createElement('strong');
        title.textContent = copy.template_selected.replace(':name', preview.label);
        container.append(title);

        const categoriesSection = document.createElement('section');
        categoriesSection.className = 'template-summary__section';
        const categoriesTitle = document.createElement('strong');
        categoriesTitle.textContent = copy.categories_to_create;
        const categories = document.createElement('div');
        categories.className = 'template-summary__items';

        preview.categories.forEach((category) => {
            const chip = document.createElement('span');
            chip.className = 'template-summary__chip';
            chip.textContent = category;
            categories.append(chip);
        });

        categoriesSection.append(categoriesTitle, categories);
        container.append(categoriesSection);

        preview.groups.forEach((group) => {
            const fieldsSection = document.createElement('section');
            fieldsSection.className = 'template-summary__section';
            const groupTitle = document.createElement('strong');
            groupTitle.textContent = copy.review_field_group.replace(':category', group.category).replace(':group', group.name);
            const fields = document.createElement('p');
            fields.className = 'template-summary__fields';
            fields.textContent = group.fields.join(' · ') || copy.without_initial_fields;
            fieldsSection.append(groupTitle, fields);
            container.append(fieldsSection);
        });
    };

    const renderReview = () => {
        const currencies = [getValue('primary_currency')].concat(selectedAdditionalCurrencies);
        const phones = [...phoneList.querySelectorAll('[data-phone-row]')].map((row) => {
            const code = row.querySelector('[data-phone-calling-code]')?.value || '';
            const number = row.querySelector('[data-phone-number]')?.value || '';
            return [code, number].filter(Boolean).join(' ');
        }).filter(Boolean);
        const rows = [
            [copy.review_language, localeSelect.selectedOptions[0]?.textContent || getValue('locale')],
            [copy.review_country, countrySelect.selectedOptions[0]?.textContent || getValue('country_code')],
            [copy.review_business, getValue('business_name')],
            [copy.review_template, form.elements.business_type.selectedOptions[0]?.textContent || ''],
            [copy.review_owner, getValue('owner_name')],
            [copy.review_email, getValue('owner_email')],
            [copy.review_primary_currency, getValue('primary_currency')],
            [copy.review_enabled_currencies, [...new Set(currencies)].join(', ')],
            [copy.review_contacts, phones.length ? phones.join(', ') : copy.review_no_phones],
            [copy.review_hours, businessHours.length ? businessHours.map((item) => {
                const day = dayLabels[item.day] || item.day;
                return day + ' ' + item.open + '–' + item.close;
            }).join(', ') : copy.review_no_hours],
            [copy.review_photos, form.querySelector('input[type="checkbox"][name="photos_enabled"]')?.checked ? copy.enabled : copy.disabled]
        ];
        document.getElementById('setup-review').replaceChildren(...rows.map(([label, content]) => {
            const row = document.createElement('div');
            const strong = document.createElement('strong');
            const span = document.createElement('span');
            strong.textContent = label;
            span.textContent = content;
            row.append(strong, span);
            return row;
        }));
    };

    next.addEventListener('click', () => {
        if (validateStep()) showStep(Math.min(current + 1, steps.length - 1));
    });
    prev.addEventListener('click', () => showStep(Math.max(current - 1, 0)));
    form.addEventListener('submit', (event) => {
        if (!validateStep()) {
            event.preventDefault();
            return;
        }
        submit.disabled = true;
        submit.textContent = @json(__('setup.creating_installation'));
    });
    syncSetupUrl();
    showStep(0);
})();
</script>
@endpush
