<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import vSelect from "vue-select";
import "vue-select/dist/vue-select.css";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import * as turf from "@turf/turf";
import { db } from "../data/db";
import { trips, selectedTripId, refreshTrips } from "../state/tripSelection";
import { selectedVisitId } from "../state/visitSelection";

const tripData = ref(null);
const tripInfo = ref(null);
const locations = ref([]);
const visits = ref([]);

const visitForm = ref({
  name: "",
  dateTime: "",
  durationMin: "",
  radiusKm: "",
  note: "",
  targetSpecies: [],
  type: "birding",
});

const addingVisit = ref(false);
const nameNeedsUpdate = ref(false);

const mapContainer = ref(null);
let map = null;
let mapLoaded = false;
let locationPopup = null;
const locationPopupLocked = ref(false);
let visitPopup = null;
let selectedVisitMarker = null;
let radiusMarkers = [];
let nonBirdingMarkers = [];
const radiusBearings = [0, 90, 180, 270];
const isDraggingRadius = ref(false);
const previewRadiusKm = ref(null);
const isDraggingCenter = ref(false);
const previewCenter = ref(null);
const skipNextFocus = ref(false);
const importFileInput = ref(null);
const routeSegments = ref({});
const routeLoadingId = ref("");
let routeRequestId = 0;
const itineraryListRef = ref(null);
const itineraryBodyRef = ref(null);
const mapStyle = ref("mapbox://styles/mapbox/outdoors-v12");
const pendingMapState = ref(null);
const visitStatsTimers = new Map();
const isMobilePanelOpen = ref(false);
const itinerarySplitPercent = ref(60);
const isDraggingSplit = ref(false);
let geolocateControl = null;
const isSatellite = computed({
  get: () => mapStyle.value === "mapbox://styles/mapbox/satellite-streets-v12",
  set: (value) => {
    mapStyle.value = value
      ? "mapbox://styles/mapbox/satellite-streets-v12"
      : "mapbox://styles/mapbox/outdoors-v12";
  },
});

mapboxgl.accessToken = "pk.eyJ1IjoicmFmbnVzcyIsImEiOiIzMVE1dnc0In0.3FNMKIlQ_afYktqki-6m0g";

const getMapStateKey = (tripId) => (tripId ? `buildTripMapState:${tripId}` : "");

const normalizeMapStyle = (style) => {
  if (style === "mapbox://styles/mapbox/satellite-streets-v12") return style;
  if (style === "mapbox://styles/mapbox/outdoors-v12") return style;
  return "";
};

const loadSavedMapState = (tripId) => {
  const key = getMapStateKey(tripId);
  if (!key) return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const center = Array.isArray(parsed.center) ? parsed.center : null;
    if (!center || center.length !== 2) return null;
    const [lng, lat] = center.map((value) => Number(value));
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    const zoom = Number(parsed.zoom);
    const bearing = Number(parsed.bearing);
    const pitch = Number(parsed.pitch);
    const style = normalizeMapStyle(parsed.style);
    if (!Number.isFinite(zoom)) return null;
    return {
      style,
      center: [lng, lat],
      zoom,
      bearing: Number.isFinite(bearing) ? bearing : 0,
      pitch: Number.isFinite(pitch) ? pitch : 0,
    };
  } catch (error) {
    console.warn("Could not restore map state", error);
    return null;
  }
};

const saveMapState = () => {
  if (!map || !selectedTripId.value) return;
  const key = getMapStateKey(selectedTripId.value);
  if (!key) return;
  const center = map.getCenter();
  const payload = {
    style: mapStyle.value,
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  };
  localStorage.setItem(key, JSON.stringify(payload));
};

const selectedTrip = computed(
  () => trips.value.find((trip) => trip.id === selectedTripId.value) || null,
);
const selectedVisit = computed(
  () => visits.value.find((visit) => String(visit.id) === String(selectedVisitId.value)) || null,
);

const sortedVisits = computed(() => getSortedVisits());

const visitTypeOptions = [
  { value: "birding", label: "Birding", icon: "bi-feather" },
  { value: "accommodation", label: "Accommodation", icon: "bi-house-door" },
  { value: "waypoint", label: "Waypoint", icon: "bi-geo-alt" },
  { value: "food", label: "Food", icon: "bi-cup-hot" },
  { value: "airport", label: "Airport", icon: "bi-airplane" },
];

const getVisitType = (visit) => visit?.type || "birding";

const getVisitTypeIcon = (visit) => {
  const type = getVisitType(visit);
  return visitTypeOptions.find((item) => item.value === type)?.icon || "bi-geo-alt";
};

const getVisitTypeLabel = (visit) => {
  const type = getVisitType(visit);
  return visitTypeOptions.find((item) => item.value === type)?.label || "Stop";
};

const tripSpeciesOptions = computed(() => tripData.value?.speciesList || []);
const statsSourceUpdatedAt = computed(() => tripData.value?.updatedAt ?? null);

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const distanceKm = (a, b) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLat = lat2 - lat1;
  const dLon = toRad(b[0] - a[0]);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const hav = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(hav)));
};

const locationMeta = computed(() => {
  const base = locations.value || [];
  return base
    .map((location) => {
      const lon = toNumber(location.longitude, NaN);
      const lat = toNumber(location.latitude, NaN);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      const entries = Array.isArray(location.species_checklist_counts)
        ? location.species_checklist_counts
        : [];
      return {
        lon,
        lat,
        checklistCount: toNumber(location.checklist_count, 0),
        speciesEntries: entries,
      };
    })
    .filter(Boolean);
});

const selectedVisitStats = computed(() => {
  const visit = selectedVisit.value;
  if (!visit || getVisitType(visit) !== "birding") {
    return { species: 0, checklists: 0, locations: 0 };
  }
  const center = [visit.longitude, visit.latitude];
  const radiusKm = Number(visit.radiusKm) || 0;
  const speciesSet = new Set();
  let checklistTotal = 0;
  let locationCount = 0;

  locations.value.forEach((location) => {
    const distanceKm = turf.distance(center, [location.longitude, location.latitude], {
      units: "kilometers",
    });
    if (distanceKm <= radiusKm) {
      locationCount += 1;
      checklistTotal += location.checklist_count || 0;
      const entries = location.species_checklist_counts || [];
      for (const [code] of entries) {
        speciesSet.add(code);
      }
    }
  });

  return {
    species: speciesSet.size,
    checklists: checklistTotal,
    locations: locationCount,
  };
});

const buildVisitStats = (visit) => {
  const effort = Math.max(0, toNumber(visit?.durationMin, 1));
  if (!visit || getVisitType(visit) !== "birding") {
    return {
      statsChecklistCount: 0,
      statsLocationCount: 0,
      statsSpeciesCounts: {},
      statsEffort: effort,
      statsSourceUpdatedAt: statsSourceUpdatedAt.value,
      statsUpdatedAt: Date.now(),
    };
  }

  const radiusKm = Math.max(0, toNumber(visit.radiusKm, 0));
  const centerLon = toNumber(visit.longitude, NaN);
  const centerLat = toNumber(visit.latitude, NaN);
  if (!Number.isFinite(centerLon) || !Number.isFinite(centerLat) || radiusKm <= 0) {
    return {
      statsChecklistCount: 0,
      statsLocationCount: 0,
      statsSpeciesCounts: {},
      statsEffort: effort,
      statsSourceUpdatedAt: statsSourceUpdatedAt.value,
      statsUpdatedAt: Date.now(),
    };
  }

  const latRange = radiusKm / 111;
  const centerLatRad = (centerLat * Math.PI) / 180;
  const cosLat = Math.cos(centerLatRad);
  const lonRange = radiusKm / (111 * Math.max(cosLat, 0.2));
  const speciesCounts = {};
  let checklistCount = 0;
  let locationCount = 0;

  locationMeta.value.forEach((location) => {
    const locLon = location.lon;
    const locLat = location.lat;
    if (Math.abs(locLat - centerLat) > latRange) return;
    if (Math.abs(locLon - centerLon) > lonRange) return;
    if (distanceKm([centerLon, centerLat], [locLon, locLat]) > radiusKm) return;

    locationCount += 1;
    checklistCount += location.checklistCount;
    location.speciesEntries.forEach(([code, count]) => {
      const safeCount = toNumber(count, 0);
      if (!code) return;
      speciesCounts[code] = (speciesCounts[code] || 0) + safeCount;
    });
  });

  return {
    statsChecklistCount: checklistCount,
    statsLocationCount: locationCount,
    statsSpeciesCounts: speciesCounts,
    statsEffort: effort,
    statsSourceUpdatedAt: statsSourceUpdatedAt.value,
    statsUpdatedAt: Date.now(),
  };
};

