<script setup>
import { ref, shallowRef, computed, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import vSelect from "vue-select";
import "vue-select/dist/vue-select.css";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import MapboxGeocoder from "@mapbox/mapbox-gl-geocoder";
import "@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css";
import { circle as turfCircle } from "@turf/circle";
import { destination as turfDestination } from "@turf/destination";
import { distance as turfDistance } from "@turf/distance";
import { useTripBundleLoader } from "../composables/useTripBundleLoader";
import { db, readTripComments } from "../data/db";
import { buildCommentMarkdown, copyMarkdown, downloadMarkdown } from "../utils/commentExport";
import { selectedTripId, refreshTrips } from "../state/tripSelection";
import { selectedVisitId } from "../state/visitSelection";
import { resolveRecordConflict, withUpdatedAt } from "../utils/recordConflicts";
import { MapStyleControl } from "../utils/mapStyleControl";

const tripData = shallowRef(null);
const locations = shallowRef([]);
const visits = shallowRef([]);
const selectedVisitIds = ref([]);
const multipleSelectionMode = ref(false);
const selectionAnchorId = ref("");
const bulkShiftAmount = ref(3);
const bulkShiftUnit = ref("days");
const isApplyingBulkShift = ref(false);
const bulkShiftStatus = ref("");

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
const locationSearchContainer = ref(null);
let map = null;
let mapLoaded = false;
let locationSearchControl = null;
let locationPopup = null;
const locationPopupLocked = ref(false);
let visitPopup = null;
let selectedVisitMarker = null;
let radiusMarkers = [];
let nonBirdingMarkers = [];
let searchHighlightTimer = null;
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
let mapStyleControl = null;
const searchHighlightCoords = ref(null);
const { loadTripBundle, resetTripBundleLoader } = useTripBundleLoader({
  includeEbd: true,
  includeVisits: true,
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

const selectedVisit = computed(
  () => visits.value.find((visit) => String(visit.id) === String(selectedVisitId.value)) || null,
);

const sortedVisits = computed(() => getSortedVisits());
const selectedVisits = computed(() => {
  const ids = new Set(selectedVisitIds.value);
  return sortedVisits.value.filter((visit) => ids.has(String(visit.id)));
});
const selectedVisitCount = computed(() => selectedVisitIds.value.length);
const isBulkSelection = computed(() => selectedVisitCount.value > 1);
const hasItineraryDetails = computed(() => isBulkSelection.value || !!selectedVisit.value);

const isVisitSelected = (visitId) => selectedVisitIds.value.includes(String(visitId));

const setSelectedVisitIds = (visitIds) => {
  selectedVisitIds.value = [...new Set(visitIds.map(String))];
};

const finishMultipleSelection = () => {
  multipleSelectionMode.value = false;
  bulkShiftStatus.value = "";
  const primaryId = isVisitSelected(selectedVisitId.value)
    ? String(selectedVisitId.value)
    : selectedVisitIds.value[0] || "";
  selectedVisitId.value = primaryId;
  setSelectedVisitIds(primaryId ? [primaryId] : []);
};

const handleVisitSelection = (visitId, event = {}) => {
  const id = String(visitId);
  const usesModifier = event.metaKey || event.ctrlKey;
  const usesRange = event.shiftKey;

  if (!usesModifier && !usesRange) {
    multipleSelectionMode.value = false;
    selectionAnchorId.value = id;
    selectedVisitId.value = visitId;
    setSelectedVisitIds([id]);
    return;
  }

  if (!multipleSelectionMode.value) {
    multipleSelectionMode.value = true;
    setSelectedVisitIds(selectedVisitId.value ? [selectedVisitId.value] : []);
  }

  if (usesRange) {
    const orderedIds = sortedVisits.value.map((visit) => String(visit.id));
    const anchorId = selectionAnchorId.value || String(selectedVisitId.value || id);
    const anchorIndex = orderedIds.indexOf(anchorId);
    const visitIndex = orderedIds.indexOf(id);
    const start = Math.min(anchorIndex < 0 ? visitIndex : anchorIndex, visitIndex);
    const end = Math.max(anchorIndex < 0 ? visitIndex : anchorIndex, visitIndex);
    const rangeIds = orderedIds.slice(start, end + 1);
    setSelectedVisitIds(usesModifier ? [...selectedVisitIds.value, ...rangeIds] : rangeIds);
  } else {
    const nextIds = isVisitSelected(id)
      ? selectedVisitIds.value.filter((selectedId) => selectedId !== id)
      : [...selectedVisitIds.value, id];
    setSelectedVisitIds(nextIds);
    selectionAnchorId.value = id;
  }

  multipleSelectionMode.value = selectedVisitIds.value.length > 1;

  if (isVisitSelected(id)) {
    selectedVisitId.value = visitId;
  } else if (!isVisitSelected(selectedVisitId.value)) {
    selectedVisitId.value = selectedVisitIds.value.at(-1) || "";
  }
  bulkShiftStatus.value = "";
};

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

const normalizeSearchText = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const searchableLocations = computed(() => {
  const seen = new Set();
  return (locations.value || [])
    .map((location) => {
      const lon = toNumber(location.longitude, NaN);
      const lat = toNumber(location.latitude, NaN);
      const locality = String(location.locality || "").trim();
      if (!locality || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      const uniqueKey = location.locality_id || `${locality}:${lat}:${lon}`;
      if (seen.has(uniqueKey)) return null;
      seen.add(uniqueKey);
      const county = String(location.county || "").trim();
      const state = String(location.state || "").trim();
      const country = String(location.country || "").trim();
      const detailParts = [county, state, country].filter(Boolean);
      const detailText = detailParts.join(", ");
      const placeName = detailText ? `${locality}, ${detailText}` : locality;
      return {
        id: uniqueKey,
        locality,
        placeName,
        center: [lon, lat],
        localityHotspot: location.locality_hotspot === true,
        normalizedLocality: normalizeSearchText(locality),
        normalizedDetail: normalizeSearchText(detailText),
      };
    })
    .filter(Boolean);
});

// Cheap bounding-box reject before the exact distance check: at most a handful
// of locations survive it, so the expensive work stays proportional to the radius
// rather than to the size of the EBD import.
const makeRadiusFilter = (centerLon, centerLat, radiusKm) => {
  if (!Number.isFinite(centerLon) || !Number.isFinite(centerLat) || !(radiusKm > 0)) return null;
  const latRange = radiusKm / 111;
  const lonRange = radiusKm / (111 * Math.max(Math.cos((centerLat * Math.PI) / 180), 0.2));
  const center = [centerLon, centerLat];
  return (lon, lat) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
    if (Math.abs(lat - centerLat) > latRange) return false;
    if (Math.abs(lon - centerLon) > lonRange) return false;
    return distanceKm(center, [lon, lat]) <= radiusKm;
  };
};

const summarizeVisitAreas = (areaVisits, useMeanDuration = false) => {
  const radiusFilters = areaVisits
    .filter((visit) => getVisitType(visit) === "birding")
    .map((visit) =>
      makeRadiusFilter(
        toNumber(visit.longitude, NaN),
        toNumber(visit.latitude, NaN),
        Number(visit.radiusKm) || 0,
      ),
    )
    .filter(Boolean);
  const speciesSet = new Set();
  const durations = [];
  const distances = [];
  let checklistTotal = 0;
  let locationCount = 0;

  locations.value.forEach((location) => {
    const lon = Number(location.longitude);
    const lat = Number(location.latitude);
    if (!radiusFilters.some((isWithin) => isWithin(lon, lat))) return;
    locationCount += 1;
    checklistTotal += location.checklist_count || 0;
    // Current trips keep just the durations on the location; older ones still have
    // the full checklist records inline.
    if (Array.isArray(location.checklist_durations)) {
      for (const minutes of location.checklist_durations) {
        if (Number.isFinite(minutes) && minutes > 0) durations.push(minutes);
      }
      for (const kilometers of location.checklist_distances_km || []) {
        if (Number.isFinite(kilometers) && kilometers > 0) distances.push(kilometers);
      }
    } else if (Array.isArray(location.checklist)) {
      for (const checklist of location.checklist) {
        const minutes = Number(checklist?.duration_minutes);
        if (Number.isFinite(minutes) && minutes > 0) durations.push(minutes);
        const kilometers = Number(checklist?.effort_distance_km);
        if (Number.isFinite(kilometers) && kilometers > 0) distances.push(kilometers);
      }
    }
    const entries = location.species_checklist_counts || [];
    for (const [code] of entries) speciesSet.add(code);
  });

  const sortedDurations = durations.slice().sort((a, b) => a - b);
  let durationLabel = "";
  if (sortedDurations.length) {
    const middle = Math.floor(sortedDurations.length / 2);
    const durationMinutes = useMeanDuration
      ? Math.round(sortedDurations.reduce((sum, minutes) => sum + minutes, 0) / sortedDurations.length)
      : sortedDurations.length % 2 === 0
        ? Math.round((sortedDurations[middle - 1] + sortedDurations[middle]) / 2)
        : sortedDurations[middle];
    durationLabel = formatMinutesCompact(durationMinutes);
  }

  const sortedDistances = distances.slice().sort((a, b) => a - b);
  let distanceLabel = "";
  if (sortedDistances.length) {
    const middle = Math.floor(sortedDistances.length / 2);
    const distanceKm = sortedDistances.length % 2 === 0
      ? (sortedDistances[middle - 1] + sortedDistances[middle]) / 2
      : sortedDistances[middle];
    distanceLabel = `${distanceKm.toLocaleString(undefined, { maximumFractionDigits: 1 })} km`;
  }

  return {
    species: speciesSet.size,
    checklists: checklistTotal,
    locations: locationCount,
    durationLabel,
    distanceLabel,
  };
};

const selectedVisitStats = computed(() => {
  const stats = summarizeVisitAreas(selectedVisit.value ? [selectedVisit.value] : []);
  return { ...stats, medianDurationLabel: stats.durationLabel };
});

const selectedVisitAreaStats = computed(() => summarizeVisitAreas(selectedVisits.value, true));
const selectedBirdingVisitCount = computed(
  () => selectedVisits.value.filter((visit) => getVisitType(visit) === "birding").length,
);

// Every note written inside the visit radius. Reuses the same radius filter the
// visit summary uses, then narrows the comment corpus to those localities.
const isExportingComments = ref(false);
// Confirmation lives on the button itself and clears itself: "" | "copied" |
// "copy-failed" | "downloaded".
const commentExportDone = ref("");
let commentFeedbackTimer = null;
const flashCommentFeedback = (state) => {
  commentExportDone.value = state;
  clearTimeout(commentFeedbackTimer);
  commentFeedbackTimer = setTimeout(() => {
    commentExportDone.value = "";
  }, 2500);
};

const exportVisitComments = async (mode) => {
  const areaVisits = (isBulkSelection.value ? selectedVisits.value : [selectedVisit.value]).filter(
    (visit) => visit && getVisitType(visit) === "birding",
  );
  const areas = areaVisits
    .map((visit) => {
      const centerLon = toNumber(visit.longitude, NaN);
      const centerLat = toNumber(visit.latitude, NaN);
      const radiusKm = Number(visit.radiusKm) || 0;
      return {
        visit,
        centerLon,
        centerLat,
        radiusKm,
        isWithin: makeRadiusFilter(centerLon, centerLat, radiusKm),
      };
    })
    .filter((area) => area.isWithin);
  if (!areas.length) {
    flashCommentFeedback("copy-failed");
    return;
  }

  isExportingComments.value = true;
  try {
    const locationsById = new Map();
    for (const location of locations.value) {
      const lon = Number(location.longitude);
      const lat = Number(location.latitude);
      if (!areas.some((area) => area.isWithin(lon, lat))) continue;
      locationsById.set(String(location.locality_id), location);
    }
    const entries = (await readTripComments(selectedTripId.value)).filter((entry) =>
      locationsById.has(String(entry.locality_id)),
    );
    const speciesNameByCode = new Map(
      (tripData.value?.speciesList || []).map((species) => [
        species.code,
        species.commonName || species.code,
      ]),
    );
    const isCombined = isBulkSelection.value;
    const firstArea = areas[0];
    const visitName = isCombined
      ? `${areas.length} selected birding ${areas.length === 1 ? "visit" : "visits"}`
      : firstArea.visit.name ||
        getVisitName([firstArea.centerLon, firstArea.centerLat], firstArea.radiusKm) ||
        "Visit";
    const contextLines = isCombined
      ? [
          `Combined area from ${areas.length} selected birding ${areas.length === 1 ? "visit" : "visits"}`,
          "",
        ]
      : [
          firstArea.visit.dateTime ? `Date: ${formatVisitDate(firstArea.visit.dateTime)}` : "",
          `Area: ${Math.round(firstArea.radiusKm * 10) / 10} km around ${firstArea.centerLat.toFixed(4)}, ${firstArea.centerLon.toFixed(4)}`,
          firstArea.visit.note ? `Visit note: ${firstArea.visit.note}` : "",
          "",
        ];
    const markdown = buildCommentMarkdown({
      heading: `${visitName} - observer comments`,
      contextLines,
      entries,
      locationsById,
      speciesNameByCode,
    });

    if (mode === "copy") {
      const copied = await copyMarkdown(markdown);
      flashCommentFeedback(copied ? "copied" : "copy-failed");
      return;
    }
    const safeName = visitName.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "visit";
    downloadMarkdown(`comments-${safeName.toLowerCase()}.md`, markdown);
    flashCommentFeedback("downloaded");
  } finally {
    isExportingComments.value = false;
  }
};

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

  const isWithin = makeRadiusFilter(centerLon, centerLat, radiusKm);
  const speciesCounts = {};
  let checklistCount = 0;
  let locationCount = 0;

  locationMeta.value.forEach((location) => {
    if (!isWithin(location.lon, location.lat)) return;

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
    await applyVisitUpdates(visit.id, stats, { skipStats: true, promptOnConflict: false });
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
    weekday: "short",
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
      const group = { dateKey, visits: [], driveDurationS: 0, birdingDurationHours: 0 };
      byDate.set(dateKey, group);
      groups.push(group);
    }
    const group = byDate.get(dateKey);
    group.visits.push({ ...visit, globalIndex: index });
    group.driveDurationS += Math.max(0, Number(visit.routeDurationS) || 0);
    if (getVisitType(visit) === "birding") {
      group.birdingDurationHours += Math.max(0, Number(visit.durationMin) || 0);
    }
  });
  groups.forEach((group) => {
    group.driveLabel = formatDriveDurationCompact(group.driveDurationS);
    group.birdingLabel = formatHoursCompact(group.birdingDurationHours);
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

const shiftDateTime = (value, amount, unit) => {
  const date = new Date(value);
  if (unit === "hours") date.setHours(date.getHours() + amount);
  if (unit === "days") date.setDate(date.getDate() + amount);
  if (unit === "weeks") date.setDate(date.getDate() + amount * 7);
  return formatDateTimeLocal(date);
};

const applyBulkDateShift = async (amount = bulkShiftAmount.value, unit = bulkShiftUnit.value) => {
  const numericAmount = Number(amount);
  const datedVisits = selectedVisits.value.filter(
    (visit) => visit.dateTime && !Number.isNaN(new Date(visit.dateTime).getTime()),
  );
  if (!numericAmount || !datedVisits.length) return;

  isApplyingBulkShift.value = true;
  bulkShiftStatus.value = "";
  try {
    const updatedAt = Date.now();
    const shiftedDates = new Map(
      datedVisits.map((visit) => [
        String(visit.id),
        shiftDateTime(visit.dateTime, numericAmount, unit),
      ]),
    );
    const oldOrder = sortedVisits.value.map((visit) => String(visit.id));
    const nextVisits = visits.value.map((visit) => {
      const dateTime = shiftedDates.get(String(visit.id));
      return dateTime ? { ...visit, dateTime, updatedAt } : visit;
    });
    const nextOrder = [...nextVisits]
      .sort((a, b) => new Date(a.dateTime || 0) - new Date(b.dateTime || 0))
      .map((visit) => String(visit.id));
    const oldPredecessor = new Map(oldOrder.map((id, index) => [id, oldOrder[index - 1] || ""]));
    const invalidRouteIds = nextOrder.filter(
      (id, index) => oldPredecessor.get(id) !== (nextOrder[index - 1] || ""),
    );
    const patches = new Map();
    const visitIdsByString = new Map(visits.value.map((visit) => [String(visit.id), visit.id]));

    shiftedDates.forEach((dateTime, id) => {
      patches.set(id, { dateTime, updatedAt });
    });
    invalidRouteIds.forEach((id) => {
      patches.set(id, {
        ...(patches.get(id) || {}),
        routeGeometry: null,
        routeDistanceM: 0,
        routeDurationS: 0,
        updatedAt,
      });
    });

    await db.transaction("rw", db.visits, async () => {
      await Promise.all(
        [...patches].map(([id, updates]) => db.visits.update(visitIdsByString.get(id), updates)),
      );
    });
    visits.value = visits.value.map((visit) => ({
      ...visit,
      ...(patches.get(String(visit.id)) || {}),
    }));

    if (invalidRouteIds.length) {
      const nextSegments = { ...routeSegments.value };
      invalidRouteIds.forEach((id) => delete nextSegments[id]);
      routeSegments.value = nextSegments;
      refreshRouteSource();
    }
    syncVisitForm();
    const skipped = selectedVisitCount.value - datedVisits.length;
    bulkShiftStatus.value = `${datedVisits.length} ${datedVisits.length === 1 ? "visit" : "visits"} shifted${skipped ? ` · ${skipped} without a date skipped` : ""}.`;
  } finally {
    isApplyingBulkShift.value = false;
  }
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
  const isWithin = makeRadiusFilter(Number(center[0]), Number(center[1]), radiusKm);
  if (!isWithin) return "New visit";
  const localityCounts = new Map();
  let hotspotBest = null;
  locations.value.forEach((location) => {
    if (!isWithin(Number(location.longitude), Number(location.latitude))) return;
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
  updateVisitSources();
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
  handleVisitSelection(visitId, event.originalEvent || {});
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

const formatMinutesCompact = (minutes) => {
  const totalMinutes = Math.max(0, Math.round(Number(minutes) || 0));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const rem = totalMinutes % 60;
  if (rem === 0) return `${hours}h`;
  return `${hours}h${String(rem).padStart(2, "0")}`;
};

const formatDriveDurationCompact = (seconds) => {
  const totalMinutes = Math.max(0, Math.round((Number(seconds) || 0) / 60));
  if (!totalMinutes) return "";
  if (totalMinutes < 60) return `${totalMinutes}`;
  const hours = Math.floor(totalMinutes / 60);
  const rem = totalMinutes % 60;
  if (rem === 0) return `${hours}h`;
  return `${hours}h ${String(rem).padStart(2, "0")}`;
};

const formatHoursCompact = (hoursValue) => {
  const totalHours = Math.max(0, Number(hoursValue) || 0);
  if (!totalHours) return "";
  const roundedHours = Math.round(totalHours * 10) / 10;
  return `${roundedHours}h`;
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

const buildSearchHighlightData = () => {
  const coords = searchHighlightCoords.value;
  if (!Array.isArray(coords) || coords.length !== 2) {
    return { type: "FeatureCollection", features: [] };
  }
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: coords,
        },
        properties: {},
      },
    ],
  };
};

const clearSearchHighlight = () => {
  searchHighlightCoords.value = null;
  if (searchHighlightTimer) {
    clearTimeout(searchHighlightTimer);
    searchHighlightTimer = null;
  }
  if (!map || !mapLoaded) return;
  const source = map.getSource("search-result-highlight");
  if (source) {
    source.setData(buildSearchHighlightData());
  }
};

const setSearchHighlight = (coords) => {
  if (!Array.isArray(coords) || coords.length !== 2) return;
  searchHighlightCoords.value = coords;
  if (searchHighlightTimer) {
    clearTimeout(searchHighlightTimer);
  }
  searchHighlightTimer = setTimeout(() => {
    clearSearchHighlight();
  }, 15000);
  if (!map || !mapLoaded) return;
  const source = map.getSource("search-result-highlight");
  if (source) {
    source.setData(buildSearchHighlightData());
  }
};

const getSearchFeatureCenter = (feature) => {
  const geometryCoords = feature?.geometry?.coordinates;
  if (
    Array.isArray(geometryCoords) &&
    geometryCoords.length === 2 &&
    Number.isFinite(Number(geometryCoords[0])) &&
    Number.isFinite(Number(geometryCoords[1]))
  ) {
    return [Number(geometryCoords[0]), Number(geometryCoords[1])];
  }
  const center = feature?.center;
  if (
    Array.isArray(center) &&
    center.length === 2 &&
    Number.isFinite(Number(center[0])) &&
    Number.isFinite(Number(center[1]))
  ) {
    return [Number(center[0]), Number(center[1])];
  }
  const coordinates = feature?.properties?.coordinates;
  if (
    coordinates &&
    Number.isFinite(Number(coordinates.longitude)) &&
    Number.isFinite(Number(coordinates.latitude))
  ) {
    return [Number(coordinates.longitude), Number(coordinates.latitude)];
  }
  return null;
};

const focusOnSearchFeature = (feature) => {
  if (!map || !mapLoaded || !feature) return;
  const bbox = Array.isArray(feature?.bbox) && feature.bbox.length === 4 ? feature.bbox : null;
  const center = getSearchFeatureCenter(feature);
  if (bbox) {
    map.fitBounds(
      [
        [Number(bbox[0]), Number(bbox[1])],
        [Number(bbox[2]), Number(bbox[3])],
      ],
      { padding: 80, maxZoom: 12 },
    );
  } else if (center) {
    const isLocal = feature?.properties?.resultSource === "ebd-location";
    map.flyTo({
      center,
      zoom: isLocal ? Math.max(map.getZoom(), 12.5) : Math.max(map.getZoom(), 10),
      essential: true,
    });
  }
  if (center) {
    setSearchHighlight(center);
  }
};

const searchLocalLocations = (query) => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery || normalizedQuery.length < 2) return [];
  const currentBounds = map?.getBounds?.() || null;
  return searchableLocations.value
    .map((location) => {
      let score = 0;
      if (location.normalizedLocality.startsWith(normalizedQuery)) {
        score += 200;
      } else if (location.normalizedLocality.includes(normalizedQuery)) {
        score += 120;
      } else if (location.normalizedDetail.includes(normalizedQuery)) {
        score += 60;
      } else {
        return null;
      }
      if (location.localityHotspot) score += 10;
      if (
        currentBounds &&
        currentBounds.contains({ lng: location.center[0], lat: location.center[1] })
      ) {
        score += 15;
      }
      return {
        score,
        feature: {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: location.center,
          },
          center: location.center,
          place_name: location.placeName,
          text: location.locality,
          place_type: ["place"],
          properties: {
            resultSource: "ebd-location",
            locality_id: location.id,
            locality_hotspot: location.localityHotspot,
          },
        },
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.feature.place_name.localeCompare(b.feature.place_name))
    .slice(0, 8)
    .map((entry) => entry.feature);
};

const setupLocationSearch = () => {
  if (!map || locationSearchControl || !locationSearchContainer.value) return;
  locationSearchControl = new MapboxGeocoder({
    accessToken: mapboxgl.accessToken,
    mapboxgl,
    marker: false,
    flyTo: false,
    minLength: 2,
    limit: 8,
    reverseGeocode: false,
    enableEventLogging: false,
    localGeocoderOnly: false,
    localGeocoder: searchLocalLocations,
    placeholder: "Search EBD location or place",
  });
  locationSearchControl.on("result", (event) => {
    focusOnSearchFeature(event?.result || null);
  });
  locationSearchControl.on("clear", () => {
    clearSearchHighlight();
  });
  locationSearchContainer.value.appendChild(locationSearchControl.onAdd(map));
};

const teardownLocationSearch = () => {
  if (!locationSearchControl) return;
  locationSearchControl.onRemove();
  locationSearchControl = null;
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
    }, { promptOnConflict: false });
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
        }, { promptOnConflict: false }),
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
    const handlePoint = turfDestination(center, radiusKm, bearing, { units: "kilometers" });
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
  if (!visit || isBulkSelection.value) {
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
      updateVisitSources();
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
        const newRadius = turfDistance(currentCenter, [lng, lat], {
          units: "kilometers",
        });
        const safeRadius = Math.max(newRadius, 0.1);
        previewRadiusKm.value = safeRadius;
        updateVisitSources();
        updateRadiusHandlePositions(currentCenter, safeRadius, index);
      });

      marker.on("dragend", async () => {
        map.dragPan.enable();
        const { lng, lat } = marker.getLngLat();
        const currentVisit = selectedVisit.value || visit;
        const currentCenter = getEffectiveCenter(currentVisit);
        const newRadius = turfDistance(currentCenter, [lng, lat], {
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

const applyLoadedVisits = (nextVisits) => {
  visits.value = Array.isArray(nextVisits) ? nextVisits : [];
  if (visits.value.length > 0) {
    const exists = visits.value.some((visit) => String(visit.id) === String(selectedVisitId.value));
    if (!exists) {
      selectedVisitId.value = visits.value[0].id;
    }
  } else {
    selectedVisitId.value = "";
  }
  const availableIds = new Set(visits.value.map((visit) => String(visit.id)));
  if (multipleSelectionMode.value) {
    setSelectedVisitIds(selectedVisitIds.value.filter((id) => availableIds.has(id)));
  } else {
    setSelectedVisitIds(selectedVisitId.value ? [selectedVisitId.value] : []);
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

const loadVisits = async (tripId) => {
  if (!tripId) {
    applyLoadedVisits([]);
    return;
  }
  const nextVisits = await db.visits.where("tripId").equals(tripId).toArray();
  applyLoadedVisits(nextVisits);
};

const loadTripData = async (tripId) => {
  clearSearchHighlight();
  if (!tripId) {
    resetTripBundleLoader();
    resetAddMode();
    tripData.value = null;
    locations.value = [];
    applyLoadedVisits([]);
    updateMapData();
    return;
  }
  resetAddMode();
  const { bundle, isCurrent } = await loadTripBundle(tripId);
  if (!isCurrent) return;
  tripData.value = bundle.ebd;
  locations.value = tripData.value?.locations || [];
  applyLoadedVisits(bundle.visits);
  await nextTick();
  updateMapData();
  updateNonBirdingMarkers();
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
  const currentVisit = await db.visits.get(visitId);
  if (!currentVisit) {
    if (selectedTripId.value) {
      await loadVisits(selectedTripId.value);
    }
    return false;
  }

  const localUpdatedAt = Number(current?.updatedAt ?? 0);
  const dbUpdatedAt = Number(currentVisit.updatedAt ?? 0);
  if (current) {
    const shouldOverwrite = await resolveRecordConflict({
      label: "This visit",
      localUpdatedAt,
      currentUpdatedAt: dbUpdatedAt,
      reload: async () => {
        await loadVisits(selectedTripId.value);
      },
      promptOnConflict: options.promptOnConflict,
    });
    if (!shouldOverwrite) return false;
  }

  const needsStats = !options.skipStats && hasStatRelevantChange(current, updates);
  const nextUpdates = withUpdatedAt(updates);
  await db.visits.update(visitId, nextUpdates);
  if (index >= 0) {
    const nextVisits = visits.value.slice();
    nextVisits[index] = { ...nextVisits[index], ...nextUpdates };
    visits.value = nextVisits;
  }
  if (options.syncForm) {
    syncVisitForm();
  }
  if (needsStats) {
    scheduleVisitStats(visitId);
  }
  return true;
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
  if (!hasItineraryDetails.value) return;
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
  if (!hasItineraryDetails.value) return {};
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
  const visitsToDelete = isBulkSelection.value ? selectedVisits.value : [selectedVisit.value].filter(Boolean);
  if (!visitsToDelete.length) return;
  const sorted = getSortedVisits();
  const visitIds = new Set(visitsToDelete.map((visit) => String(visit.id)));
  const firstIndex = sorted.findIndex((visit) => visitIds.has(String(visit.id)));
  const fallbackVisitId = [
    ...sorted.slice(Math.max(0, firstIndex)),
    ...sorted.slice(0, Math.max(0, firstIndex)).reverse(),
  ].find((visit) => !visitIds.has(String(visit.id)))?.id;
  const confirmed = window.confirm(
    visitsToDelete.length === 1
      ? `Delete ${visitsToDelete[0].name || "this visit"}? This cannot be undone.`
      : `Delete ${visitsToDelete.length} visits? This cannot be undone.`,
  );
  if (!confirmed) return;

  const currentVisits = await Promise.all(visitsToDelete.map((visit) => db.visits.get(visit.id)));
  if (currentVisits.some((visit) => !visit)) {
    await loadVisits(selectedTripId.value);
    return;
  }
  for (const [index, currentVisit] of currentVisits.entries()) {
    const shouldDelete = await resolveRecordConflict({
      label: "A selected visit",
      localUpdatedAt: Number(visitsToDelete[index].updatedAt ?? 0),
      currentUpdatedAt: Number(currentVisit.updatedAt ?? 0),
      reload: async () => {
        await loadVisits(selectedTripId.value);
      },
    });
    if (!shouldDelete) return;
  }

  const affectedRouteIds = sorted.flatMap((visit, index) =>
    visitIds.has(String(visit.id)) ? [visit.id, sorted[index + 1]?.id].filter(Boolean) : [],
  );
  await db.visits.bulkDelete(visitsToDelete.map((visit) => visit.id));
  visits.value = visits.value.filter((visit) => !visitIds.has(String(visit.id)));
  const remainingSorted = getSortedVisits();
  selectedVisitId.value = fallbackVisitId || remainingSorted[0]?.id || "";
  setSelectedVisitIds(selectedVisitId.value ? [selectedVisitId.value] : []);
  multipleSelectionMode.value = false;
  selectionAnchorId.value = selectedVisitId.value ? String(selectedVisitId.value) : "";
  bulkShiftStatus.value = "";
  nameNeedsUpdate.value = false;
  await clearRouteForVisits(affectedRouteIds);
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
  if (!selectedTripId.value || isBulkSelection.value) return;
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
  if (key === "escape" && isBulkSelection.value) {
    event.preventDefault();
    finishMultipleSelection();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (key === "a") {
    event.preventDefault();
    startAddVisit();
  }
  if (key === "d") {
    event.preventDefault();
    deleteVisit();
  }
};

const locationFeatures = computed(() =>
  locations.value.map((location) => ({
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
  })),
);

const updateLocationsSource = () => {
  if (!map || !mapLoaded) return;
  const locationsSource = map.getSource("trip-locations");
  if (!locationsSource) return;
  locationsSource.setData({
    type: "FeatureCollection",
    features: locationFeatures.value,
  });
};

// Visit-derived layers only. Called on every pointer move while dragging a
// visit centre or radius handle, so it must stay proportional to visit count.
const updateVisitSources = () => {
  if (!map || !mapLoaded) return;

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
        selected: isVisitSelected(visit.id),
        type: getVisitType(visit),
        icon: getVisitTypeIcon(visit),
      },
    };
  });

  const visitAreaFeatures = visits.value
    .filter((visit) => getVisitType(visit) === "birding")
    .map((visit) => {
      const center = getEffectiveCenter(visit);
      return turfCircle(center, getEffectiveRadiusKm(visit), {
        units: "kilometers",
        steps: 64,
        properties: {
          id: visit.id,
          selected: isVisitSelected(visit.id),
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
};

const updateMapData = () => {
  updateLocationsSource();
  updateVisitSources();
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
        "#418440",
        "#f8ae1c",
      ],
      "circle-opacity": 0.85,
      "circle-stroke-color": "#07464e",
      "circle-stroke-width": 1,
    },
  });

  map.addSource("search-result-highlight", {
    type: "geojson",
    data: buildSearchHighlightData(),
  });

  map.addLayer({
    id: "search-result-highlight-ring",
    type: "circle",
    source: "search-result-highlight",
    paint: {
      "circle-radius": 12,
      "circle-color": "rgba(248, 174, 28, 0.18)",
      "circle-stroke-color": "#f8ae1c",
      "circle-stroke-width": 3,
    },
  });

  map.addLayer({
    id: "search-result-highlight-core",
    type: "circle",
    source: "search-result-highlight",
    paint: {
      "circle-radius": 5,
      "circle-color": "#cf7f10",
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
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
        "rgba(248, 174, 28, 0.24)",
        "rgba(7, 70, 78, 0.12)",
      ],
      "fill-outline-color": "rgba(7, 70, 78, 0.32)",
    },
  });

  map.addLayer({
    id: "visit-areas-outline",
    type: "line",
    source: "visit-areas",
    paint: {
      "line-color": ["case", ["boolean", ["get", "selected"], false], "#f8ae1c", "#07464e"],
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
      "line-color": "#cf7f10",
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
      "line-color": "#cf7f10",
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
        "#f8ae1c",
        ["case", ["==", ["get", "type"], "birding"], "#07464e", "#7a8b84"],
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
  updateNonBirdingMarkers();
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
  map.addControl(new mapboxgl.ScaleControl({ maxWidth: 80, unit: "metric" }), "bottom-left");
  mapStyleControl = new MapStyleControl({
    initialStyle: mapStyle.value,
    onStyleChange: (style) => {
      mapStyle.value = style;
    },
  });
  map.addControl(mapStyleControl, "top-right");
  setupLocationSearch();
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

watch(
  selectedTripId,
  (tripId) => {
    multipleSelectionMode.value = false;
    selectedVisitIds.value = [];
    selectionAnchorId.value = "";
    bulkShiftStatus.value = "";
    loadTripData(tripId);
  },
  { immediate: true },
);
watch(selectedVisitId, () => {
  if (!multipleSelectionMode.value) {
    setSelectedVisitIds(selectedVisitId.value ? [selectedVisitId.value] : []);
  }
  syncVisitForm();
  nameNeedsUpdate.value = false;
  updateVisitSources();
  clearVisitMarkers();
  updateVisitMarkers();
  if (skipNextFocus.value) {
    skipNextFocus.value = false;
    return;
  }
  focusOnVisit();
  scrollToSelectedVisit();
});
watch(selectedVisitIds, () => {
  updateVisitSources();
  clearVisitMarkers();
  updateVisitMarkers();
});
watch(visits, () => {
  updateVisitSources();
  updateNonBirdingMarkers();
  updateVisitMarkers();
});
watch(mapStyle, (style) => {
  mapStyleControl?.setStyle(style);
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
  nextTick(initMap);
  window.addEventListener("keydown", handleKeydown);
});

onBeforeUnmount(() => {
  clearTimeout(commentFeedbackTimer);
  visitStatsTimers.forEach((timer) => clearTimeout(timer));
  visitStatsTimers.clear();
  if (searchHighlightTimer) {
    clearTimeout(searchHighlightTimer);
    searchHighlightTimer = null;
  }
  teardownLocationSearch();
  if (map && mapStyleControl) map.removeControl(mapStyleControl);
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
              <button
                class="btn btn-outline-primary btn-sm"
                @click="startAddVisit"
                :disabled="!selectedTripId || isBulkSelection"
              >
                <i :class="addingVisit ? 'bi bi-x-lg' : 'bi bi-plus-lg'"></i>
                <span class="ms-1 d-none d-md-inline">{{ addingVisit ? "Cancel" : "Add" }}</span>
              </button>
              <button
                class="btn btn-outline-danger btn-sm"
                @click="deleteVisit"
                :disabled="!selectedVisitCount"
                :title="isBulkSelection ? 'Delete selected visits' : 'Delete visit'"
              >
                <i class="bi bi-trash3"></i>
              </button>
              <button
                class="btn btn-sm app-action-btn app-action-btn--green"
                @click="exportVisits"
                :disabled="!selectedTripId || !visits.length"
              >
                <i class="bi bi-download"></i>
                <span class="ms-1 d-none d-md-inline">Export</span>
              </button>
              <button
                class="btn btn-sm app-action-btn app-action-btn--teal"
                @click="importVisits"
                :disabled="!selectedTripId || isBulkSelection"
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
              :class="{ 'is-full': !hasItineraryDetails }"
            >
              <template v-for="group in groupedVisits" :key="group.dateKey">
                <div
                  class="small fw-semibold text-muted bg-light py-1 px-3 border-top border-bottom position-sticky top-0"
                >
                  <div class="d-flex align-items-center justify-content-between gap-2">
                    <span>{{ group.dateKey }}</span>
                    <div class="d-inline-flex align-items-center gap-2 small text-muted">
                      <span
                        v-if="group.driveLabel"
                        class="d-inline-flex align-items-center gap-1 text-nowrap"
                      >
                        <i class="bi bi-signpost-split"></i>
                        {{ group.driveLabel }}
                      </span>
                      <span
                        v-if="group.birdingLabel"
                        class="d-inline-flex align-items-center gap-1 text-nowrap"
                      >
                        <i class="bi bi-feather"></i>
                        {{ group.birdingLabel }}
                      </span>
                    </div>
                  </div>
                </div>
                <button
                  v-for="visit in group.visits"
                  :key="visit.id"
                  type="button"
                  class="list-group-item list-group-item-action"
                  :data-visit-id="visit.id"
                  :class="{ active: isVisitSelected(visit.id) }"
                  :aria-pressed="isVisitSelected(visit.id)"
                  @click="handleVisitSelection(visit.id, $event)"
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
                        v-if="visit.globalIndex !== 0"
                        class="btn btn-outline-secondary btn-sm"
                        type="button"
                        @click.stop="computeRouteSegment(visit.id)"
                        :disabled="routeLoadingId === String(visit.id)"
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
              v-if="hasItineraryDetails"
              class="build-trip-splitter"
              role="separator"
              aria-label="Resize itinerary panels"
              @pointerdown="startSplitDrag"
            >
              <i class="bi bi-grip-horizontal" aria-hidden="true"></i>
            </div>
            <transition name="slide">
              <div
                v-if="isBulkSelection"
                class="build-trip-edit bulk-visit-edit bg-white shadow-sm"
              >
                <div class="mb-3">
                  <div class="fw-semibold text-dark">
                    {{ selectedVisitCount }} {{ selectedVisitCount === 1 ? "visit" : "visits" }} selected
                  </div>
                  <div class="small text-muted mt-1">
                    Use Cmd/Ctrl-click to add or remove visits, Shift-click to select a range, or
                    click without a modifier to return to a single visit.
                  </div>
                </div>

                <label class="form-label" for="bulk-shift-amount">Shift date and time</label>
                <div class="small text-muted mb-2">
                  Enter a positive or negative amount to shift every dated visit. Day and week
                  shifts preserve each visit's local clock time.
                </div>
                <div class="input-group mb-2">
                  <input
                    id="bulk-shift-amount"
                    v-model.number="bulkShiftAmount"
                    type="number"
                    step="1"
                    class="form-control"
                    aria-label="Date shift amount"
                  />
                  <select v-model="bulkShiftUnit" class="form-select" aria-label="Date shift unit">
                    <option value="hours">hours</option>
                    <option value="days">days</option>
                    <option value="weeks">weeks</option>
                  </select>
                  <button
                    class="btn btn-primary"
                    type="button"
                    @click="applyBulkDateShift()"
                    :disabled="!selectedVisitCount || !Number(bulkShiftAmount) || isApplyingBulkShift"
                  >
                    <span v-if="isApplyingBulkShift" class="spinner-border spinner-border-sm"></span>
                    <span v-else>Apply</span>
                  </button>
                </div>
                <div v-if="bulkShiftStatus" class="small text-success mt-2">
                  <i class="bi bi-check-circle me-1"></i>{{ bulkShiftStatus }}
                </div>
                <template v-if="selectedBirdingVisitCount">
                  <div class="mt-3">
                    <label class="form-label">Observer comments</label>
                    <div class="d-flex gap-2">
                      <button
                        class="btn btn-outline-secondary btn-sm flex-fill"
                        type="button"
                        @click="exportVisitComments('copy')"
                        :disabled="isExportingComments"
                      >
                        <i
                          class="bi me-1"
                          :class="commentExportDone === 'copied' ? 'bi-check-lg' : 'bi-clipboard'"
                        ></i>
                        {{
                          commentExportDone === "copied"
                            ? "Copied"
                            : commentExportDone === "copy-failed"
                              ? "Copy failed"
                              : "Copy"
                        }}
                      </button>
                      <button
                        class="btn btn-outline-secondary btn-sm flex-fill"
                        type="button"
                        @click="exportVisitComments('download')"
                        :disabled="isExportingComments"
                      >
                        <i
                          class="bi me-1"
                          :class="commentExportDone === 'downloaded' ? 'bi-check-lg' : 'bi-filetype-md'"
                        ></i>
                        {{ commentExportDone === "downloaded" ? "Downloaded" : "Download" }}
                      </button>
                    </div>
                  </div>
                  <div class="text-muted small mt-3">
                    {{ selectedVisitAreaStats.species }} species ·
                    {{ selectedVisitAreaStats.checklists }} checklists ·
                    {{ selectedVisitAreaStats.locations }} locations
                    <template v-if="selectedVisitAreaStats.durationLabel">
                      · duration: {{ selectedVisitAreaStats.durationLabel }}
                    </template>
                    <template v-if="selectedVisitAreaStats.distanceLabel">
                      · distance: {{ selectedVisitAreaStats.distanceLabel }}
                    </template>
                  </div>
                </template>
              </div>
              <div v-else-if="selectedVisit" class="build-trip-edit bg-white shadow-sm">
              <div class="d-flex align-items-center justify-content-between gap-2 mb-2">
                <div class="fw-semibold small text-dark">Details</div>
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
              <div class="mb-2" v-if="visitForm.type === 'birding'">
                <label class="form-label">
                  <i class="bi bi-star-fill text-warning me-1"></i>
                  Species of interest
                </label>
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
                    class="species-select app-vselect app-vselect--compact"
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
                <div class="mb-2">
                  <label class="form-label">Notes</label>
                  <textarea
                    v-model="visitForm.note"
                    rows="2"
                    class="form-control"
                    @input="saveVisitDetails"
                  ></textarea>
                </div>
                <div class="mt-2" v-if="visitForm.type === 'birding'">
                  <label class="form-label">Observer comments</label>
                  <div class="d-flex gap-2">
                    <button
                      class="btn btn-outline-secondary btn-sm flex-fill"
                      type="button"
                      @click="exportVisitComments('copy')"
                      :disabled="isExportingComments"
                    >
                      <i
                        class="bi me-1"
                        :class="commentExportDone === 'copied' ? 'bi-check-lg' : 'bi-clipboard'"
                      ></i>
                      {{
                        commentExportDone === "copied"
                          ? "Copied"
                          : commentExportDone === "copy-failed"
                            ? "Copy failed"
                            : "Copy"
                      }}
                    </button>
                    <button
                      class="btn btn-outline-secondary btn-sm flex-fill"
                      type="button"
                      @click="exportVisitComments('download')"
                      :disabled="isExportingComments"
                    >
                      <i
                        class="bi me-1"
                        :class="commentExportDone === 'downloaded' ? 'bi-check-lg' : 'bi-filetype-md'"
                      ></i>
                      {{ commentExportDone === "downloaded" ? "Downloaded" : "Download" }}
                    </button>
                  </div>
                </div>
                <div class="text-muted small mt-3" v-if="visitForm.type === 'birding'">
                  {{ selectedVisitStats.species }} species ·
                  {{ selectedVisitStats.checklists }} checklists ·
                  {{ selectedVisitStats.locations }} locations
                  <template v-if="selectedVisitStats.medianDurationLabel">
                    · duration: {{ selectedVisitStats.medianDurationLabel }}
                  </template>
                  <template v-if="selectedVisitStats.distanceLabel">
                    · distance: {{ selectedVisitStats.distanceLabel }}
                  </template>
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
          <div ref="locationSearchContainer" class="build-trip-search-overlay"></div>
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
.build-trip-search-overlay {
  position: absolute;
  top: 0.75rem;
  left: 0.75rem;
  right: 0.75rem;
  z-index: 4;
  pointer-events: none;
}

.build-trip-search-overlay:empty {
  display: none;
}

.build-trip-search-overlay :deep(*) {
  pointer-events: auto;
}

.build-trip-search-overlay :deep(.mapboxgl-ctrl-geocoder) {
  width: min(100%, 520px);
  max-width: 100%;
  min-width: 0;
  box-shadow: 0 10px 24px rgba(var(--app-color-deep-teal-rgb), 0.16);
  border: 1px solid rgba(var(--app-color-deep-teal-rgb), 0.14);
  border-radius: 12px;
}

.build-trip-search-overlay :deep(.mapboxgl-ctrl-geocoder--icon) {
  top: 50%;
  transform: translateY(-50%);
}

.build-trip-search-overlay :deep(.mapboxgl-ctrl-geocoder--input) {
  height: 46px;
  font-size: 0.95rem;
}

:deep(.map-style-control) {
  position: relative;
}

:deep(.map-style-control__toggle) {
  font-size: 1.05rem;
}

@media (max-width: 576px) {
  :deep(.map-style-control__toggle) {
    width: 40px;
    height: 40px;
  }
}

.visit-type-marker {
  background: #ffffff;
  border: 1px solid rgba(var(--app-color-deep-teal-rgb), 0.18);
  border-radius: 999px;
  padding: 4px 6px;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.15);
  color: var(--app-color-deep-teal);
  font-size: 0.95rem;
}

.species-select :deep(.vs__selected-options) {
  flex-wrap: wrap;
  overflow: visible;
}

.species-select :deep(.vs__selected) {
  padding: 2px 6px;
  white-space: normal;
  background: rgba(var(--app-color-gold-rgb), 0.18);
  border-color: rgba(var(--app-color-gold-rgb), 0.34);
  color: var(--app-color-ink);
}

.list-group-item.active .text-muted,
.list-group-item.active .text-muted.small {
  color: rgba(255, 255, 255, 0.85) !important;
}

.list-group-item.active .fw-semibold,
.list-group-item.active .small {
  color: #ffffff;
}

.bulk-visit-edit {
  border-top: 3px solid var(--app-color-gold);
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
  background: rgba(var(--app-color-deep-teal-rgb), 0.05);
  border-top: 1px solid rgba(var(--app-color-deep-teal-rgb), 0.12);
  border-bottom: 1px solid rgba(var(--app-color-deep-teal-rgb), 0.12);
  cursor: row-resize;
  flex: 0 0 auto;
  touch-action: none;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(var(--app-color-slate-rgb), 0.7);
  font-size: 0.8rem;
}

.build-trip-edit {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0.5rem 1rem 1rem;
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
  border: 2px solid var(--app-color-gold);
  border-radius: 50%;
  background: var(--app-color-gold);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  cursor: ew-resize;
}

:deep(.visit-center-handle) {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--app-color-gold);
  border: 2px solid #ffffff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
}

@media (max-width: 991.98px) {
  .build-trip-search-overlay {
    top: 4.25rem;
  }

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

@media (min-width: 992px) {
  .build-trip-search-overlay {
    right: auto;
  }
}
</style>
