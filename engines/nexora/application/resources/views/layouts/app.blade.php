<!doctype html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="theme-color" content="#f5f6f2">
    <title>@yield('title', 'NEXORA')</title>
    <style>
        :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#20271f;background:#f5f6f2;font-synthesis:none}
        *{box-sizing:border-box}body{margin:0;min-height:100vh}.wrap{width:min(920px,calc(100% - 32px));margin:0 auto;padding:42px 0}
        .brand{font-size:20px;font-weight:850;letter-spacing:.08em}.brand span{color:#89a92f}.muted{color:#697366}.panel{margin-top:26px;padding:26px;border:1px solid #e1e6da;border-radius:18px;background:#fff;box-shadow:0 14px 40px rgba(36,48,27,.05)}
        h1{margin:12px 0 8px;font-size:clamp(27px,5vw,38px);letter-spacing:-.04em}h2{font-size:17px;margin:0 0 12px}p{line-height:1.6}.footer{margin-top:24px;color:#889083;font-size:12px}
        .checks{display:grid;gap:10px;margin:18px 0}.check{display:flex;justify-content:space-between;gap:16px;padding:13px 14px;border:1px solid #e6eae2;border-radius:11px}.check strong{font-size:13px}.check small{display:block;margin-top:4px;color:#6f796b}.status{flex:none;font-size:11px;font-weight:800}.ok{color:#347b43}.fail{color:#b33a3a}.note{padding:12px 14px;border-radius:10px;background:#f4f6ef;color:#56614d;font-size:13px}code{font-size:.92em;overflow-wrap:anywhere}
        @media(max-width:560px){.wrap{padding:25px 0}.panel{padding:19px}.check{align-items:flex-start;flex-direction:column;gap:8px}}
    </style>
    @stack('head')
</head>
<body>
    <main class="wrap">
        <div class="brand">NEXORA<span>.</span></div>
        @yield('content')
        <div class="footer">{{ __('setup.footer') }}</div>
    </main>
    @stack('scripts')
</body>
</html>
