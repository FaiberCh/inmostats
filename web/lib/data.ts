import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  AmenityStat,
  CityStat,
  DepartmentStat,
  Dynamics,
  Histogram,
  Kpis,
  Meta,
  ModelInfo,
  OwnerSummary,
  PlaceIndexEntry,
  StratumBox,
  TopCity,
} from "./types";

// Los JSON los genera src/pipelines/export_dashboard_data.py y viven en
// public/data. Se leen en el build (componentes de servidor), asi que el
// HTML ya trae las cifras y no hay llamadas a ningun servidor para el tablero.
const DATA_DIR = path.join(process.cwd(), "public", "data");

async function read<T>(name: string): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(DATA_DIR, name), "utf-8")) as T;
}

export async function loadAll() {
  const [kpis, histogram, byDepartment, byCity, topCities, amenities, byStratum, places, meta, model, dynamics, owner] =
    await Promise.all([
      read<Kpis>("kpis.json"),
      read<Histogram>("histogram.json"),
      read<DepartmentStat[]>("by_department.json"),
      read<CityStat[]>("by_city.json"),
      read<TopCity[]>("top_cities.json"),
      read<AmenityStat[]>("amenities.json"),
      read<StratumBox[]>("by_stratum.json"),
      read<PlaceIndexEntry[]>("places/index.json"),
      read<Meta>("meta.json"),
      read<ModelInfo>("model.json"),
      read<Dynamics>("dynamics.json"),
      read<OwnerSummary>("owner_groups.json"),
    ]);
  return { kpis, histogram, byDepartment, byCity, topCities, amenities, byStratum, places, meta, model, dynamics, owner };
}
