<script setup>
import { ref, onMounted, watch, computed, nextTick } from "vue";
import { Tooltip } from "bootstrap";
import vSelect from "vue-select";
import "vue-select/dist/vue-select.css";
import { db } from "../data/db";
import { trips, selectedTripId, refreshTrips } from "../state/tripSelection";
import { selectedVisitId } from "../state/visitSelection";

const trip = ref(null);
const ebd = ref(null);
const visits = ref([]);
const locations = ref([]);
const speciesList = ref([]);

const sortKey = ref("rank");
const sortDir = ref("asc");
const liferFilters = ref({
  life: false,
  region: false,
  trip: false,
  interest: false,
});
const cumulativeTripMax = ref(0.95);
const locationMinRate = ref(0.05);

const selectedTrip = computed(
  () => trips.value.find((item) => item.id === selectedTripId.value) || null,
);
const locationFiltersActive = computed(() => Boolean(selectedVisitId.value));

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

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toSpeciesCountsMap = (counts) => {
  const map = new Map();
  if (!counts || typeof counts !== "object") return map;
  Object.entries(counts).forEach(([code, count]) => {
    if (!code) return;
    map.set(code, toNumber(count, 0));
  });
  return map;
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

const loadVisits = async (tripId) => {
  if (!tripId) {
    visits.value = [];
    return;
  }
  visits.value = await db.visits.where("tripId").equals(tripId).toArray();
};

const loadTripData = async (tripId) => {
  if (!tripId) {
    trip.value = null;
    ebd.value = null;
    visits.value = [];
    locations.value = [];
    speciesList.value = [];
    return;
  }
  trip.value = await db.trips.get(tripId);
  ebd.value = await db.ebd.where("tripId").equals(tripId).first();
  locations.value = ebd.value?.locations || [];
  speciesList.value = ebd.value?.speciesList || [];
  await loadVisits(tripId);
  if (
    selectedVisitId.value &&
    !visits.value.some((visit) => String(visit.id) === String(selectedVisitId.value))
  ) {
    selectedVisitId.value = "";
  } else if (selectedVisitId.value) {
    const selectedVisit = visits.value.find(
      (visit) => String(visit.id) === String(selectedVisitId.value),
    );
    if (selectedVisit && (selectedVisit.type || "birding") !== "birding") {
      selectedVisitId.value = "";
    }
  }
  await nextTick();
};

const visitsWithStats = computed(() => {
  const birdingVisits = visits.value.filter((visit) => (visit.type || "birding") === "birding");
  if (!birdingVisits.length) return [];
  return birdingVisits
    .map((visit) => {
      return {
        ...visit,
        radiusKm: toNumber(visit.radiusKm, 0),
        effort: Math.max(0, toNumber(visit.durationMin, 1)),
        checklistCount: toNumber(visit.statsChecklistCount, 0),
        locationCount: toNumber(visit.statsLocationCount, 0),
        speciesCounts: toSpeciesCountsMap(visit.statsSpeciesCounts),
      };
    })
    .sort((a, b) => {
      const aDate = a.dateTime ? new Date(a.dateTime).getTime() : 0;
      const bDate = b.dateTime ? new Date(b.dateTime).getTime() : 0;
      return aDate - bDate;
    });
});

const totalChecklistCount = computed(() =>
  locationMeta.value.reduce((sum, location) => sum + location.checklistCount, 0),
);

const overallSpeciesCounts = computed(() => {
  const counts = new Map();
  locationMeta.value.forEach((location) => {
    location.speciesEntries.forEach(([code, count]) => {
      counts.set(code, (counts.get(code) || 0) + toNumber(count, 0));
    });
  });
  return counts;
});

const speciesWithProbabilities = computed(() => {
  const list = speciesList.value || [];
  const visitStats = visitsWithStats.value;
  if (!list.length) return [];
  const visitsWithChecklist = visitStats.filter((visit) => visit.checklistCount > 0);
  const selectedId = selectedLocationVisit.value?.id;
  return list
    .map((species) => {
      let independentMiss = 1;
      let rateSum = 0;
      let rateCount = 0;
      let selectedRate = null;

      visitsWithChecklist.forEach((visit) => {
        const count = visit.speciesCounts.get(species.code) || 0;
        const rate = count / visit.checklistCount;
        rateSum += rate;
        rateCount += 1;
        if (rate > 0) {
          const adjusted = 1 - Math.pow(1 - rate, visit.effort || 1);
          independentMiss *= 1 - Math.min(Math.max(adjusted, 0), 1);
        }
        if (selectedId && String(visit.id) === String(selectedId)) {
          selectedRate = rate;
        }
      });

      const total = 1 - independentMiss;
      const avgRate = rateCount ? rateSum / rateCount : 0;
      let locationRate = null;
      let locationRank = null;
      if (selectedId && selectedRate !== null) {
        locationRate = selectedRate;
        let higherCount = 0;
        visitsWithChecklist.forEach((visit) => {
          const count = visit.speciesCounts.get(species.code) || 0;
          const rate = count / visit.checklistCount;
          if (rate > selectedRate) higherCount += 1;
        });
        locationRank = higherCount + 1;
      }

      return {
        ...species,
        totalProbability: Math.min(Math.max(total, 0), 1),
        overallRate: totalChecklistCount.value
          ? (overallSpeciesCounts.value.get(species.code) || 0) / totalChecklistCount.value
          : 0,
        avgRate,
        locationRate,
        locationRank,
      };
    })
    .sort((a, b) => (a.commonName || "").localeCompare(b.commonName || ""));
});

const formatPercent = (value) => {
  const percent = (value || 0) * 100;
  if (percent === 0) return "0%";
  return `${Number(percent.toPrecision(2))}%`;
};

const formatRate = (value) => {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return formatPercent(value);
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

const selectedLocationVisit = computed(() => {
  return (
    visitsWithStats.value.find((visit) => String(visit.id) === String(selectedVisitId.value)) ||
    null
  );
});

const visitSelectOptions = computed(() => visitOptions.value);

const targetSpeciesSet = computed(() => {
  const target = selectedLocationVisit.value?.targetSpecies;
  if (!Array.isArray(target)) return new Set();
  return new Set(target);
});

const isTargetSpecies = (code) => {
  if (!code) return false;
  return targetSpeciesSet.value.has(code);
};

const toggleTargetSpecies = async (code, checked) => {
  const visit = selectedLocationVisit.value;
  if (!visit || !code) return;
  const current = Array.isArray(visit.targetSpecies) ? [...visit.targetSpecies] : [];
  const next = new Set(current);
  if (checked) {
    next.add(code);
  } else {
    next.delete(code);
  }
  const updated = Array.from(next);
  await db.visits.update(visit.id, { targetSpecies: updated, updatedAt: Date.now() });
  const index = visits.value.findIndex((item) => String(item.id) === String(visit.id));
  if (index >= 0) {
    visits.value[index] = { ...visits.value[index], targetSpecies: updated };
  }
};

const visitOptions = computed(() =>
  visitsWithStats.value.map((visit) => ({
    id: visit.id,
    label: `${formatVisitDate(visit.dateTime)} · ${formatVisitTime(visit.dateTime)} · ${
      visit.name || "Untitled visit"
    }`,
  })),
);

const selectedVisitIndex = computed(() =>
  visitsWithStats.value.findIndex((visit) => String(visit.id) === String(selectedVisitId.value)),
);

const goPrevVisit = () => {
  if (!visitsWithStats.value.length) return;
  const startIndex = selectedVisitIndex.value >= 0 ? selectedVisitIndex.value : 0;
  const nextIndex = (startIndex - 1 + visitsWithStats.value.length) % visitsWithStats.value.length;
  selectedVisitId.value = visitsWithStats.value[nextIndex]?.id || "";
};

const goNextVisit = () => {
  if (!visitsWithStats.value.length) return;
  const startIndex = selectedVisitIndex.value >= 0 ? selectedVisitIndex.value : -1;
  const nextIndex = (startIndex + 1) % visitsWithStats.value.length;
  selectedVisitId.value = visitsWithStats.value[nextIndex]?.id || "";
};

const hasLifeColumn = computed(() =>
  speciesList.value.some((species) => species.liferWorld === true || species.liferWorld === false),
);
const hasRegionColumn = computed(() =>
  speciesList.value.some(
    (species) => species.liferRegion === true || species.liferRegion === false,
  ),
);
const hasTripReportColumn = computed(() =>
  speciesList.value.some(
    (species) => species.tripReportSeen === true || species.tripReportSeen === false,
  ),
);
const speciesColspan = computed(
  () =>
    7 +
    (selectedVisitId.value ? 1 : 0) +
    (hasLifeColumn.value ? 1 : 0) +
    (hasRegionColumn.value ? 1 : 0) +
    (hasTripReportColumn.value ? 1 : 0),
);

const hasActiveLiferFilter = computed(() => Object.values(liferFilters.value).some(Boolean));

const toggleSort = (key) => {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
    return;
  }
  sortKey.value = key;
  if (key === "name" || key === "taxon") {
    sortDir.value = "asc";
    return;
  }
  if (key === "rank") {
    sortDir.value = "asc";
    return;
  }
  sortDir.value = "desc";
};

const sortIcon = (key) => {
  if (sortKey.value !== key) return "bi bi-arrow-down-up";
  return sortDir.value === "asc" ? "bi bi-sort-up" : "bi bi-sort-down";
};

const sortedSpecies = computed(() => {
  const list = speciesWithProbabilities.value.filter((species) => {
    if (hasActiveLiferFilter.value) {
      const matchesLife = liferFilters.value.life && species.liferWorld === true;
      const matchesRegion = liferFilters.value.region && species.liferRegion === true;
      const matchesTrip = liferFilters.value.trip && species.tripReportSeen === false;
      const matchesInterest = liferFilters.value.interest && isTargetSpecies(species.code);
      if (!matchesLife && !matchesRegion && !matchesTrip && !matchesInterest) return false;
    }
    if (selectedVisitId.value) {
      const locationRate = Number(species.locationRate ?? 0);
      if (!Number.isFinite(locationRate) || locationRate <= 0) return false;
    }
    const rate = selectedVisitId.value ? species.locationRate : species.overallRate;
    const normalizedRate = rate === null || rate === undefined || Number.isNaN(rate) ? 0 : rate;
    if (locationFiltersActive.value) {
      const minRate = Number(locationMinRate.value ?? 0);
      if (normalizedRate < minRate) return false;
      const cumThreshold = Number(cumulativeTripMax.value ?? 1);
      const totalProbability =
        species.totalProbability === null || species.totalProbability === undefined
          ? 0
          : Number(species.totalProbability);
      if (Number.isFinite(totalProbability) && totalProbability > cumThreshold) return false;
    }
    return true;
  });
  const dir = sortDir.value === "asc" ? 1 : -1;
  list.sort((a, b) => {
    if (sortKey.value === "taxon") {
      const aOrder = a.taxonOrder ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.taxonOrder ?? Number.MAX_SAFE_INTEGER;
      return (aOrder - bOrder) * dir;
    }
    if (sortKey.value === "name") {
      return (a.commonName || "").localeCompare(b.commonName || "") * dir;
    }
    if (sortKey.value === "overall") {
      return (a.overallRate - b.overallRate) * dir;
    }
    if (sortKey.value === "avg") {
      return ((a.avgRate ?? -1) - (b.avgRate ?? -1)) * dir;
    }
    if (sortKey.value === "location") {
      return ((a.locationRate ?? -1) - (b.locationRate ?? -1)) * dir;
    }
    if (sortKey.value === "rank") {
      const aRank = a.locationRank ?? Number.POSITIVE_INFINITY;
      const bRank = b.locationRank ?? Number.POSITIVE_INFINITY;
      return (aRank - bRank) * dir;
    }
    if (sortKey.value === "lifer") {
      const aScore =
        (a.liferWorld === true ? 1 : 0) +
        (a.liferRegion === true ? 1 : 0) +
        (a.tripReportSeen === false ? 1 : 0);
      const bScore =
        (b.liferWorld === true ? 1 : 0) +
        (b.liferRegion === true ? 1 : 0) +
        (b.tripReportSeen === false ? 1 : 0);
      return (aScore - bScore) * dir;
    }
    return (a.totalProbability - b.totalProbability) * dir;
  });
  return list;
});

const getSpeciesMapUrl = (code) => {
  if (!code) return "";
  const bounds = (locations.value || []).reduce(
    (acc, loc) => {
      const lon = Number(loc.longitude);
      const lat = Number(loc.latitude);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return acc;
      acc.minX = Math.min(acc.minX, lon);
      acc.maxX = Math.max(acc.maxX, lon);
      acc.minY = Math.min(acc.minY, lat);
      acc.maxY = Math.max(acc.maxY, lat);
      return acc;
    },
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  const hasBounds =
    Number.isFinite(bounds.minX) &&
    Number.isFinite(bounds.minY) &&
    Number.isFinite(bounds.maxX) &&
    Number.isFinite(bounds.maxY);
  if (hasBounds) {
    const params = new URLSearchParams({
      "env.minX": String(bounds.minX),
      "env.minY": String(bounds.minY),
      "env.maxX": String(bounds.maxX),
      "env.maxY": String(bounds.maxY),
      "neg": "true",
      "gp": "true",
    });
    return `https://ebird.org/map/${code}?${params.toString()}`;
  }
  return `https://ebird.org/map/${code}`;
};

watch(selectedTripId, loadTripData, { immediate: true });
onMounted(async () => {
  await refreshTrips();
  if (selectedTripId.value && !trip.value) {
    await loadTripData(selectedTripId.value);
  }
  nextTick(() => {
    document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => {
      new Tooltip(el);
    });
  });
});

watch(selectedTripId, () => {
  nextTick(() => {
    document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => {
      new Tooltip(el);
    });
  });
});
</script>

