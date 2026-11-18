#!/usr/bin/env python3
"""Lee las alertas y avisos vigentes del SMN (CAP) y las guarda en alerts.json.

El SMN publica una página con los enlaces a cada aviso en formato CAP (XML).
Su servidor no manda el encabezado CORS correcto, así que el navegador no puede
leerlo directo: esta tarea corre en GitHub cada 15 minutos y deja el JSON junto a la app.
"""
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

INDEX = "https://ssl.smn.gob.ar/CAP/AR.php"
UA = "clima-personal/1.0 (+https://github.com/desimondieggo-hash/clima)"
NS = {"cap": "urn:oasis:names:tc:emergency:cap:1.2"}
SEVERITY_LEVEL = {"Minor": "amarillo", "Moderate": "amarillo", "Severe": "naranja", "Extreme": "rojo"}


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def text(el, tag):
    found = el.find(f"cap:{tag}", NS)
    return (found.text or "").strip() if found is not None and found.text else ""


def level_of(headline: str, severity: str) -> str:
    h = headline.upper()
    for lv in ("ROJ", "NARANJA", "AMARILL"):
        if lv in h:
            return {"ROJ": "rojo", "NARANJA": "naranja", "AMARILL": "amarillo"}[lv]
    return SEVERITY_LEVEL.get(severity, "amarillo")


def parse_polygon(s: str):
    pts = []
    for pair in s.split():
        try:
            lat, lon = pair.split(",")
            pts.append([round(float(lat), 4), round(float(lon), 4)])
        except ValueError:
            continue
    return pts if len(pts) >= 3 else None


def parse_cap(xml: bytes, url: str):
    root = ET.fromstring(xml)
    if text(root, "status") not in ("", "Actual") or text(root, "msgType") == "Cancel":
        return []
    out = []
    for info in root.findall("cap:info", NS):
        headline = text(info, "headline") or text(info, "event")
        areas = []
        for area in info.findall("cap:area", NS):
            polys = [p for p in (parse_polygon(pg.text or "") for pg in area.findall("cap:polygon", NS)) if p]
            areas.append({"desc": text(area, "areaDesc"), "polygons": polys})
        out.append({
            "id": text(root, "identifier") or url,
            "title": (headline[:1] + headline[1:].lower()) if headline.isupper() else headline,
            "event": text(info, "event"),
            "level": level_of(headline, text(info, "severity")),
            "severity": text(info, "severity"),
            "sent": text(root, "sent"),
            "onset": text(info, "onset") or text(info, "effective"),
            "expires": text(info, "expires"),
            "instruction": text(info, "instruction"),
            "web": text(info, "web") or url,
            "areas": areas,
        })
    return out


def main(dest: str):
    html = get(INDEX).decode("utf-8", "replace")
    links = sorted(set(re.findall(r"https?://[^\"'<>\s]+?_cap_es\.xml", html)))
    now = datetime.now(timezone.utc)
    alerts, errors = [], 0
    for url in links:
        try:
            for a in parse_cap(get(url), url):
                if a["expires"]:
                    try:
                        if datetime.fromisoformat(a["expires"]) < now:
                            continue
                    except ValueError:
                        pass
                alerts.append(a)
        except Exception as e:  # un aviso roto no debe frenar al resto
            errors += 1
            print(f"error en {url}: {e}", file=sys.stderr)
    data = {"generated": now.isoformat(timespec="seconds"), "source": INDEX, "count": len(alerts), "errors": errors, "alerts": alerts}
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(links)} enlaces, {len(alerts)} alertas vigentes, {errors} errores")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "alerts.json")
