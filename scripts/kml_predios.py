#!/usr/bin/env python3
"""Convierte el KML/KMZ de predios en predios.json (liviano) para el mapa.

Uso: python3 kml_predios.py archivo.kmz predios.json [--sin-nombres] [--tolerancia 0]
Guarda solo el nombre del predio y las hectáreas (o nada con --sin-nombres). Por defecto
conserva los contornos completos, igual que Google Maps; el mapa (Leaflet) ya simplifica
el dibujo según el zoom. --tolerancia en grados solo si hiciera falta achicar el archivo.
"""
import json, re, sys, zipfile, xml.etree.ElementTree as ET

NS = {"k": "http://www.opengis.net/kml/2.2"}


def read_kml(path):
    if zipfile.is_zipfile(path):
        z = zipfile.ZipFile(path)
        name = next(n for n in z.namelist() if n.lower().endswith(".kml"))
        return z.read(name)
    return open(path, "rb").read()


def dp(pts, tol):
    """Douglas-Peucker sobre [[lat, lon], ...]."""
    if len(pts) < 4:
        return pts
    (y1, x1), (y2, x2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = (dx * dx + dy * dy) ** 0.5 or 1e-12
    idx, dmax = 0, 0.0
    for i in range(1, len(pts) - 1):
        y, x = pts[i]
        d = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / norm
        if d > dmax:
            idx, dmax = i, d
    if dmax > tol:
        return dp(pts[: idx + 1], tol)[:-1] + dp(pts[idx:], tol)
    return [pts[0], pts[-1]]


def ring(text, tol):
    pts = []
    for tok in text.split():
        p = tok.split(",")
        if len(p) >= 2:
            pts.append([round(float(p[1]), 6), round(float(p[0]), 6)])
    if len(pts) < 4:
        return None
    if tol <= 0:
        return pts
    s = dp(pts, tol)
    return s if len(s) >= 4 else pts  # anillos chicos: se dejan completos


def field(desc, key):
    m = re.search(rf"<td>\s*{key}\s*</td>\s*<td>(.*?)</td>", desc or "", re.S | re.I)
    return re.sub(r"<[^>]+>", "", m.group(1)).strip() if m else ""


def main():
    src, dest = sys.argv[1], sys.argv[2]
    no_names = "--sin-nombres" in sys.argv
    tol = float(sys.argv[sys.argv.index("--tolerancia") + 1]) if "--tolerancia" in sys.argv else 0.0
    root = ET.fromstring(read_kml(src))
    out, total_in, total_out = [], 0, 0
    for i, pm in enumerate(root.iter("{http://www.opengis.net/kml/2.2}Placemark"), 1):
        polys = []
        for poly in pm.iter("{http://www.opengis.net/kml/2.2}Polygon"):
            rings = []
            for tagname in ("outerBoundaryIs", "innerBoundaryIs"):
                for b in poly.findall(f"k:{tagname}", NS):
                    c = b.find(".//k:coordinates", NS)
                    if c is not None and c.text:
                        total_in += len(c.text.split())
                        r = ring(c.text, tol)
                        if r:
                            total_out += len(r)
                            rings.append(r)
            if rings:
                polys.append(rings)
        if not polys:
            continue
        desc = pm.findtext("k:description", default="", namespaces=NS)
        ha = field(desc, "Has") or field(desc, "Sup")
        item = {"p": polys}
        item["n"] = f"Predio {i}" if no_names else (pm.findtext("k:name", default="", namespaces=NS) or "").strip()
        try:
            item["ha"] = round(float(ha))
        except ValueError:
            pass
        out.append(item)
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(out)} predios · {total_in} puntos → {total_out}")


if __name__ == "__main__":
    main()
