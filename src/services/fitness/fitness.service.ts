/**
 * Google Fitness REST API service.
 * Reuses existing Google OAuth tokens. Requires 'https://www.googleapis.com/auth/fitness.activity.read' scope.
 */

import { refreshGoogleTokenIfNeeded } from "../auth.service";

const FITNESS_BASE = "https://www.googleapis.com/fitness/v1/users/me";

async function fitFetch(userId: string, path: string, opts: RequestInit = {}): Promise<Response> {
  const token = await refreshGoogleTokenIfNeeded(userId);
  return fetch(`${FITNESS_BASE}${path}`, {
    ...opts,
    headers: {
      ...(opts.headers ?? {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

function todayStartMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface FitnessSummary {
  date: string;
  steps: number;
  activeMinutes: number;
  caloriesBurned: number;
}

export async function getDailySummary(userId: string): Promise<FitnessSummary> {
  const startMs = todayStartMs();
  const endMs = Date.now();

  const body = {
    aggregateBy: [
      { dataTypeName: "com.google.step_count.delta" },
      { dataTypeName: "com.google.active_minutes" },
      { dataTypeName: "com.google.calories.expended" },
    ],
    bucketByTime: { durationMillis: endMs - startMs },
    startTimeMillis: startMs,
    endTimeMillis: endMs,
  };

  const res = await fitFetch(userId, "/dataset:aggregate", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return { date: new Date().toISOString().split("T")[0], steps: 0, activeMinutes: 0, caloriesBurned: 0 };
  }

  const data = (await res.json()) as {
    bucket?: {
      dataset?: {
        dataSourceId?: string;
        point?: { value?: { intVal?: number; fpVal?: number }[] }[];
      }[];
    }[];
  };

  let steps = 0;
  let activeMinutes = 0;
  let calories = 0;

  for (const bucket of data.bucket ?? []) {
    for (const ds of bucket.dataset ?? []) {
      const src = ds.dataSourceId ?? "";
      for (const point of ds.point ?? []) {
        const val = point.value?.[0];
        if (!val) continue;
        if (src.includes("step_count")) steps += val.intVal ?? 0;
        else if (src.includes("active_minutes")) activeMinutes += val.intVal ?? 0;
        else if (src.includes("calories")) calories += Math.round(val.fpVal ?? 0);
      }
    }
  }

  return {
    date: new Date().toISOString().split("T")[0],
    steps,
    activeMinutes,
    caloriesBurned: calories,
  };
}

export async function getWeeklySummary(userId: string): Promise<FitnessSummary[]> {
  const endMs = Date.now();
  const startMs = endMs - 7 * 24 * 60 * 60 * 1000;

  const body = {
    aggregateBy: [
      { dataTypeName: "com.google.step_count.delta" },
      { dataTypeName: "com.google.active_minutes" },
      { dataTypeName: "com.google.calories.expended" },
    ],
    bucketByTime: { durationMillis: 24 * 60 * 60 * 1000 },
    startTimeMillis: startMs,
    endTimeMillis: endMs,
  };

  const res = await fitFetch(userId, "/dataset:aggregate", {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!res.ok) return [];

  const data = (await res.json()) as {
    bucket?: {
      startTimeMillis?: string;
      dataset?: {
        dataSourceId?: string;
        point?: { value?: { intVal?: number; fpVal?: number }[] }[];
      }[];
    }[];
  };

  return (data.bucket ?? []).map((bucket) => {
    let steps = 0, activeMinutes = 0, calories = 0;
    for (const ds of bucket.dataset ?? []) {
      const src = ds.dataSourceId ?? "";
      for (const point of ds.point ?? []) {
        const val = point.value?.[0];
        if (!val) continue;
        if (src.includes("step_count")) steps += val.intVal ?? 0;
        else if (src.includes("active_minutes")) activeMinutes += val.intVal ?? 0;
        else if (src.includes("calories")) calories += Math.round(val.fpVal ?? 0);
      }
    }
    const date = new Date(Number(bucket.startTimeMillis ?? 0)).toISOString().split("T")[0];
    return { date, steps, activeMinutes, caloriesBurned: calories };
  });
}
