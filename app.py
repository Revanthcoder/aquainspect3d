"""AQUAINSPECT 3D local API and static dashboard server."""

from __future__ import annotations

import base64
from pathlib import Path
import time
from typing import Literal

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from reporting import build_report, report_csv_bytes, report_pdf_bytes
from simulation import MISSION_SECTIONS, SONAR_RADIUS, Simulation
from vision import ENHANCEMENT_PROFILES, SAMPLE_DEFECTS, enhance_image, find_image_candidates, generate_sample_image


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
MAX_IMAGE_BYTES = 10 * 1024 * 1024
simulation = Simulation()
last_tick = time.monotonic()

app = FastAPI(title="AQUAINSPECT 3D", version="2.0.0")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


class MissionRequest(BaseModel):
    sections: list[str] = Field(default_factory=lambda: ["Full Dam Survey"])
    inspection_depth: int = Field(default=12, ge=1, le=23)


class SettingsRequest(BaseModel):
    communication_mode: Literal["Tethered", "Acoustic"] = "Tethered"
    low_visibility: bool = False
    water_condition: Literal["Clear", "Silt", "Heavy mud"] = "Clear"


class SampleRequest(BaseModel):
    defect_type: str
    profile: Literal["visibility", "low-light", "color-correct"] = "visibility"


class ManualMoveRequest(BaseModel):
    direction: Literal["up", "down", "left", "right", "toward", "away"]


def current_state(advance: bool = True) -> dict:
    global last_tick
    now = time.monotonic()
    if advance:
        dt = min(1.0, max(0.0, now - last_tick))
        simulation.step(dt)
    last_tick = now
    return {
        "telemetry": simulation.telemetry,
        "position": simulation.position.tolist(),
        "orientation": simulation.orientation.tolist(),
        "planned_route": simulation.planned_route,
        "traveled_path": [point.tolist() for point in simulation.traveled_path],
        "obstacles": simulation.sonar_obstacles,
        "all_obstacles": [
            {"id": f"OBS-{index:02d}", "x": x, "y": y, "z": z, "radius": radius}
            for index, (x, y, z, radius) in enumerate(simulation.obstacles, start=1)
        ],
        "defects": simulation.detected_defects,
        "defect_scenarios": simulation.defect_scenarios,
        "communication_events": simulation.communication_events[-20:],
        "sonar_phase": simulation.sonar_phase,
        "sonar_radius": SONAR_RADIUS,
        "low_visibility": simulation.low_visibility,
        "water_condition": simulation.water_condition,
        "mission_sections": simulation.mission_sections,
        "inspection_depth": simulation.inspection_depth,
        "mission_progress": simulation.mission_progress,
        "mission_priorities": simulation.prioritized_missions(),
    }


@app.get("/")
def dashboard() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/api/state")
def get_state() -> dict:
    return current_state()


@app.post("/api/mission/start")
def start_mission(request: MissionRequest) -> dict:
    try:
        simulation.start_mission(request.sections, request.inspection_depth)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return current_state(advance=False)


@app.post("/api/settings")
def update_settings(request: SettingsRequest) -> dict:
    simulation.set_communication_mode(request.communication_mode)
    simulation.low_visibility = request.low_visibility
    simulation.set_water_condition(request.water_condition)
    return current_state(advance=False)


@app.post("/api/control/{action}")
def control(action: str) -> dict:
    global last_tick
    try:
        if action == "pause":
            simulation.pause()
        elif action == "resume":
            simulation.resume()
        elif action == "stop":
            simulation.stop()
        elif action == "surface":
            simulation.return_to_surface()
        elif action == "reset":
            simulation.reset()
        else:
            raise HTTPException(status_code=404, detail=f"Unknown control action: {action}")
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    last_tick = time.monotonic()
    return current_state(advance=False)


@app.post("/api/manual/move")
def manual_move(request: ManualMoveRequest) -> dict:
    global last_tick
    try:
        simulation.manual_move(request.direction)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    last_tick = time.monotonic()
    return current_state(advance=False)


@app.get("/api/report")
def get_report() -> dict:
    return build_report(simulation)


@app.get("/api/report.csv")
def download_csv() -> Response:
    return Response(
        report_csv_bytes(simulation),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="aquainspect3d-inspection-report.csv"'},
    )


@app.get("/api/report.pdf")
def download_pdf() -> Response:
    return Response(
        report_pdf_bytes(simulation),
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="aquainspect3d-inspection-report.pdf"'},
    )


def _analyze_image(image: np.ndarray, name: str, profile: str = "visibility") -> dict:
    if profile not in ENHANCEMENT_PROFILES:
        raise HTTPException(status_code=422, detail="Choose a supported image-enhancement profile.")
    enhanced = enhance_image(image, profile)
    success, encoded = cv2.imencode(".jpg", enhanced, [cv2.IMWRITE_JPEG_QUALITY, 88])
    if not success:
        raise HTTPException(status_code=500, detail="Could not encode the enhanced inspection image.")
    return {
        "name": name,
        "width": int(image.shape[1]),
        "height": int(image.shape[0]),
        "enhanced_image": base64.b64encode(encoded.tobytes()).decode("ascii"),
        "profile": profile,
        "candidates": find_image_candidates(image),
        "source": "OpenCV heuristic; candidates are not AI model predictions",
    }


@app.post("/api/vision/sample")
def analyze_sample(request: SampleRequest) -> dict:
    if request.defect_type not in SAMPLE_DEFECTS:
        raise HTTPException(status_code=422, detail="Select a supported sample defect scenario.")
    return _analyze_image(
        generate_sample_image(request.defect_type),
        f"Simulated sample: {request.defect_type}",
        request.profile,
    )


@app.post("/api/vision/upload")
async def analyze_upload(
    file: UploadFile = File(...),
    profile: str = Form("visibility"),
) -> dict:
    content = await file.read(MAX_IMAGE_BYTES + 1)
    if len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Images must be 10 MB or smaller.")
    image = cv2.imdecode(np.frombuffer(content, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=415, detail="Unsupported or invalid image. Upload a PNG or JPEG.")
    try:
        return _analyze_image(image, file.filename or "Uploaded inspection image", profile)
    except (cv2.error, ValueError) as error:
        raise HTTPException(status_code=422, detail=f"Image analysis failed: {error}") from error


@app.post("/api/vision/enhance-frame")
async def enhance_video_frame(
    file: UploadFile = File(...),
    profile: str = Form("visibility"),
) -> dict:
    content = await file.read(MAX_IMAGE_BYTES + 1)
    if len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Video frames must be 10 MB or smaller.")
    image = cv2.imdecode(np.frombuffer(content, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=415, detail="Unsupported video frame. Upload a PNG or JPEG frame.")
    try:
        return _analyze_image(image, "Simulated ROV video frame", profile)
    except (cv2.error, ValueError) as error:
        raise HTTPException(status_code=422, detail=f"Video-frame enhancement failed: {error}") from error

