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
        <li><strong>Calibration</strong>. The model is compared with the nearest buoy over a rolling two-week history and its height corrected by the observed ratio.</li>
        <li><strong>Breaking</strong>. Usable deep-water height and period give a breaking height (Komar &amp; Gaughan 1972). The bottom slope from the Coastal Relief Model gives the Iribarren number, which says whether the wave spills, plunges or surges. Face heights shown are this breaking height; treat them as a physics-based estimate, not a report from the beach.</li>
        <li><strong>Wind</strong>. HRRR wind is split into offshore, cross-shore and onshore components against the spot&apos;s offshore bearing.</li>
        <li><strong>Tide</strong>. The predicted height is placed within the surrounding low–high swing (low / mid / high thirds) and matched to the spot&apos;s preference.</li>
      </ol>
      <p>Bands follow the familiar seven-level scale (Very Poor … Epic). Good and Epic need size, period, wind and tide all in their ideal zones at once.</p>

      <h2>What this is not</h2>
      <p>There are no cameras and no human forecasters correcting the numbers. Commercial services fold both into their ratings. Spot facing angles, exposure windows and shadows here were checked against a 1 km land mask and OpenStreetMap; size, wind and tide preferences are hand-entered surf knowledge and will be wrong in places. If you know a spot, fix its entry in <code>data/spots.json</code>.</p>

      <h2>Source</h2>
      <p>MIT licensed. Python workers fetch and reduce the model grids to small JSON; the site is a static Next.js app that only reads those files.</p>
    </main>
  );
}
