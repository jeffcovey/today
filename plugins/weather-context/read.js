#!/usr/bin/env node

/**
 * Weather Context Plugin
 *
 * Fetches current weather and forecast using Open-Meteo API (free, no key required).
 * Location is geocoded from the user's config.toml location setting.
 */

import fs from 'node:fs';
import path from 'node:path';

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();

async function getLocationFromConfig() {
  // Use plugin config override if provided
  if (config.location) {
    return config.location;
  }

  // Read from main config.toml
  const configPath = path.join(projectRoot, 'config.toml');
  const configContent = fs.readFileSync(configPath, 'utf-8');

  // Simple TOML parsing for location field
  const locationMatch = configContent.match(/^location\s*=\s*"([^"]+)"/m);
  if (locationMatch) {
    return locationMatch[1];
  }

  throw new Error('No location found in config.toml or plugin settings');
}

async function geocodeLocation(location) {
  // Open-Meteo geocoding works better with just the city name
  // Try the full location first, then fall back to just the city
  const searchTerms = [
    location,
    location.split(',')[0].trim(), // Just the city name
  ];

  for (const searchTerm of searchTerms) {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(searchTerm)}&count=5&language=en&format=json`;

    const response = await fetch(url);
    if (!response.ok) {
      continue;
    }

    const data = await response.json();
    if (!data.results || data.results.length === 0) {
      continue;
    }

    // If we have multiple results and the original location included a state/region,
    // try to match it
    let result = data.results[0];
    const locationLower = location.toLowerCase();

    for (const r of data.results) {
      const admin1Lower = (r.admin1 || '').toLowerCase();
      const countryLower = (r.country || '').toLowerCase();
      if (locationLower.includes(admin1Lower) || locationLower.includes(countryLower)) {
        result = r;
        break;
      }
    }

    return {
      latitude: result.latitude,
      longitude: result.longitude,
      name: result.name,
      admin1: result.admin1, // State/region
      country: result.country,
      timezone: result.timezone,
    };
  }

  throw new Error(`Could not find location: ${location}`);
}

async function getWeather(coords, units) {
  const isMetric = units === 'metric';
  const tempUnit = isMetric ? 'celsius' : 'fahrenheit';
  const windUnit = isMetric ? 'kmh' : 'mph';
  const precipUnit = isMetric ? 'mm' : 'inch';

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', coords.latitude);
  url.searchParams.set('longitude', coords.longitude);
  url.searchParams.set('timezone', coords.timezone || 'auto');
  url.searchParams.set('temperature_unit', tempUnit);
  url.searchParams.set('wind_speed_unit', windUnit);
  url.searchParams.set('precipitation_unit', precipUnit);

  // Current conditions
  url.searchParams.set(
    'current',
    [
      'temperature_2m',
      'relative_humidity_2m',
      'apparent_temperature',
      'weather_code',
      'wind_speed_10m',
      'wind_gusts_10m',
      'uv_index',
    ].join(',')
  );

  // Hourly forecast for next 24 hours
  url.searchParams.set(
    'hourly',
    ['temperature_2m', 'precipitation_probability', 'weather_code'].join(',')
  );
  url.searchParams.set('forecast_hours', '24');

  // Daily forecast
  url.searchParams.set(
    'daily',
    [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_probability_max',
      'sunrise',
      'sunset',
      'uv_index_max',
    ].join(',')
  );
  url.searchParams.set('forecast_days', '3');

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Weather API failed: ${response.statusText}`);
  }

  return response.json();
}

// WMO Weather interpretation codes
// https://open-meteo.com/en/docs
const weatherCodes = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Foggy',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

function describeWeather(code) {
  return weatherCodes[code] || 'Unknown';
}

function formatTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatDate(dateString) {
  const date = new Date(dateString + 'T12:00:00');
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

function formatContext(location, weather, units) {
  const isMetric = units === 'metric';
  const tempSymbol = isMetric ? '°C' : '°F';
  const windSymbol = isMetric ? 'km/h' : 'mph';

  const current = weather.current;
  const daily = weather.daily;

  // Build context string
  const lines = [];

  // Location header
  const locationStr = [location.name, location.admin1, location.country]
    .filter(Boolean)
    .join(', ');
  lines.push(`Weather for ${locationStr}`);
  lines.push('');

  // Current conditions
  lines.push('## Current Conditions');
  lines.push(`- ${describeWeather(current.weather_code)}`);
  lines.push(
    `- Temperature: ${Math.round(current.temperature_2m)}${tempSymbol} (feels like ${Math.round(current.apparent_temperature)}${tempSymbol})`
  );
  lines.push(`- Humidity: ${current.relative_humidity_2m}%`);
  lines.push(
    `- Wind: ${Math.round(current.wind_speed_10m)} ${windSymbol} (gusts ${Math.round(current.wind_gusts_10m)} ${windSymbol})`
  );
  lines.push(`- UV Index: ${current.uv_index}`);
  lines.push('');

  // Today's details
  lines.push('## Today');
  lines.push(
    `- High: ${Math.round(daily.temperature_2m_max[0])}${tempSymbol} / Low: ${Math.round(daily.temperature_2m_min[0])}${tempSymbol}`
  );
  lines.push(
    `- Precipitation chance: ${daily.precipitation_probability_max[0]}%`
  );
  lines.push(
    `- Sunrise: ${formatTime(daily.sunrise[0])} / Sunset: ${formatTime(daily.sunset[0])}`
  );
  lines.push('');

  // Upcoming hours summary
  const hourly = weather.hourly;
  const upcomingPrecip = hourly.precipitation_probability.slice(0, 12);
  const maxPrecipChance = Math.max(...upcomingPrecip);
  if (maxPrecipChance > 20) {
    const peakHourIndex = upcomingPrecip.indexOf(maxPrecipChance);
    const peakTime = formatTime(hourly.time[peakHourIndex]);
    lines.push(
      `## Rain Alert: ${maxPrecipChance}% chance of precipitation around ${peakTime}`
    );
    lines.push('');
  }

  // 3-day forecast
  lines.push('## 3-Day Forecast');
  for (let i = 0; i < 3; i++) {
    const dayName = i === 0 ? 'Today' : formatDate(daily.time[i]);
    const condition = describeWeather(daily.weather_code[i]);
    const high = Math.round(daily.temperature_2m_max[i]);
    const low = Math.round(daily.temperature_2m_min[i]);
    const precip = daily.precipitation_probability_max[i];

    lines.push(
      `- **${dayName}**: ${condition}, ${high}${tempSymbol}/${low}${tempSymbol}, ${precip}% precip`
    );
  }

  return lines.join('\n');
}

async function main() {
  try {
    const locationStr = await getLocationFromConfig();
    const coords = await geocodeLocation(locationStr);
    const units = config.units || 'imperial';
    const weather = await getWeather(coords, units);

    const context = formatContext(coords, weather, units);

    // Output as context type - just the formatted text
    console.log(
      JSON.stringify({
        context: context,
        metadata: {
          location: coords,
          units: units,
          fetched_at: new Date().toISOString(),
        },
      })
    );
  } catch (error) {
    console.error(`Weather plugin error: ${error.message}`);
    process.exit(1);
  }
}

main();
