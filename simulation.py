"""Offline underwater dam inspection simulation and procedural 3D scene."""

from __future__ import annotations

from datetime import datetime, timezone
import heapq
import math
from typing import Any, Iterable

import numpy as np
import plotly.graph_objects as go


WORLD_BOUNDS = ((-18, 18), (1, 8), (0, 24))
WALL_X_BOUNDS = (-18, 18)
WALL_DEPTH = 24
SONAR_RADIUS = 9.0
MISSION_SECTIONS = {
    "Full Dam Survey": (-12, -6, 0, 6, 12),
    "Left Section": (-12, -9, -6),
    "Center Section": (-6, 0, 6),
    "Right Section": (6, 9, 12),
}


def _distance(a: Iterable[float], b: Iterable[float]) -> float:
    return float(np.linalg.norm(np.asarray(a, dtype=float) - np.asarray(b, dtype=float)))


def plan_path(
    start: Iterable[float],
    goal: Iterable[float],
    obstacles: Iterable[tuple[float, float, float, float]],
    bounds: tuple[tuple[int, int], tuple[int, int], tuple[int, int]] = WORLD_BOUNDS,
    clearance: float = 0.8,
) -> list[tuple[int, int, int]]:
    """Find a collision-free, six-connected grid path with A*."""
    origin = tuple(int(round(value)) for value in start)
    target = tuple(int(round(value)) for value in goal)
    obstacle_list = tuple(obstacles)

    def valid(node: tuple[int, int, int]) -> bool:
        if any(not low <= coordinate <= high for coordinate, (low, high) in zip(node, bounds)):
            return False
        return all(
            _distance(node, (ox, oy, oz)) > radius + clearance
            for ox, oy, oz, radius in obstacle_list
        )

    if not valid(origin) or not valid(target):
        raise ValueError("The route start or goal intersects an obstacle or lies outside the navigation bounds.")

    queue: list[tuple[float, float, tuple[int, int, int]]] = []
    heapq.heappush(queue, (0.0, 0.0, origin))
    came_from: dict[tuple[int, int, int], tuple[int, int, int] | None] = {origin: None}
    cost_so_far = {origin: 0.0}
    directions = ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))

    while queue:
        _, current_cost, current = heapq.heappop(queue)
        if current == target:
            break
        if current_cost > cost_so_far[current]:
            continue
        for dx, dy, dz in directions:
            neighbor = (current[0] + dx, current[1] + dy, current[2] + dz)
            if not valid(neighbor):
                continue
            new_cost = current_cost + 1.0
            if new_cost >= cost_so_far.get(neighbor, math.inf):
                continue
            cost_so_far[neighbor] = new_cost
            came_from[neighbor] = current
            heuristic = sum(abs(a - b) for a, b in zip(neighbor, target))
            heapq.heappush(queue, (new_cost + heuristic, new_cost, neighbor))

    if target not in came_from:
        raise ValueError(f"No collision-free route exists from {origin} to {target}.")

    route = []
    node: tuple[int, int, int] | None = target
    while node is not None:
        route.append(node)
        node = came_from[node]
    return list(reversed(route))


