<script setup>
import { ref, computed, onMounted, watch, nextTick } from "vue";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import * as turf from "@turf/turf";
import vSelect from "vue-select";
import "vue-select/dist/vue-select.css";
import { db } from "../data/db";
import { trips, selectedTripId, refreshTrips } from "../state/tripSelection";

const tripData = ref(null);

const speciesList = ref([]);
const locations = ref([]);
const region = ref({ code: "", name: "" });

const filters = ref({
  dbscanDistance: 1,
  minChecklist: 5,
});

const isProcessing = ref(false);
const clusteredLocations = ref([]);
const clusterSpeciesCounts = ref(new Map());

const selectedSpeciesCode = ref("");
const isMobilePanelOpen = ref(false);

const mapContainer = ref(null);
let map = null;
let mapLoaded = false;
let popup = null;
const mapStyle = ref("mapbox://styles/mapbox/outdoors-v12");
const isSatellite = computed({
  get: () => mapStyle.value === "mapbox://styles/mapbox/satellite-streets-v12",
  set: (value) => {
    mapStyle.value = value
      ? "mapbox://styles/mapbox/satellite-streets-v12"
      : "mapbox://styles/mapbox/outdoors-v12";
  },
});

mapboxgl.accessToken = "pk.eyJ1IjoicmFmbnVzcyIsImEiOiIzMVE1dnc0In0.3FNMKIlQ_afYktqki-6m0g";

const hasTripData = computed(() => {
  return tripData.value && Array.isArray(locations.value) && locations.value.length > 0;
});

const selectedSpeciesLabel = computed(() => {
  if (!selectedSpeciesCode.value) return "";
  const match = speciesList.value.find((species) => species.code === selectedSpeciesCode.value);
  return match ? match.commonName : selectedSpeciesCode.value;
});

const selectedTrip = computed(
  () => trips.value.find((trip) => trip.id === selectedTripId.value) || null,
);

const speciesCount = computed(() => speciesList.value.length);
const locationCount = computed(() => locations.value.length);
const checklistCount = computed(() =>
  locations.value.reduce((sum, loc) => sum + getLocationChecklistCount(loc), 0),
);
const sizeLegend = computed(() => {
  const counts = clusteredLocations.value.map((loc) => loc.checklist_count || 0);
  if (!counts.length) return { min: 0, max: 0 };
  return { min: Math.min(...counts), max: Math.max(...counts) };
});
const colorLegend = computed(() => {
  if (selectedSpeciesCode.value) {
    return {
      label: `Reporting rate (${selectedSpeciesLabel.value})`,
      min: 0,
      max: Math.round(maxClusterRate.value * 100),
      unit: "%",
    };
  }
  const counts = clusteredLocations.value.map((loc) => loc.species_count || 0);
  if (!counts.length) return { label: "Species richness", min: 0, max: 0, unit: "" };
  return {
    label: "Species richness",
    min: Math.min(...counts),
    max: Math.max(...counts),
    unit: "",
  };
});

const getLocationChecklistEntries = (location) => {
  const entries = Array.isArray(location.checklist) ? location.checklist : [];
  return entries.filter((entry) => entry.all_species_reported === true);
};

const getLocationChecklistCount = (location) => {
  return getLocationChecklistEntries(location).length;
};

const buildSpeciesCountsMap = (entries) => {
  const counts = new Map();
  entries.forEach((entry) => {
    const uniqueCodes = new Set(
      (entry.species || []).map((species) => species.code).filter(Boolean),
    );
    uniqueCodes.forEach((code) => {
      counts.set(code, (counts.get(code) || 0) + 1);
    });
  });
  return counts;
};

const getLocationSpeciesCountsMap = (location) => {
  const entries = getLocationChecklistEntries(location);
  return buildSpeciesCountsMap(entries);
};

