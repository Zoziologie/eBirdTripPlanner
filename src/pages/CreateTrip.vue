<script setup>
import { ref, onMounted, onBeforeUnmount, watch, computed } from "vue";
import { db } from "../data/db";
import Initiate from "../components/Initiate.vue";
import LifeList from "../components/LifeList.vue";
import { trips, selectedTripId, refreshTrips } from "../state/tripSelection";

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
  console.log(safePayload);
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
const newWorldCount = computed(
  () => speciesList.value.filter((species) => species.liferWorld === true).length,
);
const newRegionCount = computed(
  () => speciesList.value.filter((species) => species.liferRegion === true).length,
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
    const codeSet = new Set();
    const sciSet = new Set();
    const prepared = entries.map((entry) => {
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        if (trimmed.includes(" ")) {
          sciSet.add(trimmed);
        } else {
          codeSet.add(trimmed);
        }
        return { code: trimmed };
      }
      const code =
        entry.speciesCode ||
        entry.code ||
        entry.species_code ||
        entry.taxonCode ||
        entry.taxon_code ||
        entry.speciesId ||
        entry.species_id ||
        "";
      const scientificName = entry.sciName || entry.scientificName || entry.scientific_name || "";
      const commonName = entry.commonName || entry.comName || entry.common_name || "";
      if (code) codeSet.add(code);
      if (scientificName) sciSet.add(scientificName);
      return {
        code,
        scientificName,
        commonName,
        taxonOrder: entry.taxonOrder ?? entry.taxon_order ?? Infinity,
      };
    });

    const existing = processedData.value?.speciesList || [];
    const nextList = existing.map((species) => {
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
    await db.trips.update(selectedTripId.value, { tripReportSyncedAt: syncTimestamp });
    lastTripReportSyncTime.value = syncTimestamp;
    tripReportStatus.value = "Trip report species synced.";
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

const importTrip = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  transferStatus.value = "";
  isImporting.value = true;
  try {
    const contents = await file.text();
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
  <div class="row g-4 mt-1">
    <div class="col-lg-6">
      <div class="card mb-3">
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
          <div v-if="trips.length">
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
              <button class="btn btn-outline-danger btn-sm flex-fill" @click="deleteTrip">
                <i class="bi bi-trash3 me-1"></i>
                Delete
              </button>
            </div>
          </div>
          <div v-else class="text-muted small">
            Create or import a trip below before selecting one here.
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
            accept="application/json"
            @change="importTrip"
            :disabled="isImporting"
          />
        </div>
      </div>
    </div>

    <div class="col-lg-6">
      <div class="card">
        <div class="card-body">
          <h5 class="card-title">Targets</h5>
          <p class="text-muted small mb-1">
            Sync life lists and trip reports to flag world, region, and trip targets.
          </p>
          <div v-if="selectedTripId">
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
                    <span
                      v-if="isSyncingTripReport"
                      class="spinner-border spinner-border-sm"
                    ></span>
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
          <div v-else class="text-muted mt-3">
            Select an active trip from the left card to manage targets.
          </div>
        </div>
      </div>
    </div>
  </div>

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
