<template>
  <template v-if="variant === 'targets'">
    <div class="d-flex flex-column gap-3">
      <div class="row g-2 align-items-start">
        <div class="col-md-3">
          <label for="lifeListInput" class="form-label fw-semibold mb-1">
            <a
              href="https://ebird.org/lifelist"
              target="_blank"
              class="text-decoration-none"
              title="Open eBird World Life List"
            >
              <i class="bi bi-globe2 text-danger me-1"></i>
              Life list
            </a>
          </label>
          <div class="text-muted small">CSV export of your world life list.</div>
        </div>
        <div class="col-md-9">
          <input
            type="file"
            id="lifeListInput"
            @change="handleLifeListUpload"
            accept=".csv"
            ref="lifeListInput"
            class="form-control form-control-sm"
          />
          <div
            v-if="hasLifeList"
            class="alert alert-success py-1 px-2 mt-2 mb-0 small d-flex align-items-center"
          >
            <i class="bi bi-check-circle-fill me-2"></i>
            <div><strong>Loaded:</strong> {{ lifeListCount }} species</div>
          </div>
          <div v-if="lifeListError" class="alert alert-danger py-1 px-2 mt-2 mb-0 small">
            <i class="bi bi-exclamation-triangle-fill me-2"></i>
            {{ lifeListError }}
          </div>
        </div>
      </div>

      <div class="row g-2 align-items-start">
        <div class="col-md-3">
          <label for="regionListInput" class="form-label fw-semibold mb-1">
            <a
              v-if="region.code"
              :href="`https://ebird.org/lifelist/${region.code}`"
              target="_blank"
              class="text-decoration-none"
              :title="`Open eBird life list for ${region.name || region.code}`"
            >
              <i class="bi bi-geo-alt-fill text-danger me-1"></i>
              Region list
            </a>
            <span v-else>
              <i class="bi bi-geo-alt-fill text-danger me-1"></i>
              Region list
            </span>
          </label>
          <div class="text-muted small">CSV export for your trip region.</div>
        </div>
        <div class="col-md-9">
          <input
            type="file"
            id="regionListInput"
            @change="handleRegionListUpload"
            accept=".csv"
            ref="regionListInput"
            class="form-control form-control-sm"
          />
          <div
            v-if="hasRegionList"
            class="alert alert-success py-1 px-2 mt-2 mb-0 small d-flex align-items-center"
          >
            <i class="bi bi-check-circle-fill me-2"></i>
            <div><strong>Loaded:</strong> {{ regionListCount }} species</div>
          </div>
          <div v-if="regionListError" class="alert alert-danger py-1 px-2 mt-2 mb-0 small">
            <i class="bi bi-exclamation-triangle-fill me-2"></i>
            {{ regionListError }}
          </div>
        </div>
      </div>
    </div>
  </template>

  <template v-else>
    <p class="small text-muted mb-3">
      Upload your life lists from eBird (use the download button for CSV format). You can upload any
      type of life list: filtered by date, customized region, or default lists.
    </p>

    <div class="row g-3">
      <!-- Life List Upload -->
      <div class="col-md-12">
        <div class="d-flex align-items-center gap-2">
          <label for="lifeListInput" class="form-label fw-semibold mb-0 text-nowrap">
            <a
              href="https://ebird.org/lifelist"
              target="_blank"
              class="text-decoration-none"
              title="Open eBird World Life List"
            >
              Life List
            </a>
          </label>
          <input
            type="file"
            id="lifeListInput"
            @change="handleLifeListUpload"
            accept=".csv"
            ref="lifeListInput"
            class="form-control form-control-sm"
          />
        </div>

        <div
          v-if="hasLifeList"
          class="alert alert-success py-1 px-2 mt-2 mb-0 small d-flex align-items-center"
        >
          <i class="bi bi-check-circle-fill me-2"></i>
          <div><strong>Loaded:</strong> {{ lifeListCount }} species</div>
        </div>
        <div v-if="lifeListError" class="alert alert-danger py-1 px-2 mt-2 mb-0 small">
          <i class="bi bi-exclamation-triangle-fill me-2"></i>
          {{ lifeListError }}
        </div>
      </div>

      <!-- Region List Upload -->
      <div class="col-md-12">
        <div class="d-flex align-items-center gap-2">
          <label for="regionListInput" class="form-label fw-semibold mb-0 text-nowrap">
            <a
              v-if="region.code"
              :href="`https://ebird.org/lifelist/${region.code}`"
              target="_blank"
              class="text-decoration-none"
              :title="`Open eBird life list for ${region.name || region.code}`"
            >
              Region List
            </a>
            <span v-else>Region List</span>
          </label>
          <input
            type="file"
            id="regionListInput"
            @change="handleRegionListUpload"
            accept=".csv"
            ref="regionListInput"
            class="form-control form-control-sm"
          />
        </div>

        <div
          v-if="hasRegionList"
          class="alert alert-success py-1 px-2 mt-2 mb-0 small d-flex align-items-center"
        >
          <i class="bi bi-check-circle-fill me-2"></i>
          <div><strong>Loaded:</strong> {{ regionListCount }} species</div>
        </div>
        <div v-if="regionListError" class="alert alert-danger py-1 px-2 mt-2 mb-0 small">
          <i class="bi bi-exclamation-triangle-fill me-2"></i>
          {{ regionListError }}
        </div>
      </div>
    </div>
  </template>

  <!-- Summary -->
  <div v-if="showSummary && (hasLifeList || hasRegionList)" class="mt-3 pt-2 border-top">
    <div class="d-flex gap-4 small">
      <div><strong>Total Species:</strong> {{ speciesCount }}</div>
      <div v-if="hasLifeList">
        <strong>Potential Lifers:</strong>
        <span class="text-success fw-bold ms-1">{{ liferCount }}</span>
      </div>
      <div v-if="hasRegionList">
        <strong>New for Region:</strong>
        <span class="text-primary fw-bold ms-1">{{ regionNewCount }}</span>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, computed } from "vue";
