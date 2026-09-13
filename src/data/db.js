import Dexie from "dexie";

// The schema version is the minor version in package.json: schema 2 ships as
// 0.2.x. Bump both together.
//
// Only the current schema is declared. Superseded versions are deliberately not
// kept: this is a single-user beta, and carrying migrations for them would buy
// nothing but constrain the shape of future changes. Dexie still upgrades an
// existing browser database in place, so stored trips survive - but a trip keeps
// whatever shape it was written with, and only re-importing its EBD gives it the
// current one.
export const db = new Dexie("ebirdTripPlanner_v1");

// `ebd` is one row per trip and every page loads it whole, so only aggregates
// live there. `checklists` holds what is large and rarely read: per-location raw
// checklists (~105 MB for a state-sized trip), fetched only when a map popup or
// the KML export needs one location. See tests/perf/README.md.
db.version(2).stores({
  trips: "id, name, updatedAt",
  ebd: "tripId, updatedAt",
  lists: "[tripId+kind], tripId, kind",
  visits: "++id, tripId, dateTime",
  checklists: "[tripId+localityId], tripId",
});

// Checklists for one location of one trip: { tripId, localityId, checklist: [] }.
export const readLocationChecklists = async (tripId, localityIds) => {
  const byLocality = new Map();
  if (!tripId || !localityIds?.length) return byLocality;
  const unique = [...new Set(localityIds.filter(Boolean).map(String))];
  const rows = await db.checklists.bulkGet(unique.map((id) => [tripId, id]));
  rows.forEach((row, index) => {
    if (row?.checklist) byLocality.set(unique[index], row.checklist);
  });
  return byLocality;
};

export const storeTripChecklists = async (tripId, checklistsByLocation) => {
  if (!tripId || !Array.isArray(checklistsByLocation) || !checklistsByLocation.length) return;
  await db.checklists.bulkPut(
    checklistsByLocation.map((entry) => ({
      tripId,
      localityId: String(entry.localityId),
      checklist: entry.checklist || [],
    })),
  );
};

export const deleteTripChecklists = (tripId) =>
  tripId ? db.checklists.where("tripId").equals(tripId).delete() : Promise.resolve();
