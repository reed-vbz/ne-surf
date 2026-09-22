import unittest
import numpy as np
from nesurf.wavefield import metric_spacing, phase_speed, arrival_from_speed, travel_time, wave_height, path_integral, sdf_metres, encode, inflow_mask, GAMMA

class WavefieldTest(unittest.TestCase):
    def test_metric_axes_and_distance(self):
        dy,dx=metric_spacing(0.001,43)
        self.assertAlmostEqual(dy,111.32)
        self.assertAlmostEqual(dx/dy,np.cos(np.radians(43)))
        water=np.ones((5,5),bool);water[0,:]=False
        self.assertAlmostEqual(sdf_metres(water,(dy,dx))[2,2],dy*2)
    def test_dispersion_extremes(self):
        h=np.array([0.05,0.5,5,50,2000])
        for T in [3,6,14,25]:
            c,k=phase_speed(h,T)
            np.testing.assert_allclose(9.81*k*np.tanh(k*h),(2*np.pi/T)**2,rtol=1e-9)
            self.assertTrue(np.isfinite(c).all())
    def test_cardinal_and_oblique_planar_wave(self):
        wet=np.ones((41,61),bool);dy,dx=100,73;c=np.full(wet.shape,10.0)
        yy,xx=np.mgrid[:41,:61]
        for d in [0,90,180,270,45,135,225,315]:
            t=arrival_from_speed(c,wet,d,(dy,dx))
            p=xx*dx*np.sin(np.radians(d))+yy*dy*np.cos(np.radians(d))
            exact=(p.max()-p)/10+0.25
            np.testing.assert_allclose(t,exact,atol=4)
    def test_enclosed_water_does_not_inject_waves(self):
        wet=np.ones((15,20),bool);wet[4:11,5:12]=False;wet[6:9,7:10]=True
        t=arrival_from_speed(np.full(wet.shape,10.),wet,90,(100,73))
        self.assertTrue(np.isnan(t[7,8]))
        encoded=encode(t,np.ones_like(t),sdf_metres(wet,(100,73)))
        self.assertTrue((encoded[7,8,:3]==0).all())
    def test_remote_path_cannot_change_local_attenuation(self):
        wet=np.ones((9,20),bool);wet[4,:]=False
        t=np.tile(np.arange(20,0,-1)*10.,(9,1));t[~wet]=np.nan
        w=np.full(t.shape,0.02);b=w.copy();b[5:,:]=10
        a=path_integral(t,w,wet,(100,73));z=path_integral(t,b,wet,(100,73))
        np.testing.assert_array_equal(a[:4],z[:4])
    def test_sloping_bottom_depth_limit(self):
        d=np.tile(np.linspace(0.5,60,60),(30,1));wet=d>0
        t=travel_time(d,wet,14,90,(100,73));h=wave_height(d,wet,t,2,14,(100,73),inflow_mask(wet,90))
        self.assertTrue(np.isfinite(h).all());self.assertTrue((h<=GAMMA*d+1e-9).all())
        self.assertTrue((np.diff(t[15])<0).all())
    def test_invalid_land_and_overflow_not_encoded_as_water(self):
        t=np.array([[np.nan,0,20000,50.]])
        encoded=encode(t,np.ones_like(t),np.array([[1,-1,1,1.]]))
        self.assertTrue((encoded[0,:3,:3]==0).all());self.assertGreater(encoded[0,3,1],0)

    def test_attenuation_is_linear_below_the_breaking_cap(self):
        d=np.full((15,30),40.);wet=d>0;t=travel_time(d,wet,10,90,(100,73));sources=inflow_mask(wet,90)
        a=wave_height(d,wet,t,.5,10,(100,73),sources);b=wave_height(d,wet,t,1.,10,(100,73),sources)
        np.testing.assert_allclose(b,2*a,rtol=1e-12)
