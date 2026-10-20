# SEO Webmaster MCP

Audita una web desde tu asistente con solo pegar su URL. Este MCP local y de solo lectura detecta problemas técnicos y propone acciones con evidencia y pasos de verificación. Puedes conectar Google Search Console y Bing Webmaster Tools para añadir datos oficiales. Requiere Node.js 22 o posterior.

Pega una URL → encuentra problemas concretos → corrígelos → repite la auditoría para verificar el cambio.

## Inicio rápido

No necesitas clonar ni compilar el repositorio, ni configurar credenciales para tu primera auditoría. Conecta tu cliente MCP:

`npx -y seo-webmaster-mcp` inicia el servidor por **stdio**. Ejecuta `npx -y seo-webmaster-mcp config codex|claude|cursor` para copiar la configuración correspondiente; no incluyas claves en ella.

**Codex:**

```bash
codex mcp add seo-webmaster -- npx -y seo-webmaster-mcp
codex mcp list
```

**Claude Desktop:** agrega lo siguiente a `claude_desktop_config.json` y reinicia la aplicación. **Cursor:** agrega el mismo objeto a tu `mcp.json`.

```json
{
  "mcpServers": {
    "seo-webmaster": {
      "command": "npx",
      "args": ["-y", "seo-webmaster-mcp"]
    }
  }
}
```

