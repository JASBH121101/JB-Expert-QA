<?php

use App\Core\Security\TrustedProxyList;

return [
    /*
    |--------------------------------------------------------------------------
    | Installation environment
    |--------------------------------------------------------------------------
    |
    | "demo" enables the protected demonstration reset workflow. Production
    | installations must leave this set to "production".
    |
    */
    'installation_mode' => env('NEXORA_INSTALLATION_MODE', 'production'),

    'trusted_proxies' => TrustedProxyList::parse(env('TRUSTED_PROXIES')),
];
