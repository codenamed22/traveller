export function placeMarkerLabel(stopId: string, fallbackIndex: number, markerOrder?: string[]) {
  if (!markerOrder) return String(fallbackIndex + 1);
  const visitIndex = markerOrder.indexOf(stopId);
  return visitIndex < 0 ? "·" : String(visitIndex + 1);
}