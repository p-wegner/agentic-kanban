import { useEffect, useMemo, useState } from "react";
import type { ProjectStatsResponse } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { ACCENT, BRAND, SEMANTIC, TYPE_COLORS } from "../lib/chartColors.js";

interface CrimeSceneCityViewProps {
  projectId: string | null;
}

export interface CrimeSceneBuilding {
  id: string;
  path: string;
  fileName: string;
  district: string;
  changes: number;
  additions: number;
  deletions: number;
  height: number;
  width: number;
  heat: "low" | "medium" | "high" | "critical";
  left: number;
  top: number;
  marker: number | null;
}

export interface CrimeSceneDistrict {
  id: string;
  name: string;
  changes: number;
  additions: number;
  deletions: number;
  buildings: CrimeSceneBuilding[];
}

export interface CrimeSceneCityModel {
  districts: CrimeSceneDistrict[];
  totalChanges: number;
  evidenceCount: number;
  dominantDistrict: string | null;
  testRatio: number;
}

const MAX_DISTRICTS = 8;
const MAX_BUILDINGS_PER_DISTRICT = 10;
const CITY_HEIGHT = 380;

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "not scanned";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function getDistrictName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return "root";
  if (parts[0] === "packages" && parts.length > 1) return `packages/${parts[1]}`;
  if (parts[0] === "src" && parts.length > 1) return `src/${parts[1]}`;
  return parts[0];
}

function getFileName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function getHeat(changes: number, maxChanges: number): CrimeSceneBuilding["heat"] {
  const ratio = maxChanges > 0 ? changes / maxChanges : 0;
  if (ratio >= 0.78) return "critical";
  if (ratio >= 0.48) return "high";
  if (ratio >= 0.22) return "medium";
  return "low";
}

function heatColor(heat: CrimeSceneBuilding["heat"]): string {
  switch (heat) {
    case "critical": return "#b4453a";
    case "high": return BRAND;
    case "medium": return "#c79a3e";
    default: return "#5b7a8c";
  }
}

export function buildCrimeSceneCityModel(stats: ProjectStatsResponse | null): CrimeSceneCityModel {
  if (!stats) {
    return { districts: [], totalChanges: 0, evidenceCount: 0, dominantDistrict: null, testRatio: 0 };
  }

  const maxChanges = Math.max(...stats.hotspots.map((file) => file.changes), 1);
  const districtsByName = new Map<string, CrimeSceneDistrict>();

  stats.hotspots.forEach((file, index) => {
    const districtName = getDistrictName(file.path);
    const district = districtsByName.get(districtName) ?? {
      id: districtName,
      name: districtName,
      changes: 0,
      additions: 0,
      deletions: 0,
      buildings: [],
    };

    const heat = getHeat(file.changes, maxChanges);
    const column = district.buildings.length % 5;
    const row = Math.floor(district.buildings.length / 5);
    district.changes += file.changes;
    district.additions += file.additions;
    district.deletions += file.deletions;
    district.buildings.push({
      id: file.path,
      path: file.path,
      fileName: getFileName(file.path),
      district: districtName,
      changes: file.changes,
      additions: file.additions,
      deletions: file.deletions,
      height: Math.max(42, Math.round(44 + (file.changes / maxChanges) * 160)),
      width: 32 + (index % 3) * 8,
      heat,
      left: 10 + column * 17 + (row % 2) * 6,
      top: 52 + row * 82,
      marker: heat === "critical" || heat === "high" ? index + 1 : null,
    });
    districtsByName.set(districtName, district);
  });

  const districts = [...districtsByName.values()]
    .map((district) => ({
      ...district,
      buildings: district.buildings
        .sort((a, b) => b.changes - a.changes)
        .slice(0, MAX_BUILDINGS_PER_DISTRICT),
    }))
    .sort((a, b) => b.changes - a.changes)
    .slice(0, MAX_DISTRICTS);

  return {
    districts,
    totalChanges: districts.reduce((sum, district) => sum + district.changes, 0),
    evidenceCount: districts.reduce((sum, district) => sum + district.buildings.filter((building) => building.marker !== null).length, 0),
    dominantDistrict: districts[0]?.name ?? null,
    testRatio: stats.codeMetrics.testRatio,
  };
}

