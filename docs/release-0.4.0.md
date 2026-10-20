# SEO Webmaster MCP 0.4.0

## Propuesta pública

Descripción para GitHub:

> Read-only SEO audits from a public URL, with optional Google Search Console and Bing data through MCP.

Topics propuestos para GitHub:

```text
mcp mcp-server seo technical-seo seo-audit google-search-console bing-webmaster-tools typescript geo
```

Título de la release:

> v0.4.0 — Audita una URL sin claves y encuentra problemas concretos

Texto de la release:

> Pega una URL y recibe acciones con evidencia y pasos de verificación. Ahora puedes revisar imágenes sin alt, idioma, viewport, canónicas mal formadas y sintaxis de JSON-LD. Google Search Console y Bing siguen disponibles como fuentes opcionales.
>
> El análisis combina etiquetas robots repetidas, reconoce none y distingue reglas HTTP por agente. Cada informe explica la muestra analizada y lo que quedó pendiente.
>
> La demo offline muestra cuatro acciones antes de corregir el HTML y ninguna después. El rastreo sigue siendo estático y de solo lectura; no confirma indexación, posicionamiento ni visibilidad en respuestas de IA.

## Demostración para compartir

Desde el checkout con dependencias instaladas:

```bash
npm run demo
```

La demo levanta el servidor MCP por stdio y hace dos llamadas usando DNS y HTTP simulados. No publica contenido ni consulta proveedores. Muestra datos completos de la página, acciones, evidencia y límites. Los archivos `examples/before.html` y `examples/after.html` también pueden servirse en una web pública propia; el MCP no permite destinos localhost ni privados.

Antes: `invalid_canonical`, `images_missing_alt`, `missing_lang`, `missing_viewport`; la página conserva HTTP 200. Después: cero acciones en las comprobaciones de esa muestra. La segunda imagen mantiene `alt=""` por ser decorativa.

Texto breve para una publicación:

> Le di cariño a SEO Webmaster MCP: auditar una web empieza con una URL, sin configurar claves. Encuentra problemas de HTML con evidencia y pasos para verificarlos. Preparé un ejemplo antes/después: canónica rota, imagen sin alt, idioma y viewport ausentes → correcciones → nueva auditoría. Google y Bing son opcionales para sumar datos oficiales. Código: https://github.com/JvnnDev/seo-webmaster-mcp

## Comprobaciones de salida

```bash
npm test
npm run demo
npm run verify:package
npm audit --omit=dev
npm pack --dry-run
git diff --check
```

Comprobar que package.json, el lockfile, server.json y la versión anunciada por el servidor indiquen 0.4.0. El paquete debe contener únicamente dist, README, changelog, licencia y package.json. CI conserva su matriz Linux/Windows/macOS con Node 22.

Validación local realizada en Windows: suite ampliada a 27 tests; demo con 4 acciones antes y 0 después; instalación aislada del tarball y comprobación de su ejecutable y MCP; versiones alineadas; paquete de 15 archivos sin credenciales; auditoría de dependencias de producción sin avisos; revisión de espacios sin errores. Se probaron llamadas MCP por red real con example.com y diez páginas de Grupo Hermoza. El detalle y los límites se conservan en [verification-0.4.0.md](verification-0.4.0.md). La matriz CI de Linux/macOS no se ejecutó desde esta máquina.

Para probar un checkout durante el desarrollo, compila y configura el cliente con node y la ruta absoluta a dist/cli.js. npx ejecuta la versión disponible en npm.
