import axios from "axios";
import { LOCATIONS, TIMEZONES, VC_KEY } from "./config.js";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function getEcmwf(citySlug: string, dates: string[]): Promise<Record<string, number>> {
  const loc = LOCATIONS[citySlug];
  const tempUnit = loc.unit === "F" ? "fahrenheit" : "celsius";
  const result: Record<string, number> = {};
  const tz = TIMEZONES[citySlug] || "UTC";
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&daily=temperature_2m_max&temperature_unit=${tempUnit}` +
    `&forecast_days=7&timezone=${tz}` +
    `&models=ecmwf_ifs025&bias_correction=true`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data } = await axios.get(url, { timeout: 10000 });
      if (!data.error) {
        const times: string[] = data.daily.time;
        const temps: (number | null)[] = data.daily.temperature_2m_max;
        for (let i = 0; i < times.length; i++) {
          if (dates.includes(times[i]) && temps[i] != null) {
            result[times[i]] = loc.unit === "C"
              ? Math.round(temps[i]! * 10) / 10
              : Math.round(temps[i]!);
          }
        }
      }
      break;
    } catch (e: any) {
      if (attempt < 2) await sleep(3000);
      else console.log(`  [ECMWF] ${citySlug}: ${e.message}`);
    }
  }
  return result;
}

export async function getHrrr(citySlug: string, dates: string[]): Promise<Record<string, number>> {
  const loc = LOCATIONS[citySlug];
  if (loc.region !== "us") return {};
  const result: Record<string, number> = {};
  const tz = TIMEZONES[citySlug] || "UTC";
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&daily=temperature_2m_max&temperature_unit=fahrenheit` +
    `&forecast_days=3&timezone=${tz}` +
    `&models=gfs_seamless`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data } = await axios.get(url, { timeout: 10000 });
      if (!data.error) {
        const times: string[] = data.daily.time;
        const temps: (number | null)[] = data.daily.temperature_2m_max;
        for (let i = 0; i < times.length; i++) {
          if (dates.includes(times[i]) && temps[i] != null) {
            result[times[i]] = Math.round(temps[i]!);
          }
        }
      }
      break;
    } catch (e: any) {
      if (attempt < 2) await sleep(3000);
      else console.log(`  [HRRR] ${citySlug}: ${e.message}`);
    }
  }
  return result;
}

export async function getMetar(citySlug: string): Promise<number | null> {
  const loc = LOCATIONS[citySlug];
  try {
    const url = `https://aviationweather.gov/api/data/metar?ids=${loc.station}&format=json`;
    const { data } = await axios.get(url, { timeout: 8000 });
    if (data && Array.isArray(data) && data.length > 0) {
      const tempC = data[0].temp;
      if (tempC != null) {
        return loc.unit === "F"
          ? Math.round(Number(tempC) * 9 / 5 + 32)
          : Math.round(Number(tempC) * 10) / 10;
      }
    }
  } catch (e: any) {
    console.log(`  [METAR] ${citySlug}: ${e.message}`);
  }
  return null;
}

export async function getActualTemp(citySlug: string, dateStr: string): Promise<number | null> {
  const loc = LOCATIONS[citySlug];
  const vcUnit = loc.unit === "F" ? "us" : "metric";
  const url =
    `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline` +
    `/${loc.station}/${dateStr}/${dateStr}` +
    `?unitGroup=${vcUnit}&key=${VC_KEY}&include=days&elements=tempmax`;
  try {
    const { data } = await axios.get(url, { timeout: 8000 });
    const days = data.days || [];
    if (days.length > 0 && days[0].tempmax != null) {
      return Math.round(Number(days[0].tempmax) * 10) / 10;
    }
  } catch (e: any) {
    console.log(`  [VC] ${citySlug} ${dateStr}: ${e.message}`);
  }
  return null;
}
