<template>
  <p class="text-muted small">
    To create a new trip, download the
    <a href="https://ebird.org/data/download" target="_blank">eBird Basic Dataset (EBD)</a>
    and load one or more .zip or .txt files below. Processing happens locally in your browser.
  </p>
  <div class="row">
    <div class="col">
      <input
        type="file"
        id="fileInput"
        @change="handleFileUpload"
        accept=".txt,.zip"
        multiple
        ref="fileInput"
        class="form-control"
        :disabled="disabled"
      />
      <!-- File Reading Progress -->
      <div v-if="readingFileProgress > 0" class="mt-2">
        <!-- Progress bar -->
        <div class="progress" v-if="readingFileProgress > 1">
          <div class="progress-bar" role="progressbar" :style="{ width: readingFileProgress + '%' }">
            {{ Math.round(readingFileProgress) }}%
          </div>
        </div>
        <small class="text-muted">
          <span
            v-if="readingFileStatus && readingFileStatus.startsWith('<span')"
            v-html="readingFileStatus"
          ></span>
          <span v-else>{{ readingFileStatus }}</span>
        </small>
      </div>

      <!-- Success message - only after raw data is loaded -->
      <div
        v-if="loadedRecordCount > 0 && readingFileProgress === 0 && !hasError"
        class="alert alert-success alert-dismissible mt-1 py-1"
      >
        <i class="bi bi-check-circle-fill me-2"></i>
        <strong>Success!</strong>
        {{ readingFileStatus }}
      </div>

      <!-- Error message -->
      <div v-if="hasError" class="alert alert-danger mt-3">
        <i class="bi bi-exclamation-triangle-fill me-2"></i>
        <strong>Processing failed!</strong>
        {{
          readingFileStatus ||
          "An error occurred while processing your file. Please check the file format and try again."
        }}
      </div>
    </div>
  </div>
  <div class="row">
    <div class="col" v-if="availableYears.min !== null">
      <!-- State/Province Filters -->
      <div v-if="availableStates.length > 1">
        <label for="stateFilter" class="form-label fw-semibold">State/Province</label>
        <select
          id="stateFilter"
          v-model="filters.state"
          class="form-select form-select-sm"
          multiple
          size="4"
        >
          <option v-for="state in availableStates" :key="state.code" :value="state.code">
            {{ state.name }}
          </option>
        </select>
      </div>
      <!-- County Filters -->

      <div v-if="availableCounties.length > 1">
        <label for="countyFilter" class="form-label fw-semibold">County</label>
        <select
          id="countyFilter"
          v-model="filters.county"
          class="form-select form-select-sm"
          multiple
          size="4"
        >
          <option v-for="county in availableCounties" :key="county.code" :value="county.code">
            {{ county.name }}
          </option>
        </select>
        <small class="text-muted">Hold Ctrl/Cmd to select multiple counties</small>
      </div>
    </div>
    <div class="col" v-if="availableYears.min !== null">
      <!-- Year Range Filter -->
      <label for="yearMinFilter" class="form-label fw-semibold">Year</label>
      <div class="row g-2 mb-3">
        <div class="col">
          <input
            type="number"
            id="yearMinFilter"
            v-model.number="filters.minYear"
            class="form-control form-control-sm"
            placeholder="Min"
            :min="availableYears.min"
            :max="availableYears.max"
          />
        </div>
        <div class="col">
          <input
            type="number"
            id="yearMaxFilter"
            v-model.number="filters.maxYear"
            class="form-control form-control-sm"
            placeholder="Max"
            :min="availableYears.min"
            :max="availableYears.max"
          />
        </div>
      </div>

      <!-- Month Range Filter -->
      <label for="monthMinFilter" class="form-label fw-semibold">Month</label>
      <div class="row g-2">
        <div class="col">
          <select
            id="monthMinFilter"
            v-model.number="filters.minMonth"
            class="form-select form-select-sm"
          >
            <option :value="null">Min</option>
            <option v-for="month in months" :key="month.value" :value="month.value">
              {{ month.label }}
            </option>
          </select>
        </div>
        <div class="col">
          <select
            id="monthMaxFilter"
            v-model.number="filters.maxMonth"
            class="form-select form-select-sm"
          >
            <option :value="null">Max</option>
            <option v-for="month in months" :key="month.value" :value="month.value">
              {{ month.label }}
            </option>
          </select>
        </div>
      </div>
    </div>
  </div>
  <!-- Process Button -->
  <div class="row mt-3" v-if="loadedRecordCount > 0 && readingFileProgress === 0">
    <p class="text-muted">
      Select the region(s) and time range of interest. Both complete and incomplete checklists are
      kept, but reporting rates use complete checklists by default.
    </p>
    <div class="col-auto d-flex align-items-center gap-3">
      <button @click="processChecklists" class="btn btn-primary" :disabled="isProcessing">
        <span v-if="isProcessing" class="spinner-border spinner-border-sm me-2"></span>
        {{ isProcessing ? "Filtering..." : "Create Trip" }}
      </button>
    </div>
    <div class="col-auto d-flex align-items-end">
      <small class="text-muted" v-if="checklists && checklists.length > 0">
        {{ checklists.length.toLocaleString() }} checklists filtered
      </small>
    </div>
  </div>
  <div class="row mt-3" v-if="saveStatus">
    <div class="col">
      <div :class="['alert', isProcessing ? 'alert-info' : 'alert-success', 'py-2', 'mb-0']">
        {{ saveStatus }}
      </div>
    </div>
  </div>
