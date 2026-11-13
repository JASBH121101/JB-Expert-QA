# NEXORA Dynamic Catalog Engine

## Objetivo

Permitir que una instalación configure sus fichas de productos según su sector sin crear tablas SQL dinámicas, duplicar módulos ni alterar la estructura física de la base de datos.

## Plantillas base

| Tipo de negocio | Campos sugeridos |
|---|---|
| Perfumería | Marca, fragancia, concentración, contenido y presentación |
| Ropa/calzado | Talla, color, material y público |
| Tecnología | Marca, modelo, procesador, RAM y almacenamiento |
| Gimnasio/fitness | Tipo de equipo, peso, material y resistencia |
| Repuestos/vehículos | Marca, modelo compatible, año, código de pieza y estado |
| Alimentos/abarrotes | Marca, contenido, presentación y vencimiento |
| Otro | Grupo libre para comenzar |

Las plantillas son datos versionados que se copian a la configuración de una instalación. No son módulos pagados ni esquemas de base de datos diferentes.

## Anatomía de un campo

~~~json
{
  "key": "net_content",
  "label": "Contenido",
  "type": "number",
  "group": "presentation",
  "sort_order": 20,
  "width": "half",
  "required": false,
  "show_public": true,
  "searchable": false,
  "unit_dimension": "volume",
  "unit_code": "ml"
}
~~~

La clave interna no cambia cuando se renombra la etiqueta. La etiqueta sí puede traducirse o personalizarse. La definición se valida en el backend, al igual que cualquier valor ingresado para un producto.

## Tipos de campo

- text: cadenas cortas.
- textarea: texto largo.
- number: número decimal; puede tener dimensión y unidad.
- select: una opción de una lista controlada.
- multiselect: varias opciones.
- boolean: sí/no.
- date: fecha ISO.

La definición de lista incluye opciones y límites de cantidad. No se permite HTML arbitrario, JavaScript ni expresiones SQL en los campos.

## Grupos, orden y ancho

Cada ficha tiene grupos; cada grupo tiene campos ordenados. El editor permite:
- Cambiar el nombre del grupo.
- Crear/eliminar grupos vacíos.
- Mover grupos arriba/abajo.
- Crear, renombrar, configurar, mover y eliminar campos.
- Definir obligatoriedad, visibilidad pública, filtro y ancho.
- Ver una previsualización mientras se edita.

Un grupo con campos no se elimina hasta moverlos o eliminarlos. En producción, eliminar campos con datos requiere confirmación y política explícita de retención.

## Reglas para evitar solapamientos

- Usar CSS Grid con dos columnas en escritorio.
- Los campos width=full abarcan toda la rejilla.
- Los campos width=half ocupan una columna.
- En móvil, todos los campos se apilan en una columna.
- No ubicar elementos con position:absolute para maquetar valores variables.
- Etiquetas y valores admiten varias líneas; valores largos deben poder envolver.
- El mismo componente de renderizado sirve para editor, previsualización y ficha pública.
- La vista pública omite campos con show_public=false.
- Las etiquetas duplicadas dentro del mismo grupo se rechazan; las claves internas son únicas en la instalación.

## Unidades

| Dimensión | Biblioteca inicial |
|---|---|
| Masa | kg, g, lb, oz |
| Volumen | L, ml, gal, fl oz |
| Cilindraje de motor | cc |
| Longitud | m, cm, mm, in, ft |
| Cantidad | unidad, pieza, par, paquete, caja, docena |
| Capacidad digital | MB, GB, TB |
| Área | m², ft² |

Una unidad pertenece a una dimensión. La UI solo presenta las unidades correspondientes a la magnitud seleccionada. RAM/almacenamiento utilizan capacidad digital y el cilindraje utiliza la magnitud de desplazamiento del motor (cc), separada del volumen de líquidos. Los clientes pueden agregar unidades propias a la biblioteca local de su instalación; no se modifican otras instalaciones.

## Fotografías opcionales

El interruptor photos_enabled pertenece a business_settings. Cuando está desactivado:
- No se muestra el selector de imágenes en el formulario de producto.
- La vista pública no reserva un bloque vacío de galería.
- El backend rechaza archivos aunque se intente llamar el endpoint manualmente.

Cuando se activa:
- La ficha puede incluir cero o varias imágenes según el límite configurado.
- Los archivos se guardan localmente en el VPS; MySQL/MariaDB conserva rutas y metadatos.
- Las imágenes reciben nombres aleatorios, validación MIME/tamaño/dimensiones y miniaturas.

## Monedas y precios

El código de moneda debe ser ISO 4217. Cada instalación define una moneda principal y monedas adicionales habilitadas. Los precios se registran manualmente por moneda y producto. El primer alcance no realiza conversión automática ni consulta un proveedor de tipos de cambio.

## Cambiar de plantilla sin perder datos

El editor presenta dos caminos explícitos:
1. **Combinar sugerencias:** añade los campos/grupos que falten y conserva los existentes.
2. **Reiniciar plantilla:** advierte qué definiciones y valores personalizados se eliminarán y requiere confirmación.

Nunca borrar valores de productos como efecto lateral silencioso del cambio de rubro.

## Lo que este motor no hace

No crea tablas/columnas desde el navegador, no gestiona existencias, inventario, pedidos, pagos, facturación ni contabilidad. No convierte NEXORA en ERP ni en plataforma SaaS multiempresa.

## Estado del prototipo

El asistente está en demo/setup.html con lógica en demo/assets/js/setup.js y estilos en demo/assets/css/setup.css. Solo persiste en el almacenamiento local del navegador; no es seguridad ni persistencia de producción.
