# AQUAINSPECT 3D

An offline-first autonomous underwater dam-inspection **simulation**. The browser dashboard uses Three.js on WebGL2 for a procedural, interactive 3D ROV and dam; a local FastAPI service runs the Python navigation, simulated telemetry, image-processing, and report logic.

> **Simulation boundary:** The app does not control a physical vehicle or provide real sonar, camera, structural, or communication measurements. Findings, sonar returns, telemetry, and link events are synthetic. Uploaded-image candidates are OpenCV heuristics—not AI model predictions.

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
- **Mission controls:** pick a dam section and inspection depth; start, pause, resume, return to surface, or reset. A* routes around simulated obstacles.
- **Data analytics:** coverage and battery timelines, finding-severity summaries, and coordinates plotted along the dam face.
- **Final report:** completed mission summary, telemetry, recorded findings, locally bundled real-world dam reference photographs, and CSV/PDF downloads. Reference photographs are not scan footage.
- **Image inspection:** generate a demonstration scenario or upload a PNG/JPEG for OpenCV enhancement and heuristic candidate regions.
- **Low visibility:** degrades the simulated camera while sonar-based simulated obstacle returns stay available.

The Three.js and Chart.js dependencies are bundled into `static/assets/app.js`; photographs are stored locally, so the browser does not need a third-party CDN. The dashboard requires a browser and graphics driver with WebGL2 support.

## Dam photograph credits

- **Alum Creek Dam spillway**, Ohio — Sixflashphoto, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), [Wikimedia Commons source](https://commons.wikimedia.org/wiki/File:Alum_Creek_Dam_Spillway_1.jpg).
- **Idukki Dam reservoir panorama**, Kerala — Timothy A. Gonsalves (Tagooty), [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), [Wikimedia Commons source](https://commons.wikimedia.org/wiki/File:Idukki_Dam_Reservoir_Hillview_Pano_Kerala_Mar22_R16_05581-Pano.jpg).

## Project layout

- `app.py` — FastAPI local API and static dashboard server.
- `simulation.py` — A* navigation, vehicle state, and simulated sensor data.
- `reporting.py` — CSV/PDF reports, including attributed reference photographs.
- `vision.py` — OpenCV enhancement, generated images, heuristics, and optional local YOLO inference.
- `web/src/main.js` — Three.js WebGL2 scene, controls, telemetry, charts, and browser interactions.
- `static/index.html`, `static/styles.css` — responsive dashboard and styling.
- `static/images/` — locally bundled, attributed dam photographs.

## Tests

```powershell
python -m unittest discover -s tests -v
```

## Optional YOLO inference

YOLO is not required for the offline demonstration. To enable inference with weights you already trust, install `ultralytics` separately and connect the model through your own backend integration; the dashboard never downloads model weights automatically.
