import json
import tempfile
import unittest
from pathlib import Path
from datetime import datetime,timezone,timedelta
import numpy as np
from shapely.geometry import shape,box
from shapely.ops import unary_union
from nesurf.common import write_json,REPO_ROOT
from nesurf.fetch_ndbc import build_buoy,parse_data_spec
from nesurf.calibrate import interp_model,heldout_skill

class DataTest(unittest.TestCase):
    def test_ndbc_roundtrip_preserves_irregular_frequency_energy(self):
        text='2026 09 22 04 00 0.1 1.25 (0.0325) 2.5 (0.0375) 4 (0.0425)'
        sp=parse_data_spec(text)
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'spectrum.json';write_json(p,{'freqs':sp['freqs'],'density':sp['density']},ndigits=6);out=json.loads(p.read_text())
        np.testing.assert_array_equal(out['freqs'],sp['freqs'])
        self.assertEqual(len(set(out['freqs'])),len(out['freqs']))
        self.assertIsNone(parse_data_spec('2026 09 22 04 00 0.1 1 (0.03) 2 (0.03)'))
    def test_old_newest_row_is_stale(self):
        text='#YY MM DD hh mm WVHT DPD APD MWD WSPD WDIR GST WTMP\n2026 09 20 04 00 1.0 8.0 6.0 90 4 180 6 16'
        now=datetime(2026,9,22,4,tzinfo=timezone.utc)
        b=build_buoy(text,None,now,timedelta(minutes=90),timedelta(hours=24),timedelta(hours=3))
        self.assertEqual(b['status'],'stale');self.assertEqual(b['wave_time'],'2026-09-20T04:00:00Z')
    def test_calibration_direction_wrap(self):
        s=[{'valid_time':'2026-09-22T00:00:00Z','dp':350},{'valid_time':'2026-09-22T03:00:00Z','dp':10}]
        self.assertAlmostEqual(interp_model(s,datetime(2026,9,22,1,30,tzinfo=timezone.utc),'dp'),0)
    def test_day_block_holdout_not_pair_count(self):
        pairs=[{'t':f'2026-09-01T{h:02}:00:00Z','obs_hs':1.2,'model_hs':1} for h in range(24)]
        self.assertFalse(heldout_skill(pairs)['bulk_skill_improved'])
        pairs=[{'t':f'2026-09-{d:02}T00:00:00Z','obs_hs':1.2,'model_hs':1} for d in range(1,10)]
        r=heldout_skill(pairs);self.assertTrue(r['bulk_skill_improved']);self.assertEqual(r['holdout_days'],2)
    def test_ribbon_is_on_authoritative_coast_and_not_domain_edge(self):
        root=REPO_ROOT/'public/data/nh'
        ocean=unary_union([shape(f['geometry']) for f in json.loads((root/'ocean.geojson').read_text())['features']])
        fs=json.loads((root/'ribbon.geojson').read_text())['features']
        self.assertGreater(len(fs),100)
        for f in fs:
            line=shape(f['geometry'])
            self.assertLess(line.difference(ocean.boundary.buffer(1e-8)).length,1e-7)
            self.assertLessEqual(f['properties']['length_m'],100.00001)
            self.assertTrue(box(-70.85,42.8,-70.2,43.6).contains(line))