const escapeHtml = (value) => {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const buildChecklistRowsForSpecies = (entries, selectedCode) => {
  return (entries || [])
    .map((entry) => {
      const match = (entry.species || []).find((species) => species.code === selectedCode);
      if (!match) return null;
      const rawTime = entry.time || "";
      const timeParts = rawTime.split(":");
      const hhmm = timeParts.length >= 2 ? `${timeParts[0]}:${timeParts[1]}` : rawTime;
      const dateTime = `${entry.date || ""} ${hhmm}`.trim();
      const checklistId = entry.checklist_id || "";
      const checklistUrl = checklistId
        ? `https://ebird.org/checklist/${checklistId}#${selectedCode}`
        : "";
      return {
        dateTime: dateTime || "Unknown",
        count: match.count ?? "",
        comment: match.species_comment || "",
        checklistUrl,
      };
    })
    .filter(Boolean);
};

const buildKmlDescription = (location, rows) => {
  if (!rows.length) return "";
  const listItems = rows
    .map((row) => {
      const dateLabel = row.checklistUrl
        ? `<a href="${escapeHtml(row.checklistUrl)}" target="_blank">${escapeHtml(
            row.dateTime,
          )}</a>`
        : escapeHtml(row.dateTime);
      const countLabel = row.count !== "" ? ` · count ${escapeHtml(row.count)}` : "";
      const commentLabel = row.comment ? ` · ${escapeHtml(row.comment)}` : "";
      return `<li>${dateLabel}${countLabel}${commentLabel}</li>`;
    })
    .join("");
  return `
    <![CDATA[
      <div>
        <strong>${escapeHtml(location.locality || "Unknown location")}</strong><br/>
        <ul>
          ${listItems}
        </ul>
      </div>
    ]]>
  `;
};

const exportKml = () => {
  const selectedCode = selectedSpeciesCode.value;
  if (!selectedCode) {
    window.alert("Select a species before exporting KML.");
    return;
  }
  const placemarks = locations.value
    .map((location) => {
      const entries = getLocationChecklistEntries(location);
      const rows = buildChecklistRowsForSpecies(entries, selectedCode);
      if (!rows.length) return null;
      const lon = Number(location.longitude);
      const lat = Number(location.latitude);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      const name = escapeHtml(location.locality || "Location");
      const description = buildKmlDescription(location, rows);
      return `
        <Placemark>
          <name>${name}</name>
          ${description ? `<description>${description}</description>` : ""}
          <styleUrl>#speciesPoint</styleUrl>
          <Point><coordinates>${lon},${lat},0</coordinates></Point>
        </Placemark>
      `;
    })
    .filter(Boolean)
    .join("");

  if (!placemarks) {
    window.alert("No locations found for this species.");
    return;
  }

  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeHtml(selectedSpeciesLabel.value || selectedCode)}</name>
    <Style id="speciesPoint">
      <IconStyle>
        <color>ff5a8dee</color>
        <scale>1.1</scale>
        <Icon>
          <href>http://maps.google.com/mapfiles/kml/paddle/grn-circle.png</href>
        </Icon>
      </IconStyle>
    </Style>
    ${placemarks}
  </Document>
</kml>`;

  const blob = new Blob([kml], { type: "application/vnd.google-earth.kml+xml" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `species-${selectedCode}-locations.kml`;
  anchor.click();
  URL.revokeObjectURL(url);
};

const formatChecklistLabel = (count) => {
  return `${count} checklist${count === 1 ? "" : "s"}`;
};

const buildSpeciesTable = (entries, selectedCode) => {
  const rows = (entries || [])
    .map((entry) => {
      const match = (entry.species || []).find((species) => species.code === selectedCode);
      if (!match) return null;
      const rawTime = entry.time || "";
      const timeParts = rawTime.split(":");
      const hhmm = timeParts.length >= 2 ? `${timeParts[0]}:${timeParts[1]}` : rawTime;
      const dateTime = `${entry.date || ""} ${hhmm}`.trim();
      const checklistId = entry.checklist_id || "";
      const dateTimeLabel = escapeHtml(dateTime || "Unknown");
      const dateTimeLink = checklistId
        ? `<a href="https://ebird.org/checklist/${escapeHtml(checklistId)}#${escapeHtml(
            selectedCode,
          )}" target="_blank">${dateTimeLabel}</a>`
        : dateTimeLabel;
      return `<tr>
        <td>${dateTimeLink}</td>
        <td>${escapeHtml(match.count ?? "")}</td>
        <td>${escapeHtml(match.species_comment || "")}</td>
      </tr>`;
    })
    .filter(Boolean)
    .join("");
  if (!rows) return "";
  return `
    <div class="species-popup-table-wrap">
      <table class="table table-sm table-striped align-middle species-popup-table">
      <thead>
        <tr>
          <th>Date/Time</th>
          <th class="text-end">Count</th>
          <th>Comments</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
      </table>
    </div>
  `;
};

