<script setup>
import { ref, onMounted, watch, computed } from "vue";
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
const lastTripReportSyncTime = ref(null);

const formatSyncTimestamp = (value) => {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "";
  }
};

const loadTrips = async () => {
  await refreshTrips();
};

const clearSelection = () => {
  selectedTripId.value = "";
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

const normalizedTripName = computed(() => tripForm.value.name.trim().toLowerCase());
const hasDuplicateName = computed(() => {
  if (!normalizedTripName.value) return false;
  return trips.value.some(
    (trip) =>
      trip.name?.trim().toLowerCase() === normalizedTripName.value &&
      trip.id !== selectedTripId.value,
  );
});

const speciesList = computed(() => processedData.value?.speciesList || []);
const region = computed(() => processedData.value?.region || { code: "", name: "" });

const persistTripDetails = async () => {
  if (!selectedTripId.value) return;
  if (!tripForm.value.name) return;
  if (hasDuplicateName.value) return;
  const now = Date.now();
  await db.trips.update(selectedTripId.value, {
    name: tripForm.value.name,
    updatedAt: now,
  });
  await loadTrips();
  loadedTrip.value = await db.trips.get(selectedTripId.value);
  setSaveStatus("Trip details updated.");
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
    clearSelection();
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

watch(selectedTripId, loadTripData);

onMounted(async () => {
  clearSelection();
  await loadTrips();
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
  await loadTrips();
  clearSelection();
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
      "http://tripreport.raphaelnussbaumer.com/tripreport-internal/v1/taxon-list/" + tripReportId,
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
    tripReportStatus.value = "";
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
          <div v-if="selectedTripId">
            <h5 class="card-title">Add trip details</h5>
            <p class="text-muted small mb-1">
              Update the trip name, refine the species list, and optionally sync an eBird trip
              report.
            </p>
            <div class="row g-3 align-items-center">
              <div class="col-md-3">
                <label class="form-label">Trip name</label>
              </div>
              <div class="col-md-9">
                <input
                  v-model="tripForm.name"
                  class="form-control"
                  placeholder="Spring migration"
                  @input="persistTripDetails"
                />
              </div>
            </div>
            <div class="mt-2" v-if="hasDuplicateName">
              <small class="text-danger">A trip with this name already exists.</small>
            </div>
            <hr />
            <h6>Sync Life list</h6>
            <LifeList
              :speciesList="speciesList"
              :region="region"
              @update:speciesList="handleSpeciesListUpdate"
            />
            <hr />
            <h6>Sync eBird trip report</h6>
            <p class="small text-muted mt-1">
              Paste the trip report ID (from the URL after /tripreport/) — find your report at
              <a
                class="text-decoration-none"
                href="https://ebird.org/mytripreports"
                target="_blank"
                rel="noopener"
              >
                eBird trip reports
              </a>
              .
            </p>
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
              v-if="lastTripReportSyncTime"
              class="alert alert-success py-1 px-2 mt-2 mb-0 small d-flex align-items-center"
            >
              <i class="bi bi-check-circle-fill me-2"></i>
              <div>
                <div><strong>Synced:</strong> {{ formatSyncTimestamp(lastTripReportSyncTime) }}</div>
              </div>
            </div>
            <div class="d-flex flex-wrap align-items-center gap-2 mt-2">
              <span class="small text-muted" v-if="tripReportStatus">{{ tripReportStatus }}</span>
            </div>
            <hr />
            <p class="text-muted small mb-2">
              Export the trip to save your progress locally and continue on another computer or
              phone.
            </p>
            <button
              class="btn btn-outline-primary w-100"
              @click="exportTrip"
              :disabled="!selectedTripId || isExporting"
            >
              <span v-if="isExporting" class="spinner-border spinner-border-sm me-2"></span>
              Export this trip
            </button>
            <button class="btn btn-outline-danger w-100 mt-2" @click="deleteTrip">
              Delete trip
            </button>
          </div>
          <div v-else class="text-muted mt-3">Select a trip from the header to edit.</div>
        </div>
      </div>
    </div>
  </div>
</template>