</template>

<script>
import { ref, reactive, shallowRef } from "vue";
import Papa from "papaparse";
import JSZip from "jszip";
import {
  taxonomyByScientificName as taxonomy_sci,
  taxonomyByCode as taxonomy_code,
} from "../utils/taxonomy";
import {
  addEbdRow,
  createEbdImportAccumulator,
  finalizeEbdImport,
  streamEbdZipEntry,
} from "../utils/ebdImport";

export default {
  emits: ["processed"],
  props: {
    disabled: {
      type: Boolean,
      default: false,
    },
  },
  setup(props, { emit }) {
    const fileInput = ref(null);
    const uploadedFiles = ref([]);

    // File reading state
    const readingFileProgress = ref(0);
    const readingFileStatus = ref("");
    const hasError = ref(false);
    const loadedRecordCount = ref(0);
    const loadedChecklists = shallowRef([]);

    // Checklists
    const isProcessing = ref(false);
    const checklists = shallowRef([]);
    const locations = shallowRef([]);
    const speciesList = shallowRef([]);
    const saveStatus = ref("");

    const availableStates = ref([]);
    const availableCounties = ref([]);
    const availableYears = ref({ min: null, max: null });

    const months = [
      { value: 1, label: "January" },
      { value: 2, label: "February" },
      { value: 3, label: "March" },
      { value: 4, label: "April" },
      { value: 5, label: "May" },
      { value: 6, label: "June" },
      { value: 7, label: "July" },
      { value: 8, label: "August" },
      { value: 9, label: "September" },
      { value: 10, label: "October" },
      { value: 11, label: "November" },
      { value: 12, label: "December" },
    ];

    const filters = reactive({
      minYear: null,
      maxYear: null,
      minMonth: 1,
      maxMonth: 12,
      state: [],
      county: [],
    });

    const clearLoadedResults = () => {
      loadedRecordCount.value = 0;
      loadedChecklists.value = [];
      checklists.value = [];
      locations.value = [];
      speciesList.value = [];
      availableStates.value = [];
      availableCounties.value = [];
      availableYears.value = { min: null, max: null };
      filters.minYear = null;
      filters.maxYear = null;
      filters.minMonth = 1;
      filters.maxMonth = 12;
      filters.state = [];
      filters.county = [];
    };

    const resetLoadedData = () => {
      clearLoadedResults();
      uploadedFiles.value = [];
      readingFileProgress.value = 0;
      if (fileInput.value) fileInput.value.value = "";
    };

    const finalizeImport = (accumulator) => {
      const result = finalizeEbdImport(accumulator);
      loadedChecklists.value = result.checklists;
      loadedRecordCount.value = result.recordCount;
      availableCounties.value = result.counties;
      availableStates.value = result.states;
      availableYears.value = { min: result.minYear, max: result.maxYear };
      filters.minYear = result.minYear;
      filters.maxYear = result.maxYear;
      readingFileStatus.value =
        `Loaded ${result.recordCount.toLocaleString()} records into ` +
        `${loadedChecklists.value.length.toLocaleString()} checklists.`;
      readingFileProgress.value = 0;
    };

    const parseTextFile = (file, accumulator, onProgress) =>
      new Promise((resolve, reject) => {
        Papa.parse(file, {
          header: true,
          delimiter: "\t",
          skipEmptyLines: true,
          chunkSize: 1024 * 1024,
          chunk(results) {
            for (const row of results.data) addEbdRow(row, accumulator);
            onProgress(results.meta.cursor / file.size);
          },
          complete: resolve,
          error: reject,
        });
      });

    const handleFileUpload = async (event) => {
      const files = Array.from(event.target.files || []);
      if (files.length === 0) return;
      clearLoadedResults();
      saveStatus.value = "";

      const invalidFile = files.find((file) => !/\.(txt|zip)$/i.test(file.name));
      if (invalidFile) {
        alert("Please select only .txt or .zip files");
        event.target.value = "";
        uploadedFiles.value = [];
        return;
      }

      uploadedFiles.value = files;
      await readFiles();
    };

    const readFiles = async () => {
      if (uploadedFiles.value.length === 0) return;

      clearLoadedResults();
      saveStatus.value = "";
      readingFileProgress.value = 1;
      readingFileStatus.value = "Starting file reading...";
      hasError.value = false;

      const accumulator = createEbdImportAccumulator(taxonomy_sci, taxonomy_code);
      const files = uploadedFiles.value;

      try {
        for (const [index, file] of files.entries()) {
          const updateProgress = (fileProgress) => {
            readingFileProgress.value = ((index + fileProgress) / files.length) * 100;
            readingFileStatus.value =
              `Reading file ${index + 1} of ${files.length} ` +
              `(${accumulator.recordCount.toLocaleString()} records retained)`;
          };

          if (file.name.toLowerCase().endsWith(".txt")) {
            await parseTextFile(file, accumulator, updateProgress);
            continue;
          }

          readingFileStatus.value = `Opening ZIP ${index + 1} of ${files.length}...`;
          const zip = await JSZip.loadAsync(file);
          const largestTxtFile = Object.values(zip.files).reduce((largest, entry) => {
            if (!entry.name.toLowerCase().endsWith(".txt") || !entry._data) return largest;
            return !largest || entry._data.uncompressedSize > largest._data.uncompressedSize
              ? entry
              : largest;
          }, null);
          if (!largestTxtFile) throw new Error(`No .txt file found in ${file.name}.`);

          await streamEbdZipEntry(largestTxtFile, accumulator, (progress) => {
            updateProgress(progress / 100);
          });
        }

        readingFileProgress.value = 100;
        readingFileStatus.value = "Finalizing data...";
        finalizeImport(accumulator);
      } catch (error) {
        console.error("File reading error:", error);
        readingFileProgress.value = 0;
        readingFileStatus.value = error?.message || "Error occurred while reading the files";
        hasError.value = true;
        checklists.value = null;
        uploadedFiles.value = [];
        if (fileInput.value) fileInput.value.value = "";
      }
    };

    const processChecklists = () => {
      if (loadedChecklists.value.length === 0) return;

      isProcessing.value = true;
      saveStatus.value = "Filtering checklists...";
      locations.value = [];
      speciesList.value = [];

      setTimeout(() => {
        const filteredChecklists = [];

        for (const checklist of loadedChecklists.value) {
          const rowDate = new Date(checklist.date);
          const rowYear = rowDate.getFullYear();
          const rowMonth = rowDate.getMonth() + 1;

          if (filters.minYear && rowYear < filters.minYear) continue;
          if (filters.maxYear && rowYear > filters.maxYear) continue;

          if (filters.minMonth && filters.maxMonth) {
            if (filters.minMonth <= filters.maxMonth) {
              if (rowMonth < filters.minMonth || rowMonth > filters.maxMonth) continue;
            } else {
              if (rowMonth < filters.minMonth && rowMonth > filters.maxMonth) continue;
            }
          }

          if (filters.state.length > 0 && !filters.state.includes(checklist.location.state_code))
            continue;
          if (filters.county.length > 0 && !filters.county.includes(checklist.location.county_code))
            continue;

          filteredChecklists.push(checklist);
        }

        checklists.value = filteredChecklists;
        saveStatus.value = "Filtering locations...";
        processLocations();
      }, 100);
    };

    const processLocations = () => {
      setTimeout(() => {
        const locationMap = new Map();

        checklists.value.forEach((checklist) => {
          if (!checklist.location) return;
          const localityId = checklist.location.locality_id;

          let location = locationMap.get(localityId);
          if (!location) {
            location = {
              locality_id: localityId,
              latitude: Number(checklist.location.latitude),
              longitude: Number(checklist.location.longitude),
              locality: checklist.location.locality || "",
              locality_hotspot: checklist.location.locality_hotspot || false,
              country: checklist.location.country || "",
              country_code: checklist.location.country_code || "",
              state: checklist.location.state || "",
              state_code: checklist.location.state_code || "",
              county: checklist.location.county || "",
              county_code: checklist.location.county_code || "",
              checklist_count: 0,
              checklist_count_complete: 0,
              checklist_count_incomplete: 0,
              speciesChecklistCounts: new Map(),
              checklist: [],
            };
            locationMap.set(localityId, location);
          }

          const isComplete = checklist.all_species_reported === true;
          if (isComplete) {
            location.checklist_count_complete += 1;
          } else {
            location.checklist_count_incomplete += 1;
          }
          location.checklist_count = location.checklist_count_complete;

          if (isComplete) {
            for (const entry of checklist.species || []) {
              const code = entry.code;
              if (!code) continue;
              location.speciesChecklistCounts.set(
                code,
                (location.speciesChecklistCounts.get(code) || 0) + 1,
              );
            }
          }
          if (isComplete) {
            location.checklist.push({
              checklist_id: checklist.checklist_id,
              date: checklist.date,
              time: checklist.time,
              duration_minutes: checklist.duration_minutes,
              effort_distance_km: checklist.effort_distance_km,
              all_species_reported: true,
              species: checklist.species,
            });
          }
        });

        locations.value = Array.from(locationMap.values());
        saveStatus.value = "Filtering species...";
        processSpecies();
      }, 50);
    };

    const processSpecies = () => {
      setTimeout(() => {
        const speciesSet = new Set();

        locations.value.forEach((location) => {
          for (const code of location.speciesChecklistCounts.keys()) {
            speciesSet.add(code);
          }
        });

        speciesList.value = Array.from(speciesSet)
          .map((code) => {
            const taxInfo = taxonomy_code[code];
            return {
              code: code,
              taxonOrder: taxInfo?.taxonOrder || Infinity,
              commonName: taxInfo?.comName || code,
              scientificName: taxInfo?.sciName || "",
            };
          })
          .sort((a, b) => a.taxonOrder - b.taxonOrder);

        saveStatus.value = "Finalizing results...";
        processDone();
      }, 50);
    };

    const buildSerializableFilters = () => ({
      minYear: filters.minYear,
      maxYear: filters.maxYear,
      minMonth: filters.minMonth,
      maxMonth: filters.maxMonth,
      state: Array.isArray(filters.state) ? [...filters.state] : [],
      county: Array.isArray(filters.county) ? [...filters.county] : [],
    });

    const processDone = () => {
      const region = { code: "", name: "" };
      const uniqueStates = new Set();
      const uniqueCountries = new Set();

      checklists.value.forEach((checklist) => {
        if (!checklist.location) return;
        uniqueStates.add(checklist.location.state_code);
        uniqueCountries.add(checklist.location.country_code);
      });

      if (uniqueStates.size === 1) {
        const stateCode = Array.from(uniqueStates)[0];
        const stateInfo = checklists.value[0]?.location;
        region.name = stateInfo?.state || "";
        region.code = stateCode;
      } else if (uniqueCountries.size === 1) {
        const countryCode = Array.from(uniqueCountries)[0];
        const countryInfo = checklists.value[0]?.location;
        region.name = countryInfo?.country || "";
        region.code = countryCode;
      }

      const payload = {
        speciesList: speciesList.value.map((species) => ({ ...species })),
        locations: locations.value.map((location) => ({
          locality_id: location.locality_id,
          latitude: Number(location.latitude),
          longitude: Number(location.longitude),
          locality: location.locality,
          locality_id: location.locality_id,
          locality_hotspot: location.locality_hotspot,
          country: location.country,
          country_code: location.country_code,
          state: location.state,
          state_code: location.state_code,
          county: location.county,
          county_code: location.county_code,
          checklist_count: location.checklist_count,
          checklist_count_complete: location.checklist_count_complete,
          checklist_count_incomplete: location.checklist_count_incomplete,
          species_checklist_counts: Array.from(location.speciesChecklistCounts.entries()),
          checklist: location.checklist,
        })),
        region,
        filters: buildSerializableFilters(),
      };
      resetLoadedData();
      emit("processed", payload);
      readingFileStatus.value = "Trip created. Import data cleared from memory.";
      saveStatus.value = "";
      isProcessing.value = false;
    };

    return {
      uploadedFiles,
      fileInput,
      readingFileProgress,
      readingFileStatus,
      hasError,
      checklists,
      loadedRecordCount,
      isProcessing,
      handleFileUpload,
      readFiles,
      processChecklists,
      availableStates,
      availableCounties,
      availableYears,
      months,
      filters,
      saveStatus,
    };
  },
};
</script>
