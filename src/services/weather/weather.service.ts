/**
 * OpenWeatherMap integration (free tier, no OAuth — server API key only).
 * OPENWEATHERMAP_API_KEY env var required.
 */

const OWM_BASE = "https://api.openweathermap.org/data/2.5";

function apiKey(): string {
  const k = process.env.OPENWEATHERMAP_API_KEY;
  if (!k) throw new Error("OPENWEATHERMAP_API_KEY is not configured.");
  return k;
}

export interface WeatherCondition {
  temp: number;
  feelsLike: number;
  humidity: number;
  description: string;
  icon: string;
  windSpeed: number;
  visibility: number;
  isRain: boolean;
  isSnow: boolean;
  isExtreme: boolean;
}

export interface ForecastHour {
  timestamp: string;
  temp: number;
  description: string;
  icon: string;
  isRain: boolean;
  precipProbability: number;
}

export async function getCurrentWeather(lat: number, lon: number): Promise<WeatherCondition> {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    units: "metric",
    appid: apiKey(),
  });

  const res = await fetch(`${OWM_BASE}/weather?${params}`);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenWeatherMap error ${res.status}: ${t.slice(0, 200)}`);
  }

  const d = (await res.json()) as {
    main?: { temp?: number; feels_like?: number; humidity?: number };
    weather?: { description?: string; icon?: string; id?: number }[];
    wind?: { speed?: number };
    visibility?: number;
  };

  const weatherId = d.weather?.[0]?.id ?? 800;
  return {
    temp: Math.round(d.main?.temp ?? 0),
    feelsLike: Math.round(d.main?.feels_like ?? 0),
    humidity: d.main?.humidity ?? 0,
    description: d.weather?.[0]?.description ?? "clear",
    icon: d.weather?.[0]?.icon ?? "01d",
    windSpeed: Math.round((d.wind?.speed ?? 0) * 3.6),
    visibility: Math.round((d.visibility ?? 10000) / 1000),
    isRain: weatherId >= 200 && weatherId < 700,
    isSnow: weatherId >= 600 && weatherId < 700,
    isExtreme: weatherId < 300 || (weatherId >= 900 && weatherId < 910),
  };
}

export async function getForecast(lat: number, lon: number, hours: number = 24): Promise<ForecastHour[]> {
  const cnt = Math.ceil(hours / 3);
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    units: "metric",
    cnt: String(Math.min(cnt, 40)),
    appid: apiKey(),
  });

  const res = await fetch(`${OWM_BASE}/forecast?${params}`);
  if (!res.ok) return [];

  const d = (await res.json()) as {
    list?: {
      dt?: number;
      main?: { temp?: number };
      weather?: { description?: string; icon?: string; id?: number }[];
      pop?: number;
    }[];
  };

  return (d.list ?? []).map((item) => {
    const wId = item.weather?.[0]?.id ?? 800;
    return {
      timestamp: new Date((item.dt ?? 0) * 1000).toISOString(),
      temp: Math.round(item.main?.temp ?? 0),
      description: item.weather?.[0]?.description ?? "clear",
      icon: item.weather?.[0]?.icon ?? "01d",
      isRain: wId >= 200 && wId < 700,
      precipProbability: Math.round((item.pop ?? 0) * 100),
    };
  });
}

export async function getWeatherForLocation(
  lat: number,
  lon: number,
): Promise<{ current: WeatherCondition; forecast: ForecastHour[] }> {
  const [current, forecast] = await Promise.all([
    getCurrentWeather(lat, lon),
    getForecast(lat, lon, 48),
  ]);
  return { current, forecast };
}
