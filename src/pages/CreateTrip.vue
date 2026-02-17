<script setup>
import { ref, onMounted, onBeforeUnmount, watch, computed } from "vue";
import { db } from "../data/db";
import Initiate from "../components/Initiate.vue";
import LifeList from "../components/LifeList.vue";
import { trips, selectedTripId, refreshTrips } from "../state/tripSelection";
import { bumpEbdUpdatedAt } from "../state/ebdUpdates";
import { resolveSpeciesTaxon, extractTaxonFields } from "../utils/taxonomy";

const tripForm = ref({
  name: "",
  tripReportId: "",
});

const processedData = ref(null);
const saveStatus = ref("");
const loadedTrip = ref(null);
const isExporting = ref(false);
const isImporting = ref(false);
const transferStatus = ref("");
const statusMessage = computed(() => transferStatus.value || saveStatus.value);
const isSyncingTripReport = ref(false);
const tripReportStatus = ref("");
const tripReportAlertMessage = computed(() => {
  if (tripReportStatus.value) return tripReportStatus.value;
  if (lastTripReportSyncTime.value) return "Trip report species synced.";
  return "";
});
const tripReportAlertVariant = computed(() => {
  const text = (tripReportStatus.value || "").toLowerCase();
  if (text.includes("failed") || text.includes("error")) return "danger";
  if (text.includes("warning")) return "warning";
  if (text.includes("canceled")) return "warning";
  if (text.includes("load")) return "warning";
  if (tripReportStatus.value) return "info";
  if (lastTripReportSyncTime.value) return "success";
  return "info";
});
const tripReportAlertIcon = computed(() => {
  const variant = tripReportAlertVariant.value;
  if (variant === "success") return "bi-check-circle-fill";
  if (variant === "danger") return "bi-exclamation-triangle-fill";
  if (variant === "warning") return "bi-exclamation-triangle-fill";
  return "bi-info-circle-fill";
});
const showLastSyncLabel = computed(
  () => tripReportAlertVariant.value === "success" && lastTripReportSyncTime.value,
);
const lastTripReportSyncTime = ref(null);
const installPromptEvent = ref(null);
const isPwaInstalled = ref(false);
const canInstallPwa = computed(() => Boolean(installPromptEvent.value) && !isPwaInstalled.value);
const appVersion = __APP_VERSION__;
const repoUrl = "https://github.com/Zoziologie/eBirdTripPlanner";
const sponsorUrl = "https://github.com/sponsors/Zoziologie";
const zoziologieUrl = "https://zoziologie.raphaelnussbaumer.com/";
const zoziologieLogoUrl = "https://zoziologie.raphaelnussbaumer.com/assets/logo_w.svg";

const formatSyncTimestamp = (value) => {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "";
  }
};

const handleBeforeInstallPrompt = (event) => {
  event.preventDefault();
  installPromptEvent.value = event;
};

const handleAppInstalled = () => {
  isPwaInstalled.value = true;
  installPromptEvent.value = null;
};

const triggerPwaInstall = async () => {
  const prompt = installPromptEvent.value;
  if (!prompt) return;
  prompt.prompt();
  try {
    const { outcome } = await prompt.userChoice;
    if (outcome === "accepted") {
      installPromptEvent.value = null;
    }
  } catch (error) {
    console.warn("Install prompt failed", error);
  }
};

const loadTrips = async () => {
  await refreshTrips();
};

const resetLocalState = () => {
  loadedTrip.value = null;
  processedData.value = null;
  saveStatus.value = "";
  tripForm.value = { name: "", tripReportId: "" };
  lastTripReportSyncTime.value = null;
};

const buildUniqueTripName = (baseName) => {
  const cleanedBase = (baseName || "").trim() || "New trip";
  if (!trips.value.some((trip) => trip.name?.trim() === cleanedBase)) {
    return cleanedBase;
  }
  let index = 2;
  let candidate = `${cleanedBase} ${index}`;
  while (trips.value.some((trip) => trip.name?.trim() === candidate)) {
    index += 1;
    candidate = `${cleanedBase} ${index}`;
  }
  return candidate;
};