const buildPopupHtml = (location) => {
  const hotspot = location.hotspot;
  const localityLabel = hotspot?.id
    ? `<a href="https://ebird.org/hotspot/${hotspot.id}" target="_blank">${escapeHtml(
        hotspot.name,
      )}</a>`
    : escapeHtml(location.locality || "Unknown location");
  const checklistLabel = formatChecklistLabel(location.checklist_count);
  const selectedCode = selectedSpeciesCode.value;
  const speciesLabel = selectedCode
    ? (() => {
        const count = getSpeciesCount(location.cluster_id, selectedCode);
        const total = location.checklist_count;
        const percent = total ? Math.round((count / total) * 100) : 0;
        return `${percent}% reporting rate`;
      })()
    : `${location.species_count || 0} species`;
  const speciesTable = selectedCode
    ? buildSpeciesTable(location.checklists || [], selectedCode)
    : "";
  const locationCountLabel =
    location.location_count && location.location_count > 0
      ? `${location.location_count} location${location.location_count === 1 ? "" : "s"}`
      : "";
  return `
    <div class="species-popup">
      <div class="fw-semibold mb-1 species-popup-title">${localityLabel}</div>
      <div class="d-flex flex-wrap gap-2 mb-2">
        ${
          locationCountLabel
            ? `<span class="badge rounded-pill text-bg-light border">
          <i class="bi bi-geo-alt me-1"></i>${escapeHtml(locationCountLabel)}
        </span>`
            : ""
        }
        <span class="badge rounded-pill text-bg-light border">
          <i class="bi bi-clipboard-check me-1"></i>${escapeHtml(checklistLabel)}
        </span>
        <span class="badge rounded-pill text-bg-light border">
          <i class="bi bi-feather me-1"></i>${escapeHtml(speciesLabel)}
        </span>
      </div>
      ${speciesTable}
    </div>
  `;
};

const showClusterPopup = (feature) => {
  const location = JSON.parse(feature.properties.locationData);
  if (!popup) {
    popup = new mapboxgl.Popup({
      closeButton: true,
      closeOnClick: false,
      offset: 15,
    });
  }
  popup.setLngLat(feature.geometry.coordinates).setHTML(buildPopupHtml(location)).addTo(map);
};

const loadTripData = async (tripId) => {
  if (!tripId) {
    tripData.value = null;
    speciesList.value = [];
    locations.value = [];
    region.value = { code: "", name: "" };
    clusteredLocations.value = [];
    clusterSpeciesCounts.value = new Map();
    selectedSpeciesCode.value = "";
    return;
  }
  tripData.value = await db.ebd.where("tripId").equals(tripId).first();
  speciesList.value = tripData.value?.speciesList || [];
  locations.value = tripData.value?.locations || [];
  region.value = tripData.value?.region || { code: "", name: "" };
  selectedSpeciesCode.value = "";
  await nextTick();
  runDbscan();
};

