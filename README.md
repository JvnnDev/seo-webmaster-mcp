# SEO Webmaster MCP

MCP local y de solo lectura para auditar SEO con Google Search Console, Bing Webmaster Tools y un rastreo acotado de la web. Incluye un plan de acción con evidencia y señales de preparación para funciones generativas de búsqueda. Requiere Node.js 22 o posterior.

## Inicio rápido

No necesitas clonar ni compilar el repositorio. Configura cada proveedor que quieras usar:

```bash
npx -y seo-webmaster-mcp setup bing
npx -y seo-webmaster-mcp setup google --client /ruta/al/cliente-oauth.json
npx -y seo-webmaster-mcp status
```

**Bing:** crea tu clave en [Bing Webmaster Tools](https://learn.microsoft.com/en-us/bingwebmaster/getting-access). El asistente la solicita sin mostrarla y comprueba que funciona.

**Google:** en [Google Cloud Console](https://console.cloud.google.com/) habilita la Search Console API, configura la pantalla OAuth y descarga un cliente OAuth de tipo **Desktop app**. Si la aplicación está en modo *Testing*, agrega tu cuenta como usuario de prueba. Pasa el archivo JSON al comando `setup google`; el navegador solicitará acceso de solo lectura y completará la conexión mediante un callback local. Cada usuario crea su propio cliente OAuth; no compartas el JSON ni el token de renovación. [Guía oficial de autorización](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing).

La configuración se guarda fuera del repositorio, en el perfil del usuario. `status` muestra la ruta y el estado sin revelar secretos. Para desconectar: `npx -y seo-webmaster-mcp disconnect google` o `disconnect bing`. En macOS/Linux el archivo tiene permisos `0600`; en Windows se guarda en AppData del usuario. Protege tu sesión de sistema porque el token de renovación se conserva localmente.

## Conectar tu cliente MCP

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

## Auditoría avanzada

Pide a tu cliente MCP que llame `seo_audit_advanced`:

```json
{
  "gscSiteUrl": "sc-domain:example.com",
  "bingSiteUrl": "https://example.com/",
  "baseUrl": "https://www.example.com/",
  "maxPages": 100
}
```

Se puede indicar solo una de las dos propiedades. Si omites las fechas, usa los últimos 90 días finalizados hasta tres días antes de la ejecución. El rastreo comienza en la portada, sigue los sitemaps y enlaces internos, respeta las exclusiones generales de `robots.txt` y se limita a URL públicas del mismo host (incluida la variante `www`). Cada petición tiene un límite de tiempo y el rastreo termina al llegar a `maxPages` (máximo 500). El informe incluye datos oficiales, problemas técnicos, oportunidades por consulta y página, señales GEO y acciones priorizadas con pasos de verificación. Una falla parcial conserva el resto del informe.

La herramienta `seo_audit_site` original sigue disponible. Las nuevas herramientas oficiales son `gsc_query_advanced`, `gsc_sitemap_details`, `bing_feed_details`, `bing_page_queries` y `bing_query_pages`. Las herramientas existentes no cambian de nombre.

## Importar impresiones de funciones generativas de Google

Search Console permite exportar el [informe de rendimiento generativo](https://support.google.com/webmasters/answer/16984139?hl=en). Su vista no está disponible como recurso independiente en la API pública. Exporta una tabla CSV por **páginas** o **fechas** y ejecuta:

```bash
npx -y seo-webmaster-mcp geo-import reporte.csv sc-domain:example.com 2026-07-01 2026-09-24 page
```

Usa `date` en vez de `page` para una tabla por fechas. Se aceptan encabezados `Page`/`Página`, `Date`/`Fecha` e `Impressions`/`Impresiones`. El CSV debe contener una tabla con esas columnas y máximo 10 000 filas. La importación queda en el perfil local, separada por propiedad. `geo_report_summary` y `seo_audit_advanced` muestran los datos importados por separado. Son **impresiones de funciones generativas de Google**, no mediciones de citas en ChatGPT, Claude u otros sistemas.

## Desarrollar

```bash
npm install
npm test
npm pack --dry-run
```

El paquete contiene solo `dist`, README y licencia. No publiques credenciales ni el cliente OAuth. Los datos oficiales pueden estar incompletos o retrasados; el MCP distingue ausencia de datos de cero tráfico y evita presentar heurísticas como errores confirmados.

---

## English quick start

Install Node.js 22+, then connect one or both providers:

```bash
npx -y seo-webmaster-mcp setup bing
npx -y seo-webmaster-mcp setup google --client /path/to/desktop-oauth-client.json
codex mcp add seo-webmaster -- npx -y seo-webmaster-mcp
```

For Claude Desktop or Cursor, use the `mcpServers` JSON above. Run `npx -y seo-webmaster-mcp config claude` or `config cursor` to print it. Call `seo_audit_advanced` with a verified Search Console or Bing property and `baseUrl`. The audit is read only; its action plan identifies confirmed issues and inferred opportunities separately. Google generative search impressions can be imported from a Search Console CSV export with `geo-import`.
