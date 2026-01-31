import { createRouter, createWebHistory } from "vue-router";
import CreateTrip from "./pages/CreateTrip.vue";
import BuildTrip from "./pages/BuildTrip.vue";
import SpeciesList from "./pages/SpeciesList.vue";
import SpeciesMap from "./pages/SpeciesMap.vue";

const routes = [
  { path: "/", redirect: "/create" },
  { path: "/create", component: CreateTrip },
  { path: "/buildTrip", component: BuildTrip, meta: { fullPage: true } },
  { path: "/viewTrip", component: SpeciesList },
  { path: "/speciesMap", component: SpeciesMap, meta: { fullPage: true } },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

export default router;
