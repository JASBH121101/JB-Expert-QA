# Estado del NEXORA Library Engine

## Entrega inicial — 0.1.0

La primera extracción separa los catálogos de referencia de Setup y los coloca en App\Core\Library. Setup conserva fachadas de compatibilidad para que las rutas y vistas existentes no necesiten una migración inmediata.

### Componentes incluidos

- Geo: códigos de país, relación país-moneda y códigos telefónicos.
- Money: catálogo de códigos de moneda.
- Localization: idiomas habilitados para la instalación.
- Contact: normalización E.164 basada en un código telefónico seleccionado explícitamente.
- LibraryCatalog: diagnóstico de consistencia entre catálogos.

### Límites conocidos y siguiente trabajo

- Los datos son catálogos estáticos; todavía no se sincronizan con un registro ISO externo.
- La lista de monedas valida códigos de tres letras y relaciones internas, pero todavía no aporta metadatos oficiales de símbolo, decimales o vigencia.
- Las unidades (unit_dimension y unit_code) siguen embebidas en TemplateCatalog. Antes de extraerlas se deben definir códigos estables y compatibilidad con valores ya guardados.
- No se ha añadido conversión de divisas ni tasas externas.
- Los códigos telefónicos se validan en formato E.164; no se verifica asignación real, longitud nacional por país ni disponibilidad del número.

### Validación

Ejecutar desde engines/nexora/application:

    composer test
    composer lint

La suite nueva está en tests/Unit/Library/LibraryCatalogTest.php. Hasta ejecutar esos comandos en un entorno PHP con dependencias instaladas, esta entrega no debe considerarse certificada.
