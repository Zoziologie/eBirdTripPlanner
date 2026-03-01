<script setup>
import { ref, shallowRef, onMounted, watch, computed, nextTick } from "vue";
import { Tooltip, Popover } from "bootstrap";
import vSelect from "vue-select";
import "vue-select/dist/vue-select.css";
import { useTripBundleLoader } from "../composables/useTripBundleLoader";
import { db } from "../data/db";
import { resolveRecordConflict, withUpdatedAt } from "../utils/recordConflicts";
import { trips, selectedTripId, refreshTrips } from "../state/tripSelection";
import { selectedVisitId } from "../state/visitSelection";
import { ebdUpdatedAt } from "../state/ebdUpdates";

const trip = shallowRef(null);
const ebd = shallowRef(null);
const visits = ref([]);
const locations = shallowRef([]);
const speciesList = shallowRef([]);
const {
  isLoadingTripBundle: isLoadingTripData,
  loadTripBundle,
  resetTripBundleLoader,
} = useTripBundleLoader({ includeTrip: true, includeEbd: true, includeVisits: true });

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
const hasSelectedVisit = computed(() => Boolean(selectedVisitId.value));
const showInterestColumn = computed(() => hasSelectedVisit.value);
const showRankColumn = computed(() => hasSelectedVisit.value);
const showEbdColumn = computed(() => !hasSelectedVisit.value);
const rateColumnSortKey = computed(() => (hasSelectedVisit.value ? "location" : "avg"));
const rateColumnLabel = computed(() =>
  hasSelectedVisit.value ? "Location" : "Average Trip",
);
const rateColumnShortLabel = computed(() =>
  hasSelectedVisit.value ? "Location" : "Avg. Trip",
);
const rateColumnPopoverTitle = computed(() =>
  hasSelectedVisit.value ? "Location rate" : "Average trip",
);
const rateColumnPopoverContent = computed(() =>
  hasSelectedVisit.value
    ? "Detection rate within the selected location filter."
    : "Average detection rate across visits.",
);
const rateFilterLabel = computed(() =>
  hasSelectedVisit.value ? "Location (min)" : "Average trip (min)",
);

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

const loadTripData = async (tripId) => {
  if (!tripId) {
    resetTripBundleLoader();
    trip.value = null;
    ebd.value = null;
    visits.value = [];
    locations.value = [];
    speciesList.value = [];
    return;
  }

  const { bundle, isCurrent } = await loadTripBundle(tripId);
  if (!isCurrent) return;

  trip.value = bundle.trip || null;
  ebd.value = bundle.ebd || null;
  locations.value = bundle.ebd?.locations || [];
  speciesList.value = bundle.ebd?.speciesList || [];
  visits.value = bundle.visits || [];

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
  const percent = Number(value) * 100;
  if (!Number.isFinite(percent)) return "-";
  return `${percent.toFixed(1)}%`;
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

const sanitizeFilename = (value) => {
  const cleaned = (value || "")
    .trim()
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "species";
};

const formatCsvNumber = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  return numeric.toFixed(4);
};

const escapeCsv = (value) => {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
};