class Simulation:
    """Stateful, deterministic-enough simulation of an inspection mission."""

    def __init__(self) -> None:
        self.start = np.array([-14.0, 4.0, 3.0])
        self.obstacles = (
            (-3.0, 2.0, 12.0, 1.2),
            (4.0, 3.0, 11.0, 1.2),
            (10.0, 2.0, 19.0, 1.3),
            (-13.0, 5.0, 17.0, 1.0),
        )
        self.defect_scenarios = (
            {"id": "SIM-CR-01", "type": "Crack", "location": (-9.0, 0.0, 12.0), "severity": "High"},
            {"id": "SIM-ER-02", "type": "Concrete erosion", "location": (-1.0, 0.0, 12.0), "severity": "Medium"},
            {"id": "SIM-LK-03", "type": "Water leakage", "location": (6.0, 0.0, 13.0), "severity": "High"},
            {"id": "SIM-SD-04", "type": "Surface damage", "location": (11.0, 0.0, 12.0), "severity": "Low"},
        )
        self.reset()

    def reset(self) -> None:
        self.position = self.start.copy()
        self.orientation = np.array([1.0, 0.0, 0.0])
        self.status = "Idle"
        self.speed = 0.0
        self.battery = 100.0
        self.sim_time = 0.0
        self.inspection_depth = 12
        self.mission_sections: list[str] = []
        self.planned_route: list[tuple[int, int, int]] = []
        self.path_index = 0
        self.traveled_path = [self.position.copy()]
        self.route_length = 0.0
        self.distance_traveled = 0.0
        self.detected_defects: list[dict[str, Any]] = []
        self.communication_mode = "Tethered"
        self.communication_connected = True
        self.packet_count = 0
        self.communication_events: list[dict[str, str]] = []
        self.sonar_phase = 0.0
        self.last_step_dt = 0.0
        self.low_visibility = False
        self.manual_move_active = False

    def start_mission(self, sections: Iterable[str], inspection_depth: int = 12) -> None:
        selected = list(dict.fromkeys(sections))
        invalid = set(selected) - set(MISSION_SECTIONS)
        if not selected or invalid:
            raise ValueError("Select at least one valid inspection section.")
        if not 1 <= int(inspection_depth) <= 23:
            raise ValueError("Inspection depth must be between 1 m and 23 m.")

        self.inspection_depth = int(inspection_depth)
        self.mission_sections = selected
        goals = []
        for section in selected:
            for x in MISSION_SECTIONS[section]:
                goal = (int(x), 2, self.inspection_depth)
                if goal not in goals:
                    goals.append(goal)
        goals.append(tuple(int(value) for value in self.start))

        full_path: list[tuple[int, int, int]] = []
        current = tuple(int(round(value)) for value in self.position)
        for goal in goals:
            segment = plan_path(current, goal, self.obstacles)
            full_path.extend(segment if not full_path else segment[1:])
            current = goal

        self.planned_route = full_path
        self.path_index = 1 if len(full_path) > 1 else len(full_path)
        self.route_length = sum(_distance(a, b) for a, b in zip(full_path, full_path[1:]))
        self.distance_traveled = 0.0
        self.traveled_path = [self.position.copy()]
        self.detected_defects = []
        self.battery = 100.0
        self.status = "Running"
        self.manual_move_active = False
        self.communication_events = []
        self.communication_connected = True
        self.packet_count = 0
        self.sim_time = 0.0

    def pause(self) -> None:
        if self.status == "Running":
            self.status = "Paused"
            self.speed = 0.0

    def resume(self) -> None:
        if self.status == "Paused":
            self.status = "Running"

    def stop(self) -> None:
        if self.status in ("Running", "Paused", "Returning to surface", "Manual control"):
            self.status = "Stopped"
            self.speed = 0.0
            self.manual_move_active = False

    def return_to_surface(self) -> None:
        goal = (int(round(self.position[0])), max(2, int(round(self.position[1]))), 0)
        segment = plan_path(self.position, goal, self.obstacles)
        self.planned_route = [tuple(int(round(value)) for value in self.position)] + segment[1:]
        self.path_index = 1 if len(self.planned_route) > 1 else len(self.planned_route)
        self.route_length = sum(_distance(a, b) for a, b in zip(self.planned_route, self.planned_route[1:]))
        self.distance_traveled = 0.0
        self.traveled_path = [self.position.copy()]
        self.status = "Returning to surface"
        self.manual_move_active = False

    def manual_move(self, direction: str) -> None:
        """Plan one collision-aware, interpolated meter-long manual nudge."""
        direction_steps = {
            "up": (0, 0, -1),
            "down": (0, 0, 1),
            "left": (-1, 0, 0),
            "right": (1, 0, 0),
            "toward": (0, -1, 0),
            "away": (0, 1, 0),
        }
        if direction not in direction_steps:
            raise ValueError(f"Unknown manual direction: {direction}.")

        origin = tuple(int(round(value)) for value in self.position)
        delta = direction_steps[direction]
        goal = tuple(value + step for value, step in zip(origin, delta))
        segment = plan_path(origin, goal, self.obstacles)
        self.planned_route = segment
        self.path_index = 1
        self.route_length = sum(_distance(a, b) for a, b in zip(segment, segment[1:]))
        self.distance_traveled = 0.0
        self.traveled_path = [self.position.copy()]
        self.mission_sections = []
        self.status = "Manual control"
        self.manual_move_active = True

    def set_communication_mode(self, mode: str) -> None:
        if mode not in ("Tethered", "Acoustic"):
            raise ValueError("Communication mode must be Tethered or Acoustic.")
        self.communication_mode = mode

    def _record_communication_state(self, connected: bool) -> None:
        if connected == self.communication_connected:
            return
        self.communication_connected = connected
        state = "restored" if connected else "interrupted"
        self.communication_events.append(
            {"time": self._timestamp(), "event": f"{self.communication_mode} link {state}"}
        )

    @staticmethod
    def _timestamp() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    def _scan_for_defects(self) -> None:
        already_detected = {item["id"] for item in self.detected_defects}
        for scenario in self.defect_scenarios:
            if scenario["id"] in already_detected:
                continue
            if _distance(self.position, scenario["location"]) <= 3.0:
                self.detected_defects.append(
                    {
                        **scenario,
                        "location": list(scenario["location"]),
                        "timestamp": self._timestamp(),
                        "confidence": None,
                        "source": "Simulated inspection scenario",
                    }
                )

    def step(self, dt: float = 1.0) -> None:
        if not math.isfinite(dt) or dt < 0:
            raise ValueError("Simulation time step must be a finite, non-negative value.")
        self.last_step_dt = dt
        self.sonar_phase = (self.sonar_phase + dt * 0.85) % (2 * math.pi)
        manual_move_active = self.status == "Manual control" and self.manual_move_active
        if self.status not in ("Running", "Paused", "Returning to surface") and not manual_move_active:
            self.speed = 0.0
            return

        self.sim_time += dt
        phase = self.sim_time % 45.0
        outage = 24.0 <= phase < 28.0 if self.communication_mode == "Acoustic" else 39.0 <= phase < 41.0
        self._record_communication_state(not outage)
        if self.communication_connected:
            self.packet_count += max(1, int(dt * 4))

        if self.status == "Paused":
            self.speed = 0.0
            return

        self.speed = 0.9
        remaining = self.speed * dt
        while remaining > 1e-8 and self.path_index < len(self.planned_route):
            target = np.asarray(self.planned_route[self.path_index], dtype=float)
            delta = target - self.position
            distance = float(np.linalg.norm(delta))
            if distance <= 1e-8:
                self.position = target
                self.path_index += 1
                continue
            self.orientation = delta / distance
            traveled = min(remaining, distance)
            self.position += self.orientation * traveled
            self.distance_traveled += traveled
            remaining -= traveled
            self.traveled_path.append(self.position.copy())
            self._scan_for_defects()
            if traveled >= distance - 1e-8:
                self.position = target
                self.path_index += 1

        self.battery = max(0.0, self.battery - dt * (0.018 + (0.025 if self.speed else 0.0)))
        if self.path_index >= len(self.planned_route):
            self.speed = 0.0
            if self.status == "Running":
                self.status = "Completed"
            elif self.status == "Returning to surface":
                self.status = "At surface"
            else:
                self.manual_move_active = False
        if len(self.traveled_path) > 2500:
            self.traveled_path = self.traveled_path[-2500:]

    @property
    def mission_progress(self) -> float:
        if not self.mission_sections:
            return 0.0
        if self.status in ("Completed", "At surface"):
            return 100.0
        if self.route_length <= 0:
            return 0.0
        return min(100.0, self.distance_traveled / self.route_length * 100.0)

    @property
    def sonar_obstacles(self) -> list[dict[str, Any]]:
        visible = []
        for index, (x, y, z, radius) in enumerate(self.obstacles, start=1):
            distance = _distance(self.position, (x, y, z))
            if distance <= SONAR_RADIUS:
                visible.append(
                    {"id": f"OBS-{index:02d}", "x": x, "y": y, "z": z, "radius": radius, "distance": distance}
                )
        return visible

    @property
    def telemetry(self) -> dict[str, Any]:
        return {
            "x": float(self.position[0]),
            "y": float(self.position[1]),
            "z": float(self.position[2]),
            "depth": float(self.position[2]),
            "battery": float(self.battery),
            "speed": float(self.speed),
            "distance_traveled": float(self.distance_traveled),
            "planned_distance": float(self.route_length),
            "status": self.status,
            "progress": self.mission_progress,
            "thrusters": "Active" if self.status in ("Running", "Returning to surface") or (self.status == "Manual control" and self.manual_move_active) else "Standby",
            "manual_move_active": self.manual_move_active,
            "camera": "Degraded (low visibility)" if self.low_visibility else "Online",
            "sonar": "Scanning",
            "communication": "Connected" if self.communication_connected else "Interrupted",
            "communication_mode": self.communication_mode,
            "packets": self.packet_count,
        }


