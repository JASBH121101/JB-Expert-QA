# Límites de motores y extensiones NEXORA

El origen documenta un monolito modular Laravel con una aplicación y una base de datos compartidas. Los límites de abajo son módulos internos; todavía no equivalen a paquetes autónomos.

## Tres motores principales

| Motor | Implementación actual |
|---|---|
| Core | `application/app/Core`, `app/Providers`, modelos, configuración, migraciones y contratos compartidos |
| Admin | `application/app/Modules/Admin`, `resources/views/admin`, middleware y autorización |
| Site Engine | `application/app/Modules/Site`, `resources/views/site`, controlador y rutas públicas |

## Extensiones

| Extensión | Código identificado | Estado |
|---|---|---|
| Setup | `app/Modules/Setup`, `app/Core/Installation` | Implementado dentro de la aplicación |
| Security | `app/Core/Authorization`, `app/Http/Middleware`, rutas de acceso | Parcial; requiere auditoría y contratos |
| Catalog | modelos, migraciones, controladores de productos/categorías/campos | Implementado dentro de la aplicación |
| Library | catálogos Geo/Money/Localization/Contact y unidades de plantilla | Primer corte extraído a Core/Library 0.1.0; unidades y metadatos monetarios pendientes |
| Media | validación de imágenes y Storage desde ProductController | Parcial; no existe módulo autónomo |
| Template | `TemplateCatalog`, campos dinámicos y etiquetas ES/EN | Parcial/funcional dentro de Setup |
| Export | no se encontró implementación PDF en el árbol importado | Pendiente |
| Domain & TLS | documentación de DNS/HTTPS, sin implementación de motor en el árbol | Pendiente |

## Regla de dependencia

Core posee los contratos y servicios transversales. Admin y Site consumen esos contratos; no deben duplicar catálogos, modelos, reglas de permisos o validaciones. La visibilidad del lado del navegador nunca sustituye autorización del backend.

## Prioridad: Library Engine

Separar de Setup/Template:
- Catálogo de países ISO 3166-1 alpha-2.
- Monedas ISO 4217 y relación país-moneda.
- Códigos telefónicos y normalización internacional.
- Locales/idiomas disponibles.
- Dimensiones: masa, volumen, longitud, cantidad, capacidad digital y área.
- Unidades por dimensión, unidades personalizadas por instalación.
- Etiquetas traducibles ES/EN, sin alterar claves/códigos estables.

El motor debe entregar datos normalizados y versionados. No debe realizar conversión cambiaria automática ni depender de servicios externos para la biblioteca básica.
