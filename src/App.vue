<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { trips, selectedTripId, refreshTrips } from "./state/tripSelection";

const route = useRoute();
const isFullPage = computed(() => !!route.meta?.fullPage);
const bodyClass = computed(() =>
  isFullPage.value
    ? "flex-grow-1 d-flex flex-column overflow-hidden full-page-main"
    : "flex-grow-1 container pb-4",
);
const isMobileNavOpen = ref(false);

const toggleMobileNav = () => {
  isMobileNavOpen.value = !isMobileNavOpen.value;
};

const closeMobileNav = () => {
  isMobileNavOpen.value = false;
};

watch(
  () => route.fullPath,
  () => {
    isMobileNavOpen.value = false;
  },
);

onMounted(() => {
  refreshTrips();
});
</script>

<template>
  <div class="d-flex flex-column min-vh-100 h-100">
    <header class="border-bottom">
      <div class="container pt-4">
        <div class="row align-items-center g-2 mb-2 mb-sm-4">
          <div class="col-auto">
            <h2 class="mb-0 site-title">eBird Trip Planner</h2>
          </div>
          <div class="col-auto d-sm-none text-end ms-auto">
            <button
              class="btn btn-outline-secondary"
              type="button"
              :aria-expanded="isMobileNavOpen"
              aria-controls="mobile-nav"
              aria-label="Toggle navigation menu"
              @click="toggleMobileNav"
            >
              <i class="bi" :class="isMobileNavOpen ? 'bi-x' : 'bi-list'"></i>
            </button>
          </div>
          <div class="col-12 col-sm order-3 order-sm-2 d-flex justify-content-end">
            <nav class="d-none d-sm-flex gap-3 justify-content-end">
              <router-link
                to="/create"
                class="nav-link p-0 text-decoration-none text-nowrap"
                active-class="active fw-semibold text-success border-bottom border-2 border-success pb-1"
                >Create</router-link
              >
              <router-link
                to="/speciesMap"
                class="nav-link p-0 text-decoration-none text-nowrap"
                active-class="active fw-semibold text-success border-bottom border-2 border-success pb-1"
                >Species Map</router-link
              >
              <router-link
                to="/buildTrip"
                class="nav-link p-0 text-decoration-none text-nowrap"
                active-class="active fw-semibold text-success border-bottom border-2 border-success pb-1"
                >Build Trip</router-link
              >
              <router-link
                to="/speciesList"
                class="nav-link p-0 text-decoration-none text-nowrap"
                active-class="active fw-semibold text-success border-bottom border-2 border-success pb-1"
                >Species List</router-link
              >
            </nav>
          </div>
          <div class="col-12 d-sm-none">
            <nav
              id="mobile-nav"
              class="nav flex-column gap-1 pt-2 mobile-nav"
              v-show="isMobileNavOpen"
            >
              <router-link
                to="/create"
                class="nav-link px-2 py-2 text-decoration-none"
                active-class="active fw-semibold text-success"
                @click="closeMobileNav"
                >Create</router-link
              >
              <router-link
                to="/speciesMap"
                class="nav-link px-2 py-2 text-decoration-none"
                active-class="active fw-semibold text-success"
                @click="closeMobileNav"
                >Species Map</router-link
              >
              <router-link
                to="/buildTrip"
                class="nav-link px-2 py-2 text-decoration-none"
                active-class="active fw-semibold text-success"
                @click="closeMobileNav"
                >Build Trip</router-link
              >
              <router-link
                to="/speciesList"
                class="nav-link px-2 py-2 text-decoration-none"
                active-class="active fw-semibold text-success"
                @click="closeMobileNav"
                >Species List</router-link
              >
            </nav>
          </div>
        </div>
      </div>
    </header>
    <main :class="bodyClass">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.site-title {
  white-space: nowrap;
}

.trip-select {
  max-width: 260px;
}

.full-page-main {
  min-height: 0;
}
</style>

<style>
html,
body,
#app {
  height: 100%;
}

body {
  margin: 0;
}
</style>