def _mesh_trace(
    vertices: np.ndarray,
    faces: list[tuple[int, int, int]],
    name: str,
    color: str,
    opacity: float = 1.0,
    hover: str | None = None,
) -> go.Mesh3d:
    array = np.asarray(vertices, dtype=float)
    i, j, k = zip(*faces)
    return go.Mesh3d(
        x=array[:, 0], y=array[:, 1], z=array[:, 2], i=i, j=j, k=k,
        name=name, color=color, opacity=opacity, flatshading=True,
        hovertemplate=hover or f"{name}<extra></extra>", showscale=False,
        lighting={"ambient": 0.55, "diffuse": 0.8, "specular": 0.45, "roughness": 0.55},
        lightposition={"x": 60, "y": 80, "z": 20},
    )


def _box_mesh(
    center: Iterable[float],
    dimensions: Iterable[float],
    color: str,
    name: str,
    opacity: float = 1.0,
) -> go.Mesh3d:
    cx, cy, cz = center
    dx, dy, dz = (value / 2.0 for value in dimensions)
    vertices = np.array(
        [
            [cx - dx, cy - dy, cz - dz], [cx + dx, cy - dy, cz - dz],
            [cx + dx, cy + dy, cz - dz], [cx - dx, cy + dy, cz - dz],
            [cx - dx, cy - dy, cz + dz], [cx + dx, cy - dy, cz + dz],
            [cx + dx, cy + dy, cz + dz], [cx - dx, cy + dy, cz + dz],
        ]
    )
    faces = [
        (0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7),
        (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5),
        (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7),
    ]
    return _mesh_trace(vertices, faces, name, color, opacity)


