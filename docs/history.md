# Historial, comparación y comprobaciones nuevas

Disponible desde 0.5.0. Ejecuta la CLI directamente desde npm o usa un checkout
compilado con `npm ci` y `npm run build`.

## Uso sin cliente MCP

```bash
npx -y seo-webmaster-mcp@0.5.0 audit https://example.com/ --max-pages 25 --save
npx -y seo-webmaster-mcp@0.5.0 history --limit 20
npx -y seo-webmaster-mcp@0.5.0 report ID --format markdown --out informe.md
npx -y seo-webmaster-mcp@0.5.0 compare ID_BASE ID_ACTUAL --format markdown
npx -y seo-webmaster-mcp@0.5.0 audit https://example.com/ --render js --max-pages 5 --save
npx -y seo-webmaster-mcp@0.5.0 audit https://example.com/ --performance --performance-strategy mobile
```

`audit` imprime JSON por defecto y devuelve `saved.id` si usas `--save`. Con
Markdown muestra el identificador antes del informe. `--out archivo` exporta el
resultado y rechaza sobrescribir un archivo existente.

Los informes se guardan en `seo-webmaster-mcp/audits`, dentro del perfil local
del usuario y separados del archivo de credenciales. Pueden contener URLs y
datos privados de proveedores: elige dónde compartirlos. No incluyen el archivo
de credenciales ni se suben automáticamente a un servicio.

La comparación acepta identificadores locales o archivos JSON exportados.
Ambos informes deben pertenecer al mismo origen HTTP(S), tener formato compatible
y estar en orden cronológico. Una base generada por 0.4.0 no registra las nuevas
comprobaciones: genera la base con la versión nueva.

| Resultado | Significado |
| --- | --- |
| Nuevo | Una comprobación equivalente anterior no mostraba el hallazgo. |
| Persistente | La misma regla sigue observándolo. |
| Resuelto | La URL se comprobó de nuevo y la regla ya no observa el hallazgo. |
| No comparable | Falta la URL, falla, cambia de destino o de regla, o faltan dependencias. |

Las acciones muestran hasta veinte URLs de ejemplo; la comparación conserva las
ocurrencias de todas las URLs examinadas. Los datos y acciones de proveedores
se conservan en los informes, pero no se etiquetan como correcciones técnicas
del rastreo. Una comparación puede resolver un hallazgo concreto y seguir siendo
parcial porque otras URLs no se comprobaron.

## Herramientas MCP

| Herramienta | Argumentos y resultado |
| --- | --- |
| `seo_audit_save` | Los argumentos de `seo_audit_advanced`; ejecuta y guarda, devuelve `saved.id` y `report`. |
| `seo_audit_history` | `limit` de 1 a 100; lista las auditorías más recientes y errores de archivos ilegibles. |
| `seo_audit_report` | `id` y `format: "json"` o `"markdown"`; devuelve el informe o su contenido Markdown. |
| `seo_audit_compare` | `baselineId`, `currentId` y `format`; devuelve la comparación. |

`seo_audit_advanced` no crea historial. Solo `seo_audit_save` declara escritura
local no idempotente; las otras 28 herramientas declaran lectura. Ninguna
modifica la web auditada. No se aceptan rutas de archivos desde estas herramientas
de historial; el acceso a archivos JSON exportados es una función de la CLI.

## Comprobaciones y límites

El informe añade `checks`: módulo, versión, URLs evaluadas, ocurrencias, errores
y `unverifiedUrls` cuando faltan destinos o se alcanza un límite de inspección.
Los siete módulos se ejecutan de forma aislada.

- Canonical múltiples y destinos observados con error HTTP o noindex.
- URL del sitemap con noindex o canonical hacia otra versión: revisión de intención.
- Hreflang declarado: formato, URL absolutas, referencia propia y reciprocidad con
  destinos HTML disponibles en la muestra. No exige hreflang a sitios monolingües
  ni `x-default`, no valida todos los códigos admitidos por Google ni visita
  otros dominios para comprobarlos.
- Saltos de niveles de encabezados como revisión contextual; varios H1 no se
  consideran automáticamente un error.
- Open Graph incompleto cuando ya existe marcado OG, URL sociales no absolutas
  y tipos de `twitter:card` no reconocidos. No descarga imágenes sociales.
- Propiedades seleccionadas de Product, Offer, AggregateOffer, Article,
  Organization y BreadcrumbList, incluidos nodos en `@graph`, cuando reconoce
  un contexto schema.org o tipos con URL completa. No exige marcado a todas
  las páginas ni interpreta vocabularios personalizados como schema.org.

