import unittest
try:
    import torch
except ImportError:
    torch=None

@unittest.skipIf(torch is None,'optional PINN dependencies not installed')
class PinnTest(unittest.TestCase):
    def test_dispersion_and_gradients_finite(self):
        from pinn.physics import wavenumber,dispersion_residual,group_speed
        h=torch.tensor([.05,.5,5.,50.,2000.],requires_grad=True);T=torch.full_like(h,14)
        k=wavenumber(h,T);self.assertLess(dispersion_residual(k,h,T).abs().max().item(),1e-5)
        group_speed(h,T).sum().backward();self.assertTrue(torch.isfinite(h.grad).all())
    def test_energy_edges_do_not_wrap(self):
        from pinn.physics import energy_balance_residual
        hs=torch.ones(1,1,8,9);th=torch.ones_like(hs);d=hs*30;T=hs*10;wet=hs.clone()
        a=energy_balance_residual(hs,th,d,T,wet,(100,73))
        hs[...,0]=10
        b=energy_balance_residual(hs,th,d,T,wet,(100,73))
        torch.testing.assert_close(a[...,-2:],b[...,-2:]);self.assertTrue((a[...,0]==0).all())
    def test_checkpoint_requires_matching_provenance(self):
        from pinn.api import checkpoint_passes
        ck={'geometry_hash':'a'*64,'geometry_version':2,'teacher_version':2,'target_source':'physics-teacher','validation_source':'physics-teacher','metrics':{'hs_mae_m':.05,'k_rel_err':.1}}
        self.assertTrue(checkpoint_passes(ck))
        self.assertFalse(checkpoint_passes(ck, "b"*64))
        self.assertFalse(checkpoint_passes({**ck,'geometry_version':1}))
        self.assertFalse(checkpoint_passes({**ck,'target_source':'swan'}))
        self.assertFalse(checkpoint_passes({**ck,'metrics':{'hs_mae_m':float('nan')}}))

    def test_full_physics_loss_has_finite_gradients(self):
        from pinn.model import SwanUNet
        from pinn.losses import pinn_loss
        model=SwanUNet(c_in=8,base=8)
        x=torch.zeros(1,8,32,32);x[:,0]=.3;x[:,1]=.5;x[:,2]=1;x[:,3]=.2;x[:,4]=.7;x[:,5]=1
        pred=model(x);loss,_=pinn_loss(pred,pred.detach(),x,(100,73))
        loss.backward()
        self.assertTrue(all(torch.isfinite(p.grad).all() for p in model.parameters() if p.grad is not None))

    def test_plane_energy_decay_matches_worker_friction_contract(self):
        import math
        from pinn.physics import energy_balance_residual,group_speed,CF
        d=torch.full((1,1,8,30),40.,dtype=torch.float64);T=torch.full_like(d,10.);cg=group_speed(d,T)
        x=torch.arange(30,dtype=torch.float64)[None,None,None,:]*10
        H=torch.exp(-.5*CF*x/(40*cg));theta=torch.full_like(d,math.pi/2)
        residual=energy_balance_residual(H,theta,d,T,torch.ones_like(d),(15,10))
        self.assertLess(residual[...,1:-1,1:-1].abs().max().item(),1e-6)

    def test_api_texture_contract_and_cycle_rollover(self):
        import io
        import numpy as np
        from unittest.mock import patch
        from PIL import Image
        from fastapi.testclient import TestClient
        from pinn.api import app
        from nesurf.wavefield import sdf_metres
        depth=np.full((16,20),40.);water=depth>0
        geom={'depth':depth,'water':water,'sdf':sdf_metres(water,(100,73)),'res_m':(100,73),'lat0':43.,'lon0':-70.8,'res_deg':.001,'geometry_hash':'a'*64}
        cycle='2026-09-22T00:00:00Z';st={'hour':0,'valid_time':cycle}
        step={'fields':{'hs':[1.],'tp':[10.],'dp':[90.]}}
        idx={'cycle':cycle,'lat':[43.005],'lon':[-70.79],'shape':[1,1]}
        with patch('pinn.api.geometry',return_value=geom), patch('pinn.api.model',return_value=None), patch('pinn.api.ww3_steps',return_value=[(st,step,idx)]):
            client=TestClient(app)
            self.assertEqual(client.get('/index.json').json()['cycle'],cycle)
            self.assertEqual(client.get('/f0.png',params={'cycle':'old'}).status_code,409)
            response=client.get('/f0.png',params={'cycle':cycle})
            self.assertEqual(response.status_code,200)
            self.assertEqual(Image.open(io.BytesIO(response.content)).size,(20,16))
            self.assertEqual(client.get('/geometry.png').status_code,200)