function CityBuilding({ building }: { building: CrimeSceneBuilding }) {
  const color = heatColor(building.heat);
  return (
    <div
      className="absolute bottom-8 rounded-t-sm border border-black/10 dark:border-white/10 shadow-sm transition-transform hover:-translate-y-1"
      style={{
        left: `${building.left}%`,
        top: building.top,
        width: building.width,
        height: building.height,
        background: `linear-gradient(180deg, ${color} 0%, rgba(40,35,30,0.88) 100%)`,
        boxShadow: building.marker ? `0 0 0 2px rgba(180,69,58,0.14), 0 0 24px ${color}66` : undefined,
      }}
      title={`${building.path}: ${formatCount(building.changes)} changed lines`}
    >
      <div className="grid grid-cols-2 gap-px p-1 opacity-45">
        {Array.from({ length: Math.min(18, Math.max(4, Math.round(building.height / 14))) }).map((_, index) => (
          <span key={index} className="h-1 rounded-[1px] bg-white/50" />
        ))}
      </div>
      {building.marker && (
        <div
          className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full border border-red-900 bg-red-50 text-[10px] font-bold text-red-700 shadow"
          aria-label={`Evidence marker ${building.marker}`}
        >
          {building.marker}
        </div>
      )}
    </div>
  );
}