def _oriented_box(
    origin: np.ndarray,
    basis: np.ndarray,
    local_center: Iterable[float],
    dimensions: Iterable[float],
    color: str,
    name: str,
) -> go.Mesh3d:
    local = np.asarray(list(local_center), dtype=float)
    dims = np.asarray(list(dimensions), dtype=float) / 2.0
    corners = np.array(
        [
            [-dims[0], -dims[1], -dims[2]], [dims[0], -dims[1], -dims[2]],
            [dims[0], dims[1], -dims[2]], [-dims[0], dims[1], -dims[2]],
            [-dims[0], -dims[1], dims[2]], [dims[0], -dims[1], dims[2]],
            [dims[0], dims[1], dims[2]], [-dims[0], dims[1], dims[2]],
        ]
    )
    vertices = origin + (corners + local) @ basis.T
    faces = [
        (0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7),
        (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5),
        (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7),
    ]
    return _mesh_trace(vertices, faces, name, color)


def _oriented_cylinder(
    origin: np.ndarray,
    basis: np.ndarray,
    local_center: Iterable[float],
    length: float,
    radius: float,
    axis: int,
    color: str,
    name: str,
) -> go.Mesh3d:
    sides = 12
    angles = np.linspace(0, 2 * math.pi, sides, endpoint=False)
    lower, upper = [], []
    for angle in angles:
        point = np.zeros(3)
        other = [dimension for dimension in range(3) if dimension != axis]
        point[other[0]] = math.cos(angle) * radius
        point[other[1]] = math.sin(angle) * radius
        point[axis] = -length / 2.0
        lower.append(point)
        point = point.copy()
        point[axis] = length / 2.0
        upper.append(point)
    local = np.asarray(list(local_center), dtype=float)
    vertices = origin + (np.asarray(lower + upper) + local) @ basis.T
    faces: list[tuple[int, int, int]] = []
    for idx in range(sides):
        nxt = (idx + 1) % sides
        faces.extend(
            [
                (idx, nxt, sides + nxt), (idx, sides + nxt, sides + idx),
                (0, nxt, idx) if idx > 0 else (0, 1, 2),
                (sides, sides + idx, sides + nxt) if idx > 0 else (sides, sides + 2, sides + 1),
            ]
        )
    return _mesh_trace(vertices, faces, name, color)


