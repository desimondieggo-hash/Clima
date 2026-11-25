# Clima

Web-app del clima personal, sin publicidad ni rastreadores. Se instala en el celular como app (PWA).

- **Pronóstico y buscador de ciudades:** [Open-Meteo](https://open-meteo.com/) (CC BY 4.0).
- **Satélite:** [NASA GIBS](https://earthdata.nasa.gov/gibs), GOES-Este (GeoColor e infrarrojo).
- **Radar:** [RainViewer](https://www.rainviewer.com/) (uso personal, con crédito).
- **Alertas:** [Servicio Meteorológico Nacional](https://www.smn.gob.ar/), feed CAP.
- **Mapa:** © OpenStreetMap, Leaflet.
- **Rutas:** enlaces a Vialidad Nacional y Ruta0.

## Parte privada

El ingreso, los predios y los reportes con foto usan Firebase (proyecto `clima-corrientes`):
solo entran los correos invitados por el administrador. Las reglas están en `firestore.rules`
y se publican desde la consola de Firebase. Los predios **no** están en este repositorio:
el administrador los sube desde la app (Cuenta → Predios → KML/KMZ).

## Campo (GPS)

Pestaña 🧭 **Campo**: mapa satelital con tu posición GPS, los predios y herramientas para trabajar en el monte.

- **Recorrido:** graba el track (distancia, tiempo). La pantalla tiene que quedar prendida.
- **Punto:** marca un lugar con tipo, nota y foto. Manteniendo apretado el mapa se marca un punto en otro lugar.
- **Medir:** distancia o área (ha) tocando el mapa o caminando con «Mi posición».
- **📂:** lista de lo guardado, compartir como KML/KMZ (con fotos, se abre en Google Earth) y **mapa sin señal**.

Todo queda guardado en el teléfono (IndexedDB), no se sube a Firebase.
Fondo con señal: Esri World Imagery (no se puede guardar). Sin señal: Sentinel-2 cloudless 2016 de EOX (CC BY 4.0, 10 m),
que se baja desde 📂 para la provincia (niveles 6-11) y alrededor de cada predio (12-15) en la caché `campo-teselas`.

## Cómo funciona

Es una página estática publicada en GitHub Pages. La tarea `Publicar` (`.github/workflows/publicar.yml`)
corre cada 15 minutos: lee los avisos del SMN con `scripts/smn_alerts.py`, arma `alerts.json`
y publica todo. Así no hace falta ningún servidor ni proxy aparte.

GitHub pausa las tareas programadas de un repositorio público si pasan 60 días sin cambios:
si las alertas dejan de actualizarse, entrá a **Actions → Publicar → Enable workflow** o hacé cualquier cambio.
