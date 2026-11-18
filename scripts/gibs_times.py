#!/usr/bin/env python3
"""Guarda en gibs.json la última hora disponible de las capas GOES-Este que usa el mapa.

Así la app puede animar las últimas 2 horas de satélite sin pedir horas que todavía no existen.
"""
import json, re, sys, urllib.request

URL = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml"
LAYERS = ["GOES-East_ABI_Band13_Clean_Infrared", "GOES-East_ABI_GeoColor"]

xml = urllib.request.urlopen(urllib.request.Request(URL, headers={"User-Agent": "clima-personal/1.0"}), timeout=60).read().decode("utf-8", "replace")
out = {}
for block in re.findall(r"<Layer>(.*?)</Layer>", xml, re.S):
    ident = re.search(r"<ows:Identifier>(.*?)</ows:Identifier>", block)
    if not ident or ident.group(1) not in LAYERS:
        continue
    vals = re.findall(r"<Value>(.*?)</Value>", block)
    latest = vals[-1].split("/")[1] if vals and "/" in vals[-1] else None
    dflt = re.search(r"<Default>(.*?)</Default>", block)
    out[ident.group(1)] = latest or (dflt.group(1) if dflt else None)
json.dump(out, open(sys.argv[1] if len(sys.argv) > 1 else "gibs.json", "w"))
print(out)