const hasStatRelevantChange = (current, updates) => {
  if (!current || !updates) return false;
  if (Object.prototype.hasOwnProperty.call(updates, "type")) {
    if ((updates.type || "birding") !== getVisitType(current)) return true;
  }
  if (Object.prototype.hasOwnProperty.call(updates, "latitude")) {
    if (Number(updates.latitude) !== Number(current.latitude)) return true;
  }
  if (Object.prototype.hasOwnProperty.call(updates, "longitude")) {
    if (Number(updates.longitude) !== Number(current.longitude)) return true;
  }
  if (Object.prototype.hasOwnProperty.call(updates, "radiusKm")) {
    if (Number(updates.radiusKm) !== Number(current.radiusKm)) return true;
  }
  if (Object.prototype.hasOwnProperty.call(updates, "durationMin")) {
    if (Number(updates.durationMin) !== Number(current.durationMin)) return true;
  }
  return false;
};

const scheduleVisitStats = (visitId) => {
  if (!visitId) return;
  const key = String(visitId);
  if (visitStatsTimers.has(key)) {
    clearTimeout(visitStatsTimers.get(key));
  }
  const timer = setTimeout(async () => {
    visitStatsTimers.delete(key);
    const visit = visits.value.find((item) => String(item.id) === key);
    if (!visit) return;
    if (!statsSourceUpdatedAt.value) return;
    const stats = buildVisitStats(visit);
    await applyVisitUpdates(visit.id, stats, { skipStats: true });
  }, 600);
  visitStatsTimers.set(key, timer);
};

const queueMissingVisitStats = () => {
  if (!statsSourceUpdatedAt.value) return;
  visits.value.forEach((visit) => {
    const hasCounts =
      visit.statsSpeciesCounts &&
      typeof visit.statsSpeciesCounts === "object" &&
      Object.keys(visit.statsSpeciesCounts).length >= 0;
    const isFresh = visit.statsSourceUpdatedAt === statsSourceUpdatedAt.value;
    if (!hasCounts || !isFresh) {
      scheduleVisitStats(visit.id);
    }
  });
};

const formatVisitDate = (value) => {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No date";
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

const formatVisitTime = (value) => {
  if (!value) return "No time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No time";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
};

const escapeHtml = (value) => {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const groupedVisits = computed(() => {
  const groups = [];
  const byDate = new Map();
  sortedVisits.value.forEach((visit, index) => {
    const dateKey = formatVisitDate(visit.dateTime);
    if (!byDate.has(dateKey)) {
      const group = { dateKey, visits: [] };
      byDate.set(dateKey, group);
      groups.push(group);
    }
    byDate.get(dateKey).visits.push({ ...visit, globalIndex: index });
  });
  return groups;
});

const formatDateTimeLocal = (date) => {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
};

const getNextVisitDateTime = () => {
  const selectedDate = selectedVisit.value?.dateTime
    ? new Date(selectedVisit.value.dateTime)
    : null;
  const hasSelectedDate = selectedDate && !Number.isNaN(selectedDate.getTime());
  const validDates = visits.value
    .map((visit) => new Date(visit.dateTime))
    .filter((date) => !Number.isNaN(date.getTime()));

  if (hasSelectedDate) {
    const afterDates = validDates.filter((date) => date > selectedDate).sort((a, b) => a - b);
    if (afterDates.length > 0) {
      const midpoint = new Date((selectedDate.getTime() + afterDates[0].getTime()) / 2);
      return formatDateTimeLocal(midpoint);
    }
    const nextDay = new Date(selectedDate);
    nextDay.setDate(nextDay.getDate() + 1);
    return formatDateTimeLocal(nextDay);
  }

  if (validDates.length === 0) {
    return formatDateTimeLocal(new Date());
  }
  const latest = new Date(Math.max(...validDates.map((date) => date.getTime())));
  latest.setDate(latest.getDate() + 1);
  return formatDateTimeLocal(latest);
};

const getVisitName = (center, radiusKm) => {
  if (!locations.value.length) return "New visit";
  const localityCounts = new Map();
  let hotspotBest = null;
  locations.value.forEach((location) => {
    const distanceKm = turf.distance(center, [location.longitude, location.latitude], {
      units: "kilometers",
    });
    if (distanceKm > radiusKm) return;
    const localityName = location.locality || "Unknown location";
    localityCounts.set(
      localityName,
      (localityCounts.get(localityName) || 0) + (location.checklist_count || 0),
    );
    if (location.locality_hotspot && location.locality_id) {
      if (!hotspotBest || (location.checklist_count || 0) > hotspotBest.count) {
        hotspotBest = {
          name: localityName,
          count: location.checklist_count || 0,
        };
      }
    }
  });
  if (hotspotBest?.name) return hotspotBest.name;
  let topName = "New visit";
  let topCount = -1;
  localityCounts.forEach((count, name) => {
    if (count > topCount) {
      topCount = count;
      topName = name;
    }
  });
  return topName;
};

const getSortedVisits = (fallbackDate) => {
  const fallback = fallbackDate ? new Date(fallbackDate) : new Date(0);
  return [...visits.value].sort((a, b) => {
    const dateA = new Date(a.dateTime || fallback);
    const dateB = new Date(b.dateTime || fallback);
    return dateA - dateB;
  });
};

const updateMapCursor = () => {
  if (!map) return;
  if (addingVisit.value) {
    map.getCanvas().style.cursor = "crosshair";
    return;
  }
  map.getCanvas().style.cursor = "";
};

const refreshRouteSource = () => {
  if (!map || !mapLoaded) return;
  const source = map.getSource("visit-route");
  if (!source) return;
  const features = Object.entries(routeSegments.value)
    .filter(([, segment]) => segment?.geometry)
    .map(([visitId, segment]) => ({
      type: "Feature",
      geometry: segment.geometry,
      properties: { visitId },
    }));
  source.setData({
    type: "FeatureCollection",
    features,
  });
  updateMapData();
};

const handleTripLocationsEnter = (event) => {
  if (!map) return;
  map.getCanvas().style.cursor = "pointer";
  if (!event.features?.length) return;
  const feature = event.features[0];
  const { locality, species_count, checklist_count, locality_id } = feature.properties;
  const coords = feature.geometry.coordinates.slice();
  const location = locations.value.find((item) => String(item.locality_id) === String(locality_id));
  const locationUrl = getEbirdLocationUrl(location);
  const googleMapsUrl = getGoogleMapsUrl(location);
  const checklistTotal =
    location?.checklist?.length ??
    (location?.checklist_count_complete !== undefined ||
    location?.checklist_count_incomplete !== undefined
      ? (location?.checklist_count_complete ?? 0) +
        (location?.checklist_count_incomplete ?? 0)
      : undefined) ??
    checklist_count ??
    0;
  const checklistLinks = (location?.checklist || [])
    .map((entry) => entry?.checklist_id)
    .filter(Boolean)
    .slice(0, 10)
    .map((checklistId) => {
      const url = getEbirdChecklistUrl(checklistId);
      return url
        ? `<a href="${url}" target="_blank" rel="noopener">${checklistId}</a>`
        : checklistId;
    });
  if (!locationPopup) {
    locationPopup = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
    });
  }
  locationPopup
    .setLngLat(coords)
    .setHTML(
      `<div><strong>${
        locationUrl
          ? `<a href="${locationUrl}" target="_blank" rel="noopener">${locality}</a>`
          : locality
      }${
        googleMapsUrl
          ? ` <a href="${googleMapsUrl}" target="_blank" rel="noopener" class="ms-1 text-decoration-none" title="Open in Google Maps"><i class="bi bi-geo-alt"></i></a>`
          : ""
      }</strong></div>` +
        `<div>${species_count} species · ${checklistTotal} checklists</div>` +
        (checklistLinks.length
          ? `<div class="mt-1"><strong>Checklists</strong><div>${checklistLinks.join(
              "<br />",
            )}</div></div>`
          : ""),
    )
    .addTo(map);
};

const handleTripLocationsLeave = () => {
  if (locationPopupLocked.value) return;
  if (locationPopup) {
    locationPopup.remove();
  }
  updateMapCursor();
};

const handleTripLocationsClick = (event) => {
  if (!map) return;
  if (!event.features?.length) return;
  handleTripLocationsEnter(event);
  locationPopupLocked.value = true;
  if (locationPopup) {
    locationPopup.addClassName("is-pinned");
    const popupElement = locationPopup.getElement();
    if (popupElement) {
      const clearLock = () => {
        locationPopupLocked.value = false;
        locationPopup.remove();
      };
      popupElement.querySelector(".mapboxgl-popup-content")?.addEventListener("click", (event) => {
        const target = event.target;
        if (target && target.tagName === "A") return;
        clearLock();
      });
    }
  }
};

const handleVisitsEnter = () => {
  if (!map) return;
  map.getCanvas().style.cursor = "pointer";
};

