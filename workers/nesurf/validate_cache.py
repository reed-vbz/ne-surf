"""Fail publication on mixed cycles, malformed spectra or inconsistent grid/texture metadata."""
import json
import math
from datetime import datetime
from pathlib import Path
from PIL import Image
from .common import CACHE_DIR

def validate(root: Path = CACHE_DIR):
    read=lambda p:json.loads((root/p).read_text())
    for model,required in [('ww3',{'hs','tp','dp'}),('hrrr',{'u10','v10','gust'})]:
        index=read(f'{model}/index.json'); spots=read(f'{model}/spots.json')
        assert index['cycle']==spots['cycle'], f'{model}: mixed cycles'
        shape=index['shape'];assert len(shape)==2 and all(isinstance(n,int) and n>0 for n in shape)
        for name,n in zip(['lat','lon'],shape):
            xs=index[name];assert len(xs)==n and all(math.isfinite(v) for v in xs) and all(b>a for a,b in zip(xs,xs[1:]))
        assert index['steps'], f'{model}: no steps'
        for st in index['steps']:
            p=Path(st['file']);assert not p.is_absolute() and '..' not in p.parts
            step=read(f'{model}/{p}');assert step['valid_time']==st['valid_time'] and step['hour']==st['hour']
            assert required<=set(step['fields'])
            for key,xs in step['fields'].items():
                assert len(xs)==shape[0]*shape[1], f'{model}/{p}: invalid {key} shape'
                assert all(v is None or math.isfinite(v) for v in xs),f'{model}/{p}: nonfinite {key}'
    wi=read('ww3/index.json');wf=read('wavefield/index.json')
    assert wf['cycle']==wi['cycle'] and wf['solver_version']==2
    assert {x['valid_time'] for x in wf['steps']} <= {x['valid_time'] for x in wi['steps']}
    for st in wf['steps']:
        with Image.open(root/'wavefield'/st['file']) as image:
            assert image.mode=='RGBA' and image.size==tuple(wf['shape'][::-1])
    nd=read('ndbc/latest.json')
    for bid,b in nd['buoys'].items():
        sp=b.get('spectrum')
        if not sp: continue
        fs,ds=sp['freqs_hz'],sp['density_m2_hz']
        assert len(fs)==len(ds) and len(fs)>=2,f'{bid}: invalid spectrum'
        assert all(math.isfinite(f) and f>0 for f in fs) and all(y>x for x,y in zip(fs,fs[1:])),f'{bid}: duplicate/invalid frequencies'
        assert all(math.isfinite(s) and s>=0 for s in ds)
        datetime.fromisoformat(sp['time'].replace('Z','+00:00'))
    print(f'Validated {len(wi["steps"])} WW3 steps, {len(wf["steps"])} textures and {len(nd["buoys"])} buoy records')
if __name__=='__main__':validate()
