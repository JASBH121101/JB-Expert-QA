# NEXORA — copia central

Esta rama contiene la copia de trabajo de NEXORA dentro de JB-Expert-QA.

## Origen exacto
- Repositorio: https://github.com/JASBH121101/Nexora
- Rama: `feature/nexora-configurable-catalog`
- Commit: `c83f4297f12fc3f804d396b3d3e4203cc8d4e7ae`
- Archivos importados: 124
- Destino: `engines/nexora/application/`

La copia preserva el árbol de la rama de origen. El repositorio NEXORA original y sus ramas no fueron modificados.

## Instalación y tecnología
La aplicación copiada es un monolito modular Laravel:
- PHP: `^8.3`
- Laravel: `^13.17`
- Dependencias backend: Composer
- Instalación de producto prevista: ZIP independiente por negocio, en VPS del comprador

**No es un paquete npm.** npm puede distribuir bibliotecas JavaScript del frontend, pero no instala el backend PHP. Los futuros paquetes PHP deberán diseñarse y probarse como paquetes Composer antes de publicarse.

## Ramas de desarrollo
- `NEXORA-Core`: copia base, contratos y servicios compartidos.
- `NEXORA-Admin`: desarrollo del panel privado; parte de NEXORA-Core.
- `NEXORA-Site-Engine`: desarrollo del sitio público; parte de NEXORA-Core.

Las dos ramas especializadas comparten el commit base de Core. No son subramas jerárquicas nativas de Git, pero sí líneas de trabajo independientes.

## Enfoque principal
La primera extracción prioritaria es **NEXORA Library Engine**: países, monedas, relación país-moneda, códigos telefónicos, locales, dimensiones y unidades de medida. Actualmente esos datos están parcialmente agrupados dentro de Setup y TemplateCatalog.

No se publican paquetes ni se declara una instalación npm/Composer hasta que exista una API estable, dependencias separadas, pruebas contractuales y documentación.
