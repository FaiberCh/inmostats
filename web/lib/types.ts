export type Kpis = {
  listings: number;
  price_mean_cop: number;
  price_median_cop: number;
  area_mean_m2: number;
  price_m2_median_cop: number;
};

export type Histogram = { edges_cop: number[]; counts: number[]; p99_cop: number };

export type DepartmentStat = {
  department: string;
  listings: number;
  price_m2_median: number;
  price_median: number;
};

export type CityStat = DepartmentStat & { city: string };

export type TopCity = { city: string; listings: number };
export type AmenityStat = { amenity: string; listings: number; share_pct: number };

export type StratumBox = {
  stratum: number;
  listings: number;
  whisker_low: number;
  q1: number;
  median: number;
  q3: number;
  whisker_high: number;
  outliers: number;
};

export type PlaceIndexEntry = { department: string; slug: string; listings: number; cities: string[] };

export type Meta = {
  generated_at: string;
  listings: number;
  data_from: string;
  data_to: string;
  departments: number;
  cities_on_map: number;
};

export type ModelInfo = {
  model_name: string;
  trained_at: string;
  n_rows: number;
  metrics_cv: { RMSE_COP: number; MAE_COP: number; "MAPE_%": number; R2: number };
  metrics_holdout: { RMSE_COP: number; MAE_COP: number; "MAPE_%": number; R2: number };
  hyperparameters: Record<string, number>;
  top_features: [string, number][];
  amenities: string[];
};

export type Dynamics = {
  n_runs: number;
  date_from: string;
  date_to: string;
  unique_listings: number;
  repeat_within_run_pct: number | null;
  runs: { date: string; listings: number; median_price_m2: number }[];
  turnover?: {
    persist_pct_mean: number;
    new_pct_mean: number;
    reappear_pct_mean: number | null;
    truly_new_pct_mean: number | null;
    never_return_pct_upper_bound: number;
    survival: { date: string; pct: number }[];
  };
  price_changes?: {
    comparisons: number;
    changed: number;
    changed_pct: number;
    down_pct: number | null;
    up_pct: number | null;
    median_abs_change_pct: number | null;
    p10_pct: number | null;
    p90_pct: number | null;
    histogram: { edges_pct: number[]; counts: number[] };
  };
  price_level?: {
    dates: string[];
    median_price_m2: number[];
    chained: number[];
    balanced: number[] | null;
    balanced_listings: number;
  };
};

export type GeoCollection = {
  type: "FeatureCollection";
  features: { type: "Feature"; properties: Record<string, string>; geometry: { type: string; coordinates: unknown } }[];
};