const runDbscan = () => {
  if (!locations.value.length) {
    clusteredLocations.value = [];
    clusterSpeciesCounts.value = new Map();
    updateMapData();
    fitMapToClusters();
    return;
  }

  isProcessing.value = true;
  const validLocations = locations.value.filter(
    (loc) => Number.isFinite(Number(loc.longitude)) && Number.isFinite(Number(loc.latitude)),
  );
  if (validLocations.length !== locations.value.length) {
    const invalid = locations.value.filter(
      (loc) => !Number.isFinite(Number(loc.longitude)) || !Number.isFinite(Number(loc.latitude)),
    );
    console.warn("Skipping locations with invalid coordinates", invalid.slice(0, 5));
  }

  const locationMeta = validLocations.map((location) => {
    const entries = getLocationChecklistEntries(location);
    return {
      location,
      entries,
      checklistCount: entries.length,
      speciesCounts: buildSpeciesCountsMap(entries),
    };
  });

  const features = validLocations.map((loc) =>
    turf.point([Number(loc.longitude), Number(loc.latitude)], {
      checklistCount: loc.checklist_count,
      locationId: loc.locality_id,
    }),
  );

  const clustered = turf.clustersDbscan(
    turf.featureCollection(features),
    filters.value.dbscanDistance,
    {
      units: "kilometers",
      minPoints: 1,
    },
  );

  const clusterMap = new Map();
  const speciesMap = new Map();

  clustered.features.forEach((feature, idx) => {
    if (feature.properties.dbscan !== "core") return;
    const meta = locationMeta[idx];
    if (!meta || meta.checklistCount < filters.value.minChecklist) return;
    const location = meta.location;

    const clusterId = Number.isFinite(feature.properties.cluster)
      ? feature.properties.cluster
      : idx;

    if (!clusterMap.has(clusterId)) {
      clusterMap.set(clusterId, {
        cluster_id: clusterId,
        latitude: 0,
        longitude: 0,
        checklist_count: 0,
        localityCounts: new Map(),
        hotspotBest: null,
        location_count: 0,
        checklists: [],
      });
      speciesMap.set(clusterId, new Map());
    }

    const cluster = clusterMap.get(clusterId);
    cluster.latitude += location.latitude;
    cluster.longitude += location.longitude;
    cluster.checklist_count += meta.checklistCount;
    cluster.location_count += 1;

    const localityName = location.locality || "Unknown location";
    cluster.localityCounts.set(
      localityName,
      (cluster.localityCounts.get(localityName) || 0) + meta.checklistCount,
    );
    if (location.locality_hotspot && location.locality_id) {
      const currentBest = cluster.hotspotBest;
      if (!currentBest || meta.checklistCount > currentBest.count) {
        cluster.hotspotBest = {
          id: location.locality_id,
          name: localityName,
          count: meta.checklistCount,
        };
      }
    }

    const clusterSpecies = speciesMap.get(clusterId);
    for (const [code, count] of meta.speciesCounts.entries()) {
      clusterSpecies.set(code, (clusterSpecies.get(code) || 0) + count);
    }
    cluster.checklists.push(...meta.entries);
  });

  const clusters = Array.from(clusterMap.values()).map((cluster) => {
    let locality = "Unknown location";
    if (cluster.hotspotBest?.name) {
      locality = cluster.hotspotBest.name;
    } else {
      let topCount = -1;
      for (const [name, count] of cluster.localityCounts.entries()) {
        if (count > topCount) {
          topCount = count;
          locality = name;
        }
      }
    }
    const speciesCount = speciesMap.get(cluster.cluster_id)?.size || 0;
    return {
      cluster_id: cluster.cluster_id,
      latitude: cluster.latitude / cluster.location_count,
      longitude: cluster.longitude / cluster.location_count,
      locality,
      hotspot: cluster.hotspotBest,
      checklist_count: cluster.checklist_count,
      species_count: speciesCount,
      checklists: cluster.checklists,
    };
  });

  clusteredLocations.value = clusters;
  clusterSpeciesCounts.value = speciesMap;
  isProcessing.value = false;
  updateMapData();
  fitMapToClusters();
};

const getSpeciesCount = (clusterId, speciesCode) => {
  const counts = clusterSpeciesCounts.value.get(clusterId);
  if (!counts) return 0;
  return counts.get(speciesCode) || 0;
};

const clusterRateById = computed(() => {
  if (!selectedSpeciesCode.value) return new Map();
  const map = new Map();
  clusteredLocations.value.forEach((cluster) => {
    const counts = clusterSpeciesCounts.value.get(cluster.cluster_id);
    const count = counts?.get(selectedSpeciesCode.value) || 0;
    const rate = cluster.checklist_count ? count / cluster.checklist_count : 0;
    map.set(cluster.cluster_id, rate);
  });
  return map;
});

const maxClusterRate = computed(() => {
  if (!selectedSpeciesCode.value) return 0;
  const rates = Array.from(clusterRateById.value.values());
  return rates.length ? Math.max(...rates) : 0;
});

const setupMapLayers = () => {
  if (!map) return;
  if (!map.getSource("clusters")) {
    map.addSource("clusters", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [],
      },
    });
  }

  if (!map.getLayer("clusters-circle")) {
    map.addLayer({
      id: "clusters-circle",
      type: "circle",
      source: "clusters",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "size_normalized"], 0, 4, 1, 12],
        "circle-color": [
          "interpolate",
          ["linear"],
          ["get", "color_value"],
          0,
          "#c9cdd3",
          0.25,
          "#7aa5d2",
          0.5,
          "#4cc9f0",
          0.75,
          "#2fbf71",
          1,
          "#1b8a5a",
        ],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
      layout: {
        "circle-sort-key": ["get", "sort_key"],
      },
    });
  }

  map.off("mouseenter", "clusters-circle", handleClusterEnter);
  map.off("click", "clusters-circle", handleClusterClick);
  map.off("mouseleave", "clusters-circle", handleClusterLeave);
  map.on("mouseenter", "clusters-circle", handleClusterEnter);
  map.on("click", "clusters-circle", handleClusterClick);
  map.on("mouseleave", "clusters-circle", handleClusterLeave);

  map.off("click", handleMapClick);
  map.on("click", handleMapClick);
};