def _oriented_sphere(
    origin: np.ndarray,
    basis: np.ndarray,
    local_center: Iterable[float],
    radii: Iterable[float],
    color: str,
    name: str,
    opacity: float = 1.0,
) -> go.Mesh3d:
    rings, slices = 8, 12
    vertices = []
    for ring in range(rings + 1):
        phi = math.pi * ring / rings
        for slice_index in range(slices):
            theta = 2 * math.pi * slice_index / slices
            vertices.append(
                [
                    math.sin(phi) * math.cos(theta),
                    math.sin(phi) * math.sin(theta),
                    math.cos(phi),
                ]
            )
    local = np.asarray(list(local_center), dtype=float)
    scaled = np.asarray(vertices) * np.asarray(list(radii), dtype=float) + local
    transformed = origin + scaled @ basis.T
    faces = []
    for ring in range(rings):
        for slice_index in range(slices):
            current = ring * slices + slice_index
            next_slice = ring * slices + (slice_index + 1) % slices
            lower = current + slices
            lower_next = next_slice + slices
            faces.extend(((current, next_slice, lower), (next_slice, lower_next, lower)))
    return _mesh_trace(transformed, faces, name, color, opacity)


def _robot_basis(direction: np.ndarray) -> np.ndarray:
    forward = np.asarray(direction, dtype=float)
    forward /= max(float(np.linalg.norm(forward)), 1e-9)
    lateral = np.cross(np.array([0.0, 0.0, 1.0]), forward)
    if np.linalg.norm(lateral) < 1e-5:
        lateral = np.array([0.0, 1.0, 0.0])
    lateral /= np.linalg.norm(lateral)
    vertical = np.cross(forward, lateral)
    vertical /= max(float(np.linalg.norm(vertical)), 1e-9)
    return np.column_stack((forward, lateral, vertical))


