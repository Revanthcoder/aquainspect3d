import unittest

import numpy as np

from reporting import report_csv_bytes, report_pdf_bytes
from simulation import Simulation, create_scene, plan_path
from vision import enhance_image, find_image_candidates, generate_sample_image


class NavigationTests(unittest.TestCase):
    def test_every_mission_section_plans_without_route_endpoint_collision(self):
        for section in ("Full Dam Survey", "Left Section", "Center Section", "Right Section"):
            with self.subTest(section=section):
                simulation = Simulation()
                simulation.start_mission([section], inspection_depth=12)
                self.assertGreater(len(simulation.planned_route), 1)

    def test_astar_routes_around_obstacle(self):
        obstacle = (-3.0, 2.0, 12.0, 1.2)
        route = plan_path((-6, 2, 12), (0, 2, 12), [obstacle], clearance=0.8)
        self.assertEqual(route[0], (-6, 2, 12))
        self.assertEqual(route[-1], (0, 2, 12))
        for point in route:
            distance = np.linalg.norm(np.asarray(point) - np.asarray(obstacle[:3]))
            self.assertGreater(distance, obstacle[3] + 0.8)

    def test_mission_moves_interpolatively_and_detects_scripted_defects(self):
        simulation = Simulation()
        simulation.start_mission(["Full Dam Survey"], inspection_depth=12)
        self.assertGreater(simulation.telemetry["planned_distance"], 0)
        self.assertEqual(simulation.telemetry["distance_traveled"], 0)
        start = simulation.position.copy()
        simulation.step(0.25)
        self.assertGreater(np.linalg.norm(simulation.position - start), 0)
        self.assertLessEqual(np.linalg.norm(simulation.position - start), 0.9 * 0.25 + 1e-8)

        for _ in range(400):
            simulation.step(1.0)
            if simulation.status == "Completed":
                break

        self.assertEqual(simulation.status, "Completed")
        self.assertAlmostEqual(
            simulation.telemetry["distance_traveled"],
            simulation.telemetry["planned_distance"],
            places=5,
        )
        self.assertLess(np.linalg.norm(simulation.position - simulation.start), 0.1)
        self.assertEqual(len(simulation.detected_defects), len(simulation.defect_scenarios))
        self.assertTrue(all(item["confidence"] is None for item in simulation.detected_defects))

    def test_restarting_a_stopped_mission_keeps_current_position(self):
        simulation = Simulation()
        simulation.start_mission(["Left Section"], inspection_depth=12)
        simulation.step(0.5)
        position_before_restart = simulation.position.copy()
        simulation.stop()

        simulation.start_mission(["Center Section"], inspection_depth=14)

        np.testing.assert_allclose(simulation.position, position_before_restart)
        self.assertEqual(simulation.planned_route[0], tuple(int(round(value)) for value in position_before_restart))
        simulation.step(0.1)
        self.assertLessEqual(np.linalg.norm(simulation.position - position_before_restart), 0.09 + 1e-8)

    def test_sonar_returns_remain_available_in_low_visibility(self):
        simulation = Simulation()
        simulation.low_visibility = True
        simulation.step(0)
        self.assertEqual(simulation.telemetry["camera"], "Very low visibility")
        self.assertEqual(simulation.telemetry["sonar"], "Scanning")

    def test_muddy_water_reduces_camera_visibility_without_affecting_sonar(self):
        simulation = Simulation()
        simulation.set_water_condition("Silt")
        self.assertEqual(simulation.telemetry["camera"], "Reduced visibility")
        self.assertGreater(simulation.telemetry["visibility_obscuration"], 0.3)
        simulation.set_water_condition("Heavy mud")
        self.assertEqual(simulation.telemetry["camera"], "Very low visibility")
        self.assertGreater(simulation.telemetry["visibility_obscuration"], 0.7)
        self.assertEqual(simulation.telemetry["sonar"], "Scanning")
        with self.assertRaisesRegex(ValueError, "Water condition"):
            simulation.set_water_condition("Unknown")

    def test_adaptive_imaging_switches_with_visibility_and_keeps_sonar_available(self):
        simulation = Simulation()
        self.assertEqual(simulation.telemetry["imaging_mode"], "Camera-primary")
        simulation.set_water_condition("Silt")
        self.assertEqual(simulation.telemetry["imaging_mode"], "Camera + sonar fusion")
        simulation.set_water_condition("Heavy mud")
        self.assertEqual(simulation.telemetry["imaging_mode"], "Sonar-primary")
        simulation.set_water_condition("Clear")
        simulation.low_visibility = True
        self.assertEqual(simulation.telemetry["imaging_mode"], "Sonar-primary")
        self.assertEqual(simulation.telemetry["sonar"], "Scanning")

    def test_sonar_primary_inspection_records_method_and_risk_for_sample_finding(self):
        simulation = Simulation()
        simulation.set_water_condition("Heavy mud")
        simulation.position = np.array([-9.0, 3.8, 12.0])
        simulation._scan_for_defects()
        self.assertEqual(len(simulation.detected_defects), 1)
        finding = simulation.detected_defects[0]
        self.assertEqual(finding["id"], "SIM-CR-01")
        self.assertEqual(finding["risk_score"], 82)
        self.assertEqual(finding["detection_method"], "Simulated sonar anomaly classification")

    def test_risk_priorities_are_weighted_and_rise_for_recorded_scenarios(self):
        simulation = Simulation()
        initial = simulation.prioritized_missions()
        self.assertEqual([item["section"] for item in initial], ["Right Section", "Left Section", "Center Section"])
        self.assertEqual([item["risk_score"] for item in initial], [86, 82, 54])
        simulation.detected_defects.append({"id": "SIM-CR-01"})
        updated = simulation.prioritized_missions()
        self.assertEqual(updated[0]["section"], "Left Section")
        self.assertEqual(updated[0]["risk_score"], 87)
        self.assertIn("simulated finding", updated[0]["reason"])

    def test_tethered_link_remains_connected_with_high_simulated_capacity(self):
        simulation = Simulation()
        simulation.start_mission(["Left Section"])
        for _ in range(50):
            simulation.step(1)
        self.assertTrue(simulation.communication_connected)
        self.assertEqual(simulation.telemetry["link_quality"], 99.9)
        self.assertEqual(simulation.telemetry["link_bandwidth_kbps"], 8000)
        self.assertEqual(simulation.telemetry["video_fps"], 24)

    def test_acoustic_link_interrupts_and_recovers(self):
        simulation = Simulation()
        simulation.set_communication_mode("Acoustic")
        simulation.start_mission(["Left Section"], inspection_depth=12)
        for _ in range(24):
            simulation.step(1)
        self.assertFalse(simulation.communication_connected)
        for _ in range(4):
            simulation.step(1)
        self.assertTrue(simulation.communication_connected)
        self.assertEqual(len(simulation.communication_events), 2)

    def test_idle_simulation_does_not_transmit_mission_packets(self):
        simulation = Simulation()
        for _ in range(5):
            simulation.step(1)
        self.assertEqual(simulation.packet_count, 0)
        self.assertTrue(simulation.communication_connected)
        self.assertEqual(simulation.communication_events, [])

    def test_manual_moves_interpolate_in_all_three_axes(self):
        expected_positions = {
            "left": (-15.0, 4.0, 3.0),
            "right": (-13.0, 4.0, 3.0),
            "up": (-14.0, 4.0, 2.0),
            "down": (-14.0, 4.0, 4.0),
            "toward": (-14.0, 3.0, 3.0),
            "away": (-14.0, 5.0, 3.0),
        }
        for direction, expected in expected_positions.items():
            with self.subTest(direction=direction):
                simulation = Simulation()
                simulation.manual_move(direction)
                self.assertEqual(simulation.status, "Manual control")
                self.assertEqual(simulation.telemetry["thrusters"], "Active")
                self.assertEqual(simulation.mission_progress, 0)
                start = simulation.position.copy()
                simulation.step(0.25)
                self.assertGreater(np.linalg.norm(simulation.position - start), 0)
                self.assertLessEqual(np.linalg.norm(simulation.position - start), 0.9 * 0.25 + 1e-8)
                for _ in range(10):
                    simulation.step(0.25)
                np.testing.assert_allclose(simulation.position, expected)
                self.assertFalse(simulation.manual_move_active)

    def test_manual_move_rejects_obstacle_collision_and_world_boundary(self):
        simulation = Simulation()
        simulation.position = np.array([-6.0, 2.0, 12.0])
        with self.assertRaisesRegex(ValueError, "intersects an obstacle"):
            simulation.manual_move("right")

        simulation = Simulation()
        simulation.position = np.array([18.0, 4.0, 3.0])
        with self.assertRaisesRegex(ValueError, "navigation bounds"):
            simulation.manual_move("right")

    def test_manual_move_rejects_unknown_direction(self):
        with self.assertRaisesRegex(ValueError, "Unknown manual direction"):
            Simulation().manual_move("diagonal")