const handleClusterEnter = (e) => {
  map.getCanvas().style.cursor = "pointer";
  if (!e.features.length) return;
  showClusterPopup(e.features[0]);
};

const handleClusterClick = (e) => {
  if (!e.features.length) return;
  showClusterPopup(e.features[0]);
};

const handleClusterLeave = () => {
  map.getCanvas().style.cursor = "";
};

const handleMapClick = () => {
  if (popup) {
    popup.remove();
    popup = null;
  }
};

const initMap = () => {
  if (!mapContainer.value || map) return;

  map = new mapboxgl.Map({
    container: mapContainer.value,
    style: mapStyle.value,
    center: [0, 0],
    zoom: 1.2,
  });

  map.addControl(new mapboxgl.NavigationControl());

  map.on("load", () => {
    mapLoaded = true;
    setupMapLayers();
    updateMapData();
    fitMapToClusters();
  });
};

const fitMapToClusters = () => {
  if (!map || !mapLoaded) return;
  const points = clusteredLocations.value;
  if (!points.length) return;
  if (points.length === 1) {
    map.flyTo({
      center: [points[0].longitude, points[0].latitude],
      zoom: 12,
    });
    return;
  }
  const bounds = new mapboxgl.LngLatBounds();
  points.forEach((location) => {
    bounds.extend([location.longitude, location.latitude]);
  });
  try {
    map.fitBounds(bounds, { padding: 50, maxZoom: 15 });
  } catch (error) {
    console.warn("Could not fit bounds", error);
  }
};

const updateSelectedSpecies = (value) => {
  selectedSpeciesCode.value = value || "";
};

const openMobilePanel = () => {
  isMobilePanelOpen.value = true;
};

const closeMobilePanel = () => {
  isMobilePanelOpen.value = false;
};

const updateMapData = () => {
  if (!map || !mapLoaded || !map.getSource("clusters")) return;

  const checklistCounts = clusteredLocations.value.map((loc) => loc.checklist_count);
  const speciesCounts = clusteredLocations.value.map((loc) => loc.species_count || 0);

  const minSpeciesCount = speciesCounts.length ? Math.min(...speciesCounts) : 0;
  const maxSpeciesCount = speciesCounts.length ? Math.max(...speciesCounts) : 0;
  const minLogChecklist = checklistCounts.length ? Math.log(Math.min(...checklistCounts) + 1) : 0;
  const maxLogChecklist = checklistCounts.length ? Math.log(Math.max(...checklistCounts) + 1) : 0;
  const logRange = maxLogChecklist - minLogChecklist;
  const maxRate = maxClusterRate.value;

  const features = clusteredLocations.value.map((location) => {
    const logCount = Math.log(location.checklist_count + 1);
    const sizeNormalized = logRange > 0 ? (logCount - minLogChecklist) / logRange : 0.5;

    let colorValue = 0;
    let sortKey = 0;
    if (selectedSpeciesCode.value) {
      const rate = clusterRateById.value.get(location.cluster_id) || 0;
      colorValue = maxRate > 0 ? rate / maxRate : 0;
      sortKey = rate;
    } else if (maxSpeciesCount > minSpeciesCount) {
      colorValue = (location.species_count - minSpeciesCount) / (maxSpeciesCount - minSpeciesCount);
      sortKey = colorValue;
    } else {
      colorValue = 1;
      sortKey = 1;
    }

    return {
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [location.longitude, location.latitude],
      },
      properties: {
        id: location.cluster_id,
        size_normalized: sizeNormalized,
        color_value: colorValue,
        sort_key: sortKey,
        locationData: JSON.stringify(location),
      },
    };
  });

  map.getSource("clusters").setData({
    type: "FeatureCollection",
    features,
  });
};