const exportSpeciesCsv = () => {
  const rows = sortedSpecies.value || [];
  const header = [
    "code",
    "commonName",
    "scientificName",
    "liferWorld",
    "liferRegion",
    "tripReportSeen",
    "targetInterest",
    "locationRank",
    "locationRate",
    "totalProbability",
    "avgRate",
    "overallRate",
  ];
  const lines = [header.join(",")];
  rows.forEach((species) => {
    const line = [
      species.code || "",
      species.commonName || "",
      species.scientificName || "",
      species.liferWorld === true ? "true" : species.liferWorld === false ? "false" : "",
      species.liferRegion === true ? "true" : species.liferRegion === false ? "false" : "",
      species.tripReportSeen === true ? "true" : species.tripReportSeen === false ? "false" : "",
      isTargetSpecies(species.code) ? "true" : "false",
      species.locationRank ?? "",
      formatCsvNumber(species.locationRate),
      formatCsvNumber(species.totalProbability),
      formatCsvNumber(species.avgRate),
      formatCsvNumber(species.overallRate),
    ].map(escapeCsv);
    lines.push(line.join(","));
  });
  const csv = `${lines.join("\n")}\n`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const tripLabel = sanitizeFilename(selectedTrip.value?.name || "trip");
  const visitLabel = selectedLocationVisit.value
    ? sanitizeFilename(`visit_${selectedLocationVisit.value.id}`)
    : "all_locations";
  const filename = `species-list_${tripLabel}_${visitLabel}.csv`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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

const isTripConfirmedSpecies = (species) => species?.tripReportSeen === true;
const isLifeTargetSpecies = (species) =>
  species?.liferWorld === true && !isTripConfirmedSpecies(species);
const isRegionTargetSpecies = (species) =>
  species?.liferRegion === true && !isTripConfirmedSpecies(species);

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
  const currentVisit = await db.visits.get(visit.id);
  if (!currentVisit) {
    if (selectedTripId.value) {
      await loadTripData(selectedTripId.value);
    }
    return;
  }
  const shouldOverwrite = await resolveRecordConflict({
    label: "This visit",
    localUpdatedAt: Number(visit.updatedAt ?? 0),
    currentUpdatedAt: Number(currentVisit.updatedAt ?? 0),
    reload: async () => {
      if (selectedTripId.value) {
        await loadTripData(selectedTripId.value);
      }
    },
  });
  if (!shouldOverwrite) return;
  const nextUpdates = withUpdatedAt({ targetSpecies: updated });
  await db.visits.update(visit.id, nextUpdates);
  const index = visits.value.findIndex((item) => String(item.id) === String(visit.id));
  if (index >= 0) {
    visits.value[index] = { ...visits.value[index], ...nextUpdates };
  }
};

const visitOptions = computed(() =>
  visitsWithStats.value.map((visit) => ({
    id: String(visit.id),
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
  selectedVisitId.value = visitsWithStats.value[nextIndex]?.id
    ? String(visitsWithStats.value[nextIndex].id)
    : "";
};

const goNextVisit = () => {
  if (!visitsWithStats.value.length) return;
  const startIndex = selectedVisitIndex.value >= 0 ? selectedVisitIndex.value : -1;
  const nextIndex = (startIndex + 1) % visitsWithStats.value.length;
  selectedVisitId.value = visitsWithStats.value[nextIndex]?.id
    ? String(visitsWithStats.value[nextIndex].id)
    : "";
};

const hasLifeColumn = computed(() =>
  speciesList.value.some((species) => isLifeTargetSpecies(species)),
);
const hasRegionColumn = computed(() =>
  speciesList.value.some((species) => isRegionTargetSpecies(species)),
);
const hasTripReportColumn = computed(() =>
  speciesList.value.some(
    (species) => species.tripReportSeen === true || species.tripReportSeen === false,
  ),
);
const speciesColspan = computed(
  () =>
    4 +
    (showInterestColumn.value ? 1 : 0) +
    (showRankColumn.value ? 1 : 0) +
    (showEbdColumn.value ? 1 : 0),
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
      const matchesLife = liferFilters.value.life && isLifeTargetSpecies(species);
      const matchesRegion = liferFilters.value.region && isRegionTargetSpecies(species);
      const matchesTrip = liferFilters.value.trip && species.tripReportSeen === false;
      const matchesInterest = liferFilters.value.interest && isTargetSpecies(species.code);
      if (!matchesLife && !matchesRegion && !matchesTrip && !matchesInterest) return false;
    }
    if (hasSelectedVisit.value) {
      const locationRate = Number(species.locationRate ?? 0);
      if (!Number.isFinite(locationRate) || locationRate <= 0) return false;
    }
    const activeRate = hasSelectedVisit.value ? species.locationRate : species.avgRate;
    const normalizedRate =
      activeRate === null || activeRate === undefined || Number.isNaN(activeRate) ? 0 : activeRate;
    const minRate = Number(locationMinRate.value ?? 0);
    if (normalizedRate < minRate) return false;
    const cumThreshold = Number(cumulativeTripMax.value ?? 1);
    const totalProbability =
      species.totalProbability === null || species.totalProbability === undefined
        ? 0
        : Number(species.totalProbability);
    if (Number.isFinite(totalProbability) && totalProbability > cumThreshold) return false;
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
        (isLifeTargetSpecies(a) ? 1 : 0) +
        (isRegionTargetSpecies(a) ? 1 : 0) +
        (a.tripReportSeen === false ? 1 : 0);
      const bScore =
        (isLifeTargetSpecies(b) ? 1 : 0) +
        (isRegionTargetSpecies(b) ? 1 : 0) +
        (b.tripReportSeen === false ? 1 : 0);
      return (aScore - bScore) * dir;
    }
    return (a.totalProbability - b.totalProbability) * dir;
  });
  return list;
});