const createTripFromProcessed = async (payload) => {
  const now = Date.now();
  const id = crypto.randomUUID();
  const tripName = buildUniqueTripName(payload?.region?.name);
  const safePayload = JSON.parse(JSON.stringify(payload));
  await db.trips.put({
    id,
    name: tripName,
    tripReportId: "",
    createdAt: now,
    updatedAt: now,
  });
  await db.ebd.put({
    tripId: id,
    speciesList: safePayload.speciesList,
    locations: safePayload.locations,
    region: safePayload.region,
    filters: safePayload.filters,
    updatedAt: now,
  });
  bumpEbdUpdatedAt();
  await loadTrips();
  selectedTripId.value = id;
  setSaveStatus("Trip created.");
};

const handleProcessed = async (payload) => {
  processedData.value = payload;
  saveStatus.value = "";
  await createTripFromProcessed(payload);
};

const isRenameModalOpen = ref(false);
const renameTripName = ref("");
const normalizedRenameTripName = computed(() => renameTripName.value.trim().toLowerCase());
const hasDuplicateRename = computed(() => {
  if (!normalizedRenameTripName.value) return false;
  return trips.value.some(
    (trip) =>
      trip.name?.trim().toLowerCase() === normalizedRenameTripName.value &&
      trip.id !== selectedTripId.value,
  );
});

const speciesList = computed(() => processedData.value?.speciesList || []);
const region = computed(() => processedData.value?.region || { code: "", name: "" });
const totalSpeciesCount = computed(() => speciesList.value.length);
const isTripConfirmedSpecies = (species) => species?.tripReportSeen === true;
const isWorldTargetSpecies = (species) =>
  species?.liferWorld === true && !isTripConfirmedSpecies(species);
const isRegionTargetSpecies = (species) =>
  species?.liferRegion === true && !isTripConfirmedSpecies(species);
const newWorldCount = computed(
  () => speciesList.value.filter((species) => isWorldTargetSpecies(species)).length,
);
const newRegionCount = computed(
  () => speciesList.value.filter((species) => isRegionTargetSpecies(species)).length,
);
const newTripCount = computed(
  () => speciesList.value.filter((species) => species.tripReportSeen === false).length,
);

const persistTripDetails = async () => {
  if (!selectedTripId.value) return;
  if (!tripForm.value.name) return;
  const now = Date.now();
  await db.trips.update(selectedTripId.value, {
    name: tripForm.value.name,
    updatedAt: now,
  });
  await loadTrips();
  loadedTrip.value = await db.trips.get(selectedTripId.value);
  setSaveStatus("Trip details updated.");
};

const openRenameModal = () => {
  if (!selectedTripId.value) return;
  renameTripName.value = tripForm.value.name || loadedTrip.value?.name || "";
  isRenameModalOpen.value = true;
};

const closeRenameModal = () => {
  isRenameModalOpen.value = false;
};

const saveRenameTrip = async () => {
  if (!selectedTripId.value) return;
  const nextName = renameTripName.value.trim();
  if (!nextName || hasDuplicateRename.value) return;
  const now = Date.now();
  await db.trips.update(selectedTripId.value, { name: nextName, updatedAt: now });
  tripForm.value.name = nextName;
  await loadTrips();
  loadedTrip.value = await db.trips.get(selectedTripId.value);
  setSaveStatus("Trip details updated.");
  closeRenameModal();
};

const persistTripReportId = async () => {
  if (!selectedTripId.value) return;
  const now = Date.now();
  await db.trips.update(selectedTripId.value, {
    tripReportId: tripForm.value.tripReportId,
    updatedAt: now,
  });
  loadedTrip.value = await db.trips.get(selectedTripId.value);
  setSaveStatus("Trip details updated.");
};

let statusTimer = null;
const setSaveStatus = (message) => {
  saveStatus.value = message;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    saveStatus.value = "";
  }, 2000);
};

const handleSpeciesListUpdate = async (updatedList) => {
  if (!selectedTripId.value || !processedData.value) return;
  processedData.value = {
    ...processedData.value,
    speciesList: updatedList,
  };
  await db.ebd.where("tripId").equals(selectedTripId.value).modify({
    speciesList: updatedList,
    updatedAt: Date.now(),
  });
  bumpEbdUpdatedAt();
  setSaveStatus("Trip details updated.");
};

