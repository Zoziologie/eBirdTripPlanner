<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { refreshTrips } from "./state/tripSelection";
import appLogoUrl from "./assets/logo.svg";

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
    <header class="app-header border-bottom">
      <div class="container pt-4">
        <div class="row align-items-center g-2 mb-2 mb-sm-4">
          <div class="col-auto">
            <div class="d-flex align-items-center gap-2 site-brand">
              <img :src="appLogoUrl" alt="eBird Trip Planner logo" class="site-logo" />
              <h2 class="mb-0 site-title">
                <span class="site-title-ebird fw-bold">eBird</span>
                <span class="site-title-rest ms-1">Trip Planner</span>
              </h2>
            </div>
          </div>
          <div class="col-auto d-sm-none text-end ms-auto">
            <button
              class="btn btn-outline-secondary app-mobile-toggle"
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
                class="nav-link p-0 text-decoration-none text-nowrap app-nav-link"
                active-class="active fw-semibold app-nav-link-active"
                >Create</router-link
              >
              <router-link
                to="/speciesMap"
                class="nav-link p-0 text-decoration-none text-nowrap app-nav-link"
                active-class="active fw-semibold app-nav-link-active"
                >Species Map</router-link
              >
              <router-link
                to="/buildTrip"
                class="nav-link p-0 text-decoration-none text-nowrap app-nav-link"
                active-class="active fw-semibold app-nav-link-active"
                >Build Trip</router-link
              >
              <router-link
                to="/speciesList"
                class="nav-link p-0 text-decoration-none text-nowrap app-nav-link"
                active-class="active fw-semibold app-nav-link-active"
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
                class="nav-link px-2 py-2 text-decoration-none app-nav-link app-nav-link-mobile"
                active-class="active fw-semibold app-nav-link-active-mobile"
                @click="closeMobileNav"
                >Create</router-link
              >
              <router-link
                to="/speciesMap"
                class="nav-link px-2 py-2 text-decoration-none app-nav-link app-nav-link-mobile"
                active-class="active fw-semibold app-nav-link-active-mobile"
                @click="closeMobileNav"
                >Species Map</router-link
              >
              <router-link
                to="/buildTrip"
                class="nav-link px-2 py-2 text-decoration-none app-nav-link app-nav-link-mobile"
                active-class="active fw-semibold app-nav-link-active-mobile"
                @click="closeMobileNav"
                >Build Trip</router-link
              >
              <router-link
                to="/speciesList"
                class="nav-link px-2 py-2 text-decoration-none app-nav-link app-nav-link-mobile"
                active-class="active fw-semibold app-nav-link-active-mobile"
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
.app-header {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.95), rgba(244, 247, 242, 0.88)),
    linear-gradient(120deg, rgba(248, 174, 28, 0.08), rgba(65, 132, 64, 0.08));
  backdrop-filter: blur(12px);
}

.site-brand {
  min-width: 0;
}

.site-logo {
  width: 36px;
  height: 36px;
  object-fit: contain;
  flex: 0 0 auto;
}

.site-title {
  white-space: nowrap;
  color: #07464e;
}

.site-title-ebird {
  color: #07464e;
}

.site-title-rest {
  color: #418440;
}

.app-mobile-toggle {
  min-width: 44px;
}

.app-nav-link {
  color: rgba(25, 51, 56, 0.72);
  transition:
    color 0.18s ease,
    border-color 0.18s ease,
    background-color 0.18s ease;
}

.app-nav-link:hover {
  color: #07464e;
}

.app-nav-link-active {
  color: #07464e;
  border-bottom: 2px solid #f8ae1c;
  padding-bottom: 0.25rem;
}

.mobile-nav {
  border-top: 1px solid rgba(7, 70, 78, 0.08);
}

.app-nav-link-mobile {
  border-radius: 0.8rem;
}

.app-nav-link-active-mobile {
  color: #07464e;
  background: rgba(248, 174, 28, 0.16);
}

.trip-select {
  max-width: 260px;
}

.full-page-main {
  min-height: 0;
}
</style>
