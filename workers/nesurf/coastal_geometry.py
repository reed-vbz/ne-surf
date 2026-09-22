"""Derive shoreline and 100 m ribbon segments from the authoritative ocean polygon.

No depth threshold or independently simplified shoreline is introduced here.
"""
import json
import math
from pathlib import Path
from shapely.geometry import shape, mapping, box, Point
from shapely.ops import unary_union, transform, substring
from .common import REPO_ROOT


def build(root: Path = REPO_ROOT / 'public/data/nh'):
    ocean = unary_union([shape(f['geometry']) for f in json.loads((root/'ocean.geojson').read_text())['features']])
    sx, sy = 111320 * math.cos(math.radians(43.2)), 111320
    to_m = lambda x,y,z=None: (x*sx,y*sy)
    to_ll = lambda x,y,z=None: (x/sx,y/sy)
    wet = transform(to_m, ocean)
    # The domain perimeter is a coverage limit, never a coastline.
    interior = box(-70.85*sx+10,42.8*sy+10,-70.2*sx-10,43.6*sy-10)
    coast = wet.boundary.intersection(interior)
    lines = list(coast.geoms) if hasattr(coast, 'geoms') else [coast]
    features = []
    for line in lines:
        if line.geom_type != 'LineString': continue
        for start in range(0, math.ceil(line.length), 100):
            part = substring(line, start, min(start+100,line.length))
            if part.geom_type != 'LineString' or part.length < 0.01: continue
            mid = part.interpolate(0.5, normalized=True)
            a, b = part.interpolate(0.45, normalized=True), part.interpolate(0.55, normalized=True)
            dx,dy=b.x-a.x,b.y-a.y; length=math.hypot(dx,dy)
            if length < 1e-9: continue
            nx,ny=-dy/length,dx/length
            if not wet.contains(Point(mid.x+nx*2,mid.y+ny*2)): nx,ny=-nx,-ny
            geom = mapping(transform(to_ll, part)); m = [mid.x/sx,mid.y/sy]
            features.append({'type':'Feature','id':len(features),'geometry':geom,
                             'properties':{'n':math.degrees(math.atan2(nx,ny))%360,'e':0,'m':m,'length_m':part.length}})
    fc=lambda fs:{'type':'FeatureCollection','features':fs}
    (root/'coastline.geojson').write_text(json.dumps(fc([{'type':'Feature','properties':{},'geometry':mapping(transform(to_ll,coast))}]),separators=(',',':')))
    (root/'ribbon.geojson').write_text(json.dumps(fc(features),separators=(',',':')))
    print(f'{len(features)} shoreline ribbon segments, max 100 m')
    return features

if __name__ == '__main__': build()