const loadTripData = async (tripId) => {
  if (!tripId) {
    resetLocalState();
    return;
  }
  loadedTrip.value = await db.trips.get(tripId);
  if (loadedTrip.value) {
    tripForm.value = {
      name: loadedTrip.value.name || "",
      tripReportId: loadedTrip.value.tripReportId || "",
    };
  }
  lastTripReportSyncTime.value = loadedTrip.value?.tripReportSyncedAt || null;
  const ebd = await db.ebd.where("tripId").equals(tripId).first();
  processedData.value = ebd || null;
  saveStatus.value = "";
};

watch(selectedTripId, loadTripData, { immediate: true });

onMounted(async () => {
  resetLocalState();
  await loadTrips();
  window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  window.addEventListener("appinstalled", handleAppInstalled);
});

onBeforeUnmount(() => {
  window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  window.removeEventListener("appinstalled", handleAppInstalled);
});

const deleteTrip = async () => {
  if (!selectedTripId.value) return;
  const tripName = loadedTrip.value?.name || "this trip";
  const confirmed = window.confirm(`Delete ${tripName}? This cannot be undone.`);
  if (!confirmed) return;
  const tripId = selectedTripId.value;
  await db.trips.delete(tripId);
  await db.ebd.where("tripId").equals(tripId).delete();
  await db.visits.where("tripId").equals(tripId).delete();
  bumpEbdUpdatedAt();
  resetLocalState();
  await loadTrips();
  setSaveStatus("Trip deleted.");
};

const sanitizeFilename = (value) => {
  const cleaned = (value || "")
    .trim()
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "trip";
};

const normalizeTripReportId = (value) => (value || "").trim();

const getTripReportUrl = () => {
  const id = normalizeTripReportId(tripForm.value.tripReportId);
  if (!id) return "";
  return `https://ebird.org/tripreport/${id}`;
};

const extractTripReportSpecies = (payload) => {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return payload.species || payload.taxa || payload.taxons || payload.data || payload.list || [];
};

const normalizeTripReportEntry = (entry) => {
  if (typeof entry === "string") {
    const value = entry.trim();
    if (!value) return null;
    const looksLikeScientificName = value.includes(" ");
    const resolvedTaxon = resolveSpeciesTaxon({
      speciesCode: looksLikeScientificName ? "" : value,
      scientificName: looksLikeScientificName ? value : "",
    });
    if (!resolvedTaxon) return null;
    return {
      code: resolvedTaxon.speciesCode || (looksLikeScientificName ? "" : value),
      scientificName: resolvedTaxon.sciName || (looksLikeScientificName ? value : ""),
      commonName: resolvedTaxon.comName || "",
      taxonOrder: resolvedTaxon.taxonOrder ?? Infinity,
    };
  }

  if (!entry || typeof entry !== "object") return null;
  const { speciesCode, scientificName, commonName, category, reportAs } = extractTaxonFields(entry);

  const resolvedTaxon = resolveSpeciesTaxon({
    speciesCode,
    scientificName,
    category,
    reportAs,
  });
  if (!resolvedTaxon) return null;

  const rawTaxonOrder = Number(entry.taxonOrder ?? entry.taxon_order);
  return {
    code: resolvedTaxon.speciesCode || speciesCode || scientificName,
    scientificName: resolvedTaxon.sciName || scientificName,
    commonName: resolvedTaxon.comName || commonName,
    taxonOrder: Number.isFinite(rawTaxonOrder)
      ? rawTaxonOrder
      : (resolvedTaxon.taxonOrder ?? Infinity),
  };
};

const getCanonicalSpeciesCode = (species) => {
  const resolvedTaxon = resolveSpeciesTaxon({
    speciesCode: species?.code,
    scientificName: species?.scientificName,
  });
  return resolvedTaxon?.speciesCode || species?.code || "";
};

const collectEbdSpeciesCodes = (locations) => {
  const codes = new Set();
  if (!Array.isArray(locations)) return codes;

  locations.forEach((location) => {
    const entries = Array.isArray(location?.species_checklist_counts)
      ? location.species_checklist_counts
      : [];
    entries.forEach(([code]) => {
      if (!code) return;
      const resolvedTaxon = resolveSpeciesTaxon({ speciesCode: code });
      const normalizedCode = resolvedTaxon?.speciesCode || code;
      if (normalizedCode) codes.add(normalizedCode);
    });
  });

  return codes;
};

