import { afterEach, describe, expect, it, vi } from "vitest";
import { buoyFresh, fresh, validGrid, validStep, type GridIndex } from "../cache";
import { conditionsFor, waveAt } from "../conditions";
import { faceLabel } from "../display";
import { scoreSpot } from "../quality/score";
import { SPOTS } from "../spots";
import { observedSpectrum, spectrumVariance, validSpectrum } from "../spectra";
const spot=SPOTS.find((s)=>s.id==="nauset-beach-ma")!;
const index:GridIndex={cycle:"2026-09-22T00:00:00Z",generated_at:"2026-09-22T04:00:00Z",shape:[2,2],lat:[42,43],lon:[-71,-70],steps:[{hour:0,valid_time:"2026-09-22T00:00:00Z",file:"steps/f000.json"}]};
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.resetModules();});
describe("data contracts",()=>{
 it("rejects ragged, wrong-time and invalid fields",()=>{
   expect(validGrid(index)).toBe(true);expect(validGrid({...index,lat:[43,42]})).toBe(false);
   expect(validStep(index,{hour:0,valid_time:index.cycle,fields:{hs:[1,2]}},index.cycle)).toBe(false);
   expect(validStep(index,{hour:0,valid_time:index.cycle,fields:{}},index.cycle)).toBe(false);
   expect(validStep(index,{hour:0,valid_time:"2026-09-23T00:00:00Z",fields:{hs:[1,2,3,4]}},index.cycle)).toBe(false);
 });
 it("does not call an old or future buoy live",()=>{
   const now=Date.parse("2026-09-22T04:00:00Z");
   expect(buoyFresh({status:"ok",wvht_m:1,wave_time:"2026-09-20T04:00:00Z"},now)).toBe(false);
   expect(fresh("bad",3,now)).toBe(false);expect(fresh("2026-09-23T04:00:00Z",3,now)).toBe(false);
 });
 it("retries a transient fetch failure instead of memoizing null",async()=>{
   const fetcher=vi.fn().mockResolvedValueOnce({ok:false}).mockResolvedValueOnce({ok:true,json:async()=>({value:1})});
   vi.stubGlobal("fetch",fetcher);const {loadJson}=await import("../cache");
   expect(await loadJson("/probe.json")).toBeNull();expect(await loadJson("/probe.json")).toEqual({value:1});expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it("pins every request to a retained commit even after the branch advances",async()=>{
   vi.stubEnv("NEXT_PUBLIC_CACHE_BASE","https://raw.githubusercontent.com/reed-vbz/ne-surf/data/public/cache");
   const sha="a".repeat(40),calls:string[]=[];
   vi.stubGlobal("fetch",vi.fn(async(url:string)=>{calls.push(url);return {ok:true,json:async()=>url.endsWith("manifest.json")?{revision:sha}:{fields:{}}};}));
   const {resolveDataSource,loadWw3Step}=await import("../cache");const source=await resolveDataSource();await loadWw3Step("steps/f003.json",source.base);
   expect(calls[1]).toContain(`/${sha}/public/cache/ww3/steps/f003.json`);
 });
 it("fails closed for an invalid publication manifest",async()=>{
   vi.stubEnv("NEXT_PUBLIC_CACHE_BASE","https://raw.githubusercontent.com/reed-vbz/ne-surf/data/public/cache");
   vi.stubGlobal("fetch",vi.fn(async()=>({ok:false})));const {resolveDataSource}=await import("../cache");
   await expect(resolveDataSource()).rejects.toThrow(/manifest/);
 });
});
describe("forecast invariants",()=>{
 it("distinguishes missing waves from measured flat",()=>{
   expect(conditionsFor(spot,index.cycle,undefined,undefined,null).wave_status).toBe("missing");
   const rows=[{hour:0,valid_time:index.cycle,hs:0},{hour:3,valid_time:"2026-09-22T03:00:00Z",hs:0}];
   expect(waveAt(rows,"2026-09-22T01:00:00Z")?.hs).toBe(0);
   expect(conditionsFor(spot,"2026-09-22T01:00:00Z",rows,undefined,null).wave_status).toBe("available");
   expect(faceLabel(0)).toBe("Flat");expect(faceLabel(null)).toBe("Unavailable");
 });
 it("wraps directions through north and does not extrapolate",()=>{
   const a={hour:0,valid_time:index.cycle,hs:1,tp:10,dp:350};const b={...a,hour:3,valid_time:"2026-09-22T03:00:00Z",dp:10};
   expect(waveAt([a,b],"2026-09-22T01:30:00Z")?.dp).toBe(0);expect(waveAt([a,b],"2026-09-22T04:00:00Z")).toBeNull();
 });
 it("preserves height when equal-period variance is split between partitions",()=>{
   const c={trains:[{hs:Math.SQRT2,tp:14,dp:95,kind:"swell" as const}],wind:null,tide:null};
   const one=scoreSpot(spot,c),two=scoreSpot(spot,{...c,trains:[{...c.trains[0],hs:1},{...c.trains[0],hs:1}]});
   expect(two.face_m).toBeCloseTo(one.face_m,8);
 });
 it("long-period and short-period energy are transformed separately",()=>{
   const c={wind:null,tide:null};const a={hs:1,tp:14,dp:95,kind:"swell" as const};
   const long=scoreSpot(spot,{...c,trains:[a]});const short=scoreSpot(spot,{...c,trains:[{...a,tp:5}]});
   expect(long.face_m).toBeGreaterThan(short.face_m);
 });
});
describe("spectral conservation",()=>{
 it("conserves irregular-bin energy including partial bin overlaps",()=>{
   const f=[.05,.061,.082,.107,.142,.181],s=[1,2,4,2,1,.5];
   const edges=[.0445,.0555,.0715,.0945,.1245,.1615,.2005];const lo=1/21.5,hi=1/2.5;
   const expected=s.reduce((sum,v,i)=>sum+v*Math.max(0,Math.min(hi,edges[i+1])-Math.max(lo,edges[i])),0);
   expect(observedSpectrum(f,s).reduce((sum,b)=>sum+b.energy,0)).toBeCloseTo(expected,12);
   expect(spectrumVariance(f,s)).toBeGreaterThan(expected);
 });
 it("rejects duplicate, negative and nonfinite bins",()=>{
   expect(validSpectrum([.03,.03],[1,2])).toBe(false);expect(validSpectrum([.03,.04],[1,-1])).toBe(false);
   expect(spectrumVariance([.03,NaN],[1,2])).toBeNull();
 });
});

describe("coastal wind legend",()=>{
 it("uses the same categorical alignment and light-wind palette as the legend",async()=>{
   const {ribbonColor,windTier,windAlignment,hexToRgb,WIND_ALIGN}=await import("../colors");
   const toward=90,normal=90;
   expect(ribbonColor(toward,12,normal)).toEqual(hexToRgb(WIND_ALIGN[windTier(windAlignment(toward,normal),12)]));
   expect(ribbonColor(toward,2,normal)).toEqual(hexToRgb(WIND_ALIGN.light));
   expect(windTier(windAlignment(270,normal),12)).toBe("onshore");
 });
});