const getExpectedProbability = (species) => {
  const rawValue = hasSelectedVisit.value ? species.locationRate : species.totalProbability;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
};

const expectedSummary = computed(() => {
  const summary = {
    total: 0,
    life: 0,
    region: 0,
    trip: 0,
  };

  speciesWithProbabilities.value.forEach((species) => {
    const expected = getExpectedProbability(species);
    summary.total += expected;
    if (isLifeTargetSpecies(species)) summary.life += expected;
    if (isRegionTargetSpecies(species)) summary.region += expected;
    if (species.tripReportSeen === false) summary.trip += expected;
  });

  return summary;
});

const expectedSummaryItems = computed(() => {
  const items = [
    {
      key: "total",
      label: "Total",
      value: expectedSummary.value.total,
    },
  ];
  if (hasLifeColumn.value) {
    items.push({
      key: "life",
      label: "Life",
      value: expectedSummary.value.life,
    });
  }
  if (hasRegionColumn.value) {
    items.push({
      key: "region",
      label: "Region",
      value: expectedSummary.value.region,
    });
  }
  if (hasTripReportColumn.value && hasSelectedVisit.value) {
    items.push({
      key: "trip",
      label: "Trip",
      value: expectedSummary.value.trip,
    });
  }
  return items;
});

const formatExpectedCount = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0.0";
  return numeric.toFixed(1);
};

const speciesMapBoundsQuery = computed(() => {
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
    return new URLSearchParams({
      "env.minX": String(bounds.minX),
      "env.minY": String(bounds.minY),
      "env.maxX": String(bounds.maxX),
      "env.maxY": String(bounds.maxY),
      "neg": "true",
      "gp": "true",
    }).toString();
  }
  return "";
});

const getSpeciesMapUrl = (code) => {
  if (!code) return "";
  if (speciesMapBoundsQuery.value) {
    return `https://ebird.org/map/${code}?${speciesMapBoundsQuery.value}`;
  }
  return `https://ebird.org/map/${code}`;
};

watch(selectedTripId, loadTripData, { immediate: true });
watch(ebdUpdatedAt, async () => {
  if (!selectedTripId.value) return;
  await loadTripData(selectedTripId.value);
});
watch(
  hasSelectedVisit,
  (selected) => {
    if (selected) {
      if (sortKey.value === "avg" || sortKey.value === "overall") {
        sortKey.value = "rank";
        sortDir.value = "asc";
      }
      return;
    }
    if (sortKey.value === "rank" || sortKey.value === "location") {
      sortKey.value = "avg";
      sortDir.value = "desc";
    }
  },
  { immediate: true },
);
onMounted(async () => {
  await refreshTrips();
  nextTick(() => {
    document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => {
      new Tooltip(el);
    });
    document.querySelectorAll('[data-bs-toggle="popover"]').forEach((el) => {
      new Popover(el);
    });
  });
});

watch(selectedTripId, () => {
  nextTick(() => {
    document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => {
      new Tooltip(el);
    });
    document.querySelectorAll('[data-bs-toggle="popover"]').forEach((el) => {
      new Popover(el);
    });
  });
});
</script>

