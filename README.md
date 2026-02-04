# eBird Trip Planner

Plan birding trips from the eBird Basic Dataset (EBD) with an offline-friendly, browser-first workflow. The app processes EBD files locally, stores results in IndexedDB, and gives you a trip builder, a species list with detection rates, and a species map with reporting-rate heat clusters.

## Main Flow

1. Download the eBird Basic Dataset (EBD) and upload a `.zip`/`.txt` in **Create Trip**.
2. Filter checklists by region/date, then process and normalize species + locations locally.
3. Persist the trip in IndexedDB for fast reloads and offline use.
4. **Build Trip**: plan visits on a map, adjust radius, and track per‑visit stats.
5. **Species List**: compare detection rates, lifers, and trip-report matches.
6. **Species Map**: visualize reporting rates with clustering and export KML for selected species.

## Key Features

- Local EBD parsing with progress feedback and filters.
- Trip management with saved visits and per‑visit stats.
- Species list with detection rate metrics and flexible sorting.
- Life list + region list uploads to identify lifers and regional ticks.
- Species map with reporting‑rate visualization, clustering, and KML export.
- Offline-friendly PWA build and IndexedDB persistence.

## Screenshots

<img width="1298" height="896" alt="image" src="https://github.com/user-attachments/assets/69c4496d-ce8b-4486-a224-9b57d2dbd68d" />

<img width="1298" height="889" alt="image" src="https://github.com/user-attachments/assets/e38654c2-a458-4d01-9abf-7ecc59b38f3b" />

<img width="1298" height="889" alt="image" src="https://github.com/user-attachments/assets/2a615a39-9f83-480f-a8e6-70f81004357d" />

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
          <img src="https://dexie.org/_next/image?q=75&url=%2Fassets%2Fimages%2Fdexie-logo.png&w=256" height="36"/>
        </a>
      </td>
      <td align="center">
        <a href="https://docs.mapbox.com/mapbox-gl-js/guides/">
          <img src="https://upload.wikimedia.org/wikipedia/commons/1/1f/Mapbox_logo_2019.svg" height="40"/>
        </a>
      </td>
      <td align="center">
        <a href="https://turfjs.org/docs/next/getting-started">
          <img src="https://raw.githubusercontent.com/Turfjs/turf/9a1d5e8d99564d4080f1e2bf1517ed41d18012fa/logo.png" height="36"/>
        </a>
      </td>
    </tr>
  </tbody>
</table>

Additional tools: [Vue Router](https://router.vuejs.org/), [PapaParse](https://www.papaparse.com/), [JSZip](https://stuk.github.io/jszip/), [Bootstrap Icons](https://github.com/twbs/icons), [Vite PWA](https://github.com/vite-pwa/vite-plugin-pwa).
