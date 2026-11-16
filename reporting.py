"""CSV and PDF report generation for the offline inspection simulation."""

from __future__ import annotations

import csv
from io import BytesIO, StringIO
from pathlib import Path
from typing import Any

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    Paragraph,
    Image as ReportImage,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from simulation import Simulation


def build_report(simulation: Simulation) -> dict[str, Any]:
    telemetry = simulation.telemetry
    return {
        "mission_status": simulation.status,
        "sections": simulation.mission_sections,
        "inspection_depth_m": simulation.inspection_depth,
        "coverage_percent": round(simulation.mission_progress, 1),
        "planned_distance_m": round(simulation.route_length, 1),
        "distance_traveled_m": round(simulation.distance_traveled, 1),
        "defects": list(simulation.detected_defects),
        "obstacles_detected": list(simulation.sonar_obstacles),
        "telemetry": telemetry,
        "communication_events": list(simulation.communication_events),
        "mission_priorities": simulation.prioritized_missions(),
    }


def report_csv_bytes(simulation: Simulation) -> bytes:
    report = build_report(simulation)
    buffer = StringIO(newline="")
    writer = csv.writer(buffer)
    writer.writerow(("AQUAINSPECT 3D SIMULATED INSPECTION REPORT",))
    writer.writerow(("Mission status", report["mission_status"]))
    writer.writerow(("Sections", "; ".join(report["sections"]) or "Not selected"))
    writer.writerow(("Inspection depth (m)", report["inspection_depth_m"]))
    writer.writerow(("Coverage (%)", report["coverage_percent"]))
    writer.writerow(("Planned distance (m)", report["planned_distance_m"]))
    writer.writerow(("Distance traveled (m)", report["distance_traveled_m"]))
    writer.writerow(("Robot position X/Y/Z (m)", f"{report['telemetry']['x']:.2f}/{report['telemetry']['y']:.2f}/{report['telemetry']['z']:.2f}"))
    writer.writerow(("Battery (%)", f"{report['telemetry']['battery']:.1f}"))
    writer.writerow(("Water condition", report["telemetry"]["water_condition"]))
    writer.writerow(("Adaptive imaging mode", report["telemetry"]["imaging_mode"]))
    writer.writerow(())
    writer.writerow(("Defect ID", "Type", "X (m)", "Y (m)", "Z (m)", "Severity", "Risk score", "Detection method", "Confidence", "Source", "Timestamp"))
    for defect in report["defects"]:
        x, y, z = defect["location"]
        writer.writerow(
            (
                defect["id"], defect["type"], x, y, z, defect["severity"], defect["risk_score"],
                defect.get("detection_method", "Simulated"),
                defect["confidence"] if defect["confidence"] is not None else "N/A (simulated)",
                defect["source"], defect["timestamp"],
            )
        )
    writer.writerow(())
    writer.writerow(("Obstacle ID", "X (m)", "Y (m)", "Z (m)", "Range (m)"))
    for obstacle in report["obstacles_detected"]:
        writer.writerow((obstacle["id"], obstacle["x"], obstacle["y"], obstacle["z"], round(obstacle["distance"], 2)))
    writer.writerow(())
    writer.writerow(("Follow-up mission priority", "Risk index", "Recorded findings", "Recommendation"))
    for priority in report["mission_priorities"]:
        writer.writerow((priority["section"], priority["risk_score"], priority["finding_count"], priority["reason"]))
    return buffer.getvalue().encode("utf-8-sig")