<template>
  <div class="row g-4 mt-1">
    <div class="col-12" v-if="trip">
      <div class="card">
        <div class="card-body">
          <div class="mb-3 d-flex align-items-center gap-2">
            <button
              class="btn btn-outline-secondary btn-sm location-nav-btn"
              type="button"
              @click="goPrevVisit"
              :disabled="!visitsWithStats.length"
              aria-label="Previous location"
            >
              &lt;
            </button>
            <v-select
              v-model="selectedVisitId"
              :options="visitSelectOptions"
              :reduce="(option) => option.id"
              label="label"
              :clearable="true"
              :searchable="true"
              placeholder="All locations (full trip)"
              class="location-select-control flex-grow-1"
            >
              <template #option="{ label }">
                <div class="small">{{ label }}</div>
              </template>
              <template #selected-option="{ label }">
                <span class="small">{{ label }}</span>
              </template>
            </v-select>
            <button
              class="btn btn-outline-secondary btn-sm location-nav-btn"
              type="button"
              @click="goNextVisit"
              :disabled="!visitsWithStats.length"
              aria-label="Next location"
            >
              &gt;
            </button>
          </div>

          <div class="bg-light rounded-3 p-3 d-flex flex-wrap align-items-center gap-3">
            <div class="fw-semibold text-secondary small text-uppercase">Filters</div>
            <div
              class="d-flex align-items-center gap-2 flex-wrap"
              v-if="hasLifeColumn || hasRegionColumn || hasTripReportColumn || selectedVisitId"
            >
              <label class="form-check d-flex align-items-center gap-1 mb-0" v-if="hasLifeColumn">
                <input
                  id="filterLife"
                  class="form-check-input"
                  type="checkbox"
                  v-model="liferFilters.life"
                />
                <span class="form-check-label small">Life</span>
              </label>
              <label class="form-check d-flex align-items-center gap-1 mb-0" v-if="hasRegionColumn">
                <input
                  id="filterRegion"
                  class="form-check-input"
                  type="checkbox"
                  v-model="liferFilters.region"
                />
                <span class="form-check-label small">Region</span>
              </label>
              <label
                class="form-check d-flex align-items-center gap-1 mb-0"
                v-if="hasTripReportColumn"
              >
                <input
                  id="filterTrip"
                  class="form-check-input"
                  type="checkbox"
                  v-model="liferFilters.trip"
                />
                <span class="form-check-label small">Trip</span>
              </label>
              <label class="form-check d-flex align-items-center gap-1 mb-0" v-if="selectedVisitId">
                <input
                  id="filterInterest"
                  class="form-check-input"
                  type="checkbox"
                  v-model="liferFilters.interest"
                />
                <span class="form-check-label small">Interest</span>
              </label>
            </div>
            <div class="d-flex align-items-center gap-3 flex-wrap filter-sliders">
              <div
                class="d-flex align-items-center gap-2 slider-inline"
                :class="{ 'text-muted': !locationFiltersActive }"
              >
                <span class="small mb-0">Cum. Trip (max)</span>
                <input
                  type="range"
                  class="form-range filter-range"
                  min="0"
                  max="1"
                  step="0.01"
                  v-model.number="cumulativeTripMax"
                  :disabled="!locationFiltersActive"
                  aria-label="Maximum cumulative trip probability"
                />
                <span class="small">{{ formatPercent(cumulativeTripMax) }}</span>
              </div>
              <div
                class="d-flex align-items-center gap-2 slider-inline"
                :class="{ 'text-muted': !locationFiltersActive }"
              >
                <span class="small mb-0">Location rate (min)</span>
                <input
                  type="range"
                  class="form-range filter-range"
                  min="0"
                  max="1"
                  step="0.01"
                  v-model.number="locationMinRate"
                  :disabled="!locationFiltersActive"
                  aria-label="Minimum location rate"
                />
                <span class="small">{{ formatPercent(locationMinRate) }}</span>
              </div>
            </div>
          </div>

          <div class="table-responsive mt-3">
            <table class="table table-sm align-middle">
              <thead>
                <tr>
                  <th>
                    <button
                      class="btn btn-link p-0 fw-semibold text-decoration-none text-reset"
                      @click="toggleSort('taxon')"
                    >
                      # <i :class="[sortIcon('taxon'), 'ms-1']"></i>
                    </button>
                  </th>
                  <th>
                    <button
                      class="btn btn-link p-0 fw-semibold text-decoration-none text-reset"
                      @click="toggleSort('name')"
                    >
                      Species <i :class="[sortIcon('name'), 'ms-1']"></i>
                    </button>
                  </th>
                  <th class="text-end">
                    <button
                      class="btn btn-link p-0 fw-semibold text-decoration-none text-reset"
                      @click="toggleSort('overall')"
                    >
                      EBD <i :class="[sortIcon('overall'), 'ms-1']"></i>
                    </button>
                  </th>
                  <th class="text-end">
                    <button
                      class="btn btn-link p-0 fw-semibold text-decoration-none text-reset"
                      @click="toggleSort('avg')"
                    >
                      Avg. Trip <i :class="[sortIcon('avg'), 'ms-1']"></i>
                    </button>
                  </th>
                  <th class="text-end">
                    <div class="d-flex align-items-center justify-content-end gap-1">
                      <button
                        class="btn btn-link p-0 fw-semibold text-decoration-none text-reset"
                        @click="toggleSort('detection')"
                      >
                        Cum. Trip <i :class="[sortIcon('detection'), 'ms-1']"></i>
                      </button>
                      <button
                        class="btn btn-link p-0 text-muted small"
                        type="button"
                        data-bs-toggle="tooltip"
                        data-bs-placement="top"
                        title="Cumulative probability of detecting the species at least once across visits."
                      >
                        <i class="bi bi-info-circle"></i>
                      </button>
                    </div>
                  </th>
                  <th class="text-end" v-if="locationFiltersActive">
                    <button
                      class="btn btn-link p-0 fw-semibold text-decoration-none text-reset"
                      @click="toggleSort('location')"
                    >
                      Location <i :class="[sortIcon('location'), 'ms-1']"></i>
                    </button>
                  </th>
                  <th class="text-end" v-if="locationFiltersActive">
                    <button
                      class="btn btn-link p-0 fw-semibold text-decoration-none text-reset"
                      @click="toggleSort('rank')"
                    >
                      Top <i :class="[sortIcon('rank'), 'ms-1']"></i>
                    </button>
                  </th>
                  <th class="text-center" v-if="selectedVisitId">Interest</th>
                  <th class="text-center" v-if="hasLifeColumn">Life</th>
                  <th class="text-center" v-if="hasRegionColumn">Region</th>
                  <th class="text-center" v-if="hasTripReportColumn">Trip</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="species in sortedSpecies" :key="species.code">
                  <td class="text-muted">{{ species.taxonOrder ?? "-" }}</td>
                  <td>
                    <div
                      class="d-flex align-items-baseline gap-2"
                      :class="{ 'fw-bold': isTargetSpecies(species.code) }"
                    >
                      <span>{{ species.commonName || species.code }}</span>
                      <span class="fst-italic text-muted small" v-if="species.scientificName">
                        {{ species.scientificName }}
                      </span>
                      <a
                        v-if="getSpeciesMapUrl(species.code)"
                        :href="getSpeciesMapUrl(species.code)"
                        target="_blank"
                        class="link-secondary text-decoration-none small"
                        title="Open eBird species map"
                      >
                        <i class="bi bi-geo-alt"></i>
                      </a>
                    </div>
                  </td>
                  <td class="text-end">{{ formatRate(species.overallRate) }}</td>
                  <td class="text-end">{{ formatRate(species.avgRate) }}</td>
                  <td class="text-end">{{ formatPercent(species.totalProbability) }}</td>
                  <td class="text-end" v-if="locationFiltersActive">
                    {{ formatRate(species.locationRate) }}
                  </td>
                  <td class="text-end" v-if="locationFiltersActive">
                    {{ species.locationRank ?? "-" }}
                  </td>
                  <td class="text-center" v-if="selectedVisitId">
                    <input
                      class="form-check-input"
                      type="checkbox"
                      :checked="isTargetSpecies(species.code)"
                      @change="toggleTargetSpecies(species.code, $event.target.checked)"
                      :aria-label="`Toggle interest for ${species.commonName || species.code}`"
                    />
                  </td>
                  <td class="text-center" v-if="hasLifeColumn">
                    <i
                      v-if="species.liferWorld === true"
                      class="bi bi-bullseye text-danger"
                      title="Not yet seen in life list"
                    ></i>
                  </td>
                  <td class="text-center" v-if="hasRegionColumn">
                    <i
                      v-if="species.liferRegion === true"
                      class="bi bi-bullseye text-danger"
                      title="Not yet seen in region list"
                    ></i>
                  </td>
                  <td class="text-center" v-if="hasTripReportColumn">
                    <i
                      v-if="species.tripReportSeen === false"
                      class="bi bi-bullseye text-danger"
                      title="Not yet seen in trip report"
                    ></i>
                  </td>
                </tr>
                <tr v-if="speciesWithProbabilities.length === 0">
                  <td :colspan="speciesColspan" class="text-muted small">
                    No species data loaded.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.location-select-control :deep(.vs__dropdown-toggle) {
  min-height: 40px;
  padding: 4px 10px;
  border-radius: 10px;
}

