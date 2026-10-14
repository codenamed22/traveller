import { dayStart, minuteAt, type TravelEdge, type TravelMode, type Trip } from "./trip";

type Connection = Pick<TravelEdge, "day" | "from" | "to" | "mode">;

export class RouteSamples {
  private readonly connections = new Map<string, { connection: Connection; samples: Map<number, TravelEdge | null> }>();
  private readonly departures = new Map<string, number>();

  constructor(private readonly trip: Trip, edges: TravelEdge[]) {
    for (const edge of edges) this.add(edge);
  }

  private key(connection: Connection) {
    return JSON.stringify([connection.day, connection.from, connection.to, connection.mode]);
  }

  setDeparture(day: number, from: string, departure: number) {
    this.departures.set(JSON.stringify([day, from]), departure);
  }

  add(edge: TravelEdge) {
    this.record(edge.day, edge.from, edge.to, edge.mode, edge.sampledDeparture ?? dayStart(this.trip, edge.day), edge);
  }

  record(day: number, from: string, to: string, mode: TravelMode, departure: number, edge: TravelEdge | null) {
    const connection = { day, from, to, mode };
    const key = this.key(connection);
    const entry = this.connections.get(key) ?? { connection, samples: new Map<number, TravelEdge | null>() };
    entry.samples.set(mode === "WALK" ? 0 : departure, edge ? { ...edge, ...(mode === "TRANSIT" ? { sampledDeparture: departure } : {}) } : null);
    this.connections.set(key, entry);
  }

  has(day: number, from: string, to: string, mode: TravelMode) {
    return this.connections.has(this.key({ day, from, to, mode }));
  }

  at(day: number, from: string, to: string, mode: TravelMode, departure: number): TravelEdge | null | undefined {
    const entry = this.connections.get(this.key({ day, from, to, mode }));
    if (!entry) return undefined;
    const target = mode === "WALK" ? 0 : departure;
    let closest = Infinity;
    let selected: TravelEdge | null | undefined;
    for (const [minute, edge] of entry.samples) {
      if (Math.abs(minute - target) <= closest) { closest = Math.abs(minute - target); selected = edge; }
    }
    return selected ? { ...selected } : selected;
  }

  select(): TravelEdge[] {
    const edges: TravelEdge[] = [];
    for (const { connection } of this.connections.values()) {
      const { day, from, to, mode } = connection;
      const origin = this.trip.stops.find((stop) => stop.id === from);
      const departure = this.departures.get(JSON.stringify([day, from])) ?? (origin?.fixedTime && origin.day === day ? minuteAt(this.trip, day, origin.fixedTime) + origin.duration : dayStart(this.trip, day));
      const edge = this.at(day, from, to, mode, departure);
      if (edge) edges.push(edge);
    }
    return edges;
  }
}