<template>
  <div class="row g-4 mt-1">
    <div class="col-12" v-if="isLoadingTripData">
      <div class="card">
        <div class="card-body py-5 text-center">
          <div class="spinner-border text-primary" role="status" aria-hidden="true"></div>
          <div class="mt-3 fw-semibold">Loading species list...</div>
          <div class="small text-muted">Large trips can take a moment to open.</div>
        </div>
      </div>
    </div>
    <div class="col-12" v-else-if="trip">
      <div class="card">
        <div class="card-body">
          <div class="mb-3 visit-selector-row">
            <button
              class="btn btn-outline-secondary btn-sm location-nav-btn location-nav-btn--prev"
              type="button"
              @click="goPrevVisit"
              :disabled="!visitsWithStats.length"
              aria-label="Previous location"
            >
              <i class="bi bi-chevron-left"></i>
            </button>
            <v-select
              v-model="selectedVisitId"
              :options="visitSelectOptions"
              :reduce="(option) => option.id"
              label="label"
              :clearable="true"
              :searchable="true"
              placeholder="All locations (full trip)"
              class="location-select-control app-vselect flex-grow-1"
            >
              <template #option="{ label }">
                <div class="small visit-option-label" :title="label">{{ label }}</div>
              </template>
              <template #selected-option="{ label }">
                <span class="small visit-selected-label" :title="label">{{ label }}</span>
              </template>
            </v-select>
            <button
              class="btn btn-outline-secondary btn-sm location-nav-btn location-nav-btn--next"
              type="button"
              @click="goNextVisit"
              :disabled="!visitsWithStats.length"
              aria-label="Next location"
            >
              <i class="bi bi-chevron-right"></i>
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
              <div class="d-flex align-items-center gap-2 slider-inline">
                <span class="small mb-0">Cum. Trip (max)</span>
                <input
                  type="range"
                  class="form-range filter-range"
                  min="0"
                  max="1"
                  step="0.01"
                  v-model.number="cumulativeTripMax"
                  aria-label="Maximum cumulative trip probability"
                />
                <span class="small">{{ formatPercent(cumulativeTripMax) }}</span>
              </div>
              <div class="d-flex align-items-center gap-2 slider-inline">
                <span class="small mb-0">{{ rateFilterLabel }}</span>
                <input
                  type="range"
                  class="form-range filter-range"
                  min="0"
                  max="1"
                  step="0.01"
                  v-model.number="locationMinRate"
                  :aria-label="rateFilterLabel"
                />
                <span class="small">{{ formatPercent(locationMinRate) }}</span>
              </div>
            </div>
          </div>

          <div class="table-responsive mt-3 species-list-table-wrap">
            <table class="table table-sm align-middle">
              <thead>
                <tr>
                  <th class="d-none d-sm-table-cell">
                    <button
                      class="btn btn-link p-0 fw-semibold text-decoration-none text-reset"
                      @click="toggleSort('taxon')"
                      data-bs-toggle="popover"
                      data-bs-trigger="hover focus"
                      data-bs-placement="top"
                      data-bs-title="Row number"
                      data-bs-content="Shows the current row index (sorted by taxon order when you click)."
                    >
                      # <i :class="[sortIcon('taxon'), 'ms-1']"></i>
                    </button>
                  </th>
                  <th class="text-center" v-if="showInterestColumn">
                    <button
                      class="btn btn-link p-0 text-decoration-none text-reset"
                      type="button"
                      data-bs-toggle="popover"
                      data-bs-trigger="hover focus"
                      data-bs-placement="top"
                      data-bs-title="Interest"
                      data-bs-content="Mark a species of interest for the selected visit."
                    >
                      <i class="bi bi-star-fill"></i>
                    </button>
                  </th>
                  <th>
                    <button
                      class="btn btn-link p-0 fw-semibold text-decoration-none text-reset"
                      @click="toggleSort('name')"
                      data-bs-toggle="popover"
                      data-bs-trigger="hover focus"
                      data-bs-placement="top"
                      data-bs-title="Species"
                      data-bs-content="Common name with quick link to the eBird species map. Icons show world/region/trip targets."
                    >
                      Species <i :class="[sortIcon('name'), 'ms-1']"></i>
                    </button>
                  </th>
                  <th class="text-end" v-if="showRankColumn">
                    <button
                      class="btn btn-link p-0 fw-semibold text-decoration-none text-reset"
                      @click="toggleSort('rank')"
                      data-bs-toggle="popover"
                      data-bs-trigger="hover focus"
                      data-bs-placement="top"
                      data-bs-title="Top"
                      data-bs-content="Rank within the selected location filter (1 is highest)."
                    >
                      Top <i :class="[sortIcon('rank'), 'ms-1']"></i>
                    </button>
                  </th>
                  <th class="text-end">
                    <button
                      class="btn btn-link p-0 fw-semibold text-decoration-none text-reset"
                      @click="toggleSort(rateColumnSortKey)"
                      data-bs-toggle="popover"
                      data-bs-trigger="hover focus"
                      data-bs-placement="top"
                      :data-bs-title="rateColumnPopoverTitle"
                      :data-bs-content="rateColumnPopoverContent"
                    >
                      <span class="d-none d-lg-inline">{{ rateColumnLabel }}</span>
                      <span class="d-lg-none">{{ rateColumnShortLabel }}</span>
                      <i :class="[sortIcon(rateColumnSortKey), 'ms-1']"></i>
                    </button>
                  </th>
                  <th class="text-end">
                    <button
                      class="btn btn-link p-0 fw-semibold text-decoration-none text-reset"
                      @click="toggleSort('detection')"
                      data-bs-toggle="popover"
                      data-bs-trigger="hover focus"
                      data-bs-placement="top"
                      data-bs-title="Cumulative trip"
                      data-bs-content="Cumulative probability of detecting the species at least once across visits."
                    >
                      <span class="d-none d-lg-inline">Cumulative Trip</span>
                      <span class="d-lg-none">Cum. Trip</span>
                      <i :class="[sortIcon('detection'), 'ms-1']"></i>
                    </button>
                  </th>
                  <th class="text-end" v-if="showEbdColumn">
                    <button
                      class="btn btn-link p-0 fw-semibold text-decoration-none text-reset"
                      @click="toggleSort('overall')"
                      data-bs-toggle="popover"
                      data-bs-trigger="hover focus"
                      data-bs-placement="top"
                      data-bs-title="EBD rate"
                      data-bs-content="Overall detection rate across the filtered EBD data."
                    >
                      EBD <i :class="[sortIcon('overall'), 'ms-1']"></i>
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(species, index) in sortedSpecies"
                  :key="species.code"
                  class="species-row"
                  :class="{ 'species-row--target': isTargetSpecies(species.code) }"
                >
                  <td class="text-muted d-none d-sm-table-cell">
                    {{ index + 1 }}
                  </td>
                  <td class="text-center" v-if="showInterestColumn">
                    <input
                      class="form-check-input"
                      type="checkbox"
                      :checked="isTargetSpecies(species.code)"
                      @change="toggleTargetSpecies(species.code, $event.target.checked)"
                      :aria-label="`Toggle interest for ${species.commonName || species.code}`"
                    />
                  </td>
                  <td>
                    <div
                      class="d-flex align-items-baseline gap-2"
                      :class="{ 'fw-bold': isTargetSpecies(species.code) }"
                    >
                      <a
                        v-if="getSpeciesMapUrl(species.code)"
                        :href="getSpeciesMapUrl(species.code)"
                        target="_blank"
                        class="text-reset text-decoration-none"
                        title="Open eBird species map"
                      >
                        {{ species.commonName || species.code }}
                      </a>
                      <span v-else>{{ species.commonName || species.code }}</span>
                      <span
                        class="fst-italic text-muted small d-none d-sm-inline"
                        v-if="species.scientificName"
                      >
                        {{ species.scientificName }}
                      </span>
                      <span class="d-inline-flex align-items-center gap-1">
                        <i
                          v-if="isLifeTargetSpecies(species)"
                          class="bi bi-globe2 text-danger species-target-icon"
                          title="Not yet seen in life list"
                        ></i>
                        <i
                          v-else-if="isRegionTargetSpecies(species)"
                          class="bi bi-geo-alt-fill text-danger species-target-icon species-target-icon--region"
                          title="Not yet seen in region list"
                        ></i>
                        <i
                          v-else-if="species.tripReportSeen === false"
                          class="bi bi-car-front-fill text-danger species-target-icon species-target-icon--trip"
                          title="Not yet seen in trip report"
                        ></i>
                      </span>
                    </div>
                  </td>
                  <td class="text-end" v-if="showRankColumn">
                    {{ species.locationRank ?? "-" }}
                  </td>
                  <td class="text-end rate-cell">
                    {{ formatRate(hasSelectedVisit ? species.locationRate : species.avgRate) }}
                  </td>
                  <td class="text-end">{{ formatPercent(species.totalProbability) }}</td>
                  <td class="text-end rate-cell" v-if="showEbdColumn">
                    {{ formatRate(species.overallRate) }}
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
          <div class="expected-summary mt-3 pt-3 border-top" v-if="speciesWithProbabilities.length">
            <div class="expected-summary-row">
              <div class="expected-summary-stats small">
                <div class="expected-summary-lead fw-semibold">
                  Expected Number of species (sum of prob.):
                </div>
                <div class="expected-summary-values">
                  <template v-for="(item, index) in expectedSummaryItems" :key="item.key">
                    <span
                      class="expected-summary-pill"
                      :class="{
                        'expected-summary-pill--primary': item.key === 'total',
                        'expected-summary-pill--alert': item.key !== 'total',
                      }"
                    >
                      <span class="expected-summary-pill-label">{{ item.label }}:</span>
                      <span class="expected-summary-pill-value">{{
                        formatExpectedCount(item.value)
                      }}</span>
                    </span>
                    <span
                      v-if="index < expectedSummaryItems.length - 1"
                      class="expected-summary-sep"
                      aria-hidden="true"
                      >·</span
                    >
                  </template>
                </div>
              </div>
              <button
                class="btn btn-outline-secondary btn-sm expected-summary-export"
                type="button"
                @click="exportSpeciesCsv"
                :disabled="!sortedSpecies.length"
                aria-label="Export species list to CSV"
              >
                <i class="bi bi-filetype-csv me-1"></i>
                Export CSV
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.visit-selector-row {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) 44px;
  gap: 0.5rem;
  align-items: center;
}

