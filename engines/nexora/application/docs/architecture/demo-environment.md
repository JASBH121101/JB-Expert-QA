# NEXORA demo and QA environment

NEXORA uses two separate installation modes. The mode is set on the server, not selected by the business owner in the browser.

## Demo / QA

Use a dedicated deployment or local copy with a database that is not shared with production.

Example environment values:

```dotenv
APP_ENV=production
APP_DEBUG=false
NEXORA_INSTALLATION_MODE=demo

DB_CONNECTION=pgsql
DB_HOST=127.0.0.1
DB_PORT=5432
DB_DATABASE=nexora_demo
DB_USERNAME=nexora_demo_user
DB_PASSWORD=replace-with-a-demo-only-password
```

Keep the demo database empty before the first installation. The installer refuses to initialize a non-empty database that does not belong to NEXORA.

When the demo installation is completed, NEXORA writes `environment.mode=demo` into the installation configuration. The setup page displays a demo warning.

### Reset demo data

From the demo deployment root, run:

```bash
php artisan nexora:demo:reset --confirm=RESET-DEMO-DATA
```

The reset command requires both safeguards:

1. Server configuration must contain `NEXORA_INSTALLATION_MODE=demo`.
2. The completed database installation must be marked `environment.mode=demo`.

The command deletes NEXORA's demo business data, owner account, catalog records, sessions, and referenced public images. It preserves database tables, indexes, constraints, and the Laravel migration history, so the setup wizard can be run again.

The command does **not** use `migrate:fresh`, drop tables, roll back migrations, or reset any database that lacks the explicit demo marker. The additional `--confirm=RESET-DEMO-DATA` value is mandatory.

## Production

Production must use its own database and:

```dotenv
NEXORA_INSTALLATION_MODE=production
APP_DEBUG=false
```

Production mode is the default when `NEXORA_INSTALLATION_MODE` is missing. The demo reset command refuses to run in production mode, even if its confirmation argument is supplied.

Never point the demo deployment at a customer database. Do not change a customer installation's environment mode to `demo`.

## Installer language

The owner selects Spanish or English in step 1. Changing this selector reloads the setup wizard in the selected language while preserving the selected country. The language is then used for:

- installer headings, descriptions, buttons, dynamic controls, and review summary;
- server preflight and database preparation messages;
- validation errors;
- initial template categories, groups, field labels, and select options;
- the installation's saved regional locale.

Template field keys and field types remain stable across languages. Only presentation labels and initial option text are localized. This keeps the catalog's technical contract consistent.

## QA checklist

- Open `/setup?locale=es` and verify the wizard is Spanish.
- Open `/setup?locale=en` and verify the wizard, preflight checks, controls, and review summary are English.
- Change the language from step 1 and verify that the selected country remains selected.
- Submit an invalid English form and verify that validation messages are English.
- Install one template in each language and verify the initial categories, groups, labels, and options.
- Confirm the installation's saved `regional.locale` and `environment.mode`.
- Reset the demo installation with the exact confirmation argument and verify that the schema remains available and the setup wizard can be completed again.
- Set the mode to production and verify that the demo reset command is refused without deleting data.
