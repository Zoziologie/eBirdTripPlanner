import Dexie from "dexie";

// Fresh database name so the app uses only the current dev schema.
export const db = new Dexie("ebirdTripPlanner_v1");

db.version(1).stores({
  trips: "id, name, updatedAt",
  ebd: "tripId, updatedAt",
  lists: "[tripId+kind], tripId, kind",
  visits: "++id, tripId, dateTime",
});
