<?php

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
];
