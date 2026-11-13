# Estado inicial de extensiones NEXORA

Inventario basado en el commit importado `c83f4297f12fc3f804d396b3d3e4203cc8d4e7ae`.

| Extensión | Estado | Siguiente etapa |
|---|---|---|
| Setup | Existe en Laravel | Extraer servicios de catálogo reutilizables y reforzar instalación idempotente |
| Security | Parcial | Auditoría de autorización, sesiones, CSRF, rate limiting y pruebas negativas |
| Catalog | Existe en Laravel | Estabilizar contrato de categorías, campos dinámicos, valores, precios y publicación |
| Library | Parcial | Extraer países, monedas, teléfonos, locales y unidades a una API versionada |
| Media | Parcial | Separar validadores, almacenamiento, metadatos, miniaturas y adaptadores |
| Template | Parcial | Versionar definiciones y preservar datos cuando cambie una plantilla |
| Export | No identificado | Diseñar exportación PDF y proteger campos privados |
| Domain & TLS | No identificado | Crear diagnóstico DNS/TLS e instrucciones/automatización segura según VPS |

## Condición para declarar un paquete instalable

Cada paquete debe tener API pública, dependencias explícitas, pruebas unitarias y de contrato, integración documentada con Laravel, compatibilidad/versionado y revisión de licencias. Un directorio, clase o README no basta para declarar un motor instalable.

La arquitectura inicial sigue siendo un monolito modular Laravel distribuido como ZIP por instalación, según la documentación del origen.
