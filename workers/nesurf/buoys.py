"""NDBC buoy positions used for model calibration (from https://www.ndbc.noaa.gov/data/stations/station_table.txt, 2026-09-21)."""
BUOY_POSITIONS: dict[str, tuple[float, float]] = {
    "44097": (40.966, -71.123),  # Block Island, RI
    "44008": (40.500, -69.254),  # Nantucket 54 NM SE
    "44013": (42.346, -70.651),  # Boston 16 NM E
    "44090": (41.840, -70.329),  # Cape Cod Bay
    "44098": (42.800, -70.169),  # Jeffrey's Ledge, NH
    "44007": (43.525, -70.140),  # Portland 12 NM SE
}
