import Dexie from "dexie";
import { resolveSpeciesTaxon } from "../utils/taxonomy";

export const db = new Dexie("ebirdTripPlanner");

db.version(2).stores({
  trips: "id, name, updatedAt",
  ebd: "tripId, updatedAt",
  lists: "[tripId+kind], tripId, kind",
  visits: "++id, tripId, dateTime",
});

const toTriState = (value) => {
  if (value === true) return true;
  if (value === false) return false;
  return null;
};

const mergeTriStatePreferFalse = (a, b) => {
  const values = [toTriState(a), toTriState(b)];
  if (values.includes(false)) return false;
  if (values.includes(true)) return true;
  return null;
};

const mergeTriStatePreferTrue = (a, b) => {
  const values = [toTriState(a), toTriState(b)];
  if (values.includes(true)) return true;
  if (values.includes(false)) return false;
  return null;
};

const toFiniteOrder = (value, fallback = Infinity) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const collectEbdSpeciesCodes = (locations) => {
  const codes = new Set();
  if (!Array.isArray(locations)) return codes;

  locations.forEach((location) => {
    const entries = Array.isArray(location?.species_checklist_counts)
      ? location.species_checklist_counts
      : [];
    entries.forEach(([code]) => {
      if (!code) return;
      const resolvedTaxon = resolveSpeciesTaxon({ speciesCode: code });
      const normalizedCode = resolvedTaxon?.speciesCode || code;
      if (normalizedCode) codes.add(normalizedCode);
    });
  });

  return codes;
};

const normalizeSpeciesEntry = (species) => {
  if (!species || typeof species !== "object") return null;

  const resolvedTaxon = resolveSpeciesTaxon({
    speciesCode: species.code,
    scientificName: species.scientificName,
  });
  if (!resolvedTaxon) return null;

  const code = resolvedTaxon.speciesCode || species.code || species.scientificName || "";
  if (!code) return null;

  return {
    ...species,
    code,
    commonName:
      species.commonName ||
      resolvedTaxon.comName ||
      resolvedTaxon.speciesCode ||
      species.code ||
      species.scientificName ||
      "Unknown",
    scientificName: resolvedTaxon.sciName || species.scientificName || "",
    taxonOrder: toFiniteOrder(species.taxonOrder, resolvedTaxon.taxonOrder ?? Infinity),
  };
};

const sanitizeSpeciesList = (speciesList, allowedCodes = null) => {
  if (!Array.isArray(speciesList) || speciesList.length === 0) return [];

  const byCode = new Map();
  speciesList.forEach((item) => {
    const normalized = normalizeSpeciesEntry(item);
    if (!normalized) return;
    if (allowedCodes && allowedCodes.size > 0 && !allowedCodes.has(normalized.code)) return;

    const existing = byCode.get(normalized.code);
    if (!existing) {
      byCode.set(normalized.code, normalized);
      return;
    }

    byCode.set(normalized.code, {
      ...existing,
      commonName: existing.commonName || normalized.commonName,
      scientificName: existing.scientificName || normalized.scientificName,
      taxonOrder: Math.min(toFiniteOrder(existing.taxonOrder), toFiniteOrder(normalized.taxonOrder)),
      liferWorld: mergeTriStatePreferFalse(existing.liferWorld, normalized.liferWorld),
      liferRegion: mergeTriStatePreferFalse(existing.liferRegion, normalized.liferRegion),
      tripReportSeen: mergeTriStatePreferTrue(existing.tripReportSeen, normalized.tripReportSeen),
    });
  });

  return Array.from(byCode.values()).sort(
    (a, b) => toFiniteOrder(a.taxonOrder) - toFiniteOrder(b.taxonOrder),
  );
};

const sanitizeTargetSpeciesCodes = (codes, allowedCodes = null) => {
  if (!Array.isArray(codes) || codes.length === 0) return [];
  const normalized = new Set();

  codes.forEach((code) => {
    const resolvedTaxon = resolveSpeciesTaxon({ speciesCode: code });
    const normalizedCode = resolvedTaxon?.speciesCode;
    if (!normalizedCode) return;
    if (allowedCodes && allowedCodes.size > 0 && !allowedCodes.has(normalizedCode)) return;
    normalized.add(normalizedCode);
  });

  return Array.from(normalized);
};

db.version(3)
  .stores({
    trips: "id, name, updatedAt",
    ebd: "tripId, updatedAt",
    lists: "[tripId+kind], tripId, kind",
    visits: "++id, tripId, dateTime",
  })
  .upgrade(async (tx) => {
    const migrationTimestamp = Date.now();

    await tx
      .table("ebd")
      .toCollection()
      .modify((entry) => {
        const nextSpeciesList = sanitizeSpeciesList(entry.speciesList);
        entry.speciesList = nextSpeciesList;
        entry.updatedAt = migrationTimestamp;
      });

    await tx
      .table("visits")
      .toCollection()
      .modify((visit) => {
        if (!Array.isArray(visit.targetSpecies)) return;
        visit.targetSpecies = sanitizeTargetSpeciesCodes(visit.targetSpecies);
        visit.updatedAt = migrationTimestamp;
      });
  });

db.version(4)
  .stores({
    trips: "id, name, updatedAt",
    ebd: "tripId, updatedAt",
    lists: "[tripId+kind], tripId, kind",
    visits: "++id, tripId, dateTime",
  })
  .upgrade(async (tx) => {
    const migrationTimestamp = Date.now();
    const ebdTable = tx.table("ebd");
    const visitTable = tx.table("visits");

    const ebdEntries = await ebdTable.toArray();
    const allowedCodesByTrip = new Map();

    for (const entry of ebdEntries) {
      const allowedCodes = collectEbdSpeciesCodes(entry.locations);
      allowedCodesByTrip.set(entry.tripId, allowedCodes);
      if (allowedCodes.size === 0) continue;

      const nextSpeciesList = sanitizeSpeciesList(entry.speciesList, allowedCodes);
      await ebdTable.update(entry.tripId, {
        speciesList: nextSpeciesList,
        updatedAt: migrationTimestamp,
      });
    }

    await visitTable.toCollection().modify((visit) => {
      if (!Array.isArray(visit.targetSpecies)) return;
      const allowedCodes = allowedCodesByTrip.get(visit.tripId) || null;
      visit.targetSpecies = sanitizeTargetSpeciesCodes(visit.targetSpecies, allowedCodes);
      visit.updatedAt = migrationTimestamp;
    });
  });