const formatSpeciesLabel = (species) => {
  const common = (species?.commonName || "").trim();
  const scientific = (species?.scientificName || "").trim();
  const code = (species?.code || "").trim();
  const base =
    common && scientific ? `${common} (${scientific})` : common || scientific || "Unknown species";
  return code ? `${base} [${code}]` : base;
};

const syncTripReportSpecies = async () => {
  const tripReportId = normalizeTripReportId(tripForm.value.tripReportId);
  if (!selectedTripId.value || !tripReportId) return;
  if (!processedData.value) {
    tripReportStatus.value = "Load a trip species list before syncing.";
    return;
  }
  isSyncingTripReport.value = true;
  tripReportStatus.value = "";
  try {
    const response = await fetch(
      "https://tripreport.raphaelnussbaumer.com/tripreport-internal/v1/taxon-list/" + tripReportId,
    );
    if (!response.ok) throw new Error(`Trip report request failed: ${response.status}`);
    const payload = await response.json();
    const entries = extractTripReportSpecies(payload);
    const prepared = entries.map((entry) => normalizeTripReportEntry(entry)).filter(Boolean);
    const codeSet = new Set(prepared.map((item) => item.code).filter(Boolean));
    const sciSet = new Set(prepared.map((item) => item.scientificName).filter(Boolean));
    const ebdCodeSet = collectEbdSpeciesCodes(processedData.value?.locations || []);
    const outsideEbdSpecies = prepared.filter((species) => {
      if (ebdCodeSet.size === 0) return false;
      return species.code && !ebdCodeSet.has(species.code);
    });
    if (outsideEbdSpecies.length > 0) {
      const uniqueOutside = Array.from(
        new Map(
          outsideEbdSpecies.map((species) => [species.code || species.scientificName, species]),
        ).values(),
      );
      const speciesListText = uniqueOutside
        .map((species, index) => `${index + 1}. ${formatSpeciesLabel(species)}`)
        .join("\n");
      const confirmed = window.confirm(
        [
          "This trip report includes species not found in the original EBD species list:",
          "",
          speciesListText,
          "",
          "Press OK to continue and add them.",
          "Press Cancel to abort this trip report sync.",
        ].join("\n"),
      );
      if (!confirmed) {
        tripReportStatus.value = "Trip report sync canceled.";
        return;
      }
    }

    const existing = processedData.value?.speciesList || [];
    const baselineSpecies = existing.filter((species) => {
      if (ebdCodeSet.size === 0) return true;
      const canonicalCode = getCanonicalSpeciesCode(species);
      return canonicalCode && ebdCodeSet.has(canonicalCode);
    });
    const removedOutsideEbdCount = Math.max(existing.length - baselineSpecies.length, 0);

    const nextList = baselineSpecies.map((species) => {
      const match =
        (species.code && codeSet.has(species.code)) ||
        (species.scientificName && sciSet.has(species.scientificName));
      return {
        ...species,
        tripReportSeen: match,
      };
    });

    prepared.forEach((species) => {
      if (!species.code && !species.scientificName) return;
      const exists = nextList.some(
        (item) =>
          (species.code && item.code === species.code) ||
          (species.scientificName && item.scientificName === species.scientificName),
      );
      if (exists) return;
      nextList.push({
        code: species.code || species.scientificName || "unknown",
        commonName: species.commonName || species.code || species.scientificName || "Unknown",
        scientificName: species.scientificName || "",
        taxonOrder: species.taxonOrder ?? Infinity,
        tripReportSeen: true,
      });
    });

    const syncTimestamp = Date.now();
    processedData.value = {
      ...processedData.value,
      speciesList: nextList,
    };
    await db.ebd.where("tripId").equals(selectedTripId.value).modify({
      speciesList: nextList,
      updatedAt: syncTimestamp,
    });
    bumpEbdUpdatedAt();
    await db.trips.update(selectedTripId.value, { tripReportSyncedAt: syncTimestamp });
    lastTripReportSyncTime.value = syncTimestamp;
    tripReportStatus.value =
      removedOutsideEbdCount > 0
        ? `Trip report species synced. ${removedOutsideEbdCount} previously added non-EBD species were removed from this trip.`
        : "Trip report species synced.";
  } catch (error) {
    tripReportStatus.value = `Trip report sync failed: ${error.message || error}`;
  } finally {
    isSyncingTripReport.value = false;
  }
};