def _add_robot(fig: go.Figure, simulation: Simulation) -> None:
    origin = simulation.position
    basis = _robot_basis(simulation.orientation)
    parts = [
        _oriented_box(origin, basis, (0, 0, 0), (2.1, 1.1, 0.58), "#344b60", "Pressure-rated ROV chassis"),
        _oriented_box(origin, basis, (-0.05, 0, 0.02), (1.55, 0.88, 0.64), "#516b7e", "Armored chassis shell"),
    ]
    for side in (-1, 1):
        parts.append(_oriented_box(origin, basis, (0, side * 0.66, 0.10), (2.65, 0.12, 0.12), "#28d7dc", "Protective frame rail"))
        parts.append(_oriented_box(origin, basis, (side * 0.92, 0, 0.10), (0.12, 1.36, 0.12), "#28d7dc", "Protective frame crossbar"))
        parts.append(_oriented_cylinder(origin, basis, (0.78, side * 0.48, 0), 0.45, 0.22, 1, "#152b3c", "Horizontal thruster"))
        parts.append(_oriented_cylinder(origin, basis, (-0.78, side * 0.48, 0), 0.45, 0.22, 1, "#152b3c", "Horizontal thruster"))
        parts.append(_oriented_cylinder(origin, basis, (side * 0.78, 0, 0), 0.48, 0.20, 2, "#1c3547", "Vertical thruster"))
        parts.append(_oriented_cylinder(origin, basis, (1.26, side * 0.36, -0.02), 0.34, 0.16, 1, "#1c3547", "Forward vectored thruster"))
    parts.extend(
        [
            _oriented_sphere(origin, basis, (1.12, 0, -0.06), (0.30, 0.30, 0.26), "#091521", "Front inspection camera housing"),
            _oriented_sphere(origin, basis, (1.34, 0, -0.06), (0.12, 0.12, 0.12), "#39b8ff", "Camera optical lens"),
            _oriented_sphere(origin, basis, (1.08, -0.48, -0.12), (0.13, 0.13, 0.13), "#e8fbff", "Left LED inspection light"),
            _oriented_sphere(origin, basis, (1.08, 0.48, -0.12), (0.13, 0.13, 0.13), "#e8fbff", "Right LED inspection light"),
            _oriented_cylinder(origin, basis, (0.65, 0, -0.43), 0.24, 0.26, 2, "#18bfd0", "Forward sonar transducer"),
            _oriented_box(origin, basis, (-0.66, 0, 0.02), (0.62, 0.78, 0.40), "#d69d42", "Sealed battery module"),
            _oriented_box(origin, basis, (-0.72, 0.35, -0.34), (0.42, 0.34, 0.28), "#6f8da5", "Acoustic communication module"),
            _oriented_cylinder(origin, basis, (-0.78, 0.35, -0.57), 0.34, 0.035, 2, "#93efff", "Communication antenna"),
            _oriented_sphere(origin, basis, (-0.10, -0.50, -0.36), (0.14, 0.14, 0.13), "#86d9ff", "Depth and pressure sensor"),
            _oriented_box(origin, basis, (0.12, 0, 0.39), (0.46, 0.42, 0.20), "#7792a5", "Auxiliary sensor module"),
        ]
    )
    fig.add_traces(parts)
    label = origin + basis @ np.array([-0.10, 0.0, -0.88])
    fig.add_trace(
        go.Scatter3d(
            x=[label[0]], y=[label[1]], z=[label[2]], mode="text",
            text=["AQUAINSPECT"], textfont={"size": 10, "color": "#c8ffff"},
            name="Vehicle identification", hoverinfo="skip",
        )
    )


