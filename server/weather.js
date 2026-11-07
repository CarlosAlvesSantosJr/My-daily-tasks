'use strict';

// Previsão do tempo de onde o usuário está, com APIs públicas e sem chave:
// - Open-Meteo: previsão (https://open-meteo.com)
// - ipwho.is: cidade aproximada pelo IP, quando não há GPS
// - Nominatim (OpenStreetMap): nome da cidade a partir das coordenadas do GPS
// As consultas saem do servidor: o navegador não fala com terceiros e a CSP
// continua fechada em 'self'.

const CACHE_MS = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const TIMEOUT_MS = 8000;
const USER_AGENT = 'MinhasTarefas/2.0 (app pessoal de tarefas)';


/** Duas casas decimais (~1 km): basta para o clima e não guarda o endereço exato. */
const round = (value) => Math.round(value * 100) / 100;

function createWeather({ fetch: fetchImpl = fetch } = {}) {
  const cache = new Map();

  async function cached(key, load) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = await load();
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expiresAt: Date.now() + CACHE_MS });
    return value;
  }

  async function getJson(url) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`Falha ao consultar ${new URL(url).host}: ${err.message}`);
    }
    if (!response.ok) {
      throw new Error(`${new URL(url).host} respondeu ${response.status}`);
    }
    return response.json();
  }

  /** IP interno (rodando em casa, sem túnel) cai no IP público do próprio servidor. */
  async function locateByIp(ip) {
    const fields = 'fields=success,city,latitude,longitude';
    let found = ip ? await getJson(`https://ipwho.is/${encodeURIComponent(ip)}?${fields}`) : null;
    if (!found || !found.success) found = await getJson(`https://ipwho.is/?${fields}`);
    if (!found.success) throw new Error('Local não encontrado pelo IP.');
    return { lat: round(found.latitude), lon: round(found.longitude), place: found.city || null };
  }

  /** Sem nome da cidade, a previsão aparece mesmo assim. */
  async function placeName(lat, lon) {
    try {
      const data = await getJson(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=pt-BR&lat=${lat}&lon=${lon}`,
      );
      const { address = {} } = data;
      return address.city || address.town || address.village || address.municipality || data.name || null;
    } catch {
      return null;
    }
  }

  async function forecast(lat, lon) {
    const params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      current: 'temperature_2m,weather_code,is_day',
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      forecast_days: '1',
      timezone: 'auto',
    });
    const data = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`);
    const { current, daily } = data;
    if (!current || !daily) throw new Error('Resposta da previsão incompleta.');
    return {
      temperature: Math.round(current.temperature_2m),
      weatherCode: current.weather_code,
      isDay: current.is_day === 1,
      max: Math.round(daily.temperature_2m_max[0]),
      min: Math.round(daily.temperature_2m_min[0]),
      rainChance: daily.precipitation_probability_max[0] ?? null,
    };
  }

  async function report({ lat, lon, place }) {
    const weather = await cached(`f:${lat},${lon}`, () => forecast(lat, lon));
    return { place, ...weather };
  }

  return {
    /** Coordenadas do GPS do aparelho. */
    async forCoordinates(rawLat, rawLon) {
      const lat = round(rawLat);
      const lon = round(rawLon);
      const place = await cached(`p:${lat},${lon}`, () => placeName(lat, lon));
      return report({ lat, lon, place });
    },

    /** Sem GPS: local aproximado pelo IP de quem pediu. */
    async forIp(ip) {
      const location = await cached(`ip:${ip}`, () => locateByIp(ip));
      return report(location);
    },
  };
}

module.exports = { createWeather };