const exportTrip = async () => {
  if (!selectedTripId.value) return;
  isExporting.value = true;
  transferStatus.value = "";
  try {
    const trip = await db.trips.get(selectedTripId.value);
    if (!trip) throw new Error("Trip not found.");
    const ebd = await db.ebd.where("tripId").equals(selectedTripId.value).first();
    const visits = await db.visits.where("tripId").equals(selectedTripId.value).toArray();
    const lists = await db.lists.where("tripId").equals(selectedTripId.value).toArray();
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      trip,
      ebd,
      visits,
      lists,
    };
    const blob = new Blob([JSON.stringify(payload)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const safeName = sanitizeFilename(trip.name);
    link.href = url;
    link.download = `ebird-trip-${safeName}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    transferStatus.value = "Trip exported.";
  } catch (error) {
    transferStatus.value = `Export failed: ${error.message || error}`;
  } finally {
    isExporting.value = false;
  }
};

const stripUtf8Bom = (text) => {
  if (typeof text !== "string") return "";
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
};

const readFileWithFileReader = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.readAsText(file);
  });

const readImportedTripFile = async (file) => {
  const attempts = [];

  if (typeof file?.text === "function") {
    try {
      const text = await file.text();
      if (typeof text === "string" && text.trim()) return stripUtf8Bom(text);
      attempts.push("empty text() result");
    } catch (error) {
      attempts.push(`text() failed: ${error?.message || error}`);
    }
  }

  if (typeof file?.arrayBuffer === "function") {
    try {
      const buffer = await file.arrayBuffer();
      const text = new TextDecoder("utf-8").decode(buffer);
      if (text.trim()) return stripUtf8Bom(text);
      attempts.push("empty arrayBuffer() decode");
    } catch (error) {
      attempts.push(`arrayBuffer() failed: ${error?.message || error}`);
    }
  }

  try {
    const text = await readFileWithFileReader(file);
    if (text.trim()) return stripUtf8Bom(text);
    attempts.push("empty FileReader result");
  } catch (error) {
    attempts.push(`FileReader failed: ${error?.message || error}`);
  }

  throw new Error(
    `Could not read file content from this provider. ${attempts.join("; ")}. Try downloading locally first.`,
  );
};

const importTrip = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  transferStatus.value = "";
  isImporting.value = true;
  try {
    const contents = await readImportedTripFile(file);
    const parsed = JSON.parse(contents);
    if (!parsed || typeof parsed !== "object" || !parsed.trip?.id) {
      throw new Error("Invalid trip file.");
    }
    const tripId = parsed.trip.id;
    const confirmed = window.confirm(
      `Import "${parsed.trip.name || "trip"}"? This will overwrite any existing data for it.`,
    );
    if (!confirmed) {
      event.target.value = "";
      return;
    }
    await db.transaction("rw", db.trips, db.ebd, db.visits, db.lists, async () => {
      await db.trips.put(parsed.trip);

      if (parsed.ebd) {
        await db.ebd.put({ ...parsed.ebd, tripId });
      } else {
        await db.ebd.where("tripId").equals(tripId).delete();
      }

      await db.visits.where("tripId").equals(tripId).delete();
      if (Array.isArray(parsed.visits) && parsed.visits.length > 0) {
        await db.visits.bulkPut(parsed.visits.map((visit) => ({ ...visit, tripId })));
      }

      await db.lists.where("tripId").equals(tripId).delete();
      if (Array.isArray(parsed.lists) && parsed.lists.length > 0) {
        await db.lists.bulkPut(parsed.lists.map((item) => ({ ...item, tripId })));
      }
    });
    bumpEbdUpdatedAt();
    await loadTrips();
    selectedTripId.value = tripId;
    transferStatus.value = "Trip imported.";
  } catch (error) {
    transferStatus.value = `Import failed: ${error.message || error}`;
  } finally {
    isImporting.value = false;
    event.target.value = "";
  }
};
</script>

<template>
  <div class="row g-4 mt-1" v-if="!selectedTripId">
    <div class="col-12">
      <div class="card border-primary bg-primary-subtle">
        <div class="card-body py-3">
          <h5 class="card-title text-primary mb-2">
            <i class="bi bi-compass-fill me-2"></i>
            Welcome to eBird Trip Planner
          </h5>
          <p class="mb-2">
            Turn raw eBird data into a real game plan. Load your EBD export, shape it into a trip,
            and quickly see where your best species chances are.
          </p>
          <p class="mb-0 small text-muted">
            Goal: help you bird smarter, not harder. Build trips, track targets, sync life lists and
            trip reports, and focus your field time on species that matter most.
          </p>
        </div>
      </div>
    </div>
  </div>
  <div class="row g-4 mt-1">
    <div class="col-lg-6">
      <div class="card mb-3" v-if="trips.length">
        <div class="card-body">
          <div class="d-flex align-items-center justify-content-between gap-2">
            <h5 class="card-title mb-0">Select active trip</h5>
            <button
              v-if="canInstallPwa"
              class="btn btn-outline-secondary btn-sm"
              type="button"
              @click="triggerPwaInstall"
            >
              <i class="bi bi-download"></i>
              <span class="ms-1">Install app</span>
            </button>
          </div>
          <p class="text-muted small mb-2">
            Choose the trip you want to manage. This selection updates the header indicator.
          </p>
          <select
            v-model="selectedTripId"
            class="form-select"
            aria-label="Select the trip you want to edit"
          >
            <option v-if="!trips.length" value="" disabled selected>Select a trip</option>
            <option v-for="trip in trips" :key="trip.id" :value="trip.id">
              {{ trip.name }}
            </option>
          </select>
          <div class="form-text text-muted small mt-1">
            Trip actions below apply to the selected trip.
          </div>
          <div class="d-flex align-items-center gap-2 mt-3 flex-wrap" v-if="selectedTripId">
            <button class="btn btn-outline-secondary btn-sm flex-fill" @click="openRenameModal">
              <i class="bi bi-pencil-square me-1"></i>
              Rename
            </button>
            <button
              class="btn btn-outline-primary btn-sm flex-fill"
              @click="exportTrip"
              :disabled="!selectedTripId || isExporting"
            >
              <span v-if="isExporting" class="spinner-border spinner-border-sm me-1"></span>
              <i v-else class="bi bi-download me-1"></i>
              Export
            </button>
            <button
              class="btn btn-outline-secondary btn-sm flex-fill text-danger"
              @click="deleteTrip"
            >
              <i class="bi bi-trash3 me-1"></i>
              Delete
            </button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-body">
          <h5 class="card-title">Create new birding trip</h5>
          <Initiate @processed="handleProcessed" />
          <hr />
          <h5>Import existing birding trip</h5>
          <p class="text-muted small mb-2">
            Import a trip file that was previously exported from this app (via the “Export this
            trip” button).
          </p>
          <input
            type="file"
            class="form-control"
            accept=".json,application/json,text/plain,application/octet-stream"
            @change="importTrip"
            :disabled="isImporting"
          />
        </div>
      </div>
    </div>

    <div class="col-lg-6" v-if="selectedTripId">
      <div class="card">
        <div class="card-body">
          <h5 class="card-title">Targets</h5>
          <p class="text-muted small mb-1">
            Sync life lists and trip reports to flag world, region, and trip targets.
          </p>
          <LifeList
            variant="targets"
            :showSummary="false"
            :speciesList="speciesList"
            :region="region"
            @update:speciesList="handleSpeciesListUpdate"
          />
          <div class="row g-2 align-items-start mt-3">
            <div class="col-md-3">
              <label class="form-label fw-semibold mb-1">
                <a
                  class="text-decoration-none"
                  href="https://ebird.org/mytripreports"
                  target="_blank"
                  rel="noopener"
                >
                  <i class="bi bi-car-front-fill text-danger me-1"></i>
                  Trip report
                </a>
              </label>
              <div class="text-muted small">
                Paste the trip report ID to mark species seen on this trip.
              </div>
            </div>
            <div class="col-md-9">
              <div class="input-group">
                <span class="input-group-text">https://ebird.org/tripreport/</span>
                <input
                  v-model="tripForm.tripReportId"
                  class="form-control"
                  @input="persistTripReportId"
                />
                <button
                  class="btn btn-outline-secondary"
                  type="button"
                  @click="syncTripReportSpecies"
                  :disabled="!tripForm.tripReportId || isSyncingTripReport"
                  aria-label="Sync trip report species list"
                >
                  <span v-if="isSyncingTripReport" class="spinner-border spinner-border-sm"></span>
                  <i v-else class="bi bi-arrow-repeat"></i>
                </button>
              </div>
              <div
                v-if="tripReportAlertMessage"
                class="alert py-2 px-3 mt-2 mb-0 small d-flex align-items-center"
                :class="`alert-${tripReportAlertVariant}`"
              >
                <i class="bi me-2" :class="tripReportAlertIcon"></i>
                <div>
                  <div>{{ tripReportAlertMessage }}</div>
                  <div class="text-muted small" v-if="showLastSyncLabel">
                    Last synced: {{ formatSyncTimestamp(lastTripReportSyncTime) }}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-if="totalSpeciesCount" class="mt-3 pt-2 border-top">
            <div class="d-flex flex-wrap gap-3 small">
              <div><strong>Total Species (EBD):</strong> {{ totalSpeciesCount }}</div>
              <div>
                <strong>New for World:</strong>
                <span class="text-danger fw-semibold ms-1">{{ newWorldCount }}</span>
              </div>
              <div>
                <strong>New for Region:</strong>
                <span class="text-danger fw-semibold ms-1">{{ newRegionCount }}</span>
              </div>
              <div>
                <strong>New for Trip:</strong>
                <span class="text-danger fw-semibold ms-1">{{ newTripCount }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <footer class="tech-footer mt-4">
    <div class="tech-footer-links d-flex flex-wrap align-items-center justify-content-center gap-2 small text-muted">
      <span>v{{ appVersion }}</span>
      <span class="tech-footer-divider">•</span>
      <a
        :href="repoUrl"
        target="_blank"
        rel="noopener"
        class="text-decoration-none text-reset d-inline-flex align-items-center gap-1"
      >
        <i class="bi bi-github"></i>
        <span>GitHub</span>
      </a>
      <span class="tech-footer-divider">•</span>
      <a
        :href="sponsorUrl"
        target="_blank"
        rel="noopener"
        class="text-decoration-none text-reset d-inline-flex align-items-center gap-1"
      >
        <i class="bi bi-heart-fill text-danger"></i>
        <span>Sponsor</span>
      </a>
      <span class="tech-footer-divider">•</span>
      <a
        :href="zoziologieUrl"
        target="_blank"
        rel="noopener"
        class="text-decoration-none text-reset d-inline-flex align-items-center gap-1"
        title="Zoziologie"
      >
        <span>Powered by</span>
        <span class="zoziologie-logo-wrap">
          <img :src="zoziologieLogoUrl" alt="Zoziologie Logo" class="zoziologie-logo" />
        </span>
        <span class="fw-semibold">Zoziologie</span>
      </a>
    </div>
  </footer>

  <div v-if="isRenameModalOpen">
    <div
      class="modal fade show"
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      style="display: block"
    >
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">Rename trip</h5>
            <button type="button" class="btn-close" @click="closeRenameModal"></button>
          </div>
          <div class="modal-body">
            <label class="form-label">Trip name</label>
            <input v-model="renameTripName" class="form-control" placeholder="Spring migration" />
            <div class="mt-2" v-if="hasDuplicateRename">
              <small class="text-danger">A trip with this name already exists.</small>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-outline-secondary" type="button" @click="closeRenameModal">
              Cancel
            </button>
            <button
              class="btn btn-primary"
              type="button"
              @click="saveRenameTrip"
              :disabled="!renameTripName.trim() || hasDuplicateRename"
            >
              Rename
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="modal-backdrop fade show"></div>
  </div>
</template>

<style scoped>
.tech-footer {
  width: 100%;
  padding: 10px 2px 0;
  border-top: 1px solid var(--bs-border-color);
}

.tech-footer-divider {
  opacity: 0.6;
}

.zoziologie-logo-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 6px;
  border-radius: 8px;
  background: linear-gradient(135deg, #2c3e50 0%, #3f5f78 100%);
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.zoziologie-logo {
  height: 14px;
  width: auto;
  display: block;
}
</style>