watch(selectedTripId, loadTripData, { immediate: true });
watch(selectedSpeciesCode, updateMapData);
watch(hasTripData, (ready) => {
  if (ready) {
    nextTick(initMap);
  }
});
watch(mapStyle, (style) => {
  if (!map) return;
  const currentCenter = map.getCenter();
  const currentZoom = map.getZoom();
  map.setStyle(style);
  map.once("style.load", () => {
    mapLoaded = true;
    setupMapLayers();
    updateMapData();
    map.jumpTo({ center: currentCenter, zoom: currentZoom });
  });
});
watch(
  () => clusteredLocations.value,
  (newVal) => {
    if (newVal.length > 0 && map && mapLoaded) {
      updateMapData();
      fitMapToClusters();
    }
  },
  { deep: true },
);

onMounted(async () => {
  await refreshTrips();
  if (selectedTripId.value && !tripData.value) {
    await loadTripData(selectedTripId.value);
  }
  nextTick(initMap);
});
</script>

<template>
  <div class="position-relative flex-grow-1 h-100" style="min-height: 70vh">
    <div
      ref="mapContainer"
      class="species-map-canvas position-absolute top-0 bottom-0 start-0 end-0 w-100 h-100 overflow-hidden"
    ></div>
    <div
      class="position-absolute top-0 start-0 d-sm-none pe-auto"
      v-if="tripData && !isMobilePanelOpen"
      style="z-index: 4"
    >
      <button class="btn btn-light shadow-sm m-0 m-sm-3" type="button" @click="openMobilePanel">
        <i class="bi bi-sliders"></i>
        <span class="visually-hidden">Open species map panel</span>
      </button>
    </div>

    <div
      class="species-map-overlay position-absolute top-0 start-0 m-0 m-sm-3 d-flex gap-3 pe-none"
      style="z-index: 3"
    >
      <div class="species-map-panel flex-column gap-3 pe-auto" :class="{ 'is-open': isMobilePanelOpen }">
        <div class="card shadow-sm" v-if="tripData">
          <div class="card-body">
            <div class="d-flex align-items-center justify-content-between mb-1 gap-2">
              <div class="fw-semibold">Species map</div>
              <div class="d-flex align-items-center gap-2">
                <div class="form-check form-switch mb-0">
                  <input
                    id="satelliteToggleSpecies"
                    class="form-check-input"
                    type="checkbox"
                    v-model="isSatellite"
                  />
                  <label class="form-check-label small" for="satelliteToggleSpecies">Hybrid</label>
                </div>
                <button
                  class="btn btn-sm btn-outline-secondary d-sm-none"
                  type="button"
                  aria-label="Close species map panel"
                  @click="closeMobilePanel"
                >
                  <i class="bi bi-x-lg"></i>
                </button>
              </div>
            </div>
            <div class="text-muted small mb-2">
              Map reporting rate by species using complete checklists and aggregated locations.
            </div>
            <div class="mb-2">
              <v-select
                v-model="selectedSpeciesCode"
                :options="speciesList"
                label="commonName"
                :reduce="(species) => species.code"
                :clearable="true"
                :searchable="true"
                placeholder="Search species"
                class="species-select"
                @update:modelValue="updateSelectedSpecies"
              >
                <template #option="{ commonName, scientificName, code }">
                  <div class="d-flex flex-column">
                    <span class="fw-semibold">{{ commonName || code }}</span>
                    <span class="text-muted small" v-if="scientificName">
                      {{ scientificName }} · {{ code }}
                    </span>
                  </div>
                </template>
                <template #selected-option="{ commonName, code }">
                  <span class="small">{{ commonName || code }}</span>
                </template>
              </v-select>
            </div>
            <div class="trip-summary text-muted small mb-2" v-if="tripData">
              {{ speciesCount }} species · {{ checklistCount }} checklists ·
              {{ locationCount }} locations
            </div>
            <hr class="my-2" />

            <div class="fw-semibold small mb-1">Location aggregation</div>
            <div class="text-muted small mb-2">
              Cluster nearby checklists using DBSCAN to consolidate reporting rate.
            </div>
            <div class="d-flex align-items-center flex-wrap gap-2 mb-2 text-muted small">
              <label for="dbscanDistance" class="form-label mb-0">Distance</label>
              <input
                type="number"
                id="dbscanDistance"
                v-model.number="filters.dbscanDistance"
                class="form-control form-control-sm w-auto"
                step="0.01"
                min="0.01"
                max="10"
                style="width: 64px"
              />
              <span class="text-muted small">km</span>
              <label for="minChecklist" class="form-label mb-0 ms-2">Min checklists</label>
              <input
                type="number"
                id="minChecklist"
                v-model.number="filters.minChecklist"
                class="form-control form-control-sm w-auto"
                min="1"
                max="100"
                style="width: 64px"
              />
            </div>
            <button
              @click="runDbscan"
              class="btn btn-primary btn-sm w-100"
              :disabled="isProcessing"
            >
              <span v-if="isProcessing" class="spinner-border spinner-border-sm me-2"></span>
              {{ isProcessing ? "Processing..." : "Process Clusters" }}
            </button>
            <div class="text-muted small mt-2">
              {{ clusteredLocations.length }} clusters across {{ locationCount }} locations
            </div>
            <hr class="my-2" />
            <div class="d-flex flex-column gap-2 mt-2">
              <div class="fw-semibold small">Legend</div>
              <div class="d-flex flex-column gap-1">
                <div class="text-muted small">{{ colorLegend.label }}</div>
                <div class="legend-gradient"></div>
                <div class="d-flex justify-content-between text-muted small">
                  <span>{{ colorLegend.min }}{{ colorLegend.unit }}</span>
                  <span>{{ colorLegend.max }}{{ colorLegend.unit }}</span>
                </div>
              </div>
            </div>
            <div v-if="selectedSpeciesCode">
              <hr class="my-2" />
              <div class="fw-semibold small mb-1">Export sightings</div>
              <div class="text-muted small mb-2">
                Export KML for the selected species to view checklists in other apps.
              </div>
              <button class="btn btn-outline-secondary w-100" @click="exportKml">
                <i class="bi bi-download me-1"></i>
                Export KML
              </button>
            </div>
          </div>
        </div>

        <div class="alert alert-warning shadow-sm" v-else-if="selectedTripId">
          No processed locations found. Reprocess the trip in Create.
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.species-select :deep(.vs__dropdown-toggle) {
  min-height: 44px;
  padding: 6px 12px;
  border-radius: 10px;
  background: #ffffff;
  display: flex;
  align-items: center;
  font-size: 1rem;
}