def report_pdf_bytes(simulation: Simulation) -> bytes:
    report = build_report(simulation)
    buffer = BytesIO()
    document = SimpleDocTemplate(
        buffer,
        pagesize=landscape(A4),
        rightMargin=15 * mm,
        leftMargin=15 * mm,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        title="AQUAINSPECT 3D Inspection Report",
    )
    styles = getSampleStyleSheet()
    photo_caption_style = ParagraphStyle(
        "PhotoCaption",
        parent=styles["BodyText"],
        fontSize=8,
        leading=10,
        textColor=colors.HexColor("#405c66"),
    )
    story = [
        Paragraph("AQUAINSPECT 3D — Inspection Report", styles["Title"]),
        Paragraph(
            "Offline simulation output. Defect locations and sonar returns are simulated; "
            "they are not measurements from a physical robot.",
            styles["BodyText"],
        ),
        Spacer(1, 8 * mm),
    ]
    telemetry = report["telemetry"]
    summary = [
        ["Mission status", report["mission_status"], "Coverage", f"{report['coverage_percent']:.1f}%"],
        ["Sections", ", ".join(report["sections"]) or "Not selected", "Inspection depth", f"{report['inspection_depth_m']} m"],
        ["Distance traveled", f"{report['distance_traveled_m']:.1f} m", "Planned distance", f"{report['planned_distance_m']:.1f} m"],
        ["Robot position (X, Y, Z)", f"{telemetry['x']:.1f}, {telemetry['y']:.1f}, {telemetry['z']:.1f} m", "Battery", f"{telemetry['battery']:.1f}%"],
        ["Water condition", telemetry["water_condition"], "Adaptive sensor", telemetry["imaging_mode"]],
    ]
    story.extend(
        [
            Paragraph("Mission summary", styles["Heading2"]),
            Table(summary, colWidths=[43 * mm, 78 * mm, 36 * mm, 52 * mm], style=TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#EAF4F6")),
                ("TEXTCOLOR", (0, 0), (-1, -1), colors.HexColor("#123340")),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#A8C4CC")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("PADDING", (0, 0), (-1, -1), 6),
            ])),
            Spacer(1, 6 * mm),
            Paragraph(f"Detected defects ({len(report['defects'])})", styles["Heading2"]),
        ]
    )
    defect_rows = [["ID", "Type", "X / Y / Z (m)", "Severity", "Risk", "Detection method", "Timestamp"]]
    for defect in report["defects"]:
        x, y, z = defect["location"]
        defect_rows.append(
            [
                defect["id"], defect["type"], f"{x:.1f} / {y:.1f} / {z:.1f}",
                defect["severity"], f"{defect['risk_score']}/100",
                defect.get("detection_method", "Simulated"), defect["timestamp"],
            ]
        )
    if len(defect_rows) == 1:
        defect_rows.append(["—", "No defects recorded", "—", "—", "—", "—", "—"])
    story.append(Table(defect_rows, repeatRows=1, style=TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#123F52")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#A8C4CC")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F2F7F8")]),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("PADDING", (0, 0), (-1, -1), 5),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ])))
    story.extend([Spacer(1, 6 * mm), Paragraph(f"Sonar obstacle returns in range ({len(report['obstacles_detected'])})", styles["Heading2"])])
    obstacle_rows = [["ID", "X (m)", "Y (m)", "Z (m)", "Range (m)"]]
    obstacle_rows.extend(
        [[item["id"], f"{item['x']:.1f}", f"{item['y']:.1f}", f"{item['z']:.1f}", f"{item['distance']:.1f}"] for item in report["obstacles_detected"]]
    )
    if len(obstacle_rows) == 1:
        obstacle_rows.append(["—", "—", "—", "—", "No returns in current range"])
    story.append(Table(obstacle_rows, repeatRows=1, style=TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#123F52")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#A8C4CC")),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("PADDING", (0, 0), (-1, -1), 5),
    ])))
    story.extend(
        [
            Spacer(1, 6 * mm),
            Paragraph("Prioritized follow-up inspection missions", styles["Heading2"]),
            Paragraph(
                "Risk index is a simulated severity/type-weighted triage aid, not an engineering assessment.",
                styles["BodyText"],
            ),
        ]
    )
    priority_rows = [["Rank", "Dam section", "Risk index", "Scenario", "Recorded findings", "Recommendation"]]
    priority_rows.extend(
        [
            [index, item["section"], f"{item['risk_score']}/100", item["highest_risk_scenario"], item["finding_count"], item["reason"]]
            for index, item in enumerate(report["mission_priorities"], start=1)
        ]
    )
    story.append(Table(priority_rows, repeatRows=1, style=TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#123F52")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#A8C4CC")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F2F7F8")]),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("PADDING", (0, 0), (-1, -1), 5),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ])))
    image_directory = Path(__file__).resolve().parent / "static" / "images"
    reference_photos = [
        (
            image_directory / "alum-creek-dam.jpg",
            "Alum Creek Dam spillway, Ohio · Sixflashphoto · CC BY-SA 4.0",
        ),
        (
            image_directory / "idukki-reservoir.jpg",
            "Idukki Dam reservoir, Kerala · Timothy A. Gonsalves (Tagooty) · CC BY-SA 4.0",
        ),
    ]
    photo_cells = []
    for image_path, caption in reference_photos:
        if image_path.is_file():
            image = ReportImage(str(image_path), width=100 * mm, height=48 * mm, kind="proportional")
            photo_cells.append([image, Paragraph(caption, photo_caption_style)])
    if photo_cells:
        story.extend(
            [
                Spacer(1, 6 * mm),
                Paragraph("Real-world dam context references", styles["Heading2"]),
                Paragraph(
                    "Reference photographs for visual context only; these images were not captured during this simulated mission.",
                    styles["BodyText"],
                ),
                Spacer(1, 2 * mm),
                Table(
                    [photo_cells],
                    colWidths=[121 * mm] * len(photo_cells),
                    style=TableStyle([
                        ("VALIGN", (0, 0), (-1, -1), "TOP"),
                        ("LEFTPADDING", (0, 0), (-1, -1), 3),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
                        ("TOPPADDING", (0, 0), (-1, -1), 3),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                    ]),
                ),
            ]
        )
    document.build(story)
    return buffer.getvalue()
