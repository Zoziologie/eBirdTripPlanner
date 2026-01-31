<template>
  <p class="text-muted small">
    To create a new trip, download the
    <a href="https://ebird.org/data/download" target="_blank">eBird Basic Dataset (EBD)</a>
    and load the .zip or .txt file below. Processing happens locally in your browser.
  </p>
  <div class="row">
    <div class="col">
      <input
        type="file"
        id="fileInput"
        @change="handleFileUpload"
        accept=".txt,.zip"
        ref="fileInput"
        class="form-control"
        :disabled="disabled"
      />
      <!-- File Reading Progress -->
      <div v-if="readingFileProgress > 0" class="mt-2">
        <!-- Progress bar -->
        <div class="progress" v-if="readingFileProgress > 1">
          <div
            class="progress-bar progress-bar-striped progress-bar-animated"
            role="progressbar"
            :style="{ width: readingFileProgress + '%' }"
          >
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
        v-if="rawData.length > 0 && readingFileProgress === 0 && !hasError"
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
  <div class="row mt-3" v-if="rawData.length > 0 && readingFileProgress === 0">
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
import { ref, reactive } from "vue";
import Papa from "papaparse";
import JSZip from "jszip";
import taxonomy from "../assets/eBird_taxonomy.json";

const taxonomy_sci = taxonomy.reduce((acc, row) => {
  acc[row["sciName"]] = row;
  return acc;
}, {});
const taxonomy_code = taxonomy.reduce((acc, row) => {
  acc[row["speciesCode"]] = row;
  return acc;
}, {});

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
    const uploadedFile = ref(null);

    // File reading state
    const readingFileProgress = ref(0);
    const readingFileStatus = ref("");
    const hasError = ref(false);
    const rawData = ref([]);

    // Checklists
    const isProcessing = ref(false);
    const checklists = ref([]);
    const locations = ref([]);
    const speciesList = ref([]);
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

    const handleFileUpload = async (event) => {
      const file = event.target.files[0];
      if (!file) return;

      // Accept .txt or .zip
      if (file.name.endsWith(".txt")) {
        uploadedFile.value = file;
        hasError.value = false;
        readFile();
      } else if (file.name.endsWith(".zip")) {
        readingFileStatus.value =
          '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Retrieving TXT from ZIP file...';
        readingFileProgress.value = 1;
        hasError.value = false;
        try {
          const zip = await JSZip.loadAsync(file);
          const largestTxtFile = Object.values(zip.files).reduce((largest, entry) => {
            if (entry.name.toLowerCase().endsWith(".txt") && entry._data) {
              if (!largest || entry._data.uncompressedSize > largest._data.uncompressedSize) {
                return entry;
              }
            }
            return largest;
          }, null);
          if (!largestTxtFile) {
            readingFileStatus.value = "No .txt file found in ZIP.";
            hasError.value = true;
            event.target.value = "";
            return;
          }
          const txtContent = await largestTxtFile.async("blob");
          const txtFileObj = new File([txtContent], largestTxtFile.name, { type: "text/plain" });
          uploadedFile.value = txtFileObj;
          readingFileStatus.value = `TXT file extracted (${largestTxtFile.name}). Reading...`;
          readFile();
        } catch (err) {
          readingFileStatus.value = "Failed to extract ZIP: " + err.message;
          hasError.value = true;
          event.target.value = "";
          uploadedFile.value = null;
        } finally {
          readingFileProgress.value = 0;
        }
      } else {
        alert("Please select a .txt or .zip file");
        event.target.value = "";
        uploadedFile.value = null;
        return;
      }
    };

    const readFile = () => {
      if (!uploadedFile.value) return;

      // Reset state
      checklists.value = [];
      rawData.value = [];
      saveStatus.value = "";

      readingFileProgress.value = 1;
      readingFileStatus.value = "Starting file reading...";
      hasError.value = false;

      const uploadCounties = {};
      const uploadStates = {};
      let completeChecklistCount = 0;

      Papa.parse(uploadedFile.value, {
        header: true,
        delimiter: "\t",
        skipEmptyLines: true,
        worker: true,
        chunkSize: 4 * 1024 * 1024,

        chunk: function (results) {
          const progress = (results.meta.cursor / uploadedFile.value.size) * 100;
          readingFileProgress.value = progress;
          readingFileStatus.value = `Reading file (${completeChecklistCount.toLocaleString()} complete checklists found)`;

          const validRows = [];

          for (const row of results.data) {
            if (row["OBSERVATION COUNT"] === "0") continue;
            const isComplete = row["ALL SPECIES REPORTED"] === "1";
            row["ALL SPECIES REPORTED"] = isComplete;
            validRows.push(row);
            if (isComplete) {
              completeChecklistCount++;
            }

            const countyCode = row["COUNTY CODE"];
            const stateCode = row["STATE CODE"];

            if (!uploadCounties[countyCode]) {
              uploadCounties[countyCode] = {
                name: row["COUNTY"],
                code: countyCode,
              };
            }
            if (!uploadStates[stateCode]) {
              uploadStates[stateCode] = {
                name: row["STATE"],
                code: stateCode,
              };
            }
          }

          if (validRows.length > 0) {
            rawData.value.push(...validRows);
          }
        },

        complete: function () {
          readingFileProgress.value = 100;
          readingFileStatus.value = "Finalizing data...";

          availableCounties.value = Object.values(uploadCounties);
          availableStates.value = Object.values(uploadStates);

          let minYear = Infinity;
          let maxYear = -Infinity;
          for (const row of rawData.value) {
            const year = new Date(row["OBSERVATION DATE"]).getFullYear();
            if (year < minYear) minYear = year;
            if (year > maxYear) maxYear = year;
          }
          availableYears.value = {
            min: minYear,
            max: maxYear,
          };

          filters.minYear = availableYears.value.min;
          filters.maxYear = availableYears.value.max;

          readingFileStatus.value = `Loaded ${rawData.value.length.toLocaleString()} records.`;
          readingFileProgress.value = 0;
        },

        error: function (error) {
          console.error("File reading error:", error);
          readingFileProgress.value = 0;
          readingFileStatus.value = error?.message || "Error occurred while reading the file";
          hasError.value = true;
          checklists.value = null;
        },
      });
    };

    const processChecklists = () => {
      if (rawData.value.length === 0) return;

      isProcessing.value = true;
      saveStatus.value = "Filtering checklists...";
      locations.value = [];
      speciesList.value = [];

      setTimeout(() => {
        const uploadChecklists = {};
        const excludedSpecies = new Set();

        for (const row of rawData.value) {
          const rowDate = new Date(row["OBSERVATION DATE"]);
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

          if (filters.state.length > 0 && !filters.state.includes(row["STATE CODE"])) continue;
          if (filters.county.length > 0 && !filters.county.includes(row["COUNTY CODE"])) continue;

          const sciName = row["SCIENTIFIC NAME"];
          const match = taxonomy_sci[sciName];
          const speciesID = match?.REPORT_AS || match?.speciesCode || sciName;
          const match2 = taxonomy_code[speciesID] || { comName: row["COMMON NAME"] };
          const speciesCode = match2.speciesCode;

          if (match2.category !== "species") {
            excludedSpecies.add(
              JSON.stringify({
                scientificName: sciName,
                commonName: row["COMMON NAME"],
                category: match2.category || "unknown",
                speciesCode: speciesCode,
              }),
            );
            continue;
          }

          const checklistId = row["SAMPLING EVENT IDENTIFIER"];
          const groupId = row["GROUP IDENTIFIER"] || checklistId;
          if (!uploadChecklists[groupId]) {
            uploadChecklists[groupId] = {
              checklist_id: checklistId,
              group_id: groupId,
              date: row["OBSERVATION DATE"],
              time: row["TIME OBSERVATIONS STARTED"],
              location: {
                latitude: Number(row["LATITUDE"]),
                longitude: Number(row["LONGITUDE"]),
                locality: row["LOCALITY"],
                locality_id: row["LOCALITY ID"],
                locality_hotspot: row["LOCALITY TYPE"] == "H",
                country: row["COUNTRY"],
                country_code: row["COUNTRY CODE"],
                state: row["STATE"],
                state_code: row["STATE CODE"],
                county: row["COUNTY"],
                county_code: row["COUNTY CODE"],
              },
              protocol: row["PROTOCOL NAME"],
              duration_minutes: Number(row["DURATION MINUTES"]),
              effort_distance_km: Number(row["EFFORT DISTANCE KM"]),
              all_species_reported: row["ALL SPECIES REPORTED"],
              species: [],
            };
          } else {
            uploadChecklists[groupId].all_species_reported =
              uploadChecklists[groupId].all_species_reported === true &&
              row["ALL SPECIES REPORTED"] === true;
          }

          const checklist = uploadChecklists[groupId];
          const existing = checklist.species.find((entry) => entry.code === speciesCode);
          if (existing) {
            const incomingCount = row["OBSERVATION COUNT"];
            const existingNum = Number(existing.count);
            const incomingNum = Number(incomingCount);
            if (Number.isFinite(existingNum) && Number.isFinite(incomingNum)) {
              if (incomingNum > existingNum) {
                existing.count = incomingCount;
              }
            } else if (!existing.count && incomingCount) {
              existing.count = incomingCount;
            }
            const incomingComment = row["SPECIES COMMENTS"] || "";
            if (incomingComment && incomingComment !== existing.species_comment) {
              existing.species_comment = existing.species_comment
                ? `${existing.species_comment}; ${incomingComment}`
                : incomingComment;
            }
          } else {
            checklist.species.push({
              code: speciesCode,
              count: row["OBSERVATION COUNT"],
              species_comment: row["SPECIES COMMENTS"] || "",
            });
          }
        }

        checklists.value = Object.values(uploadChecklists);
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
            const uniqueCodes = new Set(
              (checklist.species || []).map((entry) => entry.code).filter(Boolean),
            );
            for (const code of uniqueCodes) {
              location.speciesChecklistCounts.set(
                code,
                (location.speciesChecklistCounts.get(code) || 0) + 1,
              );
            }
          }
          location.checklist.push({
            checklist_id: checklist.checklist_id,
            date: checklist.date,
            time: checklist.time,
            duration_minutes: checklist.duration_minutes,
            effort_distance_km: checklist.effort_distance_km,
            all_species_reported: checklist.all_species_reported === true,
            species: checklist.species,
          });
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

      emit("processed", {
        speciesList: speciesList.value,
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
        filters: { ...filters },
      });
      saveStatus.value = "";
      isProcessing.value = false;
    };

    return {
      uploadedFile,
      fileInput,
      readingFileProgress,
      readingFileStatus,
      hasError,
      checklists,
      rawData,
      isProcessing,
      handleFileUpload,
      readFile,
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