const handleVisitsLeave = () => {
  updateMapCursor();
};

const handleVisitsClick = (event) => {
  if (addingVisit.value) return;
  if (!event.features.length) return;
  const feature = event.features[0];
  const visitId = feature.properties.id;
  skipNextFocus.value = true;
  selectedVisitId.value = visitId;
  const visit = visits.value.find((item) => String(item.id) === String(visitId));
  if (visit && getVisitType(visit) !== "birding") {
    if (!visitPopup) {
      visitPopup = new mapboxgl.Popup({
        closeButton: true,
        closeOnClick: false,
        offset: 12,
      });
    }
    const dateTime = visit.dateTime
      ? formatVisitDate(visit.dateTime) + " " + formatVisitTime(visit.dateTime)
      : "No date";
    const note = visit.note ? escapeHtml(visit.note) : "No notes";
    visitPopup
      .setLngLat(feature.geometry.coordinates.slice())
      .setHTML(
        `<div><strong>${escapeHtml(visit.name || "Stop")}</strong></div>` +
          `<div class="text-muted small">${escapeHtml(dateTime)}</div>` +
          `<div class="mt-1">${note}</div>`,
      )
      .addTo(map);
  } else if (visitPopup) {
    visitPopup.remove();
    visitPopup = null;
  }
};

const handleMapClickClosePopup = (event) => {
  if (!locationPopupLocked.value) return;
  const isLocationFeature = map.queryRenderedFeatures(event.point, {
    layers: ["trip-locations-circle"],
  }).length;
  const isPopup = event.originalEvent?.target?.closest?.(".mapboxgl-popup");
  if (!isLocationFeature && !isPopup) {
    locationPopupLocked.value = false;
    locationPopup?.remove();
  }
};

const formatDistance = (meters) => {
  const km = Math.round((meters || 0) / 1000);
  if (km < 1) return "0 km";
  return `${km} km`;
};

