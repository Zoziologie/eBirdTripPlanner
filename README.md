# eBird Trip Planner

Plan birding trips from the eBird Basic Dataset (EBD) with an offline-friendly, browser-first workflow. The app processes EBD files locally, stores results in IndexedDB, and gives you a trip builder, a species list with detection rates, and a species map with reporting-rate heat clusters.

**Most important feature:** full client‑side EBD processing (no server required for your data).

## Tech stack

<table width="100%">
  <thead>
    <tr>
      <th align="center">
        Vue<br/>
        <sub>UI framework</sub>
      </th>
      <th align="center">
        Vite<br/>
        <sub>Build and dev tooling</sub>
      </th>
      <th align="center">
        Bootstrap<br/>
        <sub>UI components and styling</sub>
      </th>
      <th align="center">
        Dexie<br/>
        <sub>IndexedDB storage</sub>
      </th>
      <th align="center">
        Mapbox GL JS<br/>
        <sub>Interactive maps</sub>
      </th>
      <th align="center">
        Turf.js<br/>
        <sub>Spatial tools</sub>
      </th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center">
        <a href="https://vuejs.org/">
          <img src="https://raw.githubusercontent.com/devicons/devicon/master/icons/vuejs/vuejs-original.svg" height="40"/>
        </a>
      </td>
      <td align="center">
        <a href="https://vite.dev/">
          <img src="https://raw.githubusercontent.com/devicons/devicon/master/icons/vitejs/vitejs-original.svg" height="40"/>
        </a>
      </td>
      <td align="center">
        <a href="https://getbootstrap.com/">
          <img src="https://raw.githubusercontent.com/devicons/devicon/master/icons/bootstrap/bootstrap-original.svg" height="40"/>
        </a>
      </td>
      <td align="center">
        <a href="https://dexie.org/">
          <code>Dexie</code>
        </a>
      </td>
      <td align="center">
        <a href="https://docs.mapbox.com/mapbox-gl-js/guides/">
          <img src="https://upload.wikimedia.org/wikipedia/commons/1/1f/Mapbox_logo_2019.svg" height="40"/>
        </a>
      </td>
      <td align="center">
        <a href="https://turfjs.org/">
          <code>Turf</code>
        </a>
      </td>
    </tr>
  </tbody>
</table>

Additional tools: `Vue Router`, `PapaParse`, `JSZip`, `Bootstrap Icons`, `Vite PWA`.

**Main Flow**
1. Download the eBird Basic Dataset (EBD) and upload a `.zip`/`.txt` in **Create Trip**.
2. Filter checklists by region/date, then process and normalize species + locations locally.
3. Persist the trip in IndexedDB for fast reloads and offline use.
4. **Build Trip**: plan visits on a map, adjust radius, and track per‑visit stats.
5. **Species List**: compare detection rates, lifers, and trip-report matches.
6. **Species Map**: visualize reporting rates with clustering and export KML for selected species.

**Key Features**
- Local EBD parsing with progress feedback and filters.
- Trip management with saved visits and per‑visit stats.
- Species list with detection rate metrics and flexible sorting.
- Life list + region list uploads to identify lifers and regional ticks.
- Species map with reporting‑rate visualization, clustering, and KML export.
- Offline-friendly PWA build and IndexedDB persistence.

**Pages**
- `/create` – Ingest EBD, filter, and create/manage trips.
- `/buildTrip` – Map-based visit planning with stats and visit details.
- `/speciesList` – Species table with detection rates, filters, and lifer flags.
- `/speciesMap` – Reporting‑rate map with clustering and export.

**Screenshots**
- Create Trip: `docs/screenshots/create-trip.png`
- Build Trip: `docs/screenshots/build-trip.png`
- Species List: `docs/screenshots/species-list.png`
- Species Map: `docs/screenshots/species-map.png`

**Getting Started**
1. Install dependencies: `npm install`
2. Run the app: `npm run dev`
3. Build for production: `npm run build`
4. Preview the production build: `npm run preview`

**Configuration**
- Mapbox token is currently set in `src/pages/BuildTrip.vue` and `src/pages/SpeciesMap.vue`.
- Optional taxonomy refresh (requires an eBird API token): set `EBIRD_API_TOKEN` and run `npm run download-taxo`.

**Data & Privacy**
- Trip data is stored in the browser’s IndexedDB (Dexie). Clearing site data removes stored trips.
- Map tiles are fetched from Mapbox.
- Optional trip report sync uses an external endpoint: `https://tripreport.raphaelnussbaumer.com/`.

**License**
GPL-3.0-or-later.
