import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useTheme } from 'next-themes';

/**
 * The map on the Vehicle Tracking page.
 *
 * Leaflet directly rather than react-leaflet: the component tree here is one
 * map with a few hundred markers that are updated in place, which is exactly
 * the case where a React wrapper costs a re-render per tick and buys nothing.
 * Markers are kept in a ref keyed by plate and moved, so a 60-second refresh
 * slides the lorries instead of tearing the layer down and rebuilding it.
 *
 * Tiles are plain OpenStreetMap, which needs no key and no account. CARTO's
 * basemaps were the first choice for their dark variant, but they now demand
 * an API key and stamp "API KEY REQUIRED" across every tile without one. The
 * dark theme is handled instead by inverting the tile layer in CSS, which
 * costs nothing and cannot expire. Attribution is a condition of use and must
 * stay on screen.
 */

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export type MapState = 'MOVING' | 'IDLING' | 'PARKED' | 'OFFLINE' | 'NO_SIGNAL';

/** One palette for the whole feature - the list chips read from it too. */
export const STATE_COLOURS: Record<MapState, string> = {
  MOVING: '#16a34a',
  IDLING: '#d97706',
  PARKED: '#2563eb',
  OFFLINE: '#64748b',
  NO_SIGNAL: '#dc2626',
};

export interface MapVehicle {
  vehicleNumber: string;
  vehicleLabel: string;
  latitude: number | null;
  longitude: number | null;
  headingDeg: number | null;
  speedKmph: number | null;
  state: MapState;
  /** Shown in the tooltip, where there is room for the buyer and destination. */
  subtitle?: string | null;
}

export interface MapPoint {
  latitude: number;
  longitude: number;
  recordedAt: string;
  speedKmph: number | null;
}

interface VehicleMapProps {
  vehicles: MapVehicle[];
  selected?: string | null;
  onSelect?: (vehicleNumber: string) => void;
  /** Breadcrumb for the selected lorry, oldest first. */
  trail?: MapPoint[];
  /** Pins that are not vehicles: the factory, a destination. */
  landmarks?: { name: string; latitude: number; longitude: number; kind: 'factory' | 'destination' }[];
  /** Re-fit the view to everything on screen when this value changes. */
  fitKey?: string | number;
  className?: string;
}

/**
 * A lorry as an arrow pointing the way it is going, or a dot when it is not.
 *
 * A rotated arrow carries the one fact a dot cannot - the direction of travel -
 * which is what tells the office at a glance whether a lorry is on its way out
 * or already on its way back.
 */