Consulta la [configuración MCP de Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), la [ayuda de Claude Desktop](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) o la [documentación MCP de Cursor](https://docs.cursor.com/context/model-context-protocol) si tu cliente requiere una ruta distinta. En Windows, si el cliente no encuentra `npx`, usa la ruta absoluta del ejecutable `npx.cmd`.

### Tu primera auditoría

Pide a tu asistente:

> Audita https://example.com con seo_audit_advanced. Prioriza los problemas detectados y muestra las URL afectadas, la evidencia, cómo corregirlos y cómo comprobar cada corrección. Distingue los problemas confirmados de las comprobaciones que requieren contexto.

La llamada mínima es:

```json
{ "baseUrl": "https://example.com/" }
```

El informe puede detectar errores HTTP, enlaces internos rotos, títulos ausentes o repetidos, canónicas mal formadas y directivas de indexación. También propone revisar imágenes sin `alt`, idioma de la página y viewport. Analiza el HTML recibido sin ejecutar JavaScript y no confirma la indexación real. Los apartados de datos oficiales quedan vacíos hasta que indiques una propiedad de Google o Bing.

`summary` indica cuántas páginas HTML se analizaron, qué se comprobó, qué quedó pendiente y si el rastreo se limitó. `actions: []` significa que no se detectaron problemas en esas comprobaciones y esa muestra; no equivale a una auditoría exhaustiva ni garantiza que no haya nada que mejorar.

`summary.truncationReasons` explica los límites alcanzados: `max_pages` (URL pendientes), `discovery_limit` (hasta `2 × maxPages` URL distintas descubiertas) o `sitemap_limit` (hasta seis archivos de sitemap). Los enlaces repetidos y fragmentos como `#seccion` no consumen páginas adicionales. Las canónicas y enlaces relativos se resuelven usando el primer `<base href>` cuando existe.

Cada página incluye `jsonLdBlocks`, con los bloques `application/ld+json` numerados desde 1. `parsed` indica JSON legible con raíz de objeto o array de objetos; `invalid_json` identifica JSON mal formado o vacío, y `invalid_root` una raíz incompatible. Los errores generan la acción `invalid_json_ld` con URL, bloque y pasos de corrección. Esta comprobación no resuelve contextos remotos ni valida la semántica de schema.org o los requisitos de resultados enriquecidos; completa esa revisión con [Rich Results Test](https://search.google.com/test/rich-results). Los indicadores `indexablePages` y `snippetEligiblePages` son señales del HTML observado, no confirmación de indexación o elegibilidad real.

Para una comprobación rápida de una sola página, añade `"maxPages": 1`. Por defecto rastrea hasta 100 páginas.

### Nuevas comprobaciones de HTML en 0.4.0

| Acción | Qué observa | Cómo interpretarla |
| --- | --- | --- |
| `images_missing_alt` | Imágenes del `body` sin atributo `alt`. | Revisar cada imagen: texto descriptivo si informa o `alt=""` si es decorativa. La auditoría acepta `alt` vacío y no evalúa la calidad del texto. |
| `missing_lang` | `<html lang>` ausente o vacío. | Declarar el idioma real para ayudar a lectores de pantalla y otras tecnologías de asistencia; no representa una penalización SEO medida. |
| `missing_viewport` | Meta viewport ausente o con contenido vacío en el `head`. | Revisar la configuración móvil. La presencia de la etiqueta no demuestra que el diseño funcione en móvil. |
| `invalid_canonical` | El `href` de la canónica no resuelve a una URL HTTP(S) válida. | Corregir el valor y comprobar que corresponda a la versión elegida. El resto del análisis de la página se conserva. |

Las tres primeras acciones tienen prioridad baja y `confidence: "inferred"`: la evidencia es la ausencia observada y la corrección necesita contexto. Cada acción contiene URL, evidencia, pasos y verificación. Se cuentan todas las páginas afectadas y se muestran hasta veinte URL de ejemplo.

Cada página incorpora `lang` y `viewport` (valor observado o `null`), `canonicalError` (`null` o el motivo del error) e `images`:

```json
{
  "total": 2,
  "missingAlt": 1,
  "examples": [{ "imageIndex": 1, "src": "./audit-flow.svg" }]
}
```

`imageIndex` es la posición de la imagen entre los `img` del `body`, desde 1. `examples` incluye hasta cinco imágenes sin `alt` por página; `src` conserva el atributo recibido, recortado a 300 caracteres, o `null` si falta. No se descargan imágenes ni se añaden peticiones para estas comprobaciones. No es una auditoría completa de accesibilidad.

Las señales `noindex` y `snippetBlocked` combinan las etiquetas generales `robots`, todas las etiquetas `googlebot` y las reglas HTTP aplicables a Googlebot. Reconocen `none` como `noindex, nofollow` y no atribuyen a Google las reglas dirigidas exclusivamente a otro agente. Son señales para Google, no una simulación de todos los buscadores. Una canónica inválida deja `canonical: null` y genera `invalid_canonical`, sin duplicar `missing_canonical` ni convertir el HTTP 200 en un error de conexión.

### Demostración: detectar, corregir y verificar

Desde un checkout del repositorio, después de `npm ci`, ejecuta:

```bash
npm run demo
```

La demo ejecuta dos llamadas reales al MCP con DNS y HTTP simulados, sin salir a internet ni consultar credenciales. Usa los archivos originales [before.html](https://github.com/JvnnDev/seo-webmaster-mcp/blob/main/examples/before.html) y [after.html](https://github.com/JvnnDev/seo-webmaster-mcp/blob/main/examples/after.html):

| Ejecución | Resultado esperado |
| --- | --- |
| Antes | `invalid_canonical`, `images_missing_alt`, `missing_lang` y `missing_viewport`. HTTP 200 conservado. |
| Después | Desaparecen las cuatro acciones; dos imágenes tienen `alt`, incluida una decorativa con `alt=""`. |

Se imprimen la cobertura, los datos de la página y la evidencia completa de las acciones. `audit.example` es un destino ficticio de la demo. Para repetirla contra una web, sirve los archivos en una URL pública propia o autorizada y audita cada URL con `maxPages: 1`; adapta la canónica de `after.html` si cambias su ruta. La ausencia de acciones en esta muestra no garantiza indexación ni posiciones.

En una web propia o autorizada, usa una página de prueba pública sin `<title>`. Audítala con `maxPages: 1`: la acción `missing_title` incluirá su URL y el número de páginas afectadas. Añade un título descriptivo, publica la corrección y repite la misma auditoría: esa acción debería desaparecer. Puedes mostrar ambas ejecuciones para documentar la mejora; el cambio no garantiza resultados de posicionamiento.

También puedes reproducir un error de JSON-LD con `<script type="application/ld+json">{"@type":"Organization",}</script>`: la coma final genera `invalid_json_ld`. Al quitarla y repetir la auditoría, ese bloque debería aparecer como `parsed` y la acción desaparecer.

¿Te ayudó a encontrar algo que corregiste? ¿Dónde te atascaste? [Cuéntalo en una issue](https://github.com/JvnnDev/seo-webmaster-mcp/issues/new), indicando tu cliente MCP, sistema operativo y pasos para reproducirlo. Anonimiza los datos privados y evita incluir credenciales.

## Añadir Google o Bing (opcional)

Configura cada proveedor que quieras usar:

```bash
npx -y seo-webmaster-mcp setup bing
npx -y seo-webmaster-mcp setup google --client /ruta/al/cliente-oauth.json
npx -y seo-webmaster-mcp status
npx -y seo-webmaster-mcp doctor
```

**Bing:** crea tu clave en [Bing Webmaster Tools](https://learn.microsoft.com/en-us/bingwebmaster/getting-access). El asistente la solicita sin mostrarla y comprueba que funciona.

`--help` muestra los comandos y `--version` la versión instalada. `doctor` devuelve código de salida 1 si falla un proveedor configurado; sin proveedores devuelve `not_configured` y código 0.

**Google:** en [Google Cloud Console](https://console.cloud.google.com/) habilita la Search Console API, configura la pantalla OAuth y descarga un cliente OAuth de tipo **Desktop app**. Si la aplicación está en modo *Testing*, agrega tu cuenta como usuario de prueba. Pasa el archivo JSON al comando `setup google`; el navegador solicitará acceso de solo lectura y completará la conexión mediante un callback local. Cada usuario crea su propio cliente OAuth; no compartas el JSON ni el token de renovación. [Guía oficial de autorización](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing).

La configuración se guarda fuera del repositorio, en el perfil del usuario. `status` muestra la ruta y el estado sin revelar secretos; `doctor` prueba el acceso real a ambos proveedores. Para desconectar: `npx -y seo-webmaster-mcp disconnect google` o `disconnect bing`. En macOS/Linux el archivo tiene permisos `0600`; en Windows se guarda en AppData del usuario. Protege tu sesión de sistema porque el token de renovación se conserva localmente.

### Auditoría con datos oficiales

Pide a tu cliente MCP que llame `seo_audit_advanced`:

```json
{
  "gscSiteUrl": "sc-domain:example.com",
  "bingSiteUrl": "https://example.com/",
  "baseUrl": "https://www.example.com/",
  "maxPages": 100
}
```

Ambas propiedades son opcionales: indica una o las dos para añadir datos oficiales, u omítelas para auditar solo por URL. Si omites las fechas, los datos de proveedores usan los últimos 90 días finalizados hasta tres días antes de la ejecución. El rastreo comienza en la URL indicada, sigue los sitemaps y enlaces internos, respeta las reglas de `robots.txt` para `SEO-Webmaster-MCP` y se limita a URL públicas del mismo host (incluida la variante `www`). Comprueba robots también en las redirecciones y para cada origen; un fallo de red, HTTP 429 o 5xx en robots detiene ese origen y se informa como error. Reconoce grupos compartidos, comodines, `Allow` y `Disallow`.

Las resoluciones DNS y peticiones tienen límites de tiempo de diez segundos; la conexión usa las direcciones públicas validadas. Cada respuesta se limita a 2 MB durante la descarga. El rastreo termina al llegar a `maxPages` (máximo 500). El informe incluye los datos disponibles, problemas técnicos, señales GEO y acciones priorizadas con pasos de verificación. Una falla parcial conserva el resto del informe y muestra los errores.

La herramienta `seo_audit_site` original sigue disponible. Las nuevas herramientas oficiales son `gsc_query_advanced`, `gsc_sitemap_details`, `bing_feed_details`, `bing_page_queries` y `bing_query_pages`. Las herramientas existentes no cambian de nombre.

## Importar impresiones de funciones generativas de Google

Search Console permite exportar el [informe de rendimiento generativo](https://support.google.com/webmasters/answer/16984139?hl=en). Su vista no está disponible como recurso independiente en la API pública. Exporta una tabla CSV por **páginas** o **fechas** y ejecuta:

```bash
npx -y seo-webmaster-mcp geo-import reporte.csv sc-domain:example.com 2026-07-01 2026-09-24 page
```

Usa `date` en vez de `page` para una tabla por fechas. Se aceptan encabezados `Page`/`Página`, `Date`/`Fecha` e `Impressions`/`Impresiones`. El CSV debe contener una tabla con esas columnas y máximo 10 000 filas. La importación queda en el perfil local, separada por propiedad. `geo_report_summary` y `seo_audit_advanced` muestran los datos importados por separado. Son **impresiones de funciones generativas de Google**, no mediciones de citas en ChatGPT, Claude u otros sistemas.

Las impresiones deben ser enteros no negativos. Los marcadores `~` y `-` se conservan como `null`, con `unknownImpressionRows` indicando cuántas filas son desconocidas; si afectan a fechas, `totalImpressions` queda en `null`. Se rechazan métricas vacías, fraccionarias y fechas inválidas o fuera del periodo declarado. Si un CSV se importó con una versión anterior que convertía esos marcadores en cero, vuelve a importarlo para recuperar esa distinción.

## Desarrollar

```bash
npm install
npm test
npm run verify:package
npm pack --dry-run
```

El paquete contiene `dist`, README, changelog y licencia. Los ejemplos y la preparación de la publicación se conservan en el repositorio. No publiques credenciales ni el cliente OAuth. Los datos oficiales pueden estar incompletos o retrasados; el MCP distingue ausencia de datos de cero tráfico y evita presentar heurísticas como errores confirmados.

`verify:package` empaqueta el proyecto e instala el tarball en una carpeta temporal, comprueba el ejecutable y sus 25 herramientas MCP, y repite la demo con credenciales locales deliberadamente inválidas. La instalación requiere acceso al registro npm; las auditorías de prueba usan DNS/HTTP simulados. También se ejecuta en CI para Linux, Windows y macOS.

Para rastreo y conexión HTTP se usan [robots-parser](https://github.com/samclarke/robots-parser) y [Undici](https://github.com/nodejs/undici), respectivamente. No añaden claves ni servicios externos.

Referencias de desarrollo: [claude-seo-ai](https://github.com/Hainrixz/claude-seo-ai/tree/cabd6079dc1ae74682083ad3caf4e09bb1964404), especialmente sus comprobaciones de imágenes y viewport (MIT); [directivas robots de Google](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag), [idioma del documento](https://www.w3.org/WAI/WCAG21/Techniques/html/H57), [imágenes decorativas](https://www.w3.org/WAI/tutorials/images/decorative/) y [viewport de Lighthouse](https://developer.chrome.com/docs/lighthouse/best-practices/viewport). La implementación y los ejemplos de esta versión son propios; no se incorporan archivos de terceros.

---

## English quick start

Install Node.js 22+, then connect your MCP client. Your first audit needs only a public URL:

```bash
codex mcp add seo-webmaster -- npx -y seo-webmaster-mcp
```

For Claude Desktop or Cursor, use the `mcpServers` JSON above. Run `npx -y seo-webmaster-mcp config claude` or `config cursor` to print it. Ask your assistant to call `seo_audit_advanced` with `{ "baseUrl": "https://example.com/" }` and explain the evidence, affected URLs, fixes and verification steps. The crawl analyzes received HTML without executing JavaScript or confirming search engine indexing. Add `maxPages: 1` for a single-page check.

`summary` reports coverage, checks performed and checks not performed. An empty `actions` array means no issues were detected by these checks in the crawled sample. Each page exposes `jsonLdBlocks` with a 1-based script index and `parsed`, `invalid_json` or `invalid_root` status. Syntax or root errors generate `invalid_json_ld`; `parsed` does not confirm schema.org semantics or rich-result eligibility. Use [Rich Results Test](https://search.google.com/test/rich-results) for the latter. Readiness counts describe observed HTML signals, not confirmed indexing or AI visibility.

Version 0.4.0 also reports images without `alt`, missing or empty HTML language and viewport declarations, and malformed canonical URLs. Each page exposes `lang`, `viewport`, `canonicalError` and `images` (`total`, `missingAlt`, up to five examples with 1-based `imageIndex` and raw `src`, capped at 300 characters). An empty `alt=""` is accepted for decorative images. These are static HTML checks; language accuracy, alt-text quality and responsive layout require review. Robots flags combine general directives and rules for Googlebot, excluding other agents' scoped rules.

The crawler itself follows robots.txt for `SEO-Webmaster-MCP`, including shared groups, wildcards and redirects. Unavailable robots responses (network errors, 429 or 5xx) stop that origin. DNS addresses are validated and pinned to the connection, and response bodies are capped at 2 MB while streaming. `summary.truncationReasons` lists page, URL discovery and sitemap limits. Relative links honor the document's base URL. Imported GEO markers `~` and `-` remain unknown (`null`), rather than zero impressions.

Maintainers can run `npm run verify:package` to install the actual tarball into a temporary directory and verify its binary, version, MCP tools and before/after audits. It requires npm registry access for installation. `--help` and `--version` work without connecting providers; `doctor` exits with code 1 when a configured provider fails.

For a reproducible offline before/after demo, clone the repository, run `npm ci`, then `npm run demo`. It calls the MCP server against synthetic DNS/HTTP using the bundled repository examples: four actions before the fixes, zero afterward, with evidence and coverage. To test your changes locally in an MCP client, run `npm run build` and point its server command at `node /absolute/path/to/seo-webmaster-mcp/dist/cli.js`; restart the server after rebuilding. `npx -y seo-webmaster-mcp` runs the published package.

Optionally run `npx -y seo-webmaster-mcp setup bing` or `npx -y seo-webmaster-mcp setup google --client /path/to/desktop-oauth-client.json`, then supply `bingSiteUrl` or `gscSiteUrl` in the audit to include official data. The audit is read only; its action plan identifies confirmed issues and inferred opportunities separately. Google generative search impressions can be imported from a Search Console CSV export with `geo-import`.

Did the audit help you fix something? Where did you get stuck? [Share feedback](https://github.com/JvnnDev/seo-webmaster-mcp/issues/new) with your MCP client and operating system, omitting credentials and private data.