class VisualizationAndReportTests(unittest.TestCase):
    def test_scene_contains_separate_rov_meshes_and_dam_environment(self):
        figure = create_scene(Simulation())
        names = {trace.name for trace in figure.data}
        self.assertIn("Pressure-rated ROV chassis", names)
        self.assertIn("Horizontal thruster", names)
        self.assertIn("Front inspection camera housing", names)
        self.assertIn("Forward sonar transducer", names)
        self.assertIn("Reinforced concrete dam wall", names)
        self.assertNotIn("Actual travelled path", names)

    def test_sample_image_processing_and_report_exports(self):
        image = generate_sample_image("Crack")
        enhanced = enhance_image(image)
        self.assertEqual(enhanced.shape, image.shape)
        enhanced_profiles = []
        for profile in ("visibility", "low-light", "color-correct"):
            with self.subTest(profile=profile):
                result = enhance_image(image, profile)
                self.assertEqual(result.shape, image.shape)
                self.assertEqual(result.dtype, image.dtype)
                self.assertFalse(np.array_equal(result, image))
                enhanced_profiles.append(result)
        self.assertFalse(np.array_equal(enhanced_profiles[0], enhanced_profiles[1]))
        self.assertFalse(np.array_equal(enhanced_profiles[0], enhanced_profiles[2]))
        with self.assertRaisesRegex(ValueError, "Unknown enhancement profile"):
            enhance_image(image, "unsupported")
        self.assertIsInstance(find_image_candidates(image), list)

        simulation = Simulation()
        csv_report = report_csv_bytes(simulation)
        pdf_report = report_pdf_bytes(simulation)
        self.assertIn(b"AQUAINSPECT 3D", csv_report)
        self.assertIn(b"Adaptive imaging mode,Camera-primary", csv_report)
        self.assertIn(b"Follow-up mission priority", csv_report)
        self.assertTrue(pdf_report.startswith(b"%PDF"))


if __name__ == "__main__":
    unittest.main()