.location-select-control {
  min-width: 0;
}

.location-select-control :deep(.vs__selected-options) {
  flex-wrap: nowrap;
  overflow: hidden;
}

.location-select-control :deep(.vs__selected) {
  padding: 2px 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.visit-option-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.visit-selected-label {
  display: inline-block;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.location-nav-btn {
  height: 44px;
  width: 44px;
  min-height: 44px;
  min-width: 44px;
  flex: 0 0 44px;
  border-radius: 10px;
  border-color: var(--bs-border-color);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  font-size: 1rem;
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
  background: rgba(var(--app-color-deep-teal-rgb), 0.22);
  border-radius: 999px;
}

.filter-range::-moz-range-track {
  height: 6px;
  background: rgba(var(--app-color-deep-teal-rgb), 0.22);
  border-radius: 999px;
}

.filter-range:disabled::-webkit-slider-runnable-track {
  background: rgba(var(--app-color-slate-rgb), 0.16);
}

.filter-range:disabled::-moz-range-track {
  background: rgba(var(--app-color-slate-rgb), 0.16);
}

.filter-sliders .text-muted {
  opacity: 0.6;
}

.rate-cell {
  font-variant-numeric: tabular-nums;
  font-feature-settings:
    "tnum" 1,
    "lnum" 1;
}

.species-target-icon {
  font-size: 0.85em;
}

.species-target-icon--region {
  font-size: 0.75em;
}

.species-target-icon--trip {
  font-size: 0.85em;
}

.species-row:hover td {
  background-color: rgba(var(--app-color-deep-teal-rgb), 0.05);
}

.species-row--target td {
  background-color: rgba(var(--app-color-gold-rgb), 0.18);
}

.species-row--target:hover td {
  background-color: rgba(var(--app-color-gold-rgb), 0.28);
}

.expected-summary {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.86), rgba(var(--app-color-deep-teal-rgb), 0.05));
  border-radius: 10px;
  padding: 0.75rem 0.9rem;
}

