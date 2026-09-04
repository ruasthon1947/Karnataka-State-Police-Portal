export const KARNATAKA_BOUNDS = {
  minLat: 11.5,
  maxLat: 18.7,
  minLng: 74.0,
  maxLng: 78.7,
} as const;

export const isKarnatakaCoordinate = (latitude: number, longitude: number) =>
  Number.isFinite(latitude)
  && Number.isFinite(longitude)
  && latitude >= KARNATAKA_BOUNDS.minLat
  && latitude <= KARNATAKA_BOUNDS.maxLat
  && longitude >= KARNATAKA_BOUNDS.minLng
  && longitude <= KARNATAKA_BOUNDS.maxLng;
