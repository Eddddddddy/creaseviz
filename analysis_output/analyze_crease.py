#!/usr/bin/env python3
"""Reproducible analysis for the fold-crease STL/ZAG measurement files.

The script uses only NumPy, Pillow, and the Python standard library.  It:
1. validates both binary STL files;
2. confirms that the solid STL contains the supplied top surface;
3. reads XY/Z calibration and capture timestamps from the ZAG archive;
4. reconstructs a sparse calibrated height grid from the surface STL;
5. measures depth, FWHM width, symmetry, area, and along-fold stability;
6. writes compact CSV/JSON evidence and two PNG figures.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import struct
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


OUTPUT = Path(__file__).resolve().parent

STL_DTYPE = np.dtype(
    [
        ("normal", "<f4", (3,)),
        ("vertices", "<f4", (3, 3)),
        ("attribute", "<u2"),
    ]
)

PRIMARY_SHOULDER_BANDS_MM = (0.5, 2.5, 18.0, 20.0)
SENSITIVITY_BANDS_MM = [
    (0.0, 2.0, 18.5, 20.5),
    (0.5, 2.5, 18.0, 20.0),
    (0.5, 3.0, 17.5, 19.5),
    (1.0, 3.0, 17.0, 19.0),
    (2.0, 4.0, 16.0, 18.0),
]


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def open_binary_stl(path: Path) -> tuple[np.memmap, dict]:
    size_bytes = path.stat().st_size
    with path.open("rb") as handle:
        header = handle.read(80)
        triangle_count = struct.unpack("<I", handle.read(4))[0]
    expected_size = 84 + 50 * triangle_count
    if expected_size != size_bytes:
        raise ValueError(
            f"{path.name} is not a valid binary STL: expected {expected_size} bytes, got {size_bytes}"
        )
    mesh = np.memmap(
        path,
        mode="r",
        offset=84,
        dtype=STL_DTYPE,
        shape=(triangle_count,),
    )
    return mesh, {
        "path": str(path),
        "size_bytes": size_bytes,
        "triangle_count": triangle_count,
        "binary_stl_size_valid": True,
        "header_ascii": header.decode("ascii", errors="replace").rstrip("\x00"),
    }


def parse_zag_metadata(path: Path) -> dict:
    calibration_xml = None
    capture_names: list[str] = []
    application_version = None
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        for info in infos:
            payload = None
            if info.file_size <= 5000:
                payload = archive.read(info)
            if payload and b"<Calibration>" in payload and calibration_xml is None:
                start = payload.find(b"<?xml")
                calibration_xml = payload[start:].decode("utf-8")
            if payload and info.file_size == 18 and payload.startswith(b"VR-"):
                capture_names.append(payload.decode("ascii"))
            if payload and b"<VersionInformationMap>" in payload:
                text = payload[payload.find(b"<?xml") :].decode("utf-8")
                marker = "<Application>"
                application_version = text.split(marker, 1)[1].split("</Application>", 1)[0]

    if calibration_xml is None:
        raise ValueError("Calibration XML was not found in the ZAG archive")

    xy_pitch_m = float(
        calibration_xml.split("<MeterPerPixel>", 1)[1].split("</MeterPerPixel>", 1)[0]
    )
    z_unit_m = float(
        calibration_xml.split("<MeterPerUnit>", 1)[1].split("</MeterPerUnit>", 1)[0]
    )
    return {
        "archive_path": str(path),
        "zip_entry_count": len(infos),
        "uncompressed_bytes": sum(info.file_size for info in infos),
        "xy_meter_per_pixel": xy_pitch_m,
        "xy_pitch_um": xy_pitch_m * 1e6,
        "z_meter_per_internal_unit": z_unit_m,
        "z_internal_unit_um": z_unit_m * 1e6,
        "capture_names": sorted(set(capture_names)),
        "capture_count": len(set(capture_names)),
        "application_version": application_version,
    }


def stl_extent(mesh: np.memmap) -> dict:
    vertices = mesh["vertices"]
    mins = vertices.min(axis=(0, 1)).astype(float)
    maxs = vertices.max(axis=(0, 1)).astype(float)
    return {
        "min_mm": mins.tolist(),
        "max_mm": maxs.tolist(),
        "range_mm": (maxs - mins).tolist(),
    }


def classify_solid_mesh(solid_mesh: np.memmap, surface_triangle_count: int) -> dict:
    vertices_z = solid_mesh["vertices"][:, :, 2]
    base_z = float(vertices_z.min())
    on_base = np.isclose(vertices_z, base_z, atol=1e-6)
    bottom_triangles = int(np.all(on_base, axis=1).sum())
    triangles_touching_base = int(np.any(on_base, axis=1).sum())
    side_triangles = triangles_touching_base - bottom_triangles
    top_triangles = int((~np.any(on_base, axis=1)).sum())
    return {
        "base_z_mm": base_z,
        "top_triangles": top_triangles,
        "bottom_triangles": bottom_triangles,
        "side_triangles": side_triangles,
        "top_matches_surface_triangle_count": top_triangles == surface_triangle_count,
        "bottom_matches_surface_triangle_count": bottom_triangles == surface_triangle_count,
    }


def surface_mesh_quality(mesh: np.memmap) -> dict:
    sample_stride = 5
    vertices = mesh[::sample_stride]["vertices"].astype(np.float64)
    edge_lengths = np.stack(
        [
            np.linalg.norm(vertices[:, 1] - vertices[:, 0], axis=1),
            np.linalg.norm(vertices[:, 2] - vertices[:, 1], axis=1),
            np.linalg.norm(vertices[:, 0] - vertices[:, 2], axis=1),
        ],
        axis=1,
    )
    triangle_area = 0.5 * np.linalg.norm(
        np.cross(vertices[:, 1] - vertices[:, 0], vertices[:, 2] - vertices[:, 0]),
        axis=1,
    )
    max_edges = edge_lengths.max(axis=1)
    normals = mesh["normal"]
    return {
        "triangle_sample_stride": sample_stride,
        "sampled_triangle_count": int(len(vertices)),
        "edge_length_mm_p50": float(np.percentile(edge_lengths, 50)),
        "edge_length_mm_p95": float(np.percentile(edge_lengths, 95)),
        "edge_length_mm_p99_9": float(np.percentile(edge_lengths, 99.9)),
        "edge_length_mm_max_sample": float(edge_lengths.max()),
        "triangle_area_mm2_p50": float(np.percentile(triangle_area, 50)),
        "triangle_area_mm2_p95": float(np.percentile(triangle_area, 95)),
        "degenerate_triangle_rate_sample": float(np.mean(triangle_area <= 1e-12)),
        "triangle_max_edge_over_0_2mm_rate_sample": float(np.mean(max_edges > 0.2)),
        "nonpositive_normal_z_count": int(np.sum(normals[:, 2] <= 0)),
    }


def reconstruct_height_grid(mesh: np.memmap, xy_pitch_mm: float) -> tuple[np.ndarray, dict]:
    vertices = mesh["vertices"].reshape(-1, 3)
    x_index = np.rint(vertices[:, 0] / xy_pitch_mm).astype(np.int32)
    y_index = np.rint(vertices[:, 1] / xy_pitch_mm).astype(np.int32)
    width = int(x_index.max()) + 1
    height = int(y_index.max()) + 1
    linear_index = y_index.astype(np.int64) * width + x_index
    height_grid = np.full(width * height, np.nan, dtype=np.float32)
    height_grid[linear_index] = vertices[:, 2]
    height_grid = height_grid.reshape(height, width)
    valid = np.isfinite(height_grid)

    z_values = np.unique(height_grid[valid])
    z_scaled = np.rint(z_values * 10000).astype(np.int64)
    z_quantization_error = np.max(np.abs(z_values - z_scaled / 10000))
    return height_grid, {
        "grid_width_pixels": width,
        "grid_height_pixels": height,
        "grid_cells": int(width * height),
        "unique_surface_vertices": int(valid.sum()),
        "occupied_grid_rate": float(valid.mean()),
        "stl_z_quantization_um": 0.1,
        "max_z_quantization_residual_um": float(z_quantization_error * 1000),
    }


def block_nanmedian(grid: np.ndarray, block_y: int, block_x: int) -> tuple[np.ndarray, np.ndarray]:
    pad_y = (-grid.shape[0]) % block_y
    pad_x = (-grid.shape[1]) % block_x
    padded = np.pad(grid, ((0, pad_y), (0, pad_x)), constant_values=np.nan)
    shaped = padded.reshape(
        padded.shape[0] // block_y,
        block_y,
        padded.shape[1] // block_x,
        block_x,
    )
    with np.errstate(all="ignore"):
        reduced = np.nanmedian(shaped, axis=(1, 3))
    count = np.isfinite(shaped).sum(axis=(1, 3))
    return reduced, count


def moving_median_rows(values: np.ndarray, width: int = 5) -> np.ndarray:
    half = width // 2
    padded = np.pad(values, ((0, 0), (half, half)), mode="edge")
    windows = np.lib.stride_tricks.sliding_window_view(padded, width, axis=1)
    return np.nanmedian(windows, axis=-1)


def interpolate_threshold_crossing(
    x: np.ndarray,
    depression: np.ndarray,
    threshold: float,
    center_index: int,
    direction: int,
) -> float:
    index = center_index
    while (
        0 <= index + direction < len(x)
        and depression[index + direction] >= threshold
    ):
        index += direction
    outside = index + direction
    if outside < 0 or outside >= len(x):
        return float(x[index])
    x1, x2 = x[index], x[outside]
    y1, y2 = depression[index], depression[outside]
    if y2 == y1:
        return float(x1)
    return float(x1 + (threshold - y1) * (x2 - x1) / (y2 - y1))


def measure_profile(
    x_mm: np.ndarray,
    profile_z_mm: np.ndarray,
    shoulder_bands_mm: tuple[float, float, float, float],
) -> dict:
    left_start, left_end, right_start, right_end = shoulder_bands_mm
    shoulder_mask = (
        ((x_mm >= left_start) & (x_mm <= left_end))
        | ((x_mm >= right_start) & (x_mm <= right_end))
    ) & np.isfinite(profile_z_mm)
    design = np.column_stack(
        [np.ones(int(shoulder_mask.sum())), x_mm[shoulder_mask]]
    )
    intercept, slope = np.linalg.lstsq(
        design,
        profile_z_mm[shoulder_mask],
        rcond=None,
    )[0]
    baseline_z_mm = intercept + slope * x_mm
    depression_mm = baseline_z_mm - profile_z_mm
    search_indices = np.where((x_mm >= 3.0) & (x_mm <= 16.0))[0]
    center_index = int(search_indices[np.nanargmax(depression_mm[search_indices])])
    depth_mm = float(depression_mm[center_index])
    half_depth_mm = depth_mm / 2.0
    left_crossing_mm = interpolate_threshold_crossing(
        x_mm, depression_mm, half_depth_mm, center_index, -1
    )
    right_crossing_mm = interpolate_threshold_crossing(
        x_mm, depression_mm, half_depth_mm, center_index, 1
    )
    center_x_mm = float(x_mm[center_index])
    return {
        "center_x_mm": center_x_mm,
        "minimum_z_mm": float(profile_z_mm[center_index]),
        "baseline_at_center_mm": float(baseline_z_mm[center_index]),
        "depth_mm": depth_mm,
        "fwhm_mm": right_crossing_mm - left_crossing_mm,
        "left_half_width_mm": center_x_mm - left_crossing_mm,
        "right_half_width_mm": right_crossing_mm - center_x_mm,
        "cross_sectional_area_mm2": float(
            np.trapezoid(np.maximum(depression_mm, 0), x_mm)
        ),
        "baseline_slope_mm_per_mm": float(slope),
        "baseline_tilt_degrees": float(math.degrees(math.atan(slope))),
        "left_half_depth_crossing_mm": left_crossing_mm,
        "right_half_depth_crossing_mm": right_crossing_mm,
        "left_shoulder_median_z_mm": float(
            np.nanmedian(profile_z_mm[(x_mm >= left_start) & (x_mm <= left_end)])
        ),
        "right_shoulder_median_z_mm": float(
            np.nanmedian(profile_z_mm[(x_mm >= right_start) & (x_mm <= right_end)])
        ),
        "baseline_z_mm": baseline_z_mm,
        "depression_mm": depression_mm,
    }


def summarize_distribution(values: np.ndarray) -> dict:
    return {
        "median": float(np.median(values)),
        "p05": float(np.percentile(values, 5)),
        "p95": float(np.percentile(values, 95)),
        "std": float(np.std(values)),
        "min": float(np.min(values)),
        "max": float(np.max(values)),
    }


def write_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def interpolate_color(value: float) -> tuple[int, int, int]:
    # Blue -> pale neutral -> gold; two non-neutral roots plus neutrals.
    stops = [
        (0.00, (31, 78, 121)),
        (0.50, (232, 238, 243)),
        (1.00, (212, 167, 44)),
    ]
    value = max(0.0, min(1.0, value))
    for (v0, c0), (v1, c1) in zip(stops, stops[1:]):
        if value <= v1:
            ratio = (value - v0) / (v1 - v0)
            return tuple(int(round(a + ratio * (b - a))) for a, b in zip(c0, c1))
    return stops[-1][1]


def draw_topography(
    coarse_z: np.ndarray,
    xy_step_x_mm: float,
    xy_step_y_mm: float,
    fold_axis_x_mm: float,
    output_path: Path,
) -> None:
    finite = np.isfinite(coarse_z)
    z_min = float(np.nanpercentile(coarse_z, 0.5))
    z_max = float(np.nanpercentile(coarse_z, 99.5))
    normalized = np.clip((coarse_z - z_min) / (z_max - z_min), 0, 1)
    rgb = np.zeros((*coarse_z.shape, 3), dtype=np.uint8)
    for row, col in zip(*np.nonzero(finite)):
        rgb[row, col] = interpolate_color(float(normalized[row, col]))
    rgb[~finite] = (245, 246, 248)
    heatmap = Image.fromarray(rgb, mode="RGB")

    width, height = 1500, 1050
    canvas = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(canvas)
    title_font = load_font(36, bold=True)
    body_font = load_font(24)
    small_font = load_font(20)
    plot_left, plot_top, plot_right, plot_bottom = 130, 130, 1270, 880
    plot_w, plot_h = plot_right - plot_left, plot_bottom - plot_top
    heatmap = heatmap.resize((plot_w, plot_h), Image.Resampling.BICUBIC)
    canvas.paste(heatmap, (plot_left, plot_top))

    x_max = coarse_z.shape[1] * xy_step_x_mm
    y_max = coarse_z.shape[0] * xy_step_y_mm
    axis_x = plot_left + int(fold_axis_x_mm / x_max * plot_w)
    for y in range(plot_top, plot_bottom, 18):
        draw.line((axis_x, y, axis_x, min(y + 10, plot_bottom)), fill=(37, 39, 43), width=2)

    draw.rectangle((plot_left, plot_top, plot_right, plot_bottom), outline=(43, 47, 52), width=2)
    for tick in range(0, 21, 5):
        px = plot_left + tick / x_max * plot_w
        draw.line((px, plot_bottom, px, plot_bottom + 9), fill=(43, 47, 52), width=2)
        label = f"{tick}"
        bbox = draw.textbbox((0, 0), label, font=small_font)
        draw.text((px - (bbox[2] - bbox[0]) / 2, plot_bottom + 14), label, fill=(43, 47, 52), font=small_font)
    for tick in range(0, 16, 3):
        py = plot_bottom - tick / y_max * plot_h
        draw.line((plot_left - 9, py, plot_left, py), fill=(43, 47, 52), width=2)
        label = f"{tick}"
        bbox = draw.textbbox((0, 0), label, font=small_font)
        draw.text((plot_left - 17 - (bbox[2] - bbox[0]), py - (bbox[3] - bbox[1]) / 2), label, fill=(43, 47, 52), font=small_font)

    draw.text((plot_left, 40), "Fold-screen surface topography", fill=(33, 37, 41), font=title_font)
    draw.text((plot_left, 88), "Median height in ~0.118 mm cells; dashed line = median fold axis", fill=(78, 84, 91), font=body_font)
    draw.text(((plot_left + plot_right) / 2 - 40, 965), "X (mm)", fill=(43, 47, 52), font=body_font)
    draw.text((25, (plot_top + plot_bottom) / 2 - 25), "Y (mm)", fill=(43, 47, 52), font=body_font)

    bar_left, bar_right = 1325, 1380
    for index in range(plot_h):
        color = interpolate_color(1 - index / max(1, plot_h - 1))
        draw.line((bar_left, plot_top + index, bar_right, plot_top + index), fill=color)
    draw.rectangle((bar_left, plot_top, bar_right, plot_bottom), outline=(43, 47, 52), width=2)
    for value in np.linspace(z_min, z_max, 6):
        py = plot_bottom - (value - z_min) / (z_max - z_min) * plot_h
        draw.line((bar_right, py, bar_right + 8, py), fill=(43, 47, 52), width=2)
        draw.text((bar_right + 14, py - 10), f"{value:.2f}", fill=(43, 47, 52), font=small_font)
    draw.text((bar_left - 15, plot_top - 42), "Z (mm)", fill=(43, 47, 52), font=body_font)
    canvas.save(output_path)


def draw_cross_section(
    x_mm: np.ndarray,
    profile_z_mm: np.ndarray,
    metrics: dict,
    output_path: Path,
) -> None:
    width, height = 1500, 950
    canvas = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(canvas)
    title_font = load_font(36, bold=True)
    body_font = load_font(24)
    small_font = load_font(20)
    plot_left, plot_top, plot_right, plot_bottom = 125, 135, 1410, 790
    plot_w, plot_h = plot_right - plot_left, plot_bottom - plot_top
    x_min, x_max = 0.0, float(x_mm.max())
    z_min, z_max = 0.0, 2.3

    def px(value: float) -> float:
        return plot_left + (value - x_min) / (x_max - x_min) * plot_w

    def py(value: float) -> float:
        return plot_bottom - (value - z_min) / (z_max - z_min) * plot_h

    for z_tick in np.arange(0, 2.31, 0.5):
        y = py(float(z_tick))
        draw.line((plot_left, y, plot_right, y), fill=(225, 228, 232), width=1)
        draw.text((45, y - 10), f"{z_tick:.1f}", fill=(75, 80, 86), font=small_font)
    for x_tick in range(0, 21, 2):
        x = px(float(x_tick))
        draw.line((x, plot_bottom, x, plot_bottom + 8), fill=(43, 47, 52), width=2)
        draw.text((x - 10, plot_bottom + 14), str(x_tick), fill=(75, 80, 86), font=small_font)

    baseline = metrics["baseline_z_mm"]
    depression = metrics["depression_mm"]
    points = [(px(float(x)), py(float(z))) for x, z in zip(x_mm, profile_z_mm)]
    base_points = [(px(float(x)), py(float(z))) for x, z in zip(x_mm, baseline)]
    fill_polygon = base_points + list(reversed(points))
    draw.polygon(fill_polygon, fill=(225, 234, 243))
    draw.line(points, fill=(31, 78, 121), width=5, joint="curve")
    for start in range(0, len(base_points) - 1, 4):
        end = min(start + 2, len(base_points) - 1)
        draw.line((base_points[start], base_points[end]), fill=(72, 76, 82), width=3)

    half_level = metrics["baseline_at_center_mm"] - metrics["depth_mm"] / 2
    half_left = metrics["left_half_depth_crossing_mm"]
    half_right = metrics["right_half_depth_crossing_mm"]
    draw.line((px(half_left), py(half_level), px(half_right), py(half_level)), fill=(212, 167, 44), width=4)
    draw.line((px(metrics["center_x_mm"]), py(metrics["minimum_z_mm"]), px(metrics["center_x_mm"]), py(metrics["baseline_at_center_mm"])), fill=(184, 117, 38), width=3)
    draw.ellipse((px(metrics["center_x_mm"]) - 6, py(metrics["minimum_z_mm"]) - 6, px(metrics["center_x_mm"]) + 6, py(metrics["minimum_z_mm"]) + 6), fill=(184, 117, 38))

    draw.rectangle((plot_left, plot_top, plot_right, plot_bottom), outline=(43, 47, 52), width=2)
    draw.text((plot_left, 40), "Median cross-section across the fold", fill=(33, 37, 41), font=title_font)
    draw.text((plot_left, 88), "Blue = measured surface; dashed = shoulder baseline; gold = half-depth width", fill=(78, 84, 91), font=body_font)
    draw.text(((plot_left + plot_right) / 2 - 40, 875), "X (mm)", fill=(43, 47, 52), font=body_font)
    draw.text((20, (plot_top + plot_bottom) / 2), "Z (mm)", fill=(43, 47, 52), font=body_font)
    annotation = (
        f"Depth {metrics['depth_mm']:.3f} mm   |   FWHM {metrics['fwhm_mm']:.3f} mm   |   "
        f"Area {metrics['cross_sectional_area_mm2']:.2f} mm²"
    )
    draw.text((plot_left + 25, plot_top + 25), annotation, fill=(33, 37, 41), font=body_font)
    canvas.save(output_path)


def strip_arrays(value):
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, dict):
        return {key: strip_arrays(item) for key, item in value.items()}
    if isinstance(value, list):
        return [strip_arrays(item) for item in value]
    return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--solid-stl", type=Path, required=True)
    parser.add_argument("--surface-stl", type=Path, required=True)
    parser.add_argument("--zag", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    solid_stl = args.solid_stl.expanduser().resolve()
    surface_stl = args.surface_stl.expanduser().resolve()
    zag_file = args.zag.expanduser().resolve()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    zag_metadata = parse_zag_metadata(zag_file)
    xy_pitch_mm = zag_metadata["xy_meter_per_pixel"] * 1000

    solid_mesh, solid_info = open_binary_stl(solid_stl)
    surface_mesh, surface_info = open_binary_stl(surface_stl)
    solid_info["extent"] = stl_extent(solid_mesh)
    surface_info["extent"] = stl_extent(surface_mesh)
    solid_classification = classify_solid_mesh(
        solid_mesh, surface_info["triangle_count"]
    )
    mesh_quality = surface_mesh_quality(surface_mesh)
    height_grid, grid_info = reconstruct_height_grid(surface_mesh, xy_pitch_mm)

    # Metric grid: ~0.059 mm across X and ~0.237 mm along Y.
    block_y, block_x = 32, 8
    profile_grid, profile_counts = block_nanmedian(height_grid, block_y, block_x)
    profile_grid = moving_median_rows(profile_grid, width=5)
    x_mm = (np.arange(profile_grid.shape[1]) + 0.5) * block_x * xy_pitch_mm
    y_mm = (np.arange(profile_grid.shape[0]) + 0.5) * block_y * xy_pitch_mm
    included_y = (y_mm >= 0.5) & (y_mm <= 14.7)
    median_profile = np.nanmedian(profile_grid[included_y], axis=0)
    aggregate_metrics = measure_profile(
        x_mm, median_profile, PRIMARY_SHOULDER_BANDS_MM
    )

    along_fold_rows: list[dict] = []
    for y_position, profile, counts in zip(
        y_mm[included_y], profile_grid[included_y], profile_counts[included_y]
    ):
        measured = measure_profile(x_mm, profile, PRIMARY_SHOULDER_BANDS_MM)
        along_fold_rows.append(
            {
                "y_mm": round(float(y_position), 6),
                "center_x_mm": round(measured["center_x_mm"], 6),
                "depth_mm": round(measured["depth_mm"], 6),
                "fwhm_mm": round(measured["fwhm_mm"], 6),
                "left_half_width_mm": round(measured["left_half_width_mm"], 6),
                "right_half_width_mm": round(measured["right_half_width_mm"], 6),
                "cross_sectional_area_mm2": round(
                    measured["cross_sectional_area_mm2"], 6
                ),
                "baseline_tilt_degrees": round(
                    measured["baseline_tilt_degrees"], 6
                ),
                "source_points_in_band": int(counts.sum()),
            }
        )

    along_arrays = {
        key: np.array([row[key] for row in along_fold_rows], dtype=float)
        for key in [
            "center_x_mm",
            "depth_mm",
            "fwhm_mm",
            "left_half_width_mm",
            "right_half_width_mm",
            "cross_sectional_area_mm2",
            "baseline_tilt_degrees",
        ]
    }
    along_summary = {
        key: summarize_distribution(values) for key, values in along_arrays.items()
    }

    sensitivity_rows: list[dict] = []
    for bands in SENSITIVITY_BANDS_MM:
        measured = measure_profile(x_mm, median_profile, bands)
        sensitivity_rows.append(
            {
                "left_band_mm": f"{bands[0]:g}-{bands[1]:g}",
                "right_band_mm": f"{bands[2]:g}-{bands[3]:g}",
                "depth_mm": round(measured["depth_mm"], 6),
                "fwhm_mm": round(measured["fwhm_mm"], 6),
                "cross_sectional_area_mm2": round(
                    measured["cross_sectional_area_mm2"], 6
                ),
            }
        )

    profile_rows = []
    half_level = (
        aggregate_metrics["baseline_at_center_mm"]
        - aggregate_metrics["depth_mm"] / 2
    )
    for index, (x_value, z_value, baseline, depression) in enumerate(
        zip(
            x_mm,
            median_profile,
            aggregate_metrics["baseline_z_mm"],
            aggregate_metrics["depression_mm"],
        )
    ):
        profile_rows.append(
            {
                "x_mm": round(float(x_value), 6),
                "surface_z_mm": round(float(z_value), 6),
                "baseline_z_mm": round(float(baseline), 6),
                "half_depth_z_mm": round(float(half_level), 6),
                "depression_mm": round(float(depression), 6),
                "source_points": int(profile_counts[included_y, index].sum()),
            }
        )

    # Visualization grid: ~0.118 mm square cells.
    topography_grid, topography_counts = block_nanmedian(height_grid, 16, 16)
    topography_grid[topography_counts < 3] = np.nan
    draw_topography(
        topography_grid,
        16 * xy_pitch_mm,
        16 * xy_pitch_mm,
        along_summary["center_x_mm"]["median"],
        OUTPUT / "topography.png",
    )
    draw_cross_section(
        x_mm,
        median_profile,
        aggregate_metrics,
        OUTPUT / "cross_section.png",
    )

    write_csv(OUTPUT / "median_cross_section.csv", profile_rows)
    write_csv(OUTPUT / "along_fold_metrics.csv", along_fold_rows)
    write_csv(OUTPUT / "baseline_sensitivity.csv", sensitivity_rows)

    summary_rows = [
        {
            "metric": "Median depth along fold",
            "value": round(along_summary["depth_mm"]["median"], 6),
            "unit": "mm",
            "p05": round(along_summary["depth_mm"]["p05"], 6),
            "p95": round(along_summary["depth_mm"]["p95"], 6),
            "definition": "Shoulder baseline minus trough minimum for each Y band",
        },
        {
            "metric": "Median FWHM along fold",
            "value": round(along_summary["fwhm_mm"]["median"], 6),
            "unit": "mm",
            "p05": round(along_summary["fwhm_mm"]["p05"], 6),
            "p95": round(along_summary["fwhm_mm"]["p95"], 6),
            "definition": "Width where depression is at least half of local depth",
        },
        {
            "metric": "Median fold-axis X",
            "value": round(along_summary["center_x_mm"]["median"], 6),
            "unit": "mm",
            "p05": round(along_summary["center_x_mm"]["p05"], 6),
            "p95": round(along_summary["center_x_mm"]["p95"], 6),
            "definition": "X coordinate of maximum depression in each Y band",
        },
        {
            "metric": "Median cross-sectional depression area",
            "value": round(
                along_summary["cross_sectional_area_mm2"]["median"], 6
            ),
            "unit": "mm²",
            "p05": round(
                along_summary["cross_sectional_area_mm2"]["p05"], 6
            ),
            "p95": round(
                along_summary["cross_sectional_area_mm2"]["p95"], 6
            ),
            "definition": "Integral of positive shoulder-baseline depression across X",
        },
    ]
    write_csv(OUTPUT / "summary_metrics.csv", summary_rows)

    serializable_aggregate = {
        key: value
        for key, value in aggregate_metrics.items()
        if key not in {"baseline_z_mm", "depression_mm"}
    }
    metrics = {
        "analysis_version": 1,
        "method": {
            "primary_shoulder_bands_mm": list(PRIMARY_SHOULDER_BANDS_MM),
            "metric_x_bin_mm": block_x * xy_pitch_mm,
            "metric_y_band_mm": block_y * xy_pitch_mm,
            "x_smoothing_window_bins": 5,
            "included_y_range_mm": [0.5, 14.7],
            "depth_definition": "Shoulder baseline at trough center minus measured trough minimum",
            "fwhm_definition": "Width of contiguous depression at 50% of the local maximum depth",
        },
        "zag": zag_metadata,
        "solid_stl": solid_info,
        "surface_stl": surface_info,
        "solid_stl_classification": solid_classification,
        "surface_stl_mesh_quality": mesh_quality,
        "height_grid": grid_info,
        "aggregate_median_profile": serializable_aggregate,
        "along_fold_summary": along_summary,
        "baseline_sensitivity": sensitivity_rows,
        "data_quality": {
            "topography_cell_count": int(topography_grid.size),
            "topography_cells_with_data": int(np.isfinite(topography_grid).sum()),
            "topography_cell_coverage_rate": float(np.isfinite(topography_grid).mean()),
            "topography_points_per_cell_p01": float(np.percentile(topography_counts, 1)),
            "topography_points_per_cell_median": float(np.percentile(topography_counts, 50)),
            "topography_points_per_cell_p99": float(np.percentile(topography_counts, 99)),
        },
        "limitations": [
            "STL does not encode physical units; millimetres are supported by the ZAG XY calibration and coordinate pitch.",
            "Depth and FWHM depend on the selected shoulder baseline because the scanned window does not contain two perfectly flat plateaus.",
            "The ZAG archive may contain multiple capture records, while an STL filename does not identify which record or merge recipe produced the export.",
            "Results describe one scan/export only; repeatability, device-to-device variation, and before/after aging cannot be inferred.",
        ],
    }
    with (OUTPUT / "metrics.json").open("w", encoding="utf-8") as handle:
        json.dump(strip_arrays(metrics), handle, ensure_ascii=False, indent=2)

    print(
        json.dumps(
            {
                "depth_mm_median": along_summary["depth_mm"]["median"],
                "depth_mm_p05_p95": [
                    along_summary["depth_mm"]["p05"],
                    along_summary["depth_mm"]["p95"],
                ],
                "fwhm_mm_median": along_summary["fwhm_mm"]["median"],
                "fwhm_mm_p05_p95": [
                    along_summary["fwhm_mm"]["p05"],
                    along_summary["fwhm_mm"]["p95"],
                ],
                "fold_axis_x_mm_median": along_summary["center_x_mm"]["median"],
                "fold_axis_x_mm_p05_p95": [
                    along_summary["center_x_mm"]["p05"],
                    along_summary["center_x_mm"]["p95"],
                ],
                "aggregate_profile_depth_mm": aggregate_metrics["depth_mm"],
                "aggregate_profile_fwhm_mm": aggregate_metrics["fwhm_mm"],
                "outputs": [
                    str(OUTPUT / "metrics.json"),
                    str(OUTPUT / "median_cross_section.csv"),
                    str(OUTPUT / "along_fold_metrics.csv"),
                    str(OUTPUT / "baseline_sensitivity.csv"),
                    str(OUTPUT / "topography.png"),
                    str(OUTPUT / "cross_section.png"),
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
