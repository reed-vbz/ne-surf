import { z } from "zod";
import spotsJson from "@/data/spots.json";
import type { Spot } from "./quality/types";

const sector = z.object({ from_deg: z.number(), to_deg: z.number() });
const latLon = z.object({ lat: z.number(), lon: z.number() });
const state = z.enum(["low", "mid", "high"]);

/** Runtime guard mirroring data/spots.schema.json (the Python side validates the full schema). */
export const SpotSchema = z.object({
  id: z.string(), name: z.string(), state: z.enum(["RI", "MA", "NH", "ME"]), area: z.string().optional(),
  location: latLon, break_type: z.enum(["beach", "reef", "point", "jetty", "rivermouth", "slab"]),
  facing_deg: z.number(), offshore_sample_point: latLon,
  swell: z.object({
    window: sector, ideal_deg: z.number(), angle_tolerance_deg: z.number().optional(),
    min_period_s: z.number(), ideal_period_s: z.number(),
    min_height_m: z.number(), ideal_height_m: z.number(), max_height_m: z.number(), shoaling_factor: z.number().optional(),
  }),
  shadow_sectors: z.array(sector.extend({ attenuation: z.number(), by: z.string(), min_period_s: z.number().optional(), distance_km: z.number().optional() })).optional(),
  wind: z.object({
    offshore_deg: z.number(), offshore_tolerance_deg: z.number(), max_onshore_kts: z.number(), max_cross_kts: z.number(),
    glassy_below_kts: z.number().optional(), hrrr_sample_point: latLon.optional(),
  }),
  tide: z.object({
    station_id: z.string(), station_kind: z.enum(["reference", "subordinate"]), preferred: z.array(state),
    phase: z.enum(["any", "rising", "falling"]).optional(), avoid: z.array(state).optional(), notes: z.string().optional(),
  }),
  buoys: z.array(z.string()), skill: z.string().optional(), season: z.array(z.string()).optional(), notes: z.string().optional(),
  confidence: z.enum(["verified", "approximate"]),
  verification: z.record(z.string(), z.string()).optional(),
});

export const SPOTS: Spot[] = z.object({ version: z.literal(1), spots: z.array(SpotSchema) }).parse(spotsJson).spots;
export const spotById = (id: string): Spot | undefined => SPOTS.find((s) => s.id === id);
