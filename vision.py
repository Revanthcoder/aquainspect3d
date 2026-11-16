"""Local OpenCV inspection-image enhancement and optional model inference."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

import cv2
import numpy as np


SAMPLE_DEFECTS = ("Crack", "Concrete erosion", "Water leakage", "Surface damage")
ENHANCEMENT_PROFILES = ("visibility", "low-light", "color-correct")


def generate_sample_image(defect_type: str, seed: int = 7) -> np.ndarray:
    """Generate a deterministic synthetic concrete inspection image (BGR)."""
    if defect_type not in SAMPLE_DEFECTS:
        raise ValueError(f"Unknown sample defect type: {defect_type}")
    rng = np.random.default_rng(seed)
    height, width = 300, 480
    texture = rng.normal(0, 13, (height, width, 1)).astype(np.int16)
    base = np.full((height, width, 3), (100, 113, 120), dtype=np.int16)
    image = np.clip(base + texture, 0, 255).astype(np.uint8)
    for _ in range(24):
        x, y = int(rng.integers(0, width)), int(rng.integers(0, height))
        radius = int(rng.integers(2, 10))
        shade = int(rng.integers(76, 148))
        cv2.circle(image, (x, y), radius, (shade, shade + 4, shade + 7), -1, cv2.LINE_AA)

    if defect_type == "Crack":
        points = [(90, 45), (155, 95), (145, 145), (220, 182), (205, 235), (285, 265)]
        for start, end in zip(points, points[1:]):
            cv2.line(image, start, end, (30, 32, 34), 4, cv2.LINE_AA)
            cv2.line(image, (start[0] + 4, start[1]), (end[0] + 4, end[1]), (60, 62, 64), 1, cv2.LINE_AA)
    elif defect_type == "Concrete erosion":
        cv2.ellipse(image, (260, 160), (95, 60), -18, 0, 360, (70, 76, 80), -1, cv2.LINE_AA)
        for _ in range(100):
            x = int(rng.integers(170, 350))
            y = int(rng.integers(100, 225))
            cv2.circle(image, (x, y), int(rng.integers(1, 4)), (42, 49, 52), -1)
    elif defect_type == "Water leakage":
        cv2.ellipse(image, (300, 160), (58, 105), 15, 0, 360, (138, 106, 74), -1, cv2.LINE_AA)
        for point in ((274, 242), (314, 254), (337, 272)):
            cv2.circle(image, point, 7, (194, 179, 150), -1, cv2.LINE_AA)
    else:
        cv2.rectangle(image, (185, 90), (305, 210), (52, 57, 60), -1)
        cv2.rectangle(image, (196, 101), (294, 199), (75, 79, 81), 3)
        cv2.line(image, (180, 218), (320, 218), (40, 43, 45), 5, cv2.LINE_AA)
    return image


def enhance_image(image: np.ndarray, profile: str = "visibility") -> np.ndarray:
    """Apply an offline OpenCV enhancement profile to a three-channel BGR image."""
    if image is None or image.ndim != 3 or image.shape[2] != 3:
        raise ValueError("Expected a valid three-channel BGR image.")
    if profile not in ENHANCEMENT_PROFILES:
        raise ValueError(f"Unknown enhancement profile: {profile}")

    working = image
    if profile == "low-light":
        gamma = 0.62
        lookup = np.array([((value / 255.0) ** gamma) * 255 for value in range(256)], dtype=np.uint8)
        working = cv2.LUT(image, lookup)

    lab = cv2.cvtColor(working, cv2.COLOR_BGR2LAB)
    lightness, a_channel, b_channel = cv2.split(lab)
    clip_limit = 3.0 if profile == "low-light" else 2.2
    clahe = cv2.createCLAHE(clipLimit=clip_limit, tileGridSize=(8, 8))
    enhanced = cv2.merge((clahe.apply(lightness), a_channel, b_channel))
    enhanced_bgr = cv2.cvtColor(enhanced, cv2.COLOR_LAB2BGR)

    if profile in ("visibility", "color-correct"):
        channels = cv2.split(enhanced_bgr.astype(np.float32))
        means = [float(np.mean(channel)) for channel in channels]
        target = sum(means) / 3.0
        corrected = cv2.merge([
            np.clip(channel * min(1.35, max(0.75, target / max(mean, 1.0))), 0, 255)
            for channel, mean in zip(channels, means)
        ]).astype(np.uint8)
        blend = 0.72 if profile == "color-correct" else 0.48
        enhanced_bgr = cv2.addWeighted(enhanced_bgr, 1 - blend, corrected, blend, 0)

    if profile == "visibility":
        enhanced_bgr = cv2.fastNlMeansDenoisingColored(enhanced_bgr, None, 3, 3, 7, 21)
    return enhanced_bgr


def find_image_candidates(image: np.ndarray) -> list[dict[str, Any]]:
    """Return heuristic dark-region candidates; these are not model predictions."""
    enhanced = enhance_image(image)
    gray = cv2.cvtColor(enhanced, cv2.COLOR_BGR2GRAY)
    blackhat = cv2.morphologyEx(
        gray, cv2.MORPH_BLACKHAT, cv2.getStructuringElement(cv2.MORPH_RECT, (17, 17))
    )
    _, mask = cv2.threshold(blackhat, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates = []
    for contour in contours:
        area = float(cv2.contourArea(contour))
        if area < 18:
            continue
        x, y, width, height = cv2.boundingRect(contour)
        aspect = max(width, height) / max(1, min(width, height))
        candidate_type = "Crack-like region" if aspect >= 3.0 else "Surface anomaly"
        candidates.append(
            {
                "type": candidate_type,
                "box": [int(x), int(y), int(width), int(height)],
                "area_px": round(area, 1),
                "source": "OpenCV heuristic (not an AI model prediction)",
            }
        )
    return sorted(candidates, key=lambda item: item["area_px"], reverse=True)[:20]


def predict_with_yolo(
    image: np.ndarray,
    model_path: str,
    confidence_threshold: float = 0.35,
) -> list[dict[str, Any]]:
    """Run an explicitly selected local Ultralytics YOLO weights file, if installed."""
    path = Path(model_path).expanduser()
    if not path.is_file():
        raise FileNotFoundError(f"YOLO weights file does not exist: {path}")
    if importlib.util.find_spec("ultralytics") is None:
        raise RuntimeError("Optional YOLO inference requires the ultralytics package.")
    from ultralytics import YOLO

    model = YOLO(str(path))
    result = model.predict(source=cv2.cvtColor(image, cv2.COLOR_BGR2RGB), conf=confidence_threshold, verbose=False)[0]
    predictions = []
    if result.boxes is None:
        return predictions
    names = result.names
    for box in result.boxes:
        class_id = int(box.cls.item())
        coordinates = [int(value) for value in box.xyxy[0].tolist()]
        predictions.append(
            {
                "type": str(names[class_id]),
                "confidence": round(float(box.conf.item()), 4),
                "box_xyxy": coordinates,
                "source": "YOLO model prediction",
            }
        )
    return predictions
