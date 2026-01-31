import Dexie from "dexie";

export const db = new Dexie("ebirdTripPlanner");

db.version(2).stores({
  trips: "id, name, updatedAt",
  ebd: "tripId, updatedAt",
  lists: "[tripId+kind], tripId, kind",
  visits: "++id, tripId, dateTime",
});
