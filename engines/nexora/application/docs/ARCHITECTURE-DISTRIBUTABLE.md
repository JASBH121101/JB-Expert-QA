# NEXORA — Arquitectura distribuible y motores internos

Estado: decisión arquitectónica para la primera versión instalable.

## Decisiones de producto

- Distribución mediante paquete ZIP para instalación en el VPS del comprador.
- Una instalación independiente por negocio, con base de datos, archivos, dominio y configuración propios.
- Una cuenta propietaria en v1; el primer registro se bloquea al completar el asistente.
- Producto inicial: catálogo público, panel administrativo y publicación automática de la página web.
- El núcleo admite extensiones futuras, pero ventas, pedidos, inventario, compras, facturación, POS y CRM quedan fuera de v1.
- Aplicación Laravel modular, no microservicios ni SaaS centralizado.

## Motores internos

| Motor | Responsabilidad |
|---|---|
| NEXORA Core | Configuración de instalación, servicios compartidos, eventos y contratos de extensión. |
| NEXORA Setup Engine | Primer inicio, validación de requisitos, creación del propietario y bloqueo del setup. |
| NEXORA Security Engine | Autenticación, autorización, sesiones, CSRF, rate limiting y validaciones de seguridad. |
| NEXORA Catalog Engine | Productos, categorías, publicación, grupos y campos dinámicos. |
| NEXORA Library Engine | Monedas, dimensiones, unidades predeterminadas y unidades personalizadas. |
| NEXORA Media Engine | Carga, validación, almacenamiento local, miniaturas y eliminación de imágenes. |
| NEXORA Admin | Panel privado, dashboard, formularios, configuración y previsualización. |
| NEXORA Site Engine | Página pública, catálogo, búsqueda, fichas y SEO básico. |
| NEXORA Template Engine | Plantillas sectoriales, variantes visuales y componentes permitidos. |
| NEXORA Export Engine | Catálogos, fichas y listas de precios en PDF. |
| NEXORA Domain & TLS Manager | Diagnóstico DNS, estado HTTPS e instrucciones/automatización compatible para certificados. |

Los motores serán módulos internos de un monolito modular Laravel. Cada uno tendrá límites claros y, según corresponda, rutas, controladores, servicios, políticas, validadores, modelos, vistas y pruebas. Compartirán la aplicación y la base de datos. No se duplicarán modelos ni se crearán bases de datos por motor.

Estructura sugerida: app/Core y app/Modules/{Setup,Security,Catalog,Library,Media,Admin,Site,Templates,Export,Domain}. La organización exacta se ajustará a la versión de Laravel seleccionada.

## Site Engine: dos niveles

### Básico — incluido en v1
- Plantillas y variantes visuales.
- Logo, colores y tipografías predefinidas.
- Encabezado, presentación y contactos.
- Mostrar u ocultar secciones predefinidas.
- Variantes de tarjetas y distribución del catálogo.
- Vista previa móvil/escritorio.
- Guardar borrador y publicar.

### Avanzado — constructor visual progresivo
- Agregar, quitar y reordenar secciones de una biblioteca de componentes aprobados.
- Ajustar propiedades controladas de contenido, alineación y espaciado.
- Previsualizar antes de publicar.
- Reglas responsive y límites para evitar diseños rotos.
- No permitir HTML, CSS, JavaScript ni PHP arbitrarios.
- No permitir que el editor altere rutas, permisos, consultas o lógica del servidor.

Ambos niveles usan el mismo modelo de página y sistema de publicación. El avanzado amplía las opciones del básico; no es una aplicación aparte.

## Superficies pública y privada

- /admin: rutas privadas que requieren autenticación y autorización del propietario.
- /: sitio público que solo consulta productos publicados y campos autorizados.
- El panel genera PDF administrativos; no se publican automáticamente.
- Datos personales, credenciales, configuraciones internas y campos privados nunca se exponen.
- Publicar un producto lo hace aparecer en la web sin intervención del desarrollador. Borradores y productos ocultos no aparecen en la web, sitemap ni búsqueda pública.

## Dominios y HTTPS

La instalación admite:
1. Dominio propio del comprador, por ejemplo mitienda.com.
2. Subdominio gratuito de un proveedor externo, por ejemplo mitienda.duckdns.org, si el comprador controla el nombre y puede apuntarlo al VPS.

