# NEXORA — Arquitectura del catálogo configurable

**Modelo:** código fuente reutilizable + una instalación independiente por negocio.  
**Backend objetivo:** Laravel 13 / PHP 8.3+ + PostgreSQL (PostgreSQL 16 en el entorno de referencia).  
**Interfaz:** Blade, HTML, CSS y JavaScript.  
**Alcance:** catálogo web configurable; no ERP y no SaaS centralizado multiempresa.

## 1. Principios

1. Cada instalación pertenece a un negocio y tiene su propia base de datos, archivos, configuración y propietario.
2. No hay registro central ni selector multiempresa en producción.
3. Las plantillas son configuraciones iniciales, no estructuras SQL separadas por industria.
4. Los campos dinámicos se almacenan como definiciones y valores asociados a productos; el cliente nunca ejecuta SQL.
5. Los campos base del producto son estables y protegidos.
6. Las imágenes son opcionales por instalación y se validan en servidor.
7. La aplicación básica no depende de servicios de pago obligatorios.

## 2. Componentes de aplicación

- **Setup/Installer:** primer acceso controlado; crea al propietario y los datos iniciales. Se bloquea después de finalizar.
- **Business Settings:** identidad, moneda, teléfonos, preferencias de catálogo y fotos.
- **Template Registry:** plantillas sectoriales versionadas.
- **Catalog Schema Manager:** grupos, definiciones, tipos, opciones, unidades, visibilidad y orden.
- **Product Manager:** datos base y valores configurables.
- **Public Catalog Renderer:** genera fichas desde las mismas definiciones guardadas.
- **Media Manager:** valida y almacena imágenes localmente.
- **Owner Dashboard:** resumen y operaciones del propietario.

La UI del editor no debe contener lógica de autorización. Las políticas y validaciones se ejecutan en Laravel.

## 3. Flujo de primer inicio

El asistente de producción debe respetar los cuatro pasos del prototipo y no crear parcialmente una cuenta si el usuario abandona el proceso:

1. **Negocio y propietario:** nombre comercial, nombre del propietario, correo, credenciales iniciales, tipo de negocio y hasta cinco teléfonos de contacto. Se elige un número principal y la visibilidad pública de cada uno.
2. **Identidad y monedas:** logotipo/portada opcionales, descripción, color principal, ubicación/horario opcionales, moneda principal y monedas adicionales.
3. **Plantilla y catálogo:** plantilla sectorial, grupos, campos dinámicos, unidades, preferencia de fotografías y vista previa.
4. **Revisión y confirmación:** validar el resumen y confirmar la instalación.

Al confirmar el último paso, Laravel guarda la configuración y crea al propietario dentro de una transacción; si cualquier operación falla, se revierte la creación para no dejar una instalación a medias. La contraseña se almacena con el hasher del framework, nunca en texto plano. Después de guardar, Laravel envía el enlace de verificación de correo y el instalador bloquea el alta inicial. La cuenta puede quedar pendiente de verificación hasta que el propietario confirme su dirección.

El prototipo omite deliberadamente la captura de contraseñas reales. La implementación de producción deberá incluirla en el formulario seguro del propietario y nunca persistirla en localStorage ni en el navegador.

El registro de números no verifica su titularidad. OTP por SMS o WhatsApp se deja como integración opcional después de elegir proveedor, precio y consentimiento. Los botones de contacto utilizan enlaces `wa.me`; no requieren WhatsApp Business API.

## 4. Plantillas y catálogo dinámico

### Plantillas iniciales

- Perfumería: marca, fragancia, concentración y presentación/volumen.
- Ropa y calzado: talla, color, material y público.
- Tecnología: marca, modelo, procesador, RAM y almacenamiento.
- Gimnasio/fitness: tipo de equipo, peso, material y resistencia.
- Repuestos/vehículos: marca, modelo compatible, año, código de pieza y estado.
- Alimentos/abarrotes: contenido, unidad, presentación y vencimiento.
- Otro: grupo inicial libre.

Cada plantilla es un conjunto versionado de grupos y definiciones. Su aplicación inicial crea registros de configuración para esa instalación. No crea tablas nuevas.

### Editor

Cada grupo tiene nombre, orden y una colección de campos. Cada campo tiene:
- clave interna estable (slug/UUID), etiqueta y tipo de dato;
- orden dentro del grupo;
- ancho semántico (media columna o fila completa);
- indicador obligatorio;
- visibilidad en la ficha pública;
- disponibilidad como criterio de búsqueda/filtro;
- opciones para listas;
- magnitud y unidad para campos numéricos medibles.

Los tipos iniciales son texto, número, lista, selección múltiple, booleano, fecha y texto largo. Los valores se validan según tipo en servidor. Las opciones de listas se guardan en JSON validado.

### Cambio de plantilla y conservación de datos

