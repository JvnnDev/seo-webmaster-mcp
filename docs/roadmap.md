# Camino hacia una herramienta SEO más completa

Evaluación del 20 de octubre de 2026, posterior a la publicación de 0.4.0.
Este documento propone trabajo pendiente: ninguna capacidad de la hoja de ruta
debe anunciarse como implementada hasta superar sus criterios de aceptación.

## Estado actual

Actualización 0.5.0: implementadas las etapas 1 y 2,
con historial explícito, exportación JSON/Markdown, comparación por regla y URL,
siete módulos aislados y cobertura por comprobación. También se implementaron
parte de la etapa 3 (hreflang, canonical múltiples/destinos, consistencia del
sitemap, encabezados, tarjetas sociales y grafo de enlaces), parte de la etapa 4
(propiedades de tipos schema.org seleccionados), la etapa 5 (renderizado JS
opcional y PageSpeed Insights) y el flujo CLI/CI de la etapa 6.

Siguen pendientes perfiles sectoriales, validaciones semánticas más amplias y
asistencia de escritura por plataforma. La tabla siguiente conserva el alcance
total propuesto; no implica
que cada etapa esté terminada. Evidencia local: [verificación 0.5.0](verification-0.5.0.md).

0.4.0 es una versión publicada y verificada. Permite auditar HTML público sin
credenciales, añadir datos de Google Search Console y Bing y obtener acciones
con evidencia, cobertura y limitaciones. Su instalación y protocolo MCP están
probados en Windows, Linux y macOS.

0.4.0 no constituye todavía una suite SEO exhaustiva: no ejecuta JavaScript, no mide
rendimiento, no guarda un historial de auditorías y solo comprueba la sintaxis y
la raíz del JSON-LD. Las 25 herramientas MCP incluyen consultas a proveedores;
esa cifra no representa 25 módulos de auditoría completos.

## Qué se aprovechó de claude-seo-ai

