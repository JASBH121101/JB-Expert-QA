# NEXORA — Alcance del producto configurable

## 1. Propósito

NEXORA permite a un negocio publicar un catálogo web y administrar productos desde un panel privado. El propietario elige el tipo de negocio y recibe una plantilla sectorial que puede editar. El mismo código fuente se reutiliza, pero cada negocio tiene una instalación, base de datos, archivos y configuración independientes.

NEXORA no es ERP, POS, comercio electrónico transaccional ni SaaS centralizado multiempresa.

## 2. Modelo de usuarios

- **Propietario:** primera cuenta de la instalación. Administra identidad, contactos, plantilla y catálogo.
- **Visitante:** consulta productos y contacta al negocio por WhatsApp.

No existe registro central abierto de empresas. El registro inicial se ejecuta una sola vez durante la instalación y se bloquea al crear el propietario. Los roles avanzados quedan fuera de la primera versión.

## 3. Asistente de configuración inicial

### Paso 1 — Negocio y propietario
- Nombre comercial.
- Nombre completo del propietario.
- Correo electrónico con verificación.
- Tipo de negocio: perfumería, ropa/calzado, tecnología, gimnasio/fitness, repuestos/vehículos, alimentos/abarrotes u otro.
- Alta de hasta cinco teléfonos de WhatsApp.
- Un número principal y selección individual de los números visibles en la web.

La verificación del correo se realizará desde el servidor. Verificación por SMS o WhatsApp OTP es opcional y requiere proveedor/costo aprobado; registrar un número no equivale a verificar su titularidad.

### Paso 2 — Identidad y monedas
- Logotipo y portada opcionales.
- Descripción comercial.
- Color principal.
- Moneda principal.
- Activación de monedas adicionales desde una biblioteca.
- Ubicación y horario opcionales.

La versión inicial permite precios por moneda registrados manualmente. Conversión automática con tasas externas queda fuera de alcance hasta definir proveedor y presupuesto.

### Paso 3 — Plantilla y datos de producto
- Cargar una plantilla según el tipo de negocio.
- Plantillas editables: agregar, renombrar, ordenar o eliminar grupos y campos.
- La plantilla puede cambiarse sin perder silenciosamente personalizaciones: el cambio debe ofrecer combinación de campos nuevos o reinicio explícitamente confirmado.
- Fotografías opcionales a nivel de configuración de la instalación. Si se deshabilitan, el formulario de producto no muestra el campo de imágenes y el backend rechaza cargas.
- Biblioteca de unidades por dimensión: masa, volumen, desplazamiento del motor, longitud, cantidad, capacidad digital y área.
- Permitir agregar unidades personalizadas dentro de una dimensión.
- No mostrar unidades incompatibles con la dimensión elegida.

### Paso 4 — Revisión
- Resumen de identidad, contactos, monedas, fotos y estructura.
- Guardar configuración y pasar al panel del propietario.

## 4. Ficha de producto

Los campos base pertenecen al sistema y no se pueden eliminar:
- Nombre (obligatorio).
- Descripción (obligatoria).
- Categoría (obligatoria).
- Estado (borrador/publicado u oculto).
- Precio opcional y precios para monedas habilitadas.

Los campos sectoriales son configurables:
- Texto, número, lista, selección múltiple, booleano, fecha y texto largo.
- Grupo de información y posición.
- Ancho de presentación (media columna o ancho completo).
- Obligatorio/opcional.
- Visible/no visible en la ficha pública.
- Habilitado/no habilitado como criterio de búsqueda o filtro, sujeto al tipo de dato.
- Magnitud y unidad opcionales para campos numéricos.

Las imágenes son opcionales por instalación. Cuando están habilitadas, un producto puede tener cero o varias imágenes según la configuración de producto; el límite operativo se define en backend.

## 5. Organización visual y prevención de solapamientos

- Los campos se muestran dentro de grupos ordenados.
- Cada campo tiene una posición numérica estable y un ancho semántico.
- La presentación utiliza CSS Grid/Flexbox; no usa posicionamiento absoluto para disponer campos.
- Los campos de texto largo y los definidos como ancho completo abarcan la fila.
- En móvil se apilan en una columna.
- La vista previa usa el mismo componente de presentación que la ficha pública.
- Los campos privados no se publican ni se incluyen en los filtros públicos.
- Los campos base del sistema se presentan en secciones reservadas.

## 6. Página pública

- Portada con identidad y datos opcionales del negocio.
- Catálogo responsive.
- Búsqueda y categorías.
- Ficha de producto con grupos y campos visibles.
- Fotografías solo si están habilitadas.
- Precio en una moneda disponible o consulta sin precio.
- Enlace general de WhatsApp y enlaces contextuales por producto.
- Si hay varios teléfonos visibles, el visitante puede seleccionar el destino; el número principal se usa por defecto.

NEXORA abre enlaces `https://wa.me/` con mensajes preparados. No procesa pedidos, pagos ni conversaciones dentro de la aplicación.

## 7. Panel administrativo

- Resumen de productos, categorías y estado de publicación.
- CRUD de productos y categorías.
- Configuración de contactos, identidad, moneda y fotografías.
- Editor de plantillas y grupos/campos.
- Vista previa de fichas.
- Cuenta y seguridad del propietario.

## 8. Fuera de alcance inicial

- Carrito, checkout, pasarelas de pago y pedidos.
- Inventario, existencias, almacenes, compras y proveedores.
- Facturación, contabilidad, nómina, POS o CRM.
- Plataforma SaaS centralizada, tenants compartidos o activación de módulos.
- App móvil nativa.
- Automatización de WhatsApp Business API.
- OTP externo por SMS/WhatsApp sin aprobación.
- Conversión automática de divisas.
- Sincronización ERP o integraciones de terceros no acordadas.

