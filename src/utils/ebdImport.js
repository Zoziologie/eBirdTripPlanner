import Papa from "papaparse";

export const createEbdImportAccumulator = (taxonomyByScientificName, taxonomyByCode) => ({
  taxonomyByScientificName,
  taxonomyByCode,
  checklists: new Map(),
  locations: new Map(),
  counties: new Map(),
  states: new Map(),
  minYear: Infinity,
  maxYear: -Infinity,
  recordCount: 0,
});

export const addEbdRow = (row, accumulator) => {
  if (row["OBSERVATION COUNT"] === "0") return;

  accumulator.recordCount++;

  const countyCode = row["COUNTY CODE"];
  const stateCode = row["STATE CODE"];
  if (countyCode && !accumulator.counties.has(countyCode)) {
    accumulator.counties.set(countyCode, { name: row["COUNTY"], code: countyCode });
  }
  if (stateCode && !accumulator.states.has(stateCode)) {
    accumulator.states.set(stateCode, { name: row["STATE"], code: stateCode });
  }

  const year = Number(row["OBSERVATION DATE"]?.slice(0, 4));
  if (year < accumulator.minYear) accumulator.minYear = year;
  if (year > accumulator.maxYear) accumulator.maxYear = year;

  const sciName = row["SCIENTIFIC NAME"];
  const match = accumulator.taxonomyByScientificName[sciName];
  const speciesID = match?.reportAs || match?.REPORT_AS || match?.speciesCode || sciName;
  const taxon = accumulator.taxonomyByCode[speciesID];
  if (taxon?.category !== "species") return;

  const checklistId = row["SAMPLING EVENT IDENTIFIER"];
  const groupId = row["GROUP IDENTIFIER"] || checklistId;
  const isComplete = row["ALL SPECIES REPORTED"] === "1";
  let checklist = accumulator.checklists.get(groupId);

  if (!checklist) {
    const localityId = row["LOCALITY ID"];
    let location = accumulator.locations.get(localityId);
    if (!location) {
      location = {
        latitude: Number(row["LATITUDE"]),
        longitude: Number(row["LONGITUDE"]),
        locality: row["LOCALITY"],
        locality_id: localityId,
        locality_hotspot: row["LOCALITY TYPE"] === "H",
        country: row["COUNTRY"],
        country_code: row["COUNTRY CODE"],
        state: row["STATE"],
        state_code: stateCode,
        county: row["COUNTY"],
        county_code: countyCode,
      };
      accumulator.locations.set(localityId, location);
    }

    checklist = {
      checklist_id: checklistId,
      date: row["OBSERVATION DATE"],
      time: row["TIME OBSERVATIONS STARTED"],
      location,
      duration_minutes: Number(row["DURATION MINUTES"]),
      effort_distance_km: Number(row["EFFORT DISTANCE KM"]),
      all_species_reported: isComplete,
      speciesByCode: isComplete ? new Map() : null,
    };
    accumulator.checklists.set(groupId, checklist);
  } else {
    checklist.all_species_reported = checklist.all_species_reported && isComplete;
    if (!checklist.all_species_reported) checklist.speciesByCode = null;
  }

  if (!checklist.speciesByCode) return;

  const speciesCode = taxon.speciesCode;
  const existing = checklist.speciesByCode.get(speciesCode);
  if (!existing) {
    checklist.speciesByCode.set(speciesCode, {
      code: speciesCode,
      count: row["OBSERVATION COUNT"],
      species_comment: row["SPECIES COMMENTS"] || "",
    });
    return;
  }

  const incomingCount = row["OBSERVATION COUNT"];
  const existingNum = Number(existing.count);
  const incomingNum = Number(incomingCount);
  if (Number.isFinite(existingNum) && Number.isFinite(incomingNum) && incomingNum > existingNum) {
    existing.count = incomingCount;
  } else if (!existing.count && incomingCount) {
    existing.count = incomingCount;
  }
  const incomingComment = row["SPECIES COMMENTS"] || "";
  if (incomingComment && incomingComment !== existing.species_comment) {
    existing.species_comment = existing.species_comment
      ? `${existing.species_comment}; ${incomingComment}`
      : incomingComment;
  }
};

export const finalizeEbdImport = (accumulator) => {
  for (const checklist of accumulator.checklists.values()) {
    checklist.species = checklist.speciesByCode
      ? Array.from(checklist.speciesByCode.values())
      : [];
    delete checklist.speciesByCode;
  }

  return {
    checklists: Array.from(accumulator.checklists.values()),
    counties: Array.from(accumulator.counties.values()),
    states: Array.from(accumulator.states.values()),
    minYear: accumulator.minYear,
    maxYear: accumulator.maxYear,
    recordCount: accumulator.recordCount,
  };
};

export const streamEbdZipEntry = (entry, accumulator, onProgress) =>
  new Promise((resolve, reject) => {
    const parser = new Papa.StringStreamer({
      header: true,
      delimiter: "\t",
      skipEmptyLines: true,
      dynamicTyping: false,
      chunk(results) {
        for (const row of results.data) addEbdRow(row, accumulator);
      },
      complete: resolve,
      error: reject,
    });
    parser._nextChunk = () => {};

    entry
      .internalStream("string")
      .on("data", (chunk, metadata) => {
        parser._finished = false;
        parser.parseChunk(chunk);
        onProgress?.(metadata.percent, accumulator.recordCount);
      })
      .on("error", reject)
      .on("end", () => {
        parser._finished = true;
        parser.parseChunk("");
      })
      .resume();
  });