.location-select-control :deep(.vs__selected-options) {
  flex-wrap: nowrap;
  overflow: hidden;
  gap: 4px;
}

.location-select-control :deep(.vs__selected) {
  margin: 0;
  padding: 2px 6px;
  font-size: 0.75rem;
  white-space: nowrap;
}

.location-select-control :deep(.vs__search) {
  margin: 0;
  padding: 0;
  font-size: 0.9rem;
}

.location-select-control :deep(.vs__dropdown-menu) {
  max-height: 200px;
}

.location-nav-btn {
  height: 40px;
  width: 40px;
  border-radius: 10px;
  border-color: var(--bs-border-color);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.filter-sliders {
  flex: 1;
  min-width: 240px;
}

.slider-inline {
  align-items: center;
}

.filter-range {
  width: 180px;
  max-width: 220px;
  height: 6px;
}

.filter-range::-webkit-slider-runnable-track {
  height: 6px;
  background: #b9c0c8;
  border-radius: 999px;
}

.filter-range::-moz-range-track {
  height: 6px;
  background: #b9c0c8;
  border-radius: 999px;
}

.filter-range:disabled::-webkit-slider-runnable-track {
  background: #d7dde3;
}

.filter-range:disabled::-moz-range-track {
  background: #d7dde3;
}

.filter-sliders .text-muted {
  opacity: 0.6;
}
</style>