Referencia revisada: [Hainrixz/claude-seo-ai, commit cabd6079](https://github.com/Hainrixz/claude-seo-ai/tree/cabd6079dc1ae74682083ad3caf4e09bb1964404).

En 0.4.0 se usaron como referencia sus comprobaciones de imágenes y viewport.
La implementación y los ejemplos son propios; no se incorporaron archivos de
ese repositorio. No se ha agotado su utilidad como referencia.

Su [registro de comprobaciones](https://github.com/Hainrixz/claude-seo-ai/blob/cabd6079dc1ae74682083ad3caf4e09bb1964404/scripts/checks/index.mjs)
separa comprobaciones de página y sitio y aísla sus fallos. Su
[comparador](https://github.com/Hainrixz/claude-seo-ai/blob/cabd6079dc1ae74682083ad3caf4e09bb1964404/scripts/compare.mjs)
trabaja sobre informes persistidos. Son dos patrones especialmente útiles para
nuestro siguiente paso. También hay implementaciones de referencia para
[hreflang](https://github.com/Hainrixz/claude-seo-ai/blob/cabd6079dc1ae74682083ad3caf4e09bb1964404/scripts/checks/international.mjs),
[marcado estructurado](https://github.com/Hainrixz/claude-seo-ai/blob/cabd6079dc1ae74682083ad3caf4e09bb1964404/scripts/checks/schema.mjs)
y [tarjetas sociales](https://github.com/Hainrixz/claude-seo-ai/blob/cabd6079dc1ae74682083ad3caf4e09bb1964404/scripts/checks/social.mjs).

Su licencia MIT permite reutilización con sus condiciones. Si se adapta código,
conservar el aviso de autoría/licencia y registrar procedencia y cambios. Cada
regla importada debe contrastarse con documentación vigente y probarse: el
repositorio de referencia no sustituye esa validación.

## Orden de implementación propuesto

| Etapa | Capacidades | Criterio de aceptación |
| --- | --- | --- |
| 1. Auditoría repetible | Informes versionados, guardado local explícito, exportación JSON/Markdown y comparación entre ejecuciones. | Clasificar hallazgos nuevos, persistentes y resueltos por regla y URL. Una página ausente o una comprobación fallida se informa como no comparable, nunca como resuelta. Probarlo con una corrección real y un rastreo parcial. |
| 2. Motor extensible | Extraer las reglas actuales a módulos de página/sitio, con identificadores estables, esquema de resultados y estados por comprobación. | Conservar compatibilidad de las herramientas actuales. Un módulo que falla no elimina los resultados de otros; informar error, no aplicable y no comprobado. |
| 3. Cobertura técnica | Canonical múltiples y destinos conflictivos, consistencia sitemap/indexabilidad, hreflang, jerarquía de encabezados, Open Graph/Twitter y grafo de enlaces internos. | Fixtures positivas y negativas por familia. No exigir hreflang a sitios monolingües ni tratar varias H1 como un error universal. Distinguir páginas sin enlaces entrantes dentro de la muestra de páginas huérfanas confirmadas. |
| 4. Datos estructurados y contexto | Inspección de @graph, tipos y propiedades para un conjunto explícito de Article, Product, Organization y BreadcrumbList; perfiles de tienda, publicación y negocio local. | Indicar exactamente qué reglas se validaron y qué requiere revisión. No afirmar validación completa de schema.org ni elegibilidad garantizada. Las reglas de cada perfil deben ser aplicables al sitio observado. |
| 5. Web renderizada y rendimiento | Renderizado opcional con navegador y comparación HTML/DOM; integración opcional de PageSpeed Insights/CrUX. | Una web de prueba con contenido generado por JS produce evidencia diferente en ambos modos. Fallos del navegador/API conservan el informe estático. Separar mediciones de laboratorio y de campo; mostrar ausencia de datos sin inventar una nota. |
| 6. Seguimiento y uso continuo | CLI de auditoría y comparación sin cliente MCP, informes compartibles y ejecución en CI con políticas de regresión configurables. | Un proyecto de ejemplo detecta una regresión conocida y deja pasar una corrección. Las mismas reglas y límites se usan en CLI y MCP. No exportar credenciales ni datos privados por defecto. |
| 7. Asistencia para corregir | Propuestas de cambios por plataforma, ejemplos concretos y comprobaciones posteriores; aplicación automática como alcance separado. | Cada propuesta conserva evidencia y explica dónde cambiar. Cualquier escritura futura tiene vista previa, autorización explícita, respaldo y verificación; actualizar las anotaciones MCP según sus efectos reales. |

La primera entrega debe concentrarse en las etapas 1 y 2. Las demás se dividen en
versiones según su tamaño; esta tabla no promete que todas quepan en una sola.

## Aprovechar recursos existentes

- Mantener robots-parser y Undici para sus responsabilidades actuales.
- Evaluar adaptar reglas concretas de claude-seo-ai y sus fixtures con atribución,
  sin introducir de golpe su orquestación de Claude ni su sistema de escritura.
- Evaluar herramientas mantenidas para navegador, validación de esquemas y
  rendimiento cuando corresponda implementar esas etapas. Comprobar versiones,
  licencias y coste de instalación antes de elegirlas.
- Conservar la combinación propia de rastreo con datos de Google y Bing como
  parte central del producto.

## Cuándo considerar cumplido este alcance

Un usuario debe poder instalar, auditar una web estática o renderizada, entender
la cobertura, obtener evidencia reproducible, guardar un informe, corregir un
problema y comprobar la diferencia en una segunda ejecución. Debe funcionar
sin proveedores y mejorar con ellos cuando estén disponibles.

Antes de anunciar ese alcance como completo, verificar el flujo con un sitio
estático, una aplicación con JavaScript, un sitio multilingüe y una tienda de
prueba. Documentar tamaño de muestra, límites, errores y comprobaciones omitidas.
Mantener las comprobaciones de instalación del paquete en los tres sistemas.

No usar como medida de completitud un número de herramientas, una puntuación
general ni la cantidad de funcionalidades copiadas. La cobertura verificable y
la utilidad del ciclo de corrección son los criterios de esta hoja de ruta.
