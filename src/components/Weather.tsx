import { Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, Sun, Umbrella } from "lucide-react";
import { weatherCredit, type DayWeather, type WeatherIcon } from "@/lib/weather";

const icons: Record<WeatherIcon, typeof Sun> = { clear: Sun, partly: CloudSun, cloudy: Cloud, fog: CloudFog, drizzle: CloudDrizzle, rain: CloudRain, snow: CloudSnow, storm: CloudLightning };

// A day's forecast: its icon and high, or high and low with `range`.
export function WeatherBadge({ weather, range = false }: { weather: DayWeather; range?: boolean }) {
  const Icon = icons[weather.icon];
  return <span className="weather" title={`${weather.label} · ${weather.max}° / ${weather.min}° · ${weather.rain}% rain`}>
    <Icon size={13} aria-label={weather.label} role="img" />{weather.max}°{range && <small>{weather.min}°</small>}
  </span>;
}

// Rain likely during an outdoor visit, with a way to ask the agent for something indoors instead.
export function RainWarning({ chance, onSwap }: { chance: number; onSwap?: () => void }) {
  return <span className="rain-warning"><Umbrella size={13} />{chance}% rain{onSwap && <button type="button" className="chip" onClick={onSwap}>Swap?</button>}</span>;
}

export function WeatherCredit() {
  return <a href={weatherCredit.url} target="_blank" rel="noreferrer">{weatherCredit.label}</a>;
}