.species-select :deep(.vs__selected-options) {
  flex-wrap: nowrap;
  overflow: hidden;
  gap: 4px;
  align-items: center;
}

.species-select :deep(.vs__selected) {
  margin: 0;
  padding: 2px 6px;
  font-size: 0.95rem;
  white-space: nowrap;
}

.species-select :deep(.vs__search) {
  margin: 0;
  padding: 0;
  font-size: 1rem;
}

.species-select :deep(.vs__actions) {
  display: flex;
  align-items: center;
}

.species-select :deep(.vs__dropdown-menu) {
  max-height: 240px;
}

.species-map-panel {
  display: flex;
  width: 360px;
  max-width: calc(100vw - 32px);
}

@media (max-width: 575.98px) {
  .species-map-overlay {
    position: absolute !important;
    inset: 0;
    margin: 0 !important;
  }

  .species-map-panel {
    display: none !important;
    width: 100%;
    max-width: none;
    height: 100%;
  }

  .species-map-panel.is-open {
    display: flex !important;
  }

  .species-map-panel.is-open .card,
  .species-map-panel.is-open .alert {
    height: 100%;
    border-radius: 0;
  }

  .species-map-panel.is-open .card-body,
  .species-map-panel.is-open .alert {
    overflow-y: auto;
  }
}

.legend-gradient {
  height: 10px;
  border-radius: 999px;
  background: linear-gradient(
    90deg,
    #c9cdd3 0%,
    #7aa5d2 25%,
    #4cc9f0 50%,
    #2fbf71 75%,
    #1b8a5a 100%
  );
  border: 1px solid rgba(0, 0, 0, 0.08);
}

:deep(.species-popup-table) {
  width: 100%;
  margin-top: 6px;
  font-size: 0.72rem;
}

:deep(.species-popup-table-wrap) {
  max-height: 180px;
  overflow-y: auto;
  margin-top: 6px;
  padding-right: 4px;
}

:deep(.species-popup) {
  max-height: 260px;
}

:deep(.species-popup-title) {
  font-size: 0.95rem;
}

:deep(.mapboxgl-popup-content) {
  max-height: 280px;
  overflow: hidden;
  pointer-events: auto;
}

:deep(.mapboxgl-popup) {
  pointer-events: auto;
}

.species-popup :deep(.badge) {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.35rem 0.6rem;
}

@media (max-width: 992px) {
  .species-map-canvas {
    position: relative !important;
    height: 420px;
  }
}
</style>