const formatDuration = (seconds) => {
  const minutes = Math.round((seconds || 0) / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return `${hours}h ${rem}m`;
};

const getEbirdChecklistUrl = (checklistId) => {
  if (!checklistId) return "";
  return `https://ebird.org/checklist/${checklistId}`;
};

const getEbirdLocationUrl = (location) => {
  const localityId = location?.locality_id;
  if (!localityId || !location?.locality_hotspot) return "";
  return `https://ebird.org/hotspot/${localityId}`;
};

const getGoogleMapsUrl = (location) => {
  const lat = Number(location?.latitude);
  const lon = Number(location?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "";
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
};

const formatRouteSummary = (distanceM, durationS) => {
  if (!distanceM && !durationS) return "Route available";
  const parts = [];
  if (durationS) {
    parts.push(formatDuration(durationS));
  }
  if (distanceM) {
    parts.push(formatDistance(distanceM));
  }
  if (!parts.length) return "Route available";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} (${parts[1]})`;
};

const getLegSummary = (visitId) => {
  return routeSegments.value[visitId]?.summary || "";
};

const computeRouteSegment = async (visitId) => {
  if (!map || !mapLoaded) return;
  const sorted = sortedVisits.value;
  const index = sorted.findIndex((visit) => String(visit.id) === String(visitId));
  if (index <= 0) {
    window.alert("Select a visit that has a previous stop to compute a route segment.");
    return;
  }
  const from = sorted[index - 1];
  const to = sorted[index];
  if (
    !Number.isFinite(from.longitude) ||
    !Number.isFinite(from.latitude) ||
    !Number.isFinite(to.longitude) ||
    !Number.isFinite(to.latitude)
  ) {
    window.alert("Route segment requires valid coordinates for both visits.");
    return;
  }

  const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
  const requestId = ++routeRequestId;
  routeLoadingId.value = String(visitId);
  try {
    const url =
      `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}` +
      `?geometries=geojson&overview=full&steps=true&annotations=distance,duration` +
      `&continue_straight=false` +
      `&access_token=${mapboxgl.accessToken}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Directions request failed: ${response.status}`);
    const data = await response.json();
    if (requestId !== routeRequestId) return;
    const route = data?.routes?.[0];
    if (!route) {
      throw new Error(data?.message || "No route found");
    }
    const leg = route.legs?.[0];
    const distanceM = Number(route.distance ?? leg?.distance ?? 0);
    const durationS = Number(route.duration ?? leg?.duration ?? 0);
    const summary = formatRouteSummary(distanceM, durationS);
    routeSegments.value = {
      ...routeSegments.value,
      [visitId]: { summary, geometry: route.geometry || null },
    };
    await applyVisitUpdates(visitId, {
      routeGeometry: route.geometry || null,
      routeDistanceM: distanceM,
      routeDurationS: durationS,
      updatedAt: Date.now(),
    });
    refreshRouteSource();
  } catch (error) {
    console.warn("Directions API error, route unavailable.", error);
    if (requestId !== routeRequestId) return;
    if (!routeSegments.value[visitId]?.geometry) {
      const summary = "Route unavailable";
      routeSegments.value = {
        ...routeSegments.value,
        [visitId]: { summary, geometry: null },
      };
      refreshRouteSource();
    }
  } finally {
    if (requestId === routeRequestId) {
      routeLoadingId.value = "";
    }
  }
};

const clearRouteForVisits = async (visitIds) => {
  const ids = [...new Set(visitIds.map((id) => String(id)).filter(Boolean))];
  if (!ids.length) return;
  const existingIds = visits.value
    .filter((visit) => ids.includes(String(visit.id)))
    .map((visit) => String(visit.id));
  if (existingIds.length) {
    const updatedAt = Date.now();
    await Promise.all(
      existingIds.map((id) =>
        applyVisitUpdates(id, {
          routeGeometry: null,
          routeDistanceM: 0,
          routeDurationS: 0,
          updatedAt,
        }),
      ),
    );
  }
  const nextSegments = { ...routeSegments.value };
  ids.forEach((id) => {
    delete nextSegments[id];
  });
  routeSegments.value = nextSegments;
  refreshRouteSource();
};

const clearVisitMarkers = () => {
  if (selectedVisitMarker) {
    selectedVisitMarker.remove();
    selectedVisitMarker = null;
  }
  if (radiusMarkers.length) {
    radiusMarkers.forEach((marker) => marker.remove());
    radiusMarkers = [];
  }
  isDraggingRadius.value = false;
  previewRadiusKm.value = null;
  isDraggingCenter.value = false;
  previewCenter.value = null;
};

const getEffectiveRadiusKm = (visit) => {
  if (
    isDraggingRadius.value &&
    String(visit.id) === String(selectedVisitId.value) &&
    previewRadiusKm.value
  ) {
    return previewRadiusKm.value;
  }
  return Number(visit.radiusKm) || 0.1;
};

const getEffectiveCenter = (visit) => {
  if (
    isDraggingCenter.value &&
    String(visit.id) === String(selectedVisitId.value) &&
    previewCenter.value
  ) {
    return previewCenter.value;
  }
  return [visit.longitude, visit.latitude];
};

const updateRadiusHandlePositions = (center, radiusKm, skipIndex = null) => {
  radiusBearings.forEach((bearing, index) => {
    if (skipIndex !== null && index === skipIndex) return;
    const handlePoint = turf.destination(center, radiusKm, bearing, { units: "kilometers" });
    const handleCoords = handlePoint.geometry.coordinates;
    const marker = radiusMarkers[index];
    if (marker) {
      marker.setLngLat(handleCoords);
    }
  });
};

const updateVisitMarkers = () => {
  if (!map || !mapLoaded) return;
  const visit = selectedVisit.value;
  if (!visit) {
    clearVisitMarkers();
    return;
  }

  const center = getEffectiveCenter(visit);
  const radiusKm = getEffectiveRadiusKm(visit);

  if (!selectedVisitMarker) {
    const centerEl = document.createElement("div");
    centerEl.className = "visit-center-handle";
    centerEl.style.pointerEvents = "auto";
    centerEl.style.cursor = "move";
    centerEl.style.touchAction = "none";
    selectedVisitMarker = new mapboxgl.Marker({ element: centerEl, draggable: true })
      .setLngLat(center)
      .addTo(map);
    selectedVisitMarker.on("dragstart", () => {
      map.dragPan.disable();
      isDraggingCenter.value = true;
      previewCenter.value = [center[0], center[1]];
    });
    selectedVisitMarker.on("drag", () => {
      const { lng, lat } = selectedVisitMarker.getLngLat();
      previewCenter.value = [lng, lat];
      updateMapData();
      const currentVisit = selectedVisit.value || visit;
      const currentRadius = getEffectiveRadiusKm(currentVisit);
      updateRadiusHandlePositions([lng, lat], currentRadius);
    });
    selectedVisitMarker.on("dragend", async () => {
      map.dragPan.enable();
      const { lng, lat } = selectedVisitMarker.getLngLat();
      isDraggingCenter.value = false;
      previewCenter.value = null;
      const updates = {
        latitude: lat,
        longitude: lng,
        updatedAt: Date.now(),
      };
      await applyVisitUpdates(visit.id, updates, { syncForm: true });
      nameNeedsUpdate.value = true;
    });
  } else {
    selectedVisitMarker.setLngLat(center);
  }

  if (getVisitType(visit) !== "birding") {
    if (radiusMarkers.length) {
      radiusMarkers.forEach((marker) => marker.remove());
      radiusMarkers = [];
    }
    return;
  }

  if (!radiusMarkers.length) {
    radiusMarkers = radiusBearings.map((bearing, index) => {
      const handleEl = document.createElement("div");
      handleEl.className = "radius-handle";
      handleEl.style.pointerEvents = "auto";
      handleEl.style.cursor = bearing === 0 || bearing === 180 ? "ns-resize" : "ew-resize";
      handleEl.style.touchAction = "none";
      const marker = new mapboxgl.Marker({ element: handleEl, draggable: true })
        .setLngLat(center)
        .addTo(map);

      marker.on("dragstart", () => {
        map.dragPan.disable();
        isDraggingRadius.value = true;
        previewRadiusKm.value = radiusKm;
      });

      marker.on("drag", () => {
        const { lng, lat } = marker.getLngLat();
        const currentVisit = selectedVisit.value || visit;
        const currentCenter = getEffectiveCenter(currentVisit);
        const newRadius = turf.distance(currentCenter, [lng, lat], {
          units: "kilometers",
        });
        const safeRadius = Math.max(newRadius, 0.1);
        previewRadiusKm.value = safeRadius;
        updateMapData();
        updateRadiusHandlePositions(currentCenter, safeRadius, index);
      });

      marker.on("dragend", async () => {
        map.dragPan.enable();
        const { lng, lat } = marker.getLngLat();
        const currentVisit = selectedVisit.value || visit;
        const currentCenter = getEffectiveCenter(currentVisit);
        const newRadius = turf.distance(currentCenter, [lng, lat], {
          units: "kilometers",
        });
        const safeRadius = Math.max(newRadius, 0.1);
        previewRadiusKm.value = null;
        isDraggingRadius.value = false;
        const updates = {
          radiusKm: safeRadius,
          updatedAt: Date.now(),
        };
        await applyVisitUpdates(visit.id, updates, { syncForm: true });
        nameNeedsUpdate.value = true;
      });

      return marker;
    });
  }

  updateRadiusHandlePositions(center, radiusKm);
  updateNonBirdingMarkers();
};

const clearNonBirdingMarkers = () => {
  if (nonBirdingMarkers.length) {
    nonBirdingMarkers.forEach((marker) => marker.remove());
    nonBirdingMarkers = [];
  }
};

const updateNonBirdingMarkers = () => {
  if (!map || !mapLoaded) return;
  clearNonBirdingMarkers();
  const markers = visits.value
    .filter((visit) => getVisitType(visit) !== "birding")
    .map((visit) => {
      const el = document.createElement("div");
      el.className = "visit-type-marker";
      const iconClass = getVisitTypeIcon(visit);
      el.innerHTML = `<i class="bi ${iconClass}"></i>`;
      el.title = `${getVisitTypeLabel(visit)} · ${visit.name || "Stop"}`;
      return new mapboxgl.Marker({ element: el, anchor: "bottom" })
        .setLngLat([visit.longitude, visit.latitude])
        .addTo(map);
    });
  nonBirdingMarkers = markers;
};

const loadVisits = async (tripId) => {
  if (!tripId) {
    visits.value = [];
    selectedVisitId.value = "";
    routeSegments.value = {};
    refreshRouteSource();
    return;
  }
  visits.value = await db.visits.where("tripId").equals(tripId).toArray();
  if (visits.value.length > 0) {
    const exists = visits.value.some((visit) => String(visit.id) === String(selectedVisitId.value));
    if (!exists) {
      selectedVisitId.value = visits.value[0].id;
    }
  } else {
    selectedVisitId.value = "";
  }
  routeSegments.value = visits.value.reduce((segments, visit) => {
    if (visit.routeGeometry) {
      segments[visit.id] = {
        summary: formatRouteSummary(visit.routeDistanceM, visit.routeDurationS),
        geometry: visit.routeGeometry,
      };
    }
    return segments;
  }, {});
  refreshRouteSource();
  syncVisitForm();
  scrollToSelectedVisit();
  queueMissingVisitStats();
};

const loadTripData = async (tripId) => {
  if (!tripId) {
    resetAddMode();
    tripData.value = null;
    tripInfo.value = null;
    locations.value = [];
    await loadVisits("");
    updateMapData();
    return;
  }
  resetAddMode();
  tripInfo.value = await db.trips.get(tripId);
  tripData.value = await db.ebd.where("tripId").equals(tripId).first();
  locations.value = tripData.value?.locations || [];
  await loadVisits(tripId);
  await nextTick();
  updateMapData();
  fitMapToLocations();
};

const syncVisitForm = () => {
  const visit = selectedVisit.value;
  if (!visit) {
    visitForm.value = {
      name: "",
      dateTime: "",
      durationMin: "",
      radiusKm: "",
      note: "",
      targetSpecies: [],
      type: "birding",
    };
    return;
  }
  visitForm.value = {
    name: visit.name || "",
    dateTime: visit.dateTime || "",
    durationMin: visit.durationMin ?? "",
    radiusKm: visit.radiusKm ?? "",
    note: visit.note || "",
    targetSpecies: Array.isArray(visit.targetSpecies) ? [...visit.targetSpecies] : [],
    type: getVisitType(visit),
  };
};

const applyVisitUpdates = async (visitId, updates, options = {}) => {
  const index = visits.value.findIndex((item) => String(item.id) === String(visitId));
  const current = index >= 0 ? visits.value[index] : null;
  const needsStats = !options.skipStats && hasStatRelevantChange(current, updates);
  await db.visits.update(visitId, updates);
  if (index >= 0) {
    visits.value[index] = { ...visits.value[index], ...updates };
  }
  if (options.syncForm) {
    syncVisitForm();
  }
  if (needsStats) {
    scheduleVisitStats(visitId);
  }
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const updateSplitFromPointer = (clientY) => {
  const body = itineraryBodyRef.value;
  if (!body) return;
  const rect = body.getBoundingClientRect();
  if (!rect.height) return;
  const minTop = 180;
  const minBottom = 200;
  const maxTop = Math.max(minTop, rect.height - minBottom);
  const nextTop = clamp(clientY - rect.top, minTop, maxTop);
  const nextPercent = (nextTop / rect.height) * 100;
  itinerarySplitPercent.value = Math.round(nextPercent * 10) / 10;
};

const startSplitDrag = (event) => {
  if (!selectedVisit.value) return;
  event.preventDefault();
  isDraggingSplit.value = true;
  updateSplitFromPointer(event.clientY);

  const handleMove = (moveEvent) => {
    updateSplitFromPointer(moveEvent.clientY);
  };
  const handleUp = () => {
    isDraggingSplit.value = false;
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
  };
  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp);
};

const itinerarySplitStyle = computed(() => {
  if (!selectedVisit.value) return {};
  return { "--itinerary-split": `${itinerarySplitPercent.value}%` };
});

const openMobilePanel = () => {
  isMobilePanelOpen.value = true;
};

const closeMobilePanel = () => {
  isMobilePanelOpen.value = false;
};

const saveVisitDetails = async () => {
  const visit = selectedVisit.value;
  if (!visit) return;
  const updates = {
    name: visitForm.value.name || "Untitled visit",
    dateTime: visitForm.value.dateTime || "",
    durationMin: visitForm.value.durationMin === "" ? 0 : Number(visitForm.value.durationMin),
    radiusKm: visitForm.value.radiusKm === "" ? visit.radiusKm : Number(visitForm.value.radiusKm),
    note: visitForm.value.note || "",
    targetSpecies: Array.isArray(visitForm.value.targetSpecies)
      ? [...visitForm.value.targetSpecies]
      : [],
    type: visitForm.value.type || "birding",
    updatedAt: Date.now(),
  };
  await applyVisitUpdates(visit.id, updates);
};

const saveTargetSpecies = async () => {
  const visit = selectedVisit.value;
  if (!visit) return;
  const updates = {
    targetSpecies: Array.isArray(visitForm.value.targetSpecies)
      ? [...visitForm.value.targetSpecies]
      : [],
    updatedAt: Date.now(),
  };
  await applyVisitUpdates(visit.id, updates);
};

const buildVisitGeoJson = () => {
  const sorted = getSortedVisits();
  const visitFeatures = sorted.map((visit, index) => ({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [Number(visit.longitude), Number(visit.latitude)],
    },
    properties: {
      kind: "visit",
      order: index + 1,
      name: visit.name || "",
      dateTime: visit.dateTime || "",
      durationMin: Number(visit.durationMin ?? 0),
      radiusKm: Number(visit.radiusKm ?? 0.1),
      note: visit.note || "",
      targetSpecies: Array.isArray(visit.targetSpecies) ? [...visit.targetSpecies] : [],
      type: getVisitType(visit),
      createdAt: Number(visit.createdAt ?? Date.now()),
      updatedAt: Number(visit.updatedAt ?? Date.now()),
    },
  }));
  const routeFeatures = sorted
    .map((visit, index) => {
      if (!visit.routeGeometry) return null;
      if (index === 0) return null;
      return {
        type: "Feature",
        geometry: visit.routeGeometry,
        properties: {
          kind: "route",
          fromOrder: index,
          toOrder: index + 1,
          distanceM: Number(visit.routeDistanceM ?? 0),
          durationS: Number(visit.routeDurationS ?? 0),
          summary: formatRouteSummary(visit.routeDistanceM, visit.routeDurationS),
        },
      };
    })
    .filter(Boolean);

  return {
    type: "FeatureCollection",
    properties: {
      version: 2,
      tripId: selectedTripId.value,
      exportedAt: new Date().toISOString(),
      kind: "visitExport",
    },
    features: [...visitFeatures, ...routeFeatures],
  };
};

const exportVisits = () => {
  if (!selectedTripId.value || !visits.value.length) return;
  const payload = buildVisitGeoJson();
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/geo+json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `trip-${selectedTripId.value}-visits.geojson`;
  anchor.click();
  URL.revokeObjectURL(url);
};

const isFiniteNumber = (value) => Number.isFinite(Number(value));

const normalizeGeoJsonVisits = (payload) => {
  if (!Array.isArray(payload.features)) return { error: "Missing features array." };
  const visitFeatures = payload.features.filter((feature) => feature?.geometry?.type === "Point");
  if (!visitFeatures.length) {
    return { error: "GeoJSON must include visit point features." };
  }
  const routeFeatures = payload.features.filter(
    (feature) => feature?.geometry?.type === "LineString",
  );
  const routesByOrder = new Map();
  routeFeatures.forEach((feature) => {
    const props = feature?.properties || {};
    const toOrder = Number(props.toOrder ?? props.order ?? props.toIndex ?? props.to);
    if (!Number.isFinite(toOrder)) return;
    routesByOrder.set(toOrder, {
      geometry: feature.geometry,
      distanceM: isFiniteNumber(props.distanceM) ? Number(props.distanceM) : 0,
      durationS: isFiniteNumber(props.durationS) ? Number(props.durationS) : 0,
    });
  });
  const parsedVisits = visitFeatures.map((feature, index) => {
    const coords = feature.geometry?.coordinates || [];
    const props = feature?.properties || {};
    return {
      order: isFiniteNumber(props.order) ? Number(props.order) : index + 1,
      name: typeof props.name === "string" ? props.name : "",
      dateTime: typeof props.dateTime === "string" ? props.dateTime : "",
      durationMin: isFiniteNumber(props.durationMin) ? Number(props.durationMin) : 0,
      radiusKm: isFiniteNumber(props.radiusKm) ? Number(props.radiusKm) : 0.1,
      note: typeof props.note === "string" ? props.note : "",
      targetSpecies: Array.isArray(props.targetSpecies)
        ? props.targetSpecies.filter(Boolean)
        : typeof props.targetSpecies === "string"
          ? props.targetSpecies
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean)
          : [],
      type: typeof props.type === "string" && props.type ? props.type : "birding",
      latitude: Number(coords[1]),
      longitude: Number(coords[0]),
      createdAt: isFiniteNumber(props.createdAt) ? Number(props.createdAt) : Date.now(),
      updatedAt: isFiniteNumber(props.updatedAt) ? Number(props.updatedAt) : Date.now(),
    };
  });
  for (const visit of parsedVisits) {
    if (!isFiniteNumber(visit.latitude) || !isFiniteNumber(visit.longitude)) {
      return { error: "Each visit must include numeric latitude and longitude." };
    }
    if (!isFiniteNumber(visit.radiusKm)) {
      return { error: "Each visit must include numeric radiusKm." };
    }
  }
  const sortedVisits = [...parsedVisits].sort((a, b) => a.order - b.order);
  const normalized = sortedVisits.map((visit) => {
    const route = routesByOrder.get(visit.order);
    return {
      name: visit.name,
      dateTime: visit.dateTime,
      durationMin: visit.durationMin,
      radiusKm: visit.radiusKm,
      note: visit.note,
      targetSpecies: Array.isArray(visit.targetSpecies) ? [...visit.targetSpecies] : [],
      type: visit.type || "birding",
      latitude: visit.latitude,
      longitude: visit.longitude,
      createdAt: visit.createdAt,
      updatedAt: visit.updatedAt,
      routeGeometry: route?.geometry || null,
      routeDistanceM: route?.distanceM || 0,
      routeDurationS: route?.durationS || 0,
    };
  });
  return {
    tripId: payload.properties?.tripId,
    visits: normalized,
  };
};

const normalizeVisitImport = (payload) => {
  if (!payload || typeof payload !== "object") {
    return { error: "File is not a JSON object." };
  }
  if (payload.type === "FeatureCollection") {
    return normalizeGeoJsonVisits(payload);
  }
  return { error: "Unsupported visits file format. Please import a GeoJSON file." };
};

const importVisits = () => {
  if (!selectedTripId.value) return;
  importFileInput.value?.click();
};

const handleVisitImport = async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  event.target.value = "";
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch (error) {
    window.alert("Could not parse JSON file.");
    return;
  }
  const normalized = normalizeVisitImport(payload);
  if (normalized.error) {
    window.alert(`Import failed: ${normalized.error}`);
    return;
  }
  if (normalized.tripId && String(normalized.tripId) !== String(selectedTripId.value)) {
    const proceed = window.confirm(
      "This file was exported from a different trip. Import into the current trip anyway?",
    );
    if (!proceed) return;
  }
  if (!selectedTripId.value) return;
  const confirmed = window.confirm(
    "Replace existing visits for this trip with the imported visits? This cannot be undone.",
  );
  if (!confirmed) return;
  const normalizedVisits = normalized.visits.map((visit) => ({
    tripId: selectedTripId.value,
    name: visit.name || "Untitled visit",
    dateTime: visit.dateTime || "",
    durationMin: Number(visit.durationMin ?? 0),
    radiusKm: Math.max(Number(visit.radiusKm ?? 0.1), 0.1),
    note: visit.note || "",
    targetSpecies: Array.isArray(visit.targetSpecies) ? [...visit.targetSpecies] : [],
    type: visit.type || "birding",
    latitude: Number(visit.latitude),
    longitude: Number(visit.longitude),
    createdAt: Number(visit.createdAt ?? Date.now()),
    updatedAt: Number(visit.updatedAt ?? Date.now()),
    routeGeometry: visit.routeGeometry || null,
    routeDistanceM: Number(visit.routeDistanceM ?? 0),
    routeDurationS: Number(visit.routeDurationS ?? 0),
  }));
  await db.visits.where("tripId").equals(selectedTripId.value).delete();
  if (normalizedVisits.length) {
    await db.visits.bulkAdd(normalizedVisits);
  }
  await loadVisits(selectedTripId.value);
  selectedVisitId.value = visits.value[0]?.id || "";
};

const updateVisitNameFromLocation = async () => {
  const visit = selectedVisit.value;
  if (!visit) return;
  const center = [visit.longitude, visit.latitude];
  const radiusKm = Number(visit.radiusKm) || 0.1;
  const newName = getVisitName(center, radiusKm);
  const updates = {
    name: newName,
    updatedAt: Date.now(),
  };
  await applyVisitUpdates(visit.id, updates, { syncForm: true });
  nameNeedsUpdate.value = false;
};

const handleNameInput = async () => {
  if (!selectedVisit.value) return;
  nameNeedsUpdate.value = false;
  await saveVisitDetails();
};

const deleteVisit = async () => {
  const visit = selectedVisit.value;
  if (!visit) return;
  const sorted = getSortedVisits();
  const currentIndex = sorted.findIndex((item) => String(item.id) === String(visit.id));
  const nextVisitId = currentIndex >= 0 ? sorted[currentIndex + 1]?.id || "" : "";
  const fallbackVisitId =
    currentIndex >= 0 ? sorted[currentIndex + 1]?.id || sorted[currentIndex - 1]?.id : "";
  const confirmed = window.confirm(`Delete ${visit.name || "this visit"}? This cannot be undone.`);
  if (!confirmed) return;
  await db.visits.delete(visit.id);
  visits.value = visits.value.filter((item) => String(item.id) !== String(visit.id));
  const remainingSorted = getSortedVisits();
  selectedVisitId.value = fallbackVisitId || remainingSorted[0]?.id || "";
  nameNeedsUpdate.value = false;
  await clearRouteForVisits([visit.id, nextVisitId]);
};

const focusOnVisit = () => {
  if (!map || !mapLoaded || !selectedVisit.value) return;
  map.flyTo({
    center: [selectedVisit.value.longitude, selectedVisit.value.latitude],
    zoom: 11,
  });
};

const scrollToSelectedVisit = () => {
  const visitId = selectedVisitId.value;
  if (!visitId) return;
  const tryScroll = () => {
    const container = itineraryListRef.value;
    if (!container) return;
    const selector = `[data-visit-id="${CSS.escape(String(visitId))}"]`;
    const activeItem = container.querySelector(selector);
    if (!activeItem) return;
    const containerRect = container.getBoundingClientRect();
    const itemRect = activeItem.getBoundingClientRect();
    const offsetTop = itemRect.top - containerRect.top + container.scrollTop;
    container.scrollTop = Math.max(0, offsetTop - 8);
  };
  nextTick(() => {
    requestAnimationFrame(() => {
      tryScroll();
      requestAnimationFrame(tryScroll);
    });
  });
};

const resetAddMode = () => {
  addingVisit.value = false;
  updateMapCursor();
};

const startAddVisit = () => {
  if (!selectedTripId.value) return;
  if (addingVisit.value) {
    resetAddMode();
    return;
  }
  addingVisit.value = true;
  updateMapCursor();
};

const handleMapClick = async (event) => {
  if (!selectedTripId.value) return;
  if (!addingVisit.value) {
    if (visitPopup) {
      visitPopup.remove();
      visitPopup = null;
    }
    return;
  }
  const { lng, lat } = event.lngLat;
  const fallbackRadius = selectedVisit.value?.radiusKm || visitForm.value.radiusKm || 2;
  const safeRadius = Math.max(Number(fallbackRadius) || 2, 0.1);
  const id = await db.visits.add({
    tripId: selectedTripId.value,
    name: getVisitName([lng, lat], safeRadius),
    latitude: lat,
    longitude: lng,
    radiusKm: safeRadius,
    dateTime: getNextVisitDateTime(),
    durationMin: 1,
    note: "",
    targetSpecies: [],
    type: "birding",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  resetAddMode();
  await loadVisits(selectedTripId.value);
  selectedVisitId.value = id;
  nameNeedsUpdate.value = false;
  scheduleVisitStats(id);
  const sorted = getSortedVisits();
  const newIndex = sorted.findIndex((visit) => String(visit.id) === String(id));
  const nextVisitId = newIndex >= 0 ? sorted[newIndex + 1]?.id || "" : "";
  await clearRouteForVisits([id, nextVisitId]);
};

const isEditableTarget = (target) => {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
};

const handleKeydown = (event) => {
  if (isEditableTarget(event.target)) return;
  const key = event.key?.toLowerCase();
  if (key === "a") {
    event.preventDefault();
    startAddVisit();
  }
  if (key === "d") {
    event.preventDefault();
    deleteVisit();
  }
};

const updateMapData = () => {
  if (!map || !mapLoaded) return;

  const locationFeatures = locations.value.map((location) => ({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [location.longitude, location.latitude],
    },
    properties: {
      locality: location.locality || "Unknown location",
      species_count: location.species_checklist_counts?.length || 0,
      checklist_count: location.checklist_count || 0,
      locality_id: location.locality_id || "",
      locality_hotspot: location.locality_hotspot === true,
    },
  }));

  const visitPointFeatures = visits.value.map((visit) => {
    const center = getEffectiveCenter(visit);
    return {
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: center,
      },
      properties: {
        id: visit.id,
        selected: String(visit.id) === String(selectedVisitId.value),
        type: getVisitType(visit),
        icon: getVisitTypeIcon(visit),
      },
    };
  });

  const visitAreaFeatures = visits.value
    .filter((visit) => getVisitType(visit) === "birding")
    .map((visit) => {
      const center = getEffectiveCenter(visit);
      return turf.circle(center, getEffectiveRadiusKm(visit), {
        units: "kilometers",
        steps: 64,
        properties: {
          id: visit.id,
          selected: String(visit.id) === String(selectedVisitId.value),
        },
      });
    });

  const sortedVisits = getSortedVisits();
  const pathPoints = sortedVisits
    .map((visit) => ({
      id: visit.id,
      center: getEffectiveCenter(visit),
    }))
    .filter((visit) => Number.isFinite(visit.center[0]) && Number.isFinite(visit.center[1]));
  const visitPathSegments = [];
  for (let i = 1; i < pathPoints.length; i += 1) {
    const from = pathPoints[i - 1];
    const to = pathPoints[i];
    const toId = String(to.id);
    const hasRoute = !!routeSegments.value[toId]?.geometry;
    visitPathSegments.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [from.center, to.center],
      },
      properties: {
        toId,
        hasRoute,
      },
    });
  }

  const locationsSource = map.getSource("trip-locations");
  if (locationsSource) {
    locationsSource.setData({
      type: "FeatureCollection",
      features: locationFeatures,
    });
  }

  const visitsSource = map.getSource("visits-points");
  if (visitsSource) {
    visitsSource.setData({
      type: "FeatureCollection",
      features: visitPointFeatures,
    });
  }

  const visitAreasSource = map.getSource("visit-areas");
  if (visitAreasSource) {
    visitAreasSource.setData({
      type: "FeatureCollection",
      features: visitAreaFeatures,
    });
  }

  const visitPathSource = map.getSource("visit-path");
  if (visitPathSource) {
    visitPathSource.setData({
      type: "FeatureCollection",
      features: visitPathSegments,
    });
  }

  updateNonBirdingMarkers();
};

const fitMapToLocations = () => {
  if (!map || !mapLoaded) return;
  const bounds = new mapboxgl.LngLatBounds();
  const locationsAdded = locations.value.reduce((count, location) => {
    const lon = Number(location.longitude);
    const lat = Number(location.latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return count;
    bounds.extend([lon, lat]);
    return count + 1;
  }, 0);
  if (locationsAdded === 0) {
    const visitsAdded = visits.value.reduce((count, visit) => {
      const lon = Number(visit.longitude);
      const lat = Number(visit.latitude);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return count;
      bounds.extend([lon, lat]);
      return count + 1;
    }, 0);
    if (visitsAdded === 0) return;
  }
  try {
    map.fitBounds(bounds, { padding: 60, maxZoom: 12 });
  } catch (error) {
    console.warn("Could not fit bounds", error);
  }
};

const setupMapLayers = () => {
  if (!map) return;
  map.addSource("trip-locations", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "trip-locations-circle",
    type: "circle",
    source: "trip-locations",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "checklist_count"], 1, 3, 50, 8],
      "circle-color": [
        "case",
        ["boolean", ["get", "locality_hotspot"], false],
        "#f4a261",
        "#ffd166",
      ],
      "circle-opacity": 0.85,
      "circle-stroke-color": "#1b1f24",
      "circle-stroke-width": 1,
    },
  });

  map.off("mouseenter", "trip-locations-circle", handleTripLocationsEnter);
  map.off("mouseleave", "trip-locations-circle", handleTripLocationsLeave);
  map.off("click", "trip-locations-circle", handleTripLocationsClick);
  map.on("mouseenter", "trip-locations-circle", handleTripLocationsEnter);
  map.on("mouseleave", "trip-locations-circle", handleTripLocationsLeave);
  map.on("click", "trip-locations-circle", handleTripLocationsClick);
  map.off("click", handleMapClickClosePopup);
  map.on("click", handleMapClickClosePopup);

  map.addSource("visit-areas", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "visit-areas-fill",
    type: "fill",
    source: "visit-areas",
    paint: {
      "fill-color": [
        "case",
        ["boolean", ["get", "selected"], false],
        "rgba(255, 107, 107, 0.22)",
        "rgba(17, 138, 178, 0.14)",
      ],
      "fill-outline-color": "rgba(17, 138, 178, 0.4)",
    },
  });

  map.addLayer({
    id: "visit-areas-outline",
    type: "line",
    source: "visit-areas",
    paint: {
      "line-color": ["case", ["boolean", ["get", "selected"], false], "#ff6b6b", "#118ab2"],
      "line-width": 2,
    },
  });

  map.addSource("visits-points", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addSource("visit-path", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addSource("visit-route", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "visit-path-line",
    type: "line",
    source: "visit-path",
    paint: {
      "line-color": "#ff6b00",
      "line-width": 2.5,
      "line-blur": 0.1,
      "line-opacity": ["case", ["boolean", ["get", "hasRoute"], false], 0, 0.7],
    },
  });

  map.addLayer({
    id: "visit-route-line",
    type: "line",
    source: "visit-route",
    layout: {
      "line-join": "round",
      "line-cap": "round",
    },
    paint: {
      "line-color": "#ff6b00",
      "line-width": 3.2,
      "line-opacity": 0.8,
    },
  });

  map.addLayer({
    id: "visits-points",
    type: "circle",
    source: "visits-points",
    paint: {
      "circle-radius": 6,
      "circle-color": [
        "case",
        ["boolean", ["get", "selected"], false],
        "#ff6b6b",
        ["case", ["==", ["get", "type"], "birding"], "#118ab2", "#6c757d"],
      ],
      "circle-opacity": ["case", ["==", ["get", "type"], "birding"], 0.9, 0.5],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
    },
  });

  map.off("mouseenter", "visits-points", handleVisitsEnter);
  map.off("mouseleave", "visits-points", handleVisitsLeave);
  map.off("click", "visits-points", handleVisitsClick);
  map.on("mouseenter", "visits-points", handleVisitsEnter);
  map.on("mouseleave", "visits-points", handleVisitsLeave);
  map.on("click", "visits-points", handleVisitsClick);
  map.on("click", handleMapClick);

  updateMapData();
  if (selectedVisit.value) {
    focusOnVisit();
  } else {
    fitMapToLocations();
  }
  updateMapCursor();
  updateVisitMarkers();
  refreshRouteSource();
};

const initMap = () => {
  if (!mapContainer.value || map) return;
  const initialState = pendingMapState.value;
  map = new mapboxgl.Map({
    container: mapContainer.value,
    style: mapStyle.value,
    center: initialState?.center || [0, 0],
    zoom: Number.isFinite(initialState?.zoom) ? initialState.zoom : 1.2,
    bearing: Number.isFinite(initialState?.bearing) ? initialState.bearing : 0,
    pitch: Number.isFinite(initialState?.pitch) ? initialState.pitch : 0,
  });

  map.addControl(new mapboxgl.NavigationControl());
  geolocateControl = new mapboxgl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: false,
    showUserHeading: true,
    showUserLocation: true,
  });
  map.addControl(geolocateControl, "top-right");
  geolocateControl.on("geolocate", (event) => {
    const { longitude, latitude } = event?.coords || {};
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
    map.easeTo({ center: [longitude, latitude] });
  });

  map.on("load", () => {
    mapLoaded = true;
    setupMapLayers();
    if (initialState) {
      map.jumpTo({
        center: initialState.center,
        zoom: initialState.zoom,
        bearing: initialState.bearing,
        pitch: initialState.pitch,
      });
      pendingMapState.value = null;
    }
  });
};

watch(selectedTripId, loadTripData, { immediate: true });
watch(selectedVisitId, () => {
  syncVisitForm();
  nameNeedsUpdate.value = false;
  updateMapData();
  clearVisitMarkers();
  updateVisitMarkers();
  if (skipNextFocus.value) {
    skipNextFocus.value = false;
    return;
  }
  focusOnVisit();
  scrollToSelectedVisit();
});
watch(
  visits,
  () => {
    updateMapData();
    updateVisitMarkers();
  },
  { deep: true },
);
watch(mapStyle, (style) => {
  if (!map) return;
  const currentCenter = map.getCenter();
  const currentZoom = map.getZoom();
  const currentBearing = map.getBearing();
  const currentPitch = map.getPitch();
  map.setStyle(style);
  map.once("style.load", () => {
    mapLoaded = true;
    setupMapLayers();
    map.jumpTo({
      center: currentCenter,
      zoom: currentZoom,
      bearing: currentBearing,
      pitch: currentPitch,
    });
  });
});

onMounted(async () => {
  await refreshTrips();
  if (selectedTripId.value) {
    const restored = loadSavedMapState(selectedTripId.value);
    if (restored?.style) {
      mapStyle.value = restored.style;
    }
    pendingMapState.value = restored;
  }
  if (selectedTripId.value && !tripData.value) {
    await loadTripData(selectedTripId.value);
  }
  nextTick(initMap);
  window.addEventListener("keydown", handleKeydown);
});

onBeforeUnmount(() => {
  visitStatsTimers.forEach((timer) => clearTimeout(timer));
  visitStatsTimers.clear();
  saveMapState();
  window.removeEventListener("keydown", handleKeydown);
});
</script>

<template>
  <div class="d-flex flex-column flex-grow-1 h-100 overflow-hidden build-trip">
    <div class="row g-0 flex-grow-1 h-100 build-trip-row">
      <div
        class="col-12 col-lg-5 col-xl-5 col-xxl-4 d-flex h-100 build-trip-pane build-trip-panel"
        :class="{ 'is-open': isMobilePanelOpen }"
      >
        <div
          class="card rounded-0 border-0 border-end flex-grow-1 d-flex flex-column build-trip-card"
        >
          <div
            class="d-flex align-items-center justify-content-between px-3 py-2 border-bottom bg-white gap-2"
          >
            <div class="fw-semibold">Itinerary</div>
            <div class="d-flex align-items-center gap-2">
              <div class="form-check form-switch mb-0">
                <input
                  id="satelliteToggleBuild"
                  class="form-check-input"
                  type="checkbox"
                  v-model="isSatellite"
                />
                <label class="form-check-label small" for="satelliteToggleBuild">Hybrid map</label>
              </div>
              <button
                class="btn btn-outline-secondary btn-sm"
                @click="exportVisits"
                :disabled="!selectedTripId || !visits.length"
              >
                <i class="bi bi-download"></i>
                <span class="ms-1 d-none d-md-inline">Export</span>
              </button>
              <button
                class="btn btn-outline-secondary btn-sm"
                @click="importVisits"
                :disabled="!selectedTripId"
              >
                <i class="bi bi-upload"></i>
                <span class="ms-1 d-none d-md-inline">Import</span>
              </button>
              <button
                class="btn btn-outline-secondary btn-sm d-lg-none"
                type="button"
                aria-label="Close itinerary panel"
                @click="closeMobilePanel"
              >
                <i class="bi bi-x-lg"></i>
              </button>
            </div>
          </div>
          <div
            ref="itineraryBodyRef"
            class="build-trip-body"
            :class="{ 'is-dragging': isDraggingSplit }"
            :style="itinerarySplitStyle"
          >
            <div
              ref="itineraryListRef"
              class="list-group list-group-flush bg-white build-trip-list"
              :class="{ 'is-full': !selectedVisit }"
            >
              <template v-for="group in groupedVisits" :key="group.dateKey">
                <div
                  class="small fw-semibold text-muted bg-light py-1 px-3 border-top border-bottom position-sticky top-0"
                >
                  <span>{{ group.dateKey }}</span>
                </div>
                <button
                  v-for="visit in group.visits"
                  :key="visit.id"
                  type="button"
                  class="list-group-item list-group-item-action"
                  :data-visit-id="visit.id"
                  :class="{ active: String(visit.id) === String(selectedVisitId) }"
                  @click="selectedVisitId = visit.id"
                >
                  <div class="d-flex align-items-center justify-content-between gap-2">
                    <div class="d-flex align-items-center gap-2 flex-grow-1 overflow-hidden">
                      <span class="text-muted small" :title="getVisitTypeLabel(visit)">
                        <i :class="['bi', getVisitTypeIcon(visit)]"></i>
                      </span>
                      <span class="small text-muted text-nowrap">{{
                        formatVisitTime(visit.dateTime)
                      }}</span>
                      <span class="fw-semibold text-truncate flex-grow-1">
                        {{ visit.name || "Untitled visit" }}
                      </span>
                    </div>
                    <div class="d-inline-flex align-items-center gap-2">
                      <span
                        class="small text-muted d-inline-flex align-items-center gap-1 text-nowrap"
                        v-if="getLegSummary(visit.id)"
                      >
                        <i class="bi bi-arrow-right"></i>
                        {{ getLegSummary(visit.id) }}
                      </span>
                      <button
                        class="btn btn-outline-secondary btn-sm"
                        type="button"
                        @click.stop="computeRouteSegment(visit.id)"
                        :disabled="routeLoadingId === String(visit.id) || visit.globalIndex === 0"
                      >
                        <span
                          v-if="routeLoadingId === String(visit.id)"
                          class="spinner-border spinner-border-sm"
                        ></span>
                        <i v-else class="bi bi-signpost-split"></i>
                      </button>
                    </div>
                  </div>
                </button>
              </template>
              <div v-if="sortedVisits.length === 0" class="p-3 text-muted small">
                No visits yet. Add one to get started.
              </div>
            </div>
            <div
              v-if="selectedVisit"
              class="build-trip-splitter"
              role="separator"
              aria-label="Resize itinerary panels"
              @pointerdown="startSplitDrag"
            >
              <i class="bi bi-grip-horizontal" aria-hidden="true"></i>
            </div>
            <transition name="slide">
              <div v-if="selectedVisit" class="build-trip-edit bg-white shadow-sm">
                <div class="d-flex align-items-center justify-content-between gap-2 mb-2">
                  <div class="fw-semibold small text-dark">Edit visit</div>
                  <div class="d-inline-flex align-items-center gap-2">
                    <button
                      class="btn btn-outline-primary btn-sm"
                      @click="startAddVisit"
                      :disabled="!selectedTripId"
                    >
                      <i :class="addingVisit ? 'bi bi-x-lg' : 'bi bi-plus-lg'"></i>
                      <span class="ms-1">{{ addingVisit ? "Cancel" : "Add" }}</span>
                    </button>
                    <button
                      class="btn btn-outline-danger btn-sm"
                      @click="deleteVisit"
                      :disabled="!selectedVisit"
                    >
                      <i class="bi bi-trash3"></i>
                    </button>
                  </div>
                </div>
                <div class="mb-2">
                  <div class="d-flex align-items-center gap-2">
                    <label class="form-label mb-0">Name</label>
                    <div class="input-group">
                      <input
                        v-model="visitForm.name"
                        class="form-control"
                        @input="handleNameInput"
                      />
                      <button
                        v-if="nameNeedsUpdate"
                        class="btn btn-outline-secondary"
                        type="button"
                        @click="updateVisitNameFromLocation"
                        :disabled="!selectedVisit"
                        aria-label="Update name from location"
                      >
                        <i class="bi bi-arrow-clockwise"></i>
                      </button>
                    </div>
                  </div>
                </div>
                <div class="mb-2">
                  <div class="d-flex align-items-center gap-2">
                    <label class="form-label mb-0">Type</label>
                    <select
                      v-model="visitForm.type"
                      class="form-select form-select-sm"
                      @change="saveVisitDetails"
                    >
                      <option
                        v-for="option in visitTypeOptions"
                        :key="option.value"
                        :value="option.value"
                      >
                        {{ option.label }}
                      </option>
                    </select>
                  </div>
                </div>
                <div class="row g-2 mb-2">
                  <div class="col-lg-7">
                    <div class="d-flex align-items-center gap-2">
                      <label class="form-label mb-0">Date</label>
                      <input
                        v-model="visitForm.dateTime"
                        type="datetime-local"
                        class="form-control"
                        @input="saveVisitDetails"
                      />
                    </div>
                  </div>
                  <div class="col-lg-5" v-if="visitForm.type === 'birding'">
                    <div class="d-flex align-items-center gap-2">
                      <label class="form-label mb-0">Effort</label>
                      <div class="input-group">
                        <input
                          v-model.number="visitForm.durationMin"
                          type="number"
                          min="0.1"
                          step="0.1"
                          class="form-control"
                          @input="saveVisitDetails"
                        />
                        <span class="input-group-text">hrs</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="mb-2">
                  <label class="form-label">Notes</label>
                  <textarea
                    v-model="visitForm.note"
                    rows="2"
                    class="form-control"
                    @input="saveVisitDetails"
                  ></textarea>
                </div>
                <div class="mb-2" v-if="visitForm.type === 'birding'">
                  <label class="form-label">Species of interest</label>
                  <v-select
                    v-model="visitForm.targetSpecies"
                    :options="tripSpeciesOptions"
                    label="commonName"
                    :reduce="(species) => species.code"
                    multiple
                    :close-on-select="false"
                    :clearable="false"
                    :searchable="true"
                    :append-to-body="true"
                    :disabled="visitForm.type !== 'birding'"
                    placeholder="Select species"
                    class="species-select"
                    @update:modelValue="saveTargetSpecies"
                  >
                    <template #option="{ commonName, scientificName, code }">
                      <div class="d-flex flex-column">
                        <span class="fw-semibold small">{{ commonName || code }}</span>
                        <span class="text-muted small" v-if="scientificName">
                          {{ scientificName }}
                        </span>
                      </div>
                    </template>
                    <template #selected-option="{ commonName, code }">
                      <span class="small">{{ commonName || code }}</span>
                    </template>
                  </v-select>
                </div>
                <div class="text-muted small" v-if="visitForm.type === 'birding'">
                  {{ selectedVisitStats.species }} species ·
                  {{ selectedVisitStats.checklists }} checklists ·
                  {{ selectedVisitStats.locations }} locations
                </div>
              </div>
            </transition>
          </div>
          <input
            ref="importFileInput"
            type="file"
            class="d-none"
            accept=".json,.geojson,application/json,application/geo+json"
            @change="handleVisitImport"
          />
        </div>
      </div>
      <div class="col-12 col-lg-7 col-xl-7 col-xxl-8 d-flex build-trip-pane build-trip-map-pane">
        <div class="position-relative flex-grow-1 h-100 build-trip-map" style="min-height: 420px">
          <div
            class="position-absolute top-0 start-0 d-lg-none pe-auto"
            v-if="tripData && !isMobilePanelOpen"
            style="z-index: 4"
          >
            <button
              class="btn btn-light shadow-sm m-2 m-lg-3"
              type="button"
              @click="openMobilePanel"
            >
              <i class="bi bi-list"></i>
              <span class="visually-hidden">Open itinerary panel</span>
            </button>
          </div>
          <div
            ref="mapContainer"
            class="position-absolute top-0 bottom-0 start-0 end-0 w-100 h-100"
          ></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.visit-type-marker {
  background: #ffffff;
  border: 1px solid rgba(15, 23, 42, 0.2);
  border-radius: 999px;
  padding: 4px 6px;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.15);
  color: #1f2937;
  font-size: 0.95rem;
}

.species-select :deep(.vs__dropdown-toggle) {
  min-height: 34px;
  padding: 2px 8px;
  border-radius: 6px;
}

.species-select :deep(.vs__selected-options) {
  flex-wrap: wrap;
  overflow: visible;
  gap: 4px;
}

.species-select :deep(.vs__selected) {
  margin: 0;
  padding: 2px 6px;
  font-size: 0.75rem;
  white-space: normal;
}

.species-select :deep(.vs__search) {
  margin: 0;
  padding: 0;
  font-size: 0.8rem;
}

.species-select :deep(.vs__dropdown-menu) {
  max-height: 200px;
}

.list-group-item.active .text-muted,
.list-group-item.active .text-muted.small {
  color: rgba(255, 255, 255, 0.85) !important;
}

.list-group-item.active .fw-semibold,
.list-group-item.active .small {
  color: #ffffff;
}

.build-trip {
  min-height: 0;
}

.build-trip-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.build-trip-body.is-dragging {
  cursor: row-resize;
  user-select: none;
}

.build-trip-list {
  flex: 0 0 var(--itinerary-split, 60%);
  min-height: 0;
  overflow-y: auto;
}

.build-trip-list.is-full {
  flex: 1 1 auto;
}

.build-trip-splitter {
  height: 14px;
  background: #f1f3f5;
  border-top: 1px solid #dee2e6;
  border-bottom: 1px solid #dee2e6;
  cursor: row-resize;
  flex: 0 0 auto;
  touch-action: none;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #9aa0a6;
  font-size: 0.8rem;
}

.build-trip-edit {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem;
}

.build-trip-pane {
  min-height: 0;
}

.build-trip-card {
  min-height: 0;
  height: 100%;
}

.build-trip-map {
  min-height: 0;
}

.build-trip-row {
  min-height: 0;
  position: relative;
}

.slide-enter-active,
.slide-leave-active {
  transition: opacity 0.2s ease;
}

.slide-enter-from,
.slide-leave-to {
  opacity: 0;
}

.slide-enter-to,
.slide-leave-from {
  opacity: 1;
}

:deep(.radius-handle) {
  width: 12px;
  height: 12px;
  border: 2px solid #ff6b6b;
  border-radius: 50%;
  background: #ff6b6b;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  cursor: ew-resize;
}

:deep(.visit-center-handle) {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #ff6b6b;
  border: 2px solid #ffffff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
}

@media (max-width: 991.98px) {
  .build-trip-panel {
    position: absolute;
    inset: 0;
    z-index: 4;
    display: none !important;
  }

  .build-trip-panel.is-open {
    display: flex !important;
  }

  .build-trip-panel .build-trip-card {
    border-radius: 0;
    border-right: 0;
    height: 100%;
  }

  .build-trip-panel .build-trip-list {
    overflow-y: auto;
  }
}
</style>
