import Link from "next/link";

export const metadata = { title: "About — NE Surf" };

export default function About() {
  return (
    <main className="doc mx-auto max-w-3xl p-6 md:p-10">
      <nav className="mb-4 text-sm text-slate-500"><Link href="/" className="hover:underline">← Map</Link></nav>
      <h1>How NE Surf works</h1>
      <p>A free, open-source surf forecast for Rhode Island, Massachusetts, New Hampshire and Maine. Everything comes from public NOAA data; nothing is proprietary, and every spot definition is a JSON file you can edit.</p>

      <h2>Data</h2>
      <ul>
        <li><strong>Swell</strong>: NOAA GFS-Wave (WAVEWATCH III), North Atlantic 1/6° grid, three swell partitions plus wind sea, 0–168 h every 3 h, four runs a day.</li>
        <li><strong>Wind</strong>: NOAA HRRR 10 m wind and gusts, 3 km, hourly to 48 h. Beyond 48 h the coarser GFS wind carried in the wave files is used.</li>
        <li><strong>Buoys</strong>: NDBC realtime observations (44097 Block Island, 44008 Nantucket, 44013 Boston, 44098 Jeffreys Ledge, 44090 Cape Cod Bay, 44007 Portland), including the swell / wind-sea split.</li>
        <li><strong>Tides</strong>: NOAA CO-OPS predictions and observed water level for 15 stations.</li>
        <li><strong>Bathymetry</strong>: NOAA Coastal Relief Model (Northeast, 3 arc-second) transects at each spot.</li>
      </ul>

      <h2>The score</h2>
      <p>Each spot gets a 0–100 score per forecast hour. It is a product of gates rather than a weighted sum: a flat ocean or a blown-out wind zeroes it no matter how good everything else is.</p>
      <ol>
        <li><strong>Swell reach</strong>. Every swell train is checked against the spot&apos;s exposure window and ideal direction, then attenuated by land shadows (Block Island, Long Island, Martha&apos;s Vineyard, Nantucket, Cape Cod, Cape Ann) that were ray-cast from a land mask. Energy that survives is summed into a usable height.</li>
        <li><strong>Calibration</strong>. Buoy comparisons retain up to two weeks of history. Independent day blocks and a chronological holdout measure bulk-height bias. Automatic partition corrections remain disabled until their spatial and partition transfer is validated; pair count alone is not evidence of skill.</li>
        <li><strong>Breaking</strong>. Period-dependent transfers are weighted by each partition’s usable variance to estimate breaking height (Komar &amp; Gaughan 1972). The bottom slope from the Coastal Relief Model gives the Iribarren number, which says whether the wave spills, plunges or surges. Face heights shown are this breaking height; treat them as a physics-based estimate, not a report from the beach.</li>
        <li><strong>Wind</strong>. HRRR wind is split into offshore, cross-shore and onshore components against the spot&apos;s offshore bearing.</li>
        <li><strong>Tide</strong>. The predicted height is placed within the surrounding low–high swing (low / mid / high thirds) and matched to the spot&apos;s preference.</li>
      </ol>
      <p>Bands follow the familiar seven-level scale (Very Poor … Epic). Good and Epic need size, period, wind and tide all in their ideal zones at once.</p>

      <h2>Map and time</h2>
      <p>Pins, radar and the hourly drawer follow the selected hour. Daily cards show each day’s best window, and buoy spectra are explicitly labeled latest observed. The regional animated field uses the nearest three-hour primary swell step; its time and the wind source appear in the map’s data disclosure.</p>
      <p>The dashed boundary marks detailed bathymetry coverage for the MA–NH–southern Maine map. Waves use a metric eikonal approximation with linear shoaling, empirical friction and a depth cap. This field is illustrative and independent of the empirical spot face-height calculation. Neither is validated against local surf observations. Refraction around complex headlands is not a full spectral diffraction solution.</p>
      <p>The optional surrogate identifies whether its training targets came from the physics teacher or SWAN. A teacher-trained checkpoint is an approximation of that teacher, not independent validation. Old geometry and checkpoints without matching provenance are rejected.</p>
      <h2>What this is not</h2>
      <p>There are no cameras and no human forecasters correcting the numbers. Commercial services fold both into their ratings. Spot facing angles, exposure windows and shadows here were checked against a 1 km land mask and OpenStreetMap; size, wind and tide preferences are hand-entered surf knowledge and will be wrong in places. If you know a spot, fix its entry in <code>data/spots.json</code>.</p>

      <h2>Source</h2>
      <p>MIT licensed. Python workers fetch and reduce the model grids to small JSON; the site is a static Next.js app that only reads those files.</p>
    </main>
  );
}
