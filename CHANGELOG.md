# Changelog

## 0.5.0 — 2026-10-20

- Historial local explícito de auditorías con informes versionados, consulta y exportación JSON/Markdown.
- Comparación por regla y URL: hallazgos nuevos, persistentes, resueltos y no comparables. Las URLs omitidas o las comprobaciones fallidas no se presentan como correcciones.
- CLI `audit`, `history`, `report` y `compare`, políticas de salida para CI y workflow manual de auditoría pública.
- Cuatro herramientas MCP nuevas; `seo_audit_save` declara su escritura local. Las otras 28 herramientas mantienen operaciones de lectura.
- Motor dividido en siete módulos con versiones, cobertura y aislamiento de errores.
- Revisión de hreflang, canonical múltiples/destinos observados, consistencia del sitemap, encabezados, Open Graph y tarjetas sociales.
- Inspección limitada de propiedades schema.org, incluidos nodos en `@graph`; conserva las limitaciones de contexto y elegibilidad.
- Renderizado JavaScript opcional con Chrome/Chromium/Edge instalado, perfil aislado, recursos con transporte validado y resultados parciales explícitos.
- Integración opcional de PageSpeed Insights: laboratorio y datos de campo separados por URL/origen, sin atribuir cero a datos ausentes.
- Grafo de enlaces internos de la muestra, con recuentos de enlaces entrantes y aristas limitadas; no declara páginas huérfanas sin evidencia completa.
- Pruebas del flujo persistido entre procesos y reinicios MCP, comparación de muestras parciales e instalación del tarball.

## 0.4.0 — 2026-10-20

- Primera auditoría con solo `baseUrl`, sin credenciales; Google y Bing son opcionales.
- Resumen explícito de cobertura, comprobaciones pendientes y fallos parciales. Cero acciones no se presenta como una garantía global.
- Comprobación de sintaxis y raíz de cada bloque JSON-LD, con evidencia y verificación.
- Nuevas revisiones de imágenes sin `alt`, idioma y viewport ausentes o vacíos. Ejemplos acotados y recomendaciones contextuales.
- Canónicas inválidas generan una acción propia sin perder el resto del análisis ni atribuir un error de conexión.
- Directivas robots: soporte de `none`, combinación de etiquetas repetidas y respeto del agente de las cabeceras. Los valores `max-snippet:01` y `max-image-preview:none` no generan bloqueos incorrectos.
- Demo antes/después sin red y documentación en español e inglés. Se mantienen las 25 herramientas MCP y los límites de rastreo.
- Revisión de aceptación: robots-parser para grupos y comodines, reglas por origen y en redirecciones; bloqueo prudente cuando robots no está disponible.
- DNS público fijado a la conexión, límite de respuesta aplicado a bytes durante la descarga y detección de HTML sin depender de mayúsculas.
- Un sitemap mal formado conserva sus otras entradas. URLs repetidas y fragmentos se deduplican; se explican los límites de descubrimiento y sitemaps. Se respeta base href y no se cuentan aliases redirigidos como títulos duplicados.
- GEO: los marcadores desconocidos se guardan como null; se rechazan métricas vacías/fraccionarias y fechas inválidas. CLI con ayuda, versión y código de error de doctor.
- SDK MCP actualizado a 1.32.1 y dependencia Hono actualizada; las herramientas anuncian su carácter de solo lectura.
- Verificación reproducible del tarball instalado desde cero, incorporada a CI.