Cambiar la plantilla no debe sobrescribir campos personalizados silenciosamente. El comportamiento de producción será:
- **Combinar sugerencias:** incorporar grupos/campos que falten, conservar campos existentes, valores, visibilidad y orden.
- **Reiniciar plantilla:** solo tras confirmación explícita, mostrando qué campos y valores se eliminarán.
- No reutilizar claves internas ni borrar valores por coincidencia de etiqueta únicamente.

Al eliminar una definición con valores, solicitar confirmación y permitir exportar o conservar un respaldo antes de eliminarla.

## 5. Modelo relacional propuesto

| Tabla | Responsabilidad |
|---|---|
| `users` | Propietario de esta instalación |
| `business_settings` | Identidad, tipo de negocio, color, opciones y bandera de fotos |
| `business_contacts` | Hasta cinco números, principal y visibilidad |
| `business_currencies` | Monedas habilitadas y moneda principal |
| `categories` | Categorías propias del catálogo |
| `products` | Nombre, descripción, categoría, estado y datos base |
| `product_prices` | Precio por producto y moneda habilitada |
| `product_images` | Ruta, metadatos, texto alternativo y posición |
| `measurement_units` | Biblioteca predeterminada y unidades personalizadas por dimensión |
| `product_field_groups` | Grupos de ficha y orden |
| `product_field_definitions` | Tipo, opciones, flags, unidad, ancho y orden |
| `product_field_values` | Valor de un campo dinámico para un producto |

### Reglas de datos

- Claves foráneas y restricciones de unicidad para evitar valores huérfanos.
- `product_field_definitions.key` es estable, única dentro de la instalación y no depende de la etiqueta visible.
- `product_field_values` tiene unicidad por producto y definición.
- Valor dinámico almacenado en columnas JSONB y validado por Laravel. No interpolar nombres de tablas o columnas a partir de campos del usuario.
- `product_prices` se relaciona con códigos ISO 4217 y solo admite monedas habilitadas.
- Cada unidad pertenece a una dimensión (masa, volumen, desplazamiento del motor, longitud, cantidad, capacidad digital o área); los selectores solo muestran unidades de la dimensión correspondiente.
- Las unidades personalizadas se guardan dentro de su dimensión y no alteran la biblioteca global de otras instalaciones.
- El límite de cinco teléfonos se aplica en validación de servidor y en restricciones de datos compatibles.

## 6. Reglas de presentación y prevención de solapamientos

1. La ficha pública y la vista previa comparten el mismo componente de renderizado.
2. Los grupos se ordenan por `sort_order`; los campos también, dentro de su grupo.
3. La distribución usa CSS Grid/Flexbox con flujo normal, nunca coordenadas absolutas para campos.
4. Un campo de ancho completo ocupa toda la fila; los de media columna se acomodan en una rejilla de dos columnas.
5. En anchos móviles la rejilla pasa a una columna.
6. Etiquetas largas pueden envolver líneas; valores largos usan `overflow-wrap:anywhere`.
7. Campos ocultos no se muestran ni se filtran desde la página pública.
8. Solo los tipos y campos autorizados pueden habilitar búsqueda/filtro.
9. Imágenes se presentan en su bloque reservado; si fotos están deshabilitadas no se renderiza ese bloque.

## 7. Monedas, precios y unidades

- Código de moneda ISO 4217, moneda principal y conjunto de monedas habilitadas.
- Versión inicial: captura manual de un precio por moneda. No convertir automáticamente importes.
- Conversión automática necesitaría proveedor de tasas, frecuencia, fecha de actualización y manejo de errores; es una integración opcional con costo potencial.
- La unidad es un atributo de campo numérico (por ejemplo, volumen/ml, masa/kg o desplazamiento del motor/cc) o de presentación, según configuración.
- No presentar litros en campos de peso ni unidades de masa en una dimensión de volumen. El cilindraje del motor (cc) pertenece a una dimensión separada del volumen de líquidos. No mezclar GB/TB con unidades de conteo.

## 8. Fotografías

- La bandera `photos_enabled` se configura por instalación.
- Si es falsa, el formulario oculta la carga y el endpoint rechaza archivos.
- Si es verdadera, las imágenes se guardan en el disco configurado de Laravel y la base almacena rutas/metadatos, nunca blobs.
- Validar MIME real, extensión, tamaño, dimensiones y permisos.
- Generar nombres aleatorios; no confiar en el nombre ni extensión enviados por el navegador.
- Preferir WebP cuando el servidor pueda procesarlo; crear miniaturas y limitar dimensiones.
- La política de cantidad máxima de imágenes por producto se define en configuración de servidor.

## 9. Seguridad

- Autenticación de Laravel y verificación de correo.
- Hash de contraseña con el hasher del framework.
- CSRF en formularios; sesiones y cookies seguras con HTTPS.
- Rate limiting en login, recuperación y verificación.
- Todas las rutas administrativas requieren autenticación y autorización server-side.
- Validación de datos en Form Requests y políticas.
- Sanitización/escape de salida en Blade.
- Carga de archivos limitada a tipos y tamaños permitidos; nombres generados.
- Bloqueo del setup luego de crear propietario y completar configuración.
- No incluir secretos en Git ni en ZIP.
- Pruebas de aislamiento de instalaciones; ninguna instalación comparte credenciales o base de datos.