## 9. Modelo de datos conceptual

- `users`: propietario.
- `business_settings`: identidad, opciones del catálogo y configuración de fotos.
- `business_contacts`: hasta cinco teléfonos, número principal y visibilidad.
- `business_currencies`: monedas habilitadas y moneda principal.
- `categories`: categorías.
- `products`: datos base del producto y estado.
- `product_prices`: precio por moneda habilitada.
- `product_images`: rutas y metadatos de imágenes (solo cuando fotos estén habilitadas).
- `product_field_groups`: secciones ordenadas de la ficha.
- `product_field_definitions`: definición, tipo, opciones, unidad, validación, visibilidad y orden.
- `product_field_values`: valor por producto y definición.

Los campos dinámicos se modelan como metadatos/valores; nunca crean tablas SQL arbitrarias solicitadas desde el navegador.

## 10. Criterios de aceptación

1. El asistente valida datos básicos y limita los contactos a cinco.
2. Se puede seleccionar el número principal y la visibilidad de cada contacto.
3. La configuración de fotografías controla la presencia del campo de carga y la validación de servidor.
4. La moneda principal siempre está dentro de las monedas habilitadas.
5. Las plantillas sectoriales precargan grupos y campos coherentes.
6. Se pueden agregar, editar, ordenar y eliminar campos/grupos sin colisiones de nombres dentro de un grupo.
7. Los campos numéricos solo ofrecen unidades de la dimensión elegida; el cilindraje del motor usa cc en una dimensión separada del volumen de líquidos.
8. La vista previa y la ficha pública respetan el mismo orden, grupos, anchuras y visibilidad.
9. En móvil los campos se apilan sin desbordamiento horizontal ni superposición.
10. La autenticación, autorización, persistencia y carga de archivos reales ocurren en Laravel, no en JavaScript del navegador.
11. Una instalación no puede leer los datos de otra instalación.
12. Los cambios permanecen al cambiar de dispositivo, porque se guardan en PostgreSQL.

## 11. Estado de implementación

La carpeta `demo/` contiene un prototipo interactivo HTML/CSS/JS. El asistente y el constructor de fichas guardan datos únicamente en `localStorage`. No implementa autenticación, autorización, verificación de correo, persistencia SQL ni almacenamiento seguro de imágenes. El backend Laravel de producción está pendiente.


## 12. Personalización y publicación de la página web

La página pública se genera automáticamente desde NEXORA Site Engine. No requiere que el propietario edite código ni que el desarrollador intervenga para publicar productos o realizar cambios visuales admitidos.

### Nivel 1 — Personalización guiada (incluido en la primera versión)
- Elegir plantilla y variantes visuales disponibles.
- Configurar logotipo, colores, tipografías predefinidas y presentación comercial.
- Mostrar u ocultar secciones predeterminadas.
- Ajustar encabezado, distribución del catálogo, tarjetas y contactos.
- Previsualizar la página en tamaños de escritorio y móvil.
- Guardar como borrador y publicar explícitamente.

### Nivel 2 — Constructor visual avanzado (alcance progresivo)
- Agregar, quitar y reordenar secciones desde una biblioteca de componentes aprobados.
- Elegir variantes y ajustar opciones controladas de contenido, alineación y espaciado.
- Previsualizar antes de publicar.
- No permite insertar código HTML, JavaScript o CSS arbitrario ni crear diseños sin límites. Se utilizarán componentes permitidos y configuraciones validadas para mantener seguridad, accesibilidad y compatibilidad responsive.

### Publicación y dominio
- La página pública utiliza los productos publicados y los campos autorizados para exposición pública.
- Los cambios visuales pueden permanecer en borrador hasta que el propietario los publique.
- Cada instalación admite dos opciones: dominio propio contratado por el cliente o subdominio gratuito de un proveedor externo (por ejemplo, DuckDNS) siempre que el cliente controle ese nombre y pueda configurar sus registros DNS para apuntar al VPS.
- NEXORA no registra dominios, no garantiza disponibilidad ni permanencia de subdominios gratuitos de terceros y no ofrece en v1 subdominios centrales como `cliente.nexora.tld`.
- El instalador debe mostrar los registros DNS requeridos y comprobar la resolución del nombre y el acceso al servidor. La automatización de HTTPS dependerá de DNS, puertos, servidor web, permisos y método ACME disponible; se documentará el procedimiento manual cuando no pueda automatizarse.
- HTTPS requiere DNS correcto, conectividad y un certificado TLS válido. La aplicación solo declara HTTPS activo después de comprobar el certificado, su dominio y su vigencia; escribir un dominio en el asistente no activa por sí solo la protección.

### Separación y privacidad
El panel administrativo es privado y requiere autenticación. El sitio público solo expone datos publicados y expresamente marcados como visibles. Exportaciones PDF y reportes administrativos se descargan desde el panel y no se publican automáticamente.

## 13. Criterios de aceptación del Site Engine
1. Una instalación genera su página pública a partir de su propia configuración, sin intervención del desarrollador.
2. La personalización guiada permite cambiar identidad visual y secciones predeterminadas.
3. El constructor avanzado permite reordenar y configurar únicamente componentes permitidos.
4. Los cambios pueden previsualizarse y guardarse como borrador antes de publicarse.
5. Productos no publicados y campos privados nunca aparecen en rutas públicas.
6. El diseño se adapta a móvil, tableta y escritorio.
7. No se ejecuta código arbitrario proporcionado desde el editor.
8. La página puede asociarse a un dominio propio o a un subdominio gratuito externo controlado por el cliente, cuando el VPS y DNS estén configurados.
9. La configuración de HTTPS se valida y documenta; no se declara activo sin comprobar un certificado válido.
