# Verificación de aceptación — 0.4.0

Fecha: 2026-10-20. Entorno local: Windows, Node.js 22.18.0, npm 11.19.0.

## Criterio de cierre

La versión queda verificada localmente para auditorías HTML de solo lectura: detecta los problemas conocidos, conserva evidencia y cobertura, maneja fallos y funciona desde el paquete instalado. Este informe registra las comprobaciones previas a su publicación.

## Pruebas reproducibles

```bash
npm test
npm run verify:package
npm audit --omit=dev
git diff --check
```

- La suite cubre 27 tests: extracción HTML, JSON-LD, canónicas, idioma, viewport, alt, robots, sitemaps, presupuestos, redirecciones, límites de descarga, DNS privado, CLI, CSV GEO y contratos MCP con proveedores simulados. Una prueba usa un servidor HTTP local real para comprobar cabeceras repetidas.
- El verificador crea el tarball e instala sus dependencias en una carpeta temporal. Comprueba el ejecutable a través de npm exec, la versión 0.4.0 y las 25 herramientas anunciadas como solo lectura. La auditoría no lee un archivo de credenciales deliberadamente inválido.
- Antes/después: cuatro acciones en before.html y cero en after.html, con HTTP 200 y alt vacío decorativo aceptado. Se verifica también desde el paquete instalado.
- El paquete contiene 15 archivos permitidos, sin OAuth, credenciales, tests o archivos temporales. Las versiones de manifiestos y servidor coinciden.
- npm audit de producción no reporta vulnerabilidades en esta revisión. Se actualizaron el SDK MCP a 1.32.1, Hono a 4.13.13 y Undici a 7.30.1.

La comprobación del paquete se incorpora a la matriz CI de Linux, Windows y macOS. En esta sesión se ejecutó localmente en Windows; no se afirma una ejecución de CI remota.

## Auditorías por red real

Estas auditorías se ejecutaron mediante llamadas al servidor MCP por stdio, anunciando versión 0.4.0, sin solicitar proveedores ni leer credenciales:

| Destino | Muestra | Resultado observado |
| --- | --- | --- |
| https://example.com/ | 1 HTML, HTTP 200 | Complete, sin errores. Propone revisar canónica, descripción y H1 ausentes. |
| https://www.grupohermoza.com/ | 10 HTML, todos HTTP 200 | Complete, sin errores ni acciones en las comprobaciones de la muestra; 3 bloques JSON-LD parsed en cada página. |

La segunda auditoría informa max_pages y discovery_limit. El resultado no acredita indexación, posicionamiento, validez semántica del marcado ni visibilidad en IA. Las observaciones corresponden al HTML recibido durante esta sesión y pueden cambiar con la web.

## Correcciones encontradas durante la revisión

- Reglas de robots con agentes compartidos y comodines que antes se ignoraban. Se usa robots-parser, se comprueba el origen de cada destino y se respetan exclusiones también después de redirecciones. Un robots no disponible detiene ese origen y conserva el error.
- Cabeceras X-Robots-Tag repetidas: se conservan sus límites originales para no atribuir una regla global al agente de la cabecera anterior.
- Direcciones DNS privadas o mixtas, incluido IPv4 privado representado en IPv6. La conexión queda fijada a las direcciones públicas validadas, con límites de DNS y HTTP.
- Cuerpos excesivos que se descargaban enteros antes de validar el tamaño. El límite se aplica a bytes mientras llegan y el stream se cancela al superarlo.
- Una URL inválida en un sitemap que hacía perder sus siguientes entradas. Se conserva el resto, se deduplican fragmentos y se explican los límites de descubrimiento y sitemaps.
- Canónicas y enlaces relativos resueltos sin tener en cuenta base href. También se evita atribuir títulos duplicados a dos alias que terminan en la misma URL.
- Marcadores GEO desconocidos convertidos en cero. Se conservan como null y se evita dar un total de fechas incompletas; se validan fechas, URLs y métricas enteras.
- Comandos desconocidos con salida aparentemente correcta y doctor con código 0 pese al fallo de un proveedor. Ambos devuelven ahora código 1 cuando corresponde.

## Límites pendientes de comprobación externa

- Los contratos de métricas Google/Bing y errores parciales se verificaron mediante simulaciones. Las autorizaciones OAuth dependen de la cuenta de cada usuario y no se certifican mediante estas pruebas.
- No se ejecutó Claude Desktop ni Cursor como interfaz gráfica. Sí se ejercitó el protocolo MCP por stdio con procesos reales, tanto desde el checkout como desde la instalación aislada.
- El rastreo sigue siendo estático y acotado. Las revisiones de idioma, viewport y alt necesitan contexto; no equivalen a una auditoría completa de accesibilidad o contenido.
- Importaciones GEO antiguas que ya guardaron marcadores como cero necesitan reimportar el CSV original para recuperar los desconocidos. No se modifica automáticamente el perfil del usuario.

El checkout se prueba compilando y usando node con la ruta absoluta a dist/cli.js. npx usa la versión disponible en npm.
