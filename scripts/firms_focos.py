#!/usr/bin/env python3
"""Focos de calor de las últimas 48 h (NASA FIRMS) sobre Corrientes → fires.json.

Usa los archivos públicos de FIRMS para Sudamérica (no requieren clave):
VIIRS (Suomi-NPP, NOAA-20, NOAA-21) y MODIS (Terra/Aqua).
"""
import csv, io, json, sys, urllib.request
from datetime import datetime, timezone

BASE = "https://firms.modaps.eosdis.nasa.gov/data/active_fire"
SOURCES = [
    ("VIIRS S-NPP", f"{BASE}/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_South_America_48h.csv"),
    ("VIIRS NOAA-20", f"{BASE}/noaa-20-viirs-c2/csv/J1_VIIRS_C2_South_America_48h.csv"),
    ("VIIRS NOAA-21", f"{BASE}/noaa-21-viirs-c2/csv/J2_VIIRS_C2_South_America_48h.csv"),
    ("MODIS", f"{BASE}/modis-c6.1/csv/MODIS_C6_1_South_America_48h.csv"),
]
# Corrientes con un margen para ver lo que se acerca desde provincias y países vecinos.
S, N, W, E = -31.3, -26.7, -60.3, -55.0


def conf_label(v: str) -> str:
    v = (v or "").strip().lower()
    if v in ("h", "high"):
        return "alta"
    if v in ("l", "low"):
        return "baja"
    if v.isdigit():
        n = int(v)
        return "alta" if n >= 80 else "baja" if n < 30 else "nominal"
    return "nominal"


def main(dest):
    fires, errors = [], 0
    for name, url in SOURCES:
        try:
            raw = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "clima-personal/1.0"}), timeout=60).read().decode("utf-8", "replace")
            for r in csv.DictReader(io.StringIO(raw)):
                lat, lon = float(r["latitude"]), float(r["longitude"])
                if not (S <= lat <= N and W <= lon <= E):
                    continue
                c = conf_label(r.get("confidence", ""))
                if c == "baja":
                    continue
                t = datetime.strptime(f'{r["acq_date"]} {r["acq_time"].zfill(4)}', "%Y-%m-%d %H%M").replace(tzinfo=timezone.utc)
                fires.append({"lat": round(lat, 4), "lon": round(lon, 4), "t": t.isoformat(timespec="minutes"), "sat": name,
                              "conf": c, "frp": round(float(r.get("frp") or 0), 1)})
        except Exception as e:
            errors += 1
            print(f"error {name}: {e}", file=sys.stderr)
    fires.sort(key=lambda f: f["t"], reverse=True)
    json.dump({"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "count": len(fires), "errors": errors, "fires": fires},
              open(dest, "w"), separators=(",", ":"))
    print(f"{len(fires)} focos en la zona, {errors} errores")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "fires.json")