function vehicleIcon(v: MapVehicle, isSelected: boolean, dark: boolean): L.DivIcon {
  const colour = STATE_COLOURS[v.state];
  const moving = v.state === 'MOVING' && typeof v.headingDeg === 'number';
  const size = isSelected ? 34 : 26;
  // The outline separates a marker from the map under it, so it follows the
  // basemap: a white halo on the inverted dark tiles turns the quiet greys of
  // "out of contact" into the loudest thing on the screen.
  const outline = dark ? '#0b1220' : '#ffffff';
  const ring = isSelected ? `<circle cx="12" cy="12" r="11" fill="none" stroke="${colour}" stroke-width="1.5" opacity="0.55"/>` : '';
  const body = moving
    ? `<path d="M12 3.2 L17.6 19 L12 15.4 L6.4 19 Z" fill="${colour}" stroke="${outline}" stroke-width="1.4" stroke-linejoin="round" transform="rotate(${v.headingDeg ?? 0} 12 12)"/>`
    : `<circle cx="12" cy="12" r="6.4" fill="${colour}" stroke="${outline}" stroke-width="2"/>`;

  return L.divIcon({
    className: 'rvp-vehicle-marker',
    html: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${ring}${body}</svg>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function landmarkIcon(kind: 'factory' | 'destination', dark: boolean): L.DivIcon {
  const colour = kind === 'factory' ? (dark ? '#e2e8f0' : '#0f172a') : '#7c3aed';
  const outline = dark ? '#0b1220' : '#ffffff';
  const glyph = kind === 'factory' ? 'M4 20V9l8-5 8 5v11h-6v-6h-4v6z' : 'M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7m0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5';
  return L.divIcon({
    className: 'rvp-landmark-marker',
    html: `<svg width="26" height="26" viewBox="0 0 24 24"><path d="${glyph}" fill="${colour}" stroke="${outline}" stroke-width="1.2"/></svg>`,
    iconSize: [26, 26],
    iconAnchor: [13, kind === 'factory' ? 13 : 24],
  });
}

export function VehicleMap({ vehicles, selected, onSelect, trail, landmarks, fitKey, className }: VehicleMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const landmarkLayerRef = useRef<L.LayerGroup | null>(null);
  const trailLayerRef = useRef<L.LayerGroup | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === 'dark';

  // Create once. Leaflet owns this DOM node for the life of the component.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: [19, 76],
      zoom: 6,
      zoomControl: true,
      attributionControl: true,
      // The page scrolls; grabbing the wheel inside the map makes it a trap.
      scrollWheelZoom: false,
    });
    map.on('click', () => undefined);
    tileRef.current = L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map);
    landmarkLayerRef.current = L.layerGroup().addTo(map);
    trailLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // Leaflet measures the container on creation; inside a dialog or a grid
    // that has not settled it measures zero and renders a grey box.
    const settle = setTimeout(() => map.invalidateSize(), 60);
    return () => {
      clearTimeout(settle);
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dark theme: invert and re-rotate the hue of the tile layer only, so the
  // map greys down with the app while the markers and the trail - which are
  // SVG siblings, not tiles - keep their real colours.
  useEffect(() => {
    const container = tileRef.current?.getContainer();
    if (!container) return;
    container.style.filter = dark
      ? 'invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.92) saturate(0.75)'
      : '';
  }, [dark]);

  // The pane this map sits in changes width when the nav sidebar collapses or
  // a dialog opens. Leaflet only measures on demand, so without this the map
  // keeps the old width and leaves a grey band where tiles should be.
  useEffect(() => {
    const node = containerRef.current;
    const map = mapRef.current;
    if (!node || !map || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Markers: add, move, remove - never a full rebuild, so the map does not
  // flicker on every poll.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const live = new Set<string>();

    for (const v of vehicles) {
      if (v.latitude === null || v.longitude === null) continue;
      live.add(v.vehicleNumber);
      const isSelected = v.vehicleNumber === selected;
      const label = `${v.vehicleLabel}${v.speedKmph ? ` - ${Math.round(v.speedKmph)} km/h` : ''}${v.subtitle ? `<br/>${v.subtitle}` : ''}`;
      const existing = markersRef.current.get(v.vehicleNumber);
      if (existing) {
        existing.setLatLng([v.latitude, v.longitude]);
        existing.setIcon(vehicleIcon(v, isSelected, dark));
        existing.setZIndexOffset(isSelected ? 1000 : 0);
        existing.setTooltipContent(label);
      } else {
        const marker = L.marker([v.latitude, v.longitude], {
          icon: vehicleIcon(v, isSelected, dark),
          zIndexOffset: isSelected ? 1000 : 0,
        })
          .bindTooltip(label, { direction: 'top', offset: [0, -12] })
          .on('click', () => onSelectRef.current?.(v.vehicleNumber))
          .addTo(map);
        markersRef.current.set(v.vehicleNumber, marker);
      }
    }

    for (const [plate, marker] of markersRef.current) {
      if (!live.has(plate)) {
        marker.remove();
        markersRef.current.delete(plate);
      }
    }
  }, [vehicles, selected, dark]);

  // Landmarks.
  useEffect(() => {
    const layer = landmarkLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    for (const l of landmarks ?? []) {
      L.marker([l.latitude, l.longitude], { icon: landmarkIcon(l.kind, dark) })
        .bindTooltip(l.name, { direction: 'top', offset: [0, -20] })
        .addTo(layer);
    }
  }, [landmarks, dark]);

  // The trail, drawn as a casing plus a coloured line so it stays readable on
  // both tile themes, with a hollow marker at the start of the journey.
  useEffect(() => {
    const layer = trailLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    const points = (trail ?? []).filter((p) => p.latitude !== null && p.longitude !== null);
    if (points.length < 2) return;
    const latlngs = points.map((p) => [p.latitude, p.longitude] as [number, number]);
    L.polyline(latlngs, { color: dark ? '#0f172a' : '#ffffff', weight: 7, opacity: 0.65 }).addTo(layer);
    L.polyline(latlngs, { color: '#2563eb', weight: 3.5, opacity: 0.95 }).addTo(layer);
    L.circleMarker(latlngs[0], {
      radius: 5, color: '#2563eb', weight: 2, fillColor: dark ? '#0f172a' : '#ffffff', fillOpacity: 1,
    })
      .bindTooltip('Start of this trail', { direction: 'top' })
      .addTo(layer);
  }, [trail, dark]);

  // Fit the view. Keyed rather than run on every data change, so the map does
  // not yank itself back while someone is panning around looking at a lorry.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.invalidateSize();

    const bounds = L.latLngBounds([]);
    for (const p of trail ?? []) bounds.extend([p.latitude, p.longitude]);
    if ((trail?.length ?? 0) === 0) {
      for (const v of vehicles) {
        if (v.latitude === null || v.longitude === null) continue;
        bounds.extend([v.latitude, v.longitude]);
      }
    }
    for (const l of landmarks ?? []) bounds.extend([l.latitude, l.longitude]);
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  // Centre on the lorry someone just picked, without changing the zoom they
  // have chosen.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selected) return;
    const marker = markersRef.current.get(selected);
    if (marker) map.panTo(marker.getLatLng(), { animate: true });
  }, [selected]);

  return <div ref={containerRef} className={className} role="application" aria-label="Vehicle map" />;
}
