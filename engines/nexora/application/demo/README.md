# NEXORA — Prototipo interactivo

Esta carpeta contiene demostraciones frontend HTML/CSS/JS para revisar el concepto visual y el flujo de NEXORA antes de implementar el backend.

## Vistas disponibles

- `index.html`: catálogo público de muestra con perfiles ficticios.
- `admin.html`: panel administrativo demostrativo para productos y configuración local.
- `setup.html`: asistente guiado de configuración y constructor de plantillas/fichas.
  
## Qué permite probar el nuevo asistente

- Registro de datos del negocio, propietario y correo (sin crear credenciales reales).
- Hasta cinco contactos WhatsApp, selección de principal y visibilidad pública.
- Identidad comercial, color, monedas habilitadas y moneda principal.
- Plantillas de perfumería, ropa/calzado, tecnología, gimnasio, automotriz, alimentos y plantilla libre.
- Campos editables, grupos, orden, anchura, obligatoriedad, visibilidad, opciones de listas y filtros.
- Bibliotecas de unidades por dimensión y unidades personalizadas.
- Interruptor de fotografías opcionales.
- Vista previa adaptable y resumen antes de guardar.

## Cómo funciona

Abre la carpeta demo con un navegador moderno o sírvela con un servidor estático. No requiere npm, Composer, Laravel ni base de datos.

El asistente guarda un objeto de demostración en localStorage bajo la clave `nexora-studio:v1`. El panel conserva sus datos de prueba en claves locales independientes. No hay sincronización entre dispositivos ni usuarios.

## Limitaciones y seguridad

Esta demo no tiene inicio de sesión real, verificación de correo, autorización de servidor, API, base de datos ni almacenamiento seguro de fotografías. Los datos pueden inspeccionarse o modificarse desde el navegador. No introduzcas contraseñas, números reales, datos privados ni información de clientes.

Las URL de logotipo/portada son referencias visuales; no constituyen una función de carga real. Los teléfonos y contactos no se verifican. Los precios multidivisa no tienen conversión automática.

## Producto de producción

El backend se implementará con Laravel y MariaDB/MySQL. Incluirá autenticación del propietario, verificación de correo, migraciones, validación y autorización server-side, persistencia SQL de definiciones y valores dinámicos, y almacenamiento local seguro de imágenes. La arquitectura y las reglas del motor están descritas en `../docs/ARCHITECTURE.md` y `../docs/DYNAMIC-CATALOG-ENGINE.md`.
