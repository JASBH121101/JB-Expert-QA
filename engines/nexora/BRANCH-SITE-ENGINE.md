# NEXORA Site Engine — rama especializada

Base branch: `NEXORA-Core`.

Esta rama está reservada para evolucionar el sitio público y el renderizado del catálogo. El código actual permanece dentro de la aplicación Laravel compartida.

## Implementación actual
- Controlador público: `engines/nexora/application/app/Modules/Site/Http/Controllers/PublicSiteController.php`
- Vistas públicas: `engines/nexora/application/resources/views/site/`
- Layout compartido: `resources/views/layouts/app.blade.php`
- Modelos/catálogo compartidos: `app/Models/`
- Definiciones dinámicas: `app/Modules/Setup/Services/TemplateCatalog.php` y campos de catálogo
- Rutas: `routes/web.php`

## Responsabilidad
Página pública, catálogo publicado, filtros y búsqueda, fichas de producto, campos visibles, SEO básico y enlace de contacto.

## Reglas
1. Consumir los contratos del Catalog, Library y Template Engine desde Core.
2. Exponer únicamente productos publicados y campos autorizados.
3. No devolver datos privados ni depender de controles visuales del navegador para seguridad.
4. Mantener compatibilidad ES/EN y comportamiento responsive.
5. Añadir pruebas de contrato para visibilidad pública y campos dinámicos.

No se ha extraído todavía un paquete Composer autónomo ni se publica un paquete npm en esta rama.
