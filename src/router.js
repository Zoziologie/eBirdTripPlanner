import { createRouter, createWebHistory } from "vue-router";
import CreateTrip from "./pages/CreateTrip.vue";

// BuildTrip and SpeciesMap pull in mapbox-gl and turf; loading them lazily keeps
// several megabytes out of the initial bundle for users who never open a map.
const routes = [
  { path: "/", redirect: "/create" },
  { path: "/create", component: CreateTrip },
  {
    path: "/buildTrip",
    component: () => import("./pages/BuildTrip.vue"),
    meta: { fullPage: true },
  },
  { path: "/speciesList", component: () => import("./pages/SpeciesList.vue") },
  {
    path: "/speciesMap",
    component: () => import("./pages/SpeciesMap.vue"),
    meta: { fullPage: true },
  },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

export default router;