## 10. WhatsApp

Los enlaces de contacto se componen desde números normalizados con código de país:
- Contacto general: número principal visible.
- Si hay varios números visibles, el visitante puede seleccionar destino.
- Consulta por producto: mensaje precargado con nombre del producto y precio, si lo hay.
- No guardar ni enviar mensajes por API desde NEXORA.

## 11. Instalación y entrega

El cliente contrata el VPS y decide cómo accederá a la instalación: con un dominio propio o con un subdominio gratuito de un proveedor externo que controle y pueda apuntar al VPS. NEXORA no registra dominios ni ofrece subdominios bajo un dominio central propio.

La aplicación se instala con:
1. Requisitos PHP/extensiones, Composer y servidor web.
2. Crear una base de datos PostgreSQL y un usuario con privilegios mínimos.
3. Configurar `.env`.
4. Ejecutar migraciones y seeders de biblioteca/plantillas.
5. Ejecutar el asistente de primer inicio y crear al propietario al confirmar.
6. Configurar DNS, HTTPS, almacenamiento y permisos de directorios.
7. Validar publicación, certificado TLS y copias de seguridad.

La versión compatible exacta de Laravel/PHP se fija al seleccionar el entorno mínimo de despliegue y ejecutar CI. No se habilitan servicios pagos sin aprobación.

## 12. Calidad y pruebas

- Pruebas unitarias de plantillas, validación, dimensiones de unidad y normalización de claves.
- Pruebas feature de setup de un solo uso, email verification, autenticación, CRUD y autorización.
- Pruebas de integración del guardado/lectura de valores dinámicos y precios por moneda.
- Pruebas de carga de imágenes con fotos habilitadas y deshabilitadas.
- Pruebas visuales/responsive de vista previa y ficha pública.
- JB Expert QA como auditoría auxiliar; no sustituye pruebas funcionales ni revisión visual.

## 13. Estado actual del repositorio

La demo estática contiene un prototipo del asistente y constructor en `demo/setup.html`. Los datos se guardan en `localStorage` y se limitan al navegador. No hay autenticación real, backend, verificación por correo, PostgreSQL ni almacenamiento seguro. La aplicación Laravel de producción sigue pendiente.


## 14. NEXORA Site Engine — personalización de la página pública

El Site Engine renderiza la página pública del negocio desde la configuración persistida en la misma instalación. El panel privado y el sitio público son superficies distintas: las rutas administrativas requieren autenticación y autorización; las rutas públicas solo exponen información expresamente publicada.

### Dos niveles de edición

**Nivel 1 — Personalización guiada (alcance inicial):**
- Selección de plantilla y variante visual disponible.
- Logotipo, colores, tipografías predefinidas y datos de presentación.
- Activación/desactivación de secciones permitidas.
- Configuración del encabezado, distribución del catálogo, tarjetas y contacto.
- Vista previa adaptable antes de publicar.

**Nivel 2 — Constructor visual avanzado (progresivo):**
- Agregar, quitar y reordenar secciones desde un catálogo de componentes aprobados.
- Elegir variantes y ajustar opciones controladas de espaciado, alineación y contenido.
- Vista previa en escritorio y móvil.
- Guardar cambios como borrador y publicarlos explícitamente.

El constructor no será un editor de código ni permitirá insertar HTML, JavaScript o CSS arbitrario. Las secciones y propiedades se validan en servidor mediante un esquema versionado y una lista permitida de componentes. Esto evita XSS, diseños rotos y configuraciones incompatibles.

### Modelo de publicación
- Configuración del sitio con estado borrador/publicado.
- Los cambios en borrador no alteran la página pública hasta confirmar publicación.
- El renderizador utiliza componentes Blade controlados y datos públicos validados.
- Productos en borrador u ocultos y campos marcados como privados nunca se exponen.
- Los cambios de plantilla deben conservar contenido y ofrecer combinación o reinicio con confirmación.
- La vista previa reutiliza el mismo renderizador y reglas de presentación del sitio publicado.

### Dominio y HTTPS
Cada instalación puede operar con un dominio propio. El cliente registra el dominio, configura DNS hacia su VPS y dispone de un servidor web que apunte a la aplicación. El instalador/guía comprueba la configuración y, cuando el entorno lo permita, facilita la emisión y renovación de TLS mediante ACME/Let's Encrypt. HTTPS no se considera garantizado solo por introducir un dominio: requiere DNS válido, puertos accesibles, servidor compatible y renovación operativa. Se fuerza HTTPS después de validar el certificado.

### Separación de superficies
- Sitio público: portada, catálogo, búsqueda, fichas y contactos públicos.
- Panel privado: login, productos, categorías, configuración, editor, vista previa y exportaciones.
- PDF y reportes administrativos solo se generan desde rutas autenticadas; nunca se publican por defecto.