.expected-summary-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
}

.expected-summary-stats {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}

.expected-summary-lead {
  color: var(--app-color-slate);
}

.expected-summary-values {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.35rem;
  font-size: 0.95rem;
  line-height: 1.35;
}

.expected-summary-pill {
  display: inline-flex;
  align-items: baseline;
  gap: 0.25rem;
  padding: 0.08rem 0.5rem;
  border-radius: 999px;
  background: rgba(var(--app-color-deep-teal-rgb), 0.1);
  color: var(--app-color-deep-teal);
}

.expected-summary-pill--primary {
  font-size: 1.06em;
  font-weight: 700;
  background: rgba(var(--app-color-green-rgb), 0.14);
  color: var(--app-color-green);
}

.expected-summary-pill--alert {
  background: rgba(var(--app-color-gold-rgb), 0.2);
  color: var(--app-color-gold-deep);
}

.expected-summary-pill-label {
  font-weight: 600;
}

.expected-summary-pill-value {
  font-variant-numeric: tabular-nums;
}

.expected-summary-sep {
  color: rgba(var(--app-color-slate-rgb), 0.7);
  line-height: 1;
}

.expected-summary-export {
  justify-self: end;
  white-space: nowrap;
}

@media (max-width: 575.98px) {
  .species-list-table-wrap {
    margin-left: calc(-1 * var(--bs-card-spacer-x));
    margin-right: calc(-1 * var(--bs-card-spacer-x));
  }
}

@media (max-width: 767.98px) {
  .filter-sliders {
    width: 100%;
  }

  .filter-sliders .slider-inline {
    display: grid;
    grid-template-columns: minmax(140px, 1.2fr) 1fr minmax(48px, 64px);
    gap: 8px;
    width: 100%;
  }

  .filter-sliders .slider-inline > span:first-child {
    text-align: left;
  }

  .filter-sliders .slider-inline > span:last-child {
    text-align: right;
  }

  .filter-range {
    width: 100%;
    max-width: none;
  }
}
</style>
