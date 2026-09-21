/** Shapes shared by the score engine. Kept free of React/Next so it runs in Node, workers, and tests. */

export type Sector = { from_deg: number; to_deg: number };
export type LatLon = { lat: number; lon: number };
export type TideState = "low" | "mid" | "high";
export type TidePhase = "any" | "rising" | "falling";

/** Mirrors data/spots.schema.json. */
export interface Spot {
  id: string;
  name: string;
  state: "RI" | "MA" | "NH" | "ME";
  area?: string;
  location: LatLon;
  break_type: "beach" | "reef" | "point" | "jetty" | "rivermouth" | "slab";
  facing_deg: number;
  offshore_sample_point: LatLon;
  swell: {
    window: Sector;
    ideal_deg: number;
    angle_tolerance_deg?: number;
    min_period_s: number;
    ideal_period_s: number;
    min_height_m: number;
    ideal_height_m: number;
    max_height_m: number;
    shoaling_factor?: number;
  };
  shadow_sectors?: Array<Sector & { attenuation: number; by: string; min_period_s?: number; distance_km?: number }>;
  wind: {
    offshore_deg: number;
    offshore_tolerance_deg: number;
    max_onshore_kts: number;
    max_cross_kts: number;
    glassy_below_kts?: number;
    hrrr_sample_point?: LatLon;
  };
  tide: {
    station_id: string;
    station_kind: "reference" | "subordinate";
    preferred: TideState[];
    phase?: TidePhase;
    avoid?: TideState[];
    notes?: string;
  };
  buoys: string[];
  skill?: string;
  season?: string[];
  notes?: string;
  confidence: "verified" | "approximate";
  verification?: Record<string, string>;
}

/** One swell train (a GFS-Wave partition, or the wind sea). Heights in metres, "from" degrees. */
export interface SwellTrain {
  hs: number;
  tp: number;
  dp: number;
  kind: "swell" | "windsea";
}

/** Everything the engine needs for one spot at one instant. */
export interface Conditions {
  trains: SwellTrain[];
  wind: { speed_kts: number; dir_from_deg: number; gust_kts?: number } | null;
  tide: { state: TideState; phase: TidePhase; height_m: number; range_fraction: number } | null;
  /** Deep-water model bias correction already applied to `trains` (from the nearest buoy), for display. */
  calibration?: { buoy: string; ratio_hs: number; applied: number; n_pairs: number; low_confidence: boolean } | null;
  /** Nearshore slope from NOAA CRM transects (data/bathymetry.json). */
  bathy?: { slope_tan: number | null; quality: string; has_bar?: boolean } | null;
}

export type Band = "very_poor" | "poor" | "poor_to_fair" | "fair" | "fair_to_good" | "good" | "epic";
export type Color = "red" | "yellow" | "green";

export interface ScoreBreakdown {
  score: number;              // 0-100
  band: Band;
  color: Color;
  face_ft: number;            // estimated breaking face height, feet
  face_m: number;
  components: {
    swell_angle: number;      // 0-1 energy-weighted angle match after shadowing
    swell_size: number;       // 0-1 how close face height is to the spot's ideal
    swell_period: number;     // 0-1
    wind: number;             // 0-1
    tide: number;             // 0-1
  };
  dominant: SwellTrain | null; // the train contributing most usable energy
  usable_hs_m: number;         // combined Hs of energy that actually reaches the break
  nearshore: { xi: number | null; breaker: "spilling" | "plunging" | "surging" | "unknown"; shape: number; method: string };
  reasons: string[];           // human-readable, ordered most important first
}