La inspección de JSON-LD comprueba hasta 2 000 valores por bloque, hasta cien
tipos por nodo y conserva hasta cien observaciones por página; los contextos
también tienen límites de inspección. Si se alcanza un límite, se indica
`details.schema.truncated` y esa URL no se considera comparable para propiedades.
No resuelve referencias `@id` ni contextos remotos. No sustituye un validador
completo ni Rich Results Test.

`crawl.linkGraph` contiene nodos con `inboundFromSample` y aristas con
`targetObserved`. Se unifican alias que llegan a la misma URL final y no se
cuentan autoenlaces como enlaces entrantes. Se conservan hasta 5 000 aristas,
con `truncated` explícito; los recuentos siguen considerando la muestra. Una
página sin enlaces entrantes observados no se declara huérfana confirmada.

## JavaScript y rendimiento opcionales

El valor predeterminado es `render: "static"`. `render: "js"` en MCP o
`--render js` en CLI busca Chrome, Chromium o Edge en ubicaciones habituales;
usa un perfil nuevo, sin sesiones del usuario. No descarga ni instala un
navegador automáticamente. Por defecto analiza hasta diez páginas en este modo;
su máximo es veinte. El límite estático sigue siendo quinientas.

Cada página renderizada conserva `rendering.static` (título, H1 y longitud del
texto original) y el estado, peticiones y errores del renderizado. Si el navegador
no está disponible o falla, conserva el análisis estático y marca el informe
como parcial. Los informes de modos distintos no se consideran comprobaciones
equivalentes al comparar correcciones.

El navegador no tiene red directa: sus recursos se satisfacen mediante el
transporte DNS/HTTP validado del rastreador, con robots por origen. Permite GET
de documentos, scripts, hojas de estilo y datos, con hasta cien peticiones y
20 MB por página (2 MB por respuesta) y un plazo máximo de 25 segundos para el
renderizado de cada página. No ejecuta POST, WebSocket, service
workers, Web Workers, WebRTC, WebTransport, subdocumentos ni navegaciones adicionales. Tampoco descarga imágenes,
fuentes ni multimedia. Respeta las cabeceras CSP recibidas. No reproduce una
sesión autenticada, todas las funciones del navegador ni interacción humana;
sus fallos se muestran y esas URLs quedan no comparables para correcciones.

`performance: true` o `--performance` envía la URL de entrada a la API de
PageSpeed Insights de Google, una vez por auditoría. `performanceStrategy`
(`--performance-strategy`) admite `mobile` (predeterminado) o `desktop`.
Puedes configurar `PAGESPEED_API_KEY` en el entorno si necesitas una clave
propia/cuota; no se guarda en el informe ni se incluye en los errores.

El campo `performance.lab` muestra la puntuación y métricas Lighthouse de esa
ejecución. `performance.field.url` y `.origin` conservan por separado los
percentiles CrUX que devuelva la API. Un dato ausente es `null`, no cero; no se
trasladan datos del origen a una URL ni se usa la puntuación de laboratorio
como prueba de aprobar Core Web Vitals. Un error o falta de cuota conserva el
resto del informe y se registra como fallo parcial. Estas mediciones no se
tratan como hallazgos nuevos/resueltos del motor al comparar informes.

Referencias: [contextos de Playwright](https://playwright.dev/docs/api/class-browsercontext)
y [API de PageSpeed Insights](https://developers.google.com/speed/docs/insights/v5/reference/pagespeedapi/runpagespeed).

Fuentes de las reglas: [hreflang de Google](https://developers.google.com/search/docs/specialty/international/localized-versions),
[canonical](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls),
[Product](https://developers.google.com/search/docs/appearance/structured-data/product-snippet),
[Article](https://developers.google.com/search/docs/appearance/structured-data/article)
y [Open Graph](https://ogp.me/). Una recomendación contextual no demuestra impacto
en posiciones.

## CI

`audit --fail-on-high` devuelve 3 si observa una acción de prioridad alta.
`compare --fail-on-regression` devuelve 3 si observa hallazgos nuevos comparables.

| Código | Significado |
| --- | --- |
| 0 | Ejecución correcta según la política solicitada. |
| 1 | Uso inválido u otro error. |
| 2 | Auditoría parcial o comparación limitada. |
| 3 | Se incumplió la política de hallazgos/regresión solicitada. |

Sin la política de regresión, una comparación puede devolver 2 aunque no haya
hallazgos nuevos. Revisa `notComparable`, `incompleteChecks`, cambios de muestra
y cobertura de ambos informes.

El [workflow manual](../.github/workflows/seo-audit.yml) audita una URL pública
sin proveedores y conserva el JSON como artefacto durante siete días. Puedes
usar la CLI de comparación con un informe base versionado en tu propio proyecto.