import Papa from "papaparse";

export default {
  props: {
    speciesList: {
      type: Array,
      required: true,
    },
    region: {
      type: Object,
      required: true,
      default: () => ({ code: "", name: "" }),
    },
    variant: {
      type: String,
      default: "default",
    },
    showSummary: {
      type: Boolean,
      default: true,
    },
  },
  emits: ["update:speciesList"],
  setup(props, { emit }) {
    const lifeListInput = ref(null);
    const regionListInput = ref(null);

    const lifeListError = ref("");
    const regionListError = ref("");

    const applyLiferFlags = (list, lifeCodes, regionCodes) => {
      return list.map((species) => ({
        ...species,
        liferWorld:
          lifeCodes === null
            ? species.liferWorld
            : lifeCodes.has(species.scientificName) === false,
        liferRegion:
          regionCodes === null
            ? species.liferRegion
            : regionCodes.has(species.scientificName) === false,
      }));
    };

    const speciesCount = computed(() => props.speciesList.length);
    const hasLifeList = computed(() =>
      props.speciesList.some(
        (s) => s.liferWorld === true || s.liferWorld === false
      )
    );
    const hasRegionList = computed(() =>
      props.speciesList.some(
        (s) => s.liferRegion === true || s.liferRegion === false
      )
    );
    const lifeListCount = computed(() =>
      props.speciesList.filter((s) => s.liferWorld === false).length
    );
    const regionListCount = computed(() =>
      props.speciesList.filter((s) => s.liferRegion === false).length
    );
    const liferCount = computed(() =>
      props.speciesList.filter((s) => s.liferWorld === true).length
    );
    const regionNewCount = computed(() =>
      props.speciesList.filter((s) => s.liferRegion === true).length
    );

    const parseCSV = (file) => {
      return new Promise((resolve, reject) => {
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {
            const codes = new Set();

            results.data.forEach((row) => {
              if (row["Scientific Name"] && row["Countable"] === "1") {
                const scientificName = row["Scientific Name"].trim();
                if (scientificName) {
                  codes.add(scientificName);
                }
              }
            });

            resolve(codes);
          },
          error: (error) => {
            reject(error);
          },
        });
      });
    };

    const handleLifeListUpload = async (event) => {
      const file = event.target.files[0];
      if (!file) return;

      lifeListError.value = "";

      try {
        const codes = await parseCSV(file);
        const updated = applyLiferFlags(props.speciesList, codes, null);
        emit("update:speciesList", updated);
      } catch (error) {
        lifeListError.value = `Error parsing life list: ${error.message}`;
        console.error("Life list parsing error:", error);
      }
    };

    const handleRegionListUpload = async (event) => {
      const file = event.target.files[0];
      if (!file) return;

      regionListError.value = "";

      try {
        const codes = await parseCSV(file);
        const updated = applyLiferFlags(props.speciesList, null, codes);
        emit("update:speciesList", updated);
      } catch (error) {
        regionListError.value = `Error parsing region list: ${error.message}`;
        console.error("Region list parsing error:", error);
      }
    };

    return {
      lifeListInput,
      regionListInput,
      lifeListError,
      regionListError,
      hasLifeList,
      hasRegionList,
      lifeListCount,
      regionListCount,
      speciesCount,
      liferCount,
      regionNewCount,
      handleLifeListUpload,
      handleRegionListUpload,
    };
  },
};
</script>
