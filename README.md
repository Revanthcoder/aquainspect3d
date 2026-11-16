# AQUAINSPECT 3D

An offline-first autonomous underwater dam-inspection **simulation**. The browser dashboard uses Three.js on WebGL2 for a procedural, interactive 3D ROV and dam; a local FastAPI service runs the Python navigation, simulated telemetry, image-processing, and report logic.

> **Simulation boundary:** The app does not control a physical vehicle or provide real sonar, camera, structural, or communication measurements. Findings, sonar returns, telemetry, and link events are synthetic. Uploaded-image candidates are OpenCV heuristics—not AI model predictions.

The video preview is procedural, not a live underwater camera. Tethered/acoustic bandwidth, latency, quality, and delivery behavior are illustrative simulation values; actual link reliability depends on physical hardware and operating conditions.

## Run on Windows

Requires Python 3.10+ and Node.js 18+ for the frontend bundle.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
npm install
npm run build
python -m uvicorn app:app --reload
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). Stop the server with **Ctrl+C**. Once dependencies and the frontend bundle have been installed/built, the simulation, reference-photo gallery, reports, and visualizer run locally without API keys or internet access. If PowerShell blocks activation, use `.venv\Scripts\python.exe -m pip install -r requirements.txt` instead of activating the environment.

## Dashboard

- **Live mission:** full-width WebGL2 scene, camera orbit/pan/zoom, assembled ROV components, animated sonar sweep, obstacles, findings, route history, and live telemetry.
- **Manual ROV controls:** use the directional pad or arrow keys to move horizontally and change depth; use Toward/Away or W/S to adjust wall distance. Moves are interpolated and obstacle-aware.
- **Sonar alerts:** new simulated obstacles trigger a blinking red alert and an optional browser-generated sound, which can be muted.
- **Turbidity and visibility:** select clear water, suspended silt, or heavy mud. The simulated camera view and 3D water haze adapt to turbidity; sonar obstacle returns remain available.
- **Adaptive imaging handoff:** clear water selects camera-primary inspection, silt enables camera/sonar fusion, and heavy mud or the low-visibility override switches inspection to sonar-primary. The active mode and simulated detection source are shown in telemetry and reports.
- **Risk-aware digital twin:** clickable 3D risk markers distinguish unscanned sample scenarios from findings recorded by the simulated mission. A severity/type-weighted, 0–100 triage index ranks dam sections and lets the operator select a follow-up mission.
- **Theme control:** switch between dark and light dashboard themes; the selected theme is saved in this browser.
- **Live ROV video:** a locally generated camera preview responds to vehicle position and visibility. Tethered mode models a high-rate stream, while acoustic mode models a compressed low-frame-rate preview. Optional OpenCV enhancement processes frames locally.
- **Adaptive image enhancement:** apply visibility recovery/denoising, low-light gamma lift, or color-cast correction to a sample, uploaded image, or simulated video frame.
- **Land-station communications:** monitor simulated link state, acknowledgement packets, quality, latency, throughput, and video status for tethered and acoustic modes. Acoustic interruptions and recovery are shown as simulation events.
- **Mission controls:** pick a dam section and inspection depth; start, pause, resume, return to surface, or reset. A* routes around simulated obstacles.
- **Dam geometry:** a curved, textured concrete face with buttresses, structural relief, intake grilles, terrain, and inspection details.
- **Data analytics:** coverage and battery timelines, finding-severity summaries, and coordinates plotted along the dam face.
- **Final report:** completed mission summary, telemetry, recorded findings, locally bundled real-world dam reference photographs, and CSV/PDF downloads. Reference photographs are not scan footage.
- **Image inspection:** generate a demonstration scenario or upload a PNG/JPEG for OpenCV enhancement and heuristic candidate regions.
- **Low visibility:** degrades the simulated camera while sonar-based simulated obstacle returns stay available.

Risk indices and inspection priorities are illustrative simulation outputs. They are not engineering assessments, calibrated probability-of-failure scores, or real structural measurements.

The Three.js and Chart.js dependencies are bundled into `static/assets/app.js`; photographs are stored locally, so the browser does not need a third-party CDN. The dashboard requires a browser and graphics driver with WebGL2 support.

## Dam photograph credits

- **Alum Creek Dam spillway**, Ohio — Sixflashphoto, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), [Wikimedia Commons source](https://commons.wikimedia.org/wiki/File:Alum_Creek_Dam_Spillway_1.jpg).
- **Idukki Dam reservoir panorama**, Kerala — Timothy A. Gonsalves (Tagooty), [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), [Wikimedia Commons source](https://commons.wikimedia.org/wiki/File:Idukki_Dam_Reservoir_Hillview_Pano_Kerala_Mar22_R16_05581-Pano.jpg).

## Project layout

- `app.py` — FastAPI local API and static dashboard server.
- `simulation.py` — A* navigation, vehicle state, and simulated sensor data.
- `reporting.py` — CSV/PDF reports, including attributed reference photographs.
- `vision.py` — OpenCV enhancement profiles, generated images, heuristics, and optional local YOLO inference.
- `web/src/main.js` — Three.js WebGL2 scene, controls, telemetry, charts, and browser interactions.
- `static/index.html`, `static/styles.css` — responsive dashboard and styling.
- `static/images/` — locally bundled, attributed dam photographs.

## Tests

```powershell
python -m unittest discover -s tests -v
```

## Optional YOLO inference

YOLO is not required for the offline demonstration. To enable inference with weights you already trust, install `ultralytics` separately and connect the model through your own backend integration; the dashboard never downloads model weights automatically.