NEXORA no registra dominios, no garantiza disponibilidad o permanencia de subdominios de terceros y no ofrece en v1 subdominios bajo un dominio central NEXORA. Ofrecer cliente.nexora.tld requeriría dominio central, DNS e infraestructura compartida, incompatible con el modelo ZIP independiente inicial.

Flujo:
1. El comprador registra o consigue un dominio/subdominio externo.
2. El instalador muestra los registros DNS necesarios.
3. El comprador configura DNS.
4. El instalador comprueba resolución DNS y acceso al servidor.
5. Si el VPS lo permite, se invoca un cliente ACME del servidor para solicitar un certificado Let's Encrypt; si no, se muestran instrucciones manuales.
6. Se configura HTTPS y redirección HTTP a HTTPS.
7. NEXORA comprueba el certificado y solo entonces muestra HTTPS como activo.

Let's Encrypt ofrece certificados gratuitos, pero se debe demostrar control del dominio y renovar los certificados periódicamente. La automatización depende de DNS, puertos, servidor web, permisos y método de validación. No se debe prometer HTTPS activo antes de verificarlo.

GitHub Pages es un ejemplo de subdominio gratuito y HTTPS para contenido estático, pero no aloja Laravel porque no ejecuta PHP. No se utilizará como hosting de NEXORA.

NEXORA acepta cualquier dominio/subdominio compatible y no depende de DuckDNS ni de un proveedor específico. Debe existir una guía manual para VPS sin automatización ACME.

## Instalador ZIP

Debe incluir:
- Código y dependencias de producción, respetando licencias.
- Migraciones y datos semilla de plantillas/bibliotecas.
- Comprobación de PHP, extensiones, permisos, servidor web y base de datos.
- Asistente MariaDB/MySQL, generación segura del entorno y clave de aplicación.
- Migraciones y creación del propietario.
- Configuración de URL/dominio y diagnóstico HTTPS.
- Protección contra reejecutar la instalación después de completarla.
- Manual de actualización, respaldo y restauración.

No incluir secretos ni datos de desarrollo. No exigir Docker ni cuentas externas obligatorias. El dominio y VPS son responsabilidad del comprador.

## Seguridad y operación

- Hash de contraseñas con Laravel.
- Verificación de correo del lado servidor cuando el comprador configure SMTP.
- CSRF, políticas de autorización, validación y limitación de intentos.
- Cookies y sesiones seguras al activar HTTPS.
- Archivos con MIME real, tamaño limitado, nombres aleatorios y almacenamiento no ejecutable.
- No usar localStorage para persistencia, permisos ni configuración de producción.
- Instrucciones de respaldo de base de datos y archivos.
- Logs sin contraseñas ni tokens.
- No activar servicios de pago por defecto.

## Fuera de alcance v1

Carrito, checkout, pagos, pedidos, ventas, compras, existencias, inventario, almacenes, proveedores, facturación, contabilidad, nómina, POS, CRM, app móvil, SaaS multiempresa, hosting centralizado y OTP SMS/WhatsApp. El Core tendrá puntos de extensión para evaluar módulos futuros sin incluirlos ahora.

## Criterios de aceptación

1. Instalación limpia crea una sola cuenta propietaria y bloquea el setup.
2. El propietario administra productos desde el panel sin editar código.
3. Publicar hace visible el producto; borradores y ocultos permanecen privados.
4. Cambios visuales básicos aparecen en la vista previa y página publicada.
5. El constructor avanzado solo permite componentes y propiedades autorizadas.
6. PDF administrativos no exponen información privada en la web.
7. Dominio propio o subdominio externo puede configurarse con instrucciones verificables.
8. HTTPS solo aparece activo después de comprobar un certificado válido.
9. La aplicación no depende de GitHub Pages, servicios cloud pagos ni Docker obligatorio.
10. Dos instalaciones no comparten bases de datos, archivos, sesiones ni configuraciones.
11. La arquitectura permite módulos futuros sin convertir v1 en ERP ni SaaS.

## Política de desarrollo

El prototipo actual no se considera producción hasta contar con backend real. Primero se audita y certifica la rama del catálogo configurable. Los cambios se realizan en ramas y PR; no se modifica main ni producción sin validación y aprobación.