def _add_environment(fig: go.Figure, simulation: Simulation) -> None:
    fig.add_trace(_box_mesh((0, -0.16, 12.4), (38, 0.32, 24.8), "#667b86", "Reinforced concrete dam wall"))
    fig.add_trace(_box_mesh((0, 13, 25.0), (42, 30, 1.2), "#3d5558", "Submerged terrain and floor"))

    rng = np.random.default_rng(42)
    for index, (x, y, z, radius) in enumerate(simulation.obstacles, start=1):
        fig.add_trace(
            _oriented_sphere(
                np.zeros(3), np.eye(3), (x, y, z),
                (radius, radius * 0.78, radius * 0.7),
                "#756554", f"Submerged obstacle OBS-{index:02d}",
            )
        )
    for index in range(10):
        x = float(rng.uniform(-20, 20))
        y = float(rng.uniform(4, 26))
        z = float(rng.uniform(18, 25))
        size = float(rng.uniform(0.3, 1.0))
        fig.add_trace(_oriented_sphere(np.zeros(3), np.eye(3), (x, y, z), (size, size * 0.8, size * 0.6), "#4c5d59", f"Terrain rock {index + 1}"))

    fig.add_trace(
        go.Scatter3d(
            x=[item["location"][0] for item in simulation.defect_scenarios],
            y=[0.06] * len(simulation.defect_scenarios),
            z=[item["location"][2] for item in simulation.defect_scenarios],
            mode="markers",
            marker={"size": 9, "color": ["#f1bc49", "#d78255", "#54dbe5", "#e68181"], "symbol": "circle", "line": {"color": "#e6ffff", "width": 1}},
            name="Simulated wall defect locations",
            text=[f"{item['type']} / {item['severity']}" for item in simulation.defect_scenarios],
            hovertemplate="%{text}<br>X: %{x:.1f} m, depth: %{z:.1f} m<extra></extra>",
        )
    )
    crack_x = [-10.2, -9.7, -9.9, -9.3, -9.5, -8.9, -8.5]
    crack_z = [10.8, 11.2, 11.5, 11.9, 12.2, 12.7, 13.0]
    fig.add_trace(
        go.Scatter3d(
            x=crack_x, y=[0.08] * len(crack_x), z=crack_z, mode="lines",
            line={"color": "#211e1a", "width": 5}, name="Concrete crack",
            hovertemplate="Procedural crack<extra></extra>",
        )
    )
    for x, z in ((-1.0, 12.0), (11.0, 12.0)):
        fig.add_trace(
            _oriented_sphere(np.zeros(3), np.eye(3), (x, 0.07, z), (0.72, 0.08, 0.58), "#9d7155", "Eroded / damaged concrete region", 0.9)
        )
    leak_x = [6.0, 6.1, 5.95, 6.1, 5.9]
    leak_z = [13.1, 13.8, 14.5, 15.2, 15.9]
    fig.add_trace(
        go.Scatter3d(
            x=leak_x, y=[0.12, 0.22, 0.30, 0.38, 0.48], z=leak_z, mode="lines+markers",
            line={"color": "#62e9ff", "width": 4, "dash": "dot"},
            marker={"size": 3, "color": "#9ff5ff"}, name="Simulated leakage plume",
            hovertemplate="Simulated leakage plume<extra></extra>",
        )
    )

    particles = 170
    particle_x = rng.uniform(-19, 19, particles)
    particle_y = rng.uniform(0.5, 24, particles)
    particle_z = rng.uniform(0, 24, particles)
    fig.add_trace(
        go.Scatter3d(
            x=particle_x, y=particle_y, z=particle_z, mode="markers",
            marker={
                "size": rng.uniform(1, 3.5, particles), "color": "#8bc9d4",
                "opacity": 0.48 if simulation.low_visibility else 0.24,
            },
            name="Suspended silt particles", hoverinfo="skip",
        )
    )


def _add_inspection_zones(fig: go.Figure) -> None:
    zone_edges = ((-16, -6, "#2cdbd1", "Left inspection zone"), (-6, 6, "#40b4e5", "Center inspection zone"), (6, 16, "#4ce0a7", "Right inspection zone"))
    for x0, x1, color, name in zone_edges:
        fig.add_trace(
            go.Scatter3d(
                x=[x0, x1, x1, x0, x0], y=[0.20] * 5, z=[1, 1, 23, 23, 1],
                mode="lines", line={"color": color, "width": 2, "dash": "dash"},
                name=name, hoverinfo="skip",
            )
        )


