# Verificación de 0.5.0

Evidencia de verificación de la versión 0.5.0. No implica haber completado toda
la hoja de ruta.

Resultado local: 52 pruebas aprobadas, cero fallos y cero pruebas omitidas.
La instalación del tarball, el historial, la comparación, la CLI y el renderizado
desde el paquete instalado pasan. `npm audit --omit=dev` informa cero
vulnerabilidades conocidas en las dependencias de producción.

## Flujo de uso verificado

La prueba de integración usa procesos reales de la CLI y conexiones MCP por
stdio. El DNS/HTTP de las muestras se simula; no necesita credenciales.

1. Auditar sin `--save` no crea historial.
2. Auditar y guardar una muestra con cuatro problemas genera un identificador.
3. Una segunda ejecución corregida, con la misma URL, no presenta esas acciones.
4. Comparar los informes devuelve cuatro resueltos y cero nuevos.
5. Recuperar el informe como Markdown conserva evidencia y pasos de verificación.
6. Reiniciar el servidor MCP conserva el acceso al historial y la comparación.
7. Introducir de nuevo los cuatro problemas devuelve cuatro nuevos; la política
   `--fail-on-regression` devuelve código 3.
8. Una ejecución sin conexión devuelve código 2; los cuatro problemas anteriores
   quedan no comparables, sin presentarse como resueltos.

## Casos cubiertos por las pruebas

- Ocurrencias de 25 páginas aunque las acciones solo muestran 20 ejemplos.
- Página omitida, respuesta fallida/no HTML, destino final distinto y regla
  ausente o con otra versión.
- Módulo que falla: los demás siguen ejecutándose; el fallo queda registrado.
- Comparación sin hallazgos pero sin cobertura o con reglas incompatibles:
  sigue indicando la limitación.
- Reparación de destinos de enlaces rotos y conservación de incertidumbre
  cuando un destino no se comprueba.
- Hreflang recíproco, sin retorno, formato inválido y destino fuera de la muestra.
- Canonical múltiples, encabezados, Open Graph parcial y URL sociales relativas.
- Propiedades schema.org dentro de `@graph`, contextos personalizados y límites
  ante JSON-LD grande o profundamente anidado.
- Navegador Chrome real sobre una página con contenido creado por JS y un script
  de otro origen público; diferencia respecto al HTML inicial y bloqueo de
  conexiones privadas, POST y WebSocket. Conservación de CSP.
- PageSpeed con respuestas de prueba: laboratorio/campo, URL/origen, datos nulos,
  unidades CLS, error de cuota, error Lighthouse, JSON y límite de respuesta.
- Grafo de enlaces con alias, autoenlaces y destinos fuera de la muestra.
- Historial con credenciales deliberadamente inválidas, rechazo de identificadores
  que contienen rutas y detección de archivos de historial corruptos.

## Instalación del paquete

`npm run verify:package` empaqueta e instala el tarball en una carpeta temporal.
Comprueba los archivos permitidos, el binario, las 29 herramientas y sus
anotaciones, las auditorías antes/después, guardado y recuperación, comparación
y exportación Markdown por CLI. El tarball contiene 26 archivos.

Solo `seo_audit_save` declara escritura local no idempotente. Las otras 28
herramientas declaran lectura. Ninguna modifica la web.

## Observaciones con red real

Ejecutado el 20 de octubre de 2026 sin proveedores, en un perfil temporal:

| Sitio | Cobertura | Resultado |
| --- | --- | --- |
| example.com | 1 HTML, muestra sin truncar | Tres acciones: ausencia de canonical, descripción y H1. Siete módulos sin errores; guardado y lectura correctos. |
| example.com, repetición | Mismo origen y muestra | Cero nuevos, tres persistentes, cero resueltos y cero no comparables. |
| www.grupohermoza.com | 3 HTML, límite de muestra alcanzado | Cero acciones en la muestra y comprobaciones realizadas. Siete módulos sin errores; guardado y lectura correctos. |
| example.com, renderizado JS | 1 HTML | Chrome real completó el renderizado, título Example Domain y cero errores de renderizado. |
| example.com, PageSpeed | 1 HTML conservado | El servicio real respondió HTTP 429. Informe parcial con `performance: null`; no se afirma disponer de mediciones reales de rendimiento. |

Son observaciones temporales de HTML público. Cero acciones en tres páginas no
equivale a una revisión completa del sitio ni confirma indexación o posiciones.

## Comandos

```bash
npm test
npm run verify:package
npm audit --omit=dev
git diff --check
```

La verificación local se ejecuta en Windows con Node 22. El workflow CI ejecuta
las pruebas y la instalación del paquete en Linux, Windows y macOS, y exige
un navegador instalado para las pruebas de renderizado. Los resultados de cada
commit se consultan en [GitHub Actions](https://github.com/JvnnDev/seo-webmaster-mcp/actions/workflows/ci.yml).

## Límites que permanecen

El renderizado es opcional, usa recursos limitados y no reproduce todas las
funciones del navegador. La medición real de PageSpeed quedó bloqueada por
cuota (HTTP 429); el mapeo de métricas se verificó con respuestas de prueba.
Las reglas de propiedades schema.org son un conjunto limitado, no un validador completo. Hreflang solo
comprueba reciprocidad con destinos disponibles en la muestra. No se validaron
en esta iteración credenciales reales de Google/Bing ni se aplican cambios a
CMS o archivos de una web.