function DistrictBlock({ district }: { district: CrimeSceneDistrict }) {
  const maxLocal = Math.max(...district.buildings.map((building) => building.changes), 1);
  return (
    <section className="min-w-[260px] flex-1 rounded border border-gray-200 bg-[#f7f1e8] p-3 dark:border-gray-800 dark:bg-gray-900">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100" title={district.name}>
            {district.name}
          </h3>
          <p className="text-[11px] text-gray-500 dark:text-gray-400">{formatCount(district.changes)} changed lines</p>
        </div>
        <div className="rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          zone
        </div>
      </div>
      <div className="relative overflow-hidden rounded border border-gray-300 bg-[#efe4d3] dark:border-gray-800 dark:bg-gray-950" style={{ height: CITY_HEIGHT }}>
        <div className="absolute inset-x-0 bottom-0 h-8 bg-gray-800/80 dark:bg-black/60" />
        <div className="absolute inset-x-0 top-8 h-px bg-black/10 dark:bg-white/10" />
        <div className="absolute left-0 right-0 top-16 rotate-[-8deg] bg-amber-300 py-1 text-center text-[10px] font-black uppercase tracking-[0.24em] text-gray-950 opacity-90">
          hotspot
        </div>
        {district.buildings.map((building) => (
          <CityBuilding key={building.id} building={building} />
        ))}
      </div>
      <div className="mt-3 space-y-2">
        {district.buildings.slice(0, 4).map((building) => (
          <div key={building.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
            <div className="min-w-0">
              <div className="truncate text-xs text-gray-700 dark:text-gray-300" title={building.path}>
                {building.fileName}
              </div>
              <div className="h-1.5 rounded-full bg-gray-200 dark:bg-gray-800">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.max(8, (building.changes / maxLocal) * 100)}%`, backgroundColor: heatColor(building.heat) }}
                />
              </div>
            </div>
            <div className="text-right text-[11px] font-semibold tabular-nums text-gray-600 dark:text-gray-400">
              {formatCount(building.changes)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function StatTile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded border border-gray-200 bg-white px-3 py-2 dark:border-gray-800 dark:bg-gray-900">
      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-gray-900 dark:text-gray-100" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
    </div>
  );
}

export function CrimeSceneCityView({ projectId }: CrimeSceneCityViewProps) {
  const [stats, setStats] = useState<ProjectStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!projectId) {
      setStats(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    apiFetch<ProjectStatsResponse>(`/api/projects/${projectId}/stats`)
      .then((result) => {
        if (!cancelled) setStats(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setStats(null);
          setError(err instanceof Error ? err.message : "Failed to load city metrics");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const model = useMemo(() => buildCrimeSceneCityModel(stats), [stats]);
  const topEvidence = useMemo(
    () => model.districts.flatMap((district) => district.buildings).sort((a, b) => b.changes - a.changes).slice(0, 8),
    [model],
  );

  return (
    <div className="flex-1 min-h-0 overflow-auto bg-[#f4eee5] px-4 pb-6 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <div className="mx-auto max-w-7xl space-y-4 pt-4">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-gray-300 pb-3 dark:border-gray-800">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.24em] text-red-700 dark:text-red-400">Code Crime Scene</div>
            <h2 className="mt-1 text-2xl font-semibold tracking-normal text-gray-950 dark:text-gray-50">Hotspot City</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              Files become buildings, directories become districts, and churn turns into marked evidence.
            </p>
          </div>
          <div className="rounded border border-amber-400 bg-amber-100 px-3 py-2 text-xs font-bold uppercase tracking-wide text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            evidence map
          </div>
        </header>

        {error && (
          <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
            {error}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatTile label="Changed Lines" value={formatCount(model.totalChanges)} tone={BRAND} />
          <StatTile label="Evidence Markers" value={formatCount(model.evidenceCount)} tone="#b4453a" />
          <StatTile label="Districts" value={formatCount(model.districts.length)} tone={SEMANTIC.created} />
          <StatTile label="Test Ratio" value={`${model.testRatio}%`} tone={model.testRatio >= 30 ? ACCENT : "#c79a3e"} />
          <StatTile label="Last Scan" value={stats ? formatTimestamp(stats.codeMetrics.generatedAt) : loading ? "loading" : "none"} />
        </div>

        {!loading && !error && model.districts.length === 0 && (
          <div className="flex h-64 items-center justify-center rounded border border-dashed border-gray-300 bg-white text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
            No hotspot files detected in recent git history.
          </div>
        )}

        {model.districts.length > 0 && (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="flex flex-wrap gap-4">
              {model.districts.map((district) => (
                <DistrictBlock key={district.id} district={district} />
              ))}
            </div>
            <aside className="space-y-3">
              <div className="rounded border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Case Board</h3>
                <div className="mt-3 space-y-2 text-xs text-gray-600 dark:text-gray-400">
                  <div className="flex justify-between gap-3">
                    <span>Prime district</span>
                    <span className="truncate font-semibold text-gray-900 dark:text-gray-100">{model.dominantDistrict ?? "n/a"}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>Production LOC</span>
                    <span className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatCount(stats?.codeMetrics.productionLoc ?? 0)}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>Test LOC</span>
                    <span className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatCount(stats?.codeMetrics.testLoc ?? 0)}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>Recent commits</span>
                    <span className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatCount(stats?.commitCount ?? 0)}</span>
                  </div>
                </div>
              </div>

              <div className="rounded border border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Top Evidence</h3>
                <div className="mt-3 space-y-2">
                  {topEvidence.map((building, index) => (
                    <div key={building.id} className="rounded border border-gray-100 bg-gray-50 p-2 dark:border-gray-800 dark:bg-gray-950">
                      <div className="flex items-center gap-2">
                        <span
                          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                          style={{ backgroundColor: heatColor(building.heat) }}
                        >
                          {index + 1}
                        </span>
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-gray-800 dark:text-gray-200" title={building.path}>{building.path}</div>
                          <div className="text-[11px] text-gray-500 dark:text-gray-400">
                            +{formatCount(building.additions)} / -{formatCount(building.deletions)}
                          </div>
                        </div>
                        <div className="ml-auto text-xs font-semibold tabular-nums text-gray-700 dark:text-gray-300">
                          {formatCount(building.changes)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 rounded border border-gray-200 bg-white p-3 text-[11px] dark:border-gray-800 dark:bg-gray-900">
                <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: TYPE_COLORS.bug }} />critical</div>
                <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: BRAND }} />high</div>
                <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#c79a3e]" />medium</div>
                <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#5b7a8c]" />low</div>
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
