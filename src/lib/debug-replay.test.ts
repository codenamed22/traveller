import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { solveTrip, solveTripByDays } from "./planner";
import { validateSchedule } from "./schedule-validation";
import { minuteAt, type TravelEdge, type Trip } from "./trip";

const path = "/tmp/traveller-plan-debug.json";

describe.skipIf(!existsSync(path))("replay captured planning problem", () => {
  it("diagnoses each day", async () => {
    const { trip, edges } = JSON.parse(readFileSync(path, "utf8")) as { trip: Trip; edges: TravelEdge[] };
    const name = (id: string) => id === "hotel" ? "HOTEL" : trip.stops.find((stop) => stop.id === id)?.name ?? id;
    for (let day = 0; day < trip.days; day++) {
      const stops = trip.stops.filter((stop) => stop.day === day);
      const dayEdges = edges.filter((edge) => edge.day === day);
      console.log(`\nDay ${day + 1}: ${stops.length} locked stops, ${stops.reduce((total, stop) => total + stop.duration, 0)} min`);
      for (const stop of stops.filter((candidate) => candidate.fixedTime).sort((left, right) => left.fixedTime!.localeCompare(right.fixedTime!))) console.log(`  booked ${stop.fixedTime} ${stop.name} ${stop.duration}m buf ${stop.buffer}`);
      for (const stop of stops) {
        const outgoing = dayEdges.filter((edge) => edge.from === stop.id && (edge.to === "hotel" || stops.some((other) => other.id === edge.to)));
        const best = (to: string) => Math.min(...dayEdges.filter((edge) => edge.from === stop.id && edge.to === to).map((edge) => edge.minutes));
        console.log(`  ${stop.name}: ${outgoing.length} links within day; to hotel ${best("hotel")}m; from hotel ${Math.min(...dayEdges.filter((edge) => edge.from === "hotel" && edge.to === stop.id).map((edge) => edge.minutes))}m`);
      }
      const single = { ...trip, days: 1, startDate: trip.startDate, stops: stops.map((stop) => ({ ...stop, day: 0 })), dayGroups: undefined };
      const shifted = { ...single, startDate: new Date(Date.parse(trip.startDate) + day * 86_400_000).toISOString().slice(0, 10) };
      try {
        await solveTrip(shifted, dayEdges.map((edge) => ({ ...edge, day: 0 })), 5);
        console.log(`  => locked visits alone: FEASIBLE`);
      } catch (error) {
        console.log(`  => locked visits alone: ${(error as Error).message.slice(0, 300)}`);
      }
      void minuteAt; void name;
    }
    const free = trip.stops.filter((stop) => stop.day === null && !trip.dayGroups?.some((group) => group.stopIds.includes(stop.id)));
    const started = Date.now();
    const schedule = await solveTripByDays(trip, edges, 5).catch((error: Error) => error);
    if (schedule instanceof Error) { console.log(`BY DAYS: ${schedule.message}`); return; }
    console.log(`BY DAYS: valid=${validateSchedule(trip, schedule).length === 0} in ${Date.now() - started}ms`);
    for (const plan of schedule.days) console.log(`  Day ${plan.day + 1}: ${plan.visits.map((visit) => `${new Date(Date.UTC(0, 0, 0, 0, visit.start)).toISOString().slice(11, 16)} ${name(visit.stopId)} (${visit.end - visit.start}m, ${visit.leg.mode} ${visit.leg.minutes}m)`).join(" | ")} | back ${plan.returnLeg?.minutes}m`);
    return;
    console.log(`\nUnlocked Amsterdam visits: ${free.map((stop) => `${stop.name} ${stop.duration}m`).join(", ")}`);
    const tryDay = async (day: number, stops: Trip["stops"]) => {
      const single = { ...trip, days: 1, startDate: new Date(Date.parse(trip.startDate) + day * 86_400_000).toISOString().slice(0, 10), stops: stops.map((stop) => ({ ...stop, day: 0 })), dayGroups: undefined };
      try { await solveTrip(single, edges.filter((edge) => edge.day === day).map((edge) => ({ ...edge, day: 0 })), 3); return "ok"; }
      catch (error) { return (error as Error).message.slice(0, 160); }
    };
    const group = trip.stops.filter((stop) => trip.dayGroups?.[0]?.stopIds.includes(stop.id));
    for (let day = 0; day < trip.days; day++) {
      const locked = trip.stops.filter((stop) => stop.day === day);
      if (!locked.length) console.log(`Day ${day + 1} with Utrecht group: ${await tryDay(day, group)}`);
      else for (const stop of free) console.log(`Day ${day + 1} locked + ${stop.name}: ${await tryDay(day, [...locked, stop])}`);
      if (locked.length) console.log(`Day ${day + 1} locked + all 5 free: ${await tryDay(day, [...locked, ...free])}`);
    }
    return;
    for (const seconds of [5, 30]) {
      const started = Date.now();
      try {
        const schedule = await solveTrip(trip, edges, seconds, { onStage: (stage) => console.log(`  stage ${JSON.stringify(stage)}`) });
        console.log(`full problem, ${seconds}s: FEASIBLE in ${Date.now() - started}ms; days ${schedule.days.map((day) => day.visits.length).join("/")}`);
        break;
      } catch (error) {
        console.log(`full problem, ${seconds}s: ${(error as Error).message.slice(0, 200)} (${Date.now() - started}ms)`);
      }
    }
  }, 60_000);
});