def create_scene(simulation: Simulation) -> go.Figure:
    """Create the interactive 3D dam, inspection route, sonar beam, and assembled ROV."""
    fig = go.Figure()
    _add_environment(fig, simulation)
    _add_inspection_zones(fig)

    if simulation.planned_route:
        planned = np.asarray(simulation.planned_route, dtype=float)
        fig.add_trace(
            go.Scatter3d(
                x=planned[:, 0], y=planned[:, 1], z=planned[:, 2], mode="lines",
                line={"color": "#ffd45f", "width": 4, "dash": "dash"},
                name="Planned A* route", hovertemplate="Planned waypoint<extra></extra>",
            )
        )
    if len(simulation.traveled_path) > 1:
        traveled = np.asarray(simulation.traveled_path)
        fig.add_trace(
            go.Scatter3d(
                x=traveled[:, 0], y=traveled[:, 1], z=traveled[:, 2], mode="lines",
                line={"color": "#29f0a8", "width": 5},
                name="Actual travelled path", hovertemplate="Travelled path<extra></extra>",
            )
        )

    origin = simulation.position
    beam_length = SONAR_RADIUS
    beam_angle = simulation.sonar_phase
    beam_end = origin + np.array(
        [beam_length * math.cos(beam_angle), beam_length * math.sin(beam_angle), 0.0]
    )
    fig.add_trace(
        go.Scatter3d(
            x=[origin[0], beam_end[0]], y=[origin[1], beam_end[1]], z=[origin[2], beam_end[2]],
            mode="lines", line={"color": "#4eeaff", "width": 5}, name="Animated sonar sweep",
            hovertemplate="Simulated sonar beam<extra></extra>",
        )
    )
    _add_robot(fig, simulation)
    fig.update_layout(
        height=690,
        margin={"l": 0, "r": 0, "t": 28, "b": 0},
        paper_bgcolor="#071722",
        plot_bgcolor="#071722",
        font={"color": "#d3eaf0", "family": "Arial, sans-serif"},
        legend={"orientation": "h", "y": 1.02, "x": 0, "bgcolor": "rgba(7,23,34,0.65)", "font": {"size": 10}},
        scene={
            "xaxis": {"title": "X · horizontal (m)", "range": [-20, 20], "gridcolor": "#284351", "backgroundcolor": "#0a2634"},
            "yaxis": {"title": "Y · wall distance (m)", "range": [0, 28], "gridcolor": "#284351", "backgroundcolor": "#0a2634"},
            "zaxis": {"title": "Z · depth (m)", "range": [26, 0], "gridcolor": "#284351", "backgroundcolor": "#0a2634"},
            "aspectmode": "data",
            "camera": {"eye": {"x": 1.45, "y": 1.65, "z": 1.10}},
        },
        uirevision="aquainspect-scene",
    )
    return fig


def create_sonar_figure(simulation: Simulation) -> go.Figure:
    """Render a top-down simulated sonar sweep with range rings and detections."""
    fig = go.Figure()
    angles = np.linspace(0, 2 * math.pi, 160)
    for radius in (3, 6, SONAR_RADIUS):
        fig.add_trace(
            go.Scatter(
                x=radius * np.cos(angles), y=radius * np.sin(angles), mode="lines",
                line={"color": "#1a8096", "width": 1, "dash": "dot"},
                name=f"{radius:g} m range", hoverinfo="skip",
            )
        )
    beam_angle = simulation.sonar_phase
    beam_x, beam_y = SONAR_RADIUS * math.cos(beam_angle), SONAR_RADIUS * math.sin(beam_angle)
    fig.add_trace(
        go.Scatter(
            x=[0, beam_x], y=[0, beam_y], mode="lines",
            line={"color": "#4eeaff", "width": 3}, name="Sweep beam",
        )
    )
    fig.add_trace(go.Scatter(x=[0], y=[0], mode="markers", marker={"size": 13, "color": "#e9ffff", "symbol": "diamond"}, name="ROV"))
    detections = simulation.sonar_obstacles
    if detections:
        fig.add_trace(
            go.Scatter(
                x=[item["x"] - simulation.position[0] for item in detections],
                y=[item["y"] - simulation.position[1] for item in detections],
                mode="markers+text",
                text=[item["id"] for item in detections], textposition="top center",
                marker={"size": 10, "color": "#ffb453", "symbol": "diamond"},
                customdata=[[item["distance"], item["z"]] for item in detections],
                hovertemplate="%{text}<br>Range: %{customdata[0]:.1f} m<br>Z: %{customdata[1]:.1f} m<extra></extra>",
                name="Simulated obstacle returns",
            )
        )
    fig.update_layout(
        height=330, margin={"l": 10, "r": 10, "t": 20, "b": 20},
        paper_bgcolor="#071722", plot_bgcolor="#071722",
        font={"color": "#d3eaf0"},
        xaxis={"title": "Relative X (m)", "range": [-10, 10], "gridcolor": "#203b49", "zerolinecolor": "#416272"},
        yaxis={"title": "Relative Y (m)", "range": [-10, 10], "gridcolor": "#203b49", "zerolinecolor": "#416272", "scaleanchor": "x", "scaleratio": 1},
        showlegend=False,
    )
    return fig
