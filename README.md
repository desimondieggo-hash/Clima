# Clima

Web-app del clima personal, sin publicidad ni rastreadores. Se instala en el celular como app (PWA).

- **Pronóstico y buscador de ciudades:** [Open-Meteo](https://open-meteo.com/) (CC BY 4.0).
- **Satélite:** [NASA GIBS](https://earthdata.nasa.gov/gibs), GOES-Este (GeoColor e infrarrojo).
- **Radar:** [RainViewer](https://www.rainviewer.com/) (uso personal, con crédito).
- **Alertas:** [Servicio Meteorológico Nacional](https://www.smn.gob.ar/), feed CAP.
- **Mapa:** © OpenStreetMap, Leaflet.
- **Rutas:** enlaces a Vialidad Nacional y Ruta0.

## Cómo funciona

Es una página estática publicada en GitHub Pages. La tarea `Publicar` (`.github/workflows/publicar.yml`)
corre cada 15 minutos: lee los avisos del SMN con `scripts/smn_alerts.py`, arma `alerts.json`
y publica todo. Así no hace falta ningún servidor ni proxy aparte.

GitHub pausa las tareas programadas de un repositorio público si pasan 60 días sin cambios:
si las alertas dejan de actualizarse, entrá a **Actions → Publicar → Enable workflow** o hacé cualquier cambio.
