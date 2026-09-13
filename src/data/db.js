import Dexie from "dexie";

// The schema version is the minor version in package.json: schema 3 ships as
// 0.3.x. Bump both together.
//
// Only the current schema is declared. Superseded versions are deliberately not
// kept: this is a single-user beta, and carrying migrations for them would buy
// nothing but constrain the shape of future changes. Dexie still upgrades an
// existing browser database in place, so stored trips survive - but a trip keeps
// whatever shape it was written with, and only re-importing its EBD gives it the
// current one.
export const db = new Dexie("ebirdTripPlanner_v1");

// `ebd` is one row per trip and every page loads it whole, so only aggregates
// live there. The other two tables hold what is large and rarely read:
//   `checklists` - per-location raw checklists (~105 MB for a state-sized trip),
//     read when a map popup or the KML export needs one location.
//   `comments`   - every checklist and species comment in the trip, in one row,
//     read only when someone exports comments. Keeping it out of `checklists`
//     is what lets "every note about this species" avoid reading thousands of
//     localities. See tests/perf/README.md.
db.version(3).stores({
  trips: "id, name, updatedAt",
  ebd: "tripId, updatedAt",
  lists: "[tripId+kind], tripId, kind",
  visits: "++id, tripId, dateTime",
  checklists: "[tripId+localityId], tripId",
  comments: "tripId",
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

// { tripId, entries: [ { checklist_id, locality_id, date, time, duration_minutes,
// checklist_comment, species_comments: [[code, text]] } ] }. Only checklists that
// carry at least one comment are present.
export const readTripComments = async (tripId) => {
  if (!tripId) return [];
  const row = await db.comments.get(tripId);
  return Array.isArray(row?.entries) ? row.entries : [];
};

export const storeTripComments = async (tripId, entries) => {
  if (!tripId) return;
  await db.comments.put({ tripId, entries: entries || [] });
};

export const deleteTripComments = (tripId) =>
  tripId ? db.comments.delete(tripId) : Promise.resolve();
