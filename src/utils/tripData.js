import { db } from "../data/db";

export const EMPTY_REGION = Object.freeze({ code: "", name: "" });

export const createEmptyTripBundle = () => ({
  trip: null,
  ebd: null,
  visits: [],
});

export const fetchTripBundle = async (
  tripId,
  { includeTrip = false, includeEbd = false, includeVisits = false } = {},
) => {
  if (!tripId) {
    return createEmptyTripBundle();
  }

  const [trip, ebd, visits] = await Promise.all([
    includeTrip ? db.trips.get(tripId) : Promise.resolve(null),
    includeEbd ? db.ebd.get(tripId) : Promise.resolve(null),
    includeVisits ? db.visits.where("tripId").equals(tripId).toArray() : Promise.resolve([]),
  ]);

  return {
    trip,
    ebd,
    visits,
  };
};
