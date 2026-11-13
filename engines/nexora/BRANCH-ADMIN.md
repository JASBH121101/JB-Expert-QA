# NEXORA Admin — rama especializada

Base branch: `NEXORA-Core`.

Esta rama está reservada para evolucionar el motor administrativo de NEXORA. El código actual sigue formando parte de la aplicación Laravel compartida.

## Implementación actual
- Controladores: `engines/nexora/application/app/Modules/Admin/Http/Controllers/`
- Vistas: `engines/nexora/application/resources/views/admin/`
- Middleware/seguridad compartidos: `engines/nexora/application/app/Http/Middleware/` y `app/Core/Authorization/`
- Modelos/migraciones compartidos: `app/Models/` y `database/migrations/`
- Rutas: `routes/web.php`

## Responsabilidad
Autenticación y flujos administrativos, dashboard, productos, categorías, campos dinámicos, configuración del negocio y gestión de acceso.

## Reglas
1. Consumir contratos, catálogos y validadores compartidos desde Core.
2. No duplicar monedas, países, unidades, plantillas ni modelos de catálogo.
3. Toda operación administrativa debe autorizarse en backend, no solo ocultarse en UI.
4. Mantener traducciones ES/EN coherentes en el panel.
5. Añadir pruebas para permisos permitidos/denegados y regresiones responsive.

No se ha extraído todavía un paquete Composer autónomo ni se publica un paquete npm en esta rama.
