import json
import sys
import time


def solve(payload):
    startup_started = time.perf_counter()
    from ortools.constraint_solver import pywrapcp, routing_enums_pb2

    stops = payload["stops"]
    days = payload["days"]
    ids = ["hotel", *[stop["id"] for stop in stops]]
    positions = {stop_id: index for index, stop_id in enumerate(ids)}
    edges = {}
    for edge in payload["travel"]:
        key = (edge["day"], positions[edge["from"]], positions[edge["to"]])
        previous = edges.get(key)
        if previous is None or edge["minutes"] < previous["minutes"]:
            edges[key] = edge

    manager = pywrapcp.RoutingIndexManager(len(ids), len(days), 0)
    routing = pywrapcp.RoutingModel(manager)
    horizon = max(day.get("returnEnd", day["end"]) for day in days)
    visits_end = max(day["end"] for day in days)

    def callback(day, include_service):
        def transit(from_index, to_index):
            origin = manager.IndexToNode(from_index)
            destination = manager.IndexToNode(to_index)
            edge = edges.get((day, origin, destination))
            synthetic = destination == 0 and (origin == 0 or not payload["returnToHotel"])
            minutes = 0 if synthetic else edge["minutes"] if edge else horizon + 1
            if include_service:
                minutes += stops[origin - 1]["duration"] if origin else 0
                if destination and stops[destination - 1]["fixedMinute"] is not None:
                    minutes += stops[destination - 1]["buffer"]
            return minutes
        return transit

    transit_indices = []
    for day in range(len(days)):
        transit_indices.append(routing.RegisterTransitCallback(callback(day, True)))
        cost_index = routing.RegisterTransitCallback(callback(day, False))
        routing.SetArcCostEvaluatorOfVehicle(cost_index, day)
    routing.AddDimensionWithVehicleTransits(transit_indices, horizon, horizon, False, "Time")
    timing = routing.GetDimensionOrDie("Time")
    for day, limits in enumerate(days):
        timing.CumulVar(routing.Start(day)).SetRange(limits["start"], limits["start"])
        # Visits end by "end"; the trip back to the hotel may arrive by "returnEnd".
        timing.CumulVar(routing.End(day)).SetRange(limits["start"], limits.get("returnEnd", limits["end"]))
    for node, stop in enumerate(stops, 1):
        index = manager.NodeToIndex(node)
        if stop["day"] is not None:
            routing.SetAllowedVehiclesForIndex([stop["day"]], index)
        if stop["fixedMinute"] is not None:
            timing.CumulVar(index).SetRange(stop["fixedMinute"], stop["fixedMinute"])
        else:
            timing.CumulVar(index).SetRange(min(day["start"] for day in days), max(min(day["start"] for day in days), visits_end - stop["duration"]))
        if stop["optional"]:
            routing.AddDisjunction([index], 100_000 * stop["priority"])
    count_index = routing.RegisterUnaryTransitCallback(lambda index: int(manager.IndexToNode(index) != 0))
    routing.AddDimension(count_index, 0, payload["maxStopsPerDay"], True, "Visits")
    if payload["goal"] == "BALANCED":
        routing.AddDimensionWithVehicleTransits(transit_indices, 0, horizon, True, "Activity")
        routing.GetDimensionOrDie("Activity").SetGlobalSpanCostCoefficient(1)

    parameters = pywrapcp.DefaultRoutingSearchParameters()
    parameters.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    parameters.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    parameters.time_limit.FromMilliseconds(payload["timeLimitMs"])
    started = time.perf_counter()
    first_solution = []

    def found_solution():
        if not first_solution:
            first_solution.append(round((time.perf_counter() - started) * 1000))

    routing.AddAtSolutionCallback(found_solution)
    initial = None
    if payload.get("initialRoutes"):
        routing.CloseModelWithParameters(parameters)
        routes = [[positions[stop_id] for stop_id in route] for route in payload["initialRoutes"]]
        initial = routing.ReadAssignmentFromRoutes(routes, True)
    solution = routing.SolveFromAssignmentWithParameters(initial, parameters) if initial else routing.SolveWithParameters(parameters)
    result = {"status": routing.status(), "startupMs": round((started - startup_started) * 1000), "firstSolutionMs": first_solution[0] if first_solution else None, "elapsedMs": round((time.perf_counter() - started) * 1000)}
    if not solution:
        return {**result, "outcome": "conflict" if routing.status() == 6 else "incomplete"}
    scheduled = set()
    planned_days = []
    for day, limits in enumerate(days):
        visits = []
        index = routing.Start(day)
        previous = 0
        while not routing.IsEnd(index):
            index = solution.Value(routing.NextVar(index))
            if routing.IsEnd(index):
                break
            node = manager.IndexToNode(index)
            stop = stops[node - 1]
            start = solution.Value(timing.CumulVar(index))
            visits.append({"stopId": stop["id"], "start": start, "end": start + stop["duration"], "leg": edges[(day, previous, node)]})
            scheduled.add(stop["id"])
            previous = node
        planned = {"day": day, "date": limits["date"], "visits": visits}
        if visits and payload["returnToHotel"]:
            planned["returnLeg"] = edges[(day, previous, 0)]
        planned_days.append(planned)
    return {**result, "outcome": "feasible", "schedule": {"days": planned_days, "omitted": [stop["id"] for stop in stops if stop["id"] not in scheduled], "warnings": [], "generatedAt": payload["generatedAt"]}}


if __name__ == "__main__":
    print(json.dumps(solve(json.load(sys.stdin))))