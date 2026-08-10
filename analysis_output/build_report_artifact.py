#!/usr/bin/env python3
"""Build the bounded Data Analytics report artifact from reviewed outputs."""

from __future__ import annotations

import csv
import json
import sqlite3
from pathlib import Path


OUTPUT = Path(__file__).resolve().parent
GENERATED_AT = "2026-08-07T20:25:00+08:00"


def read_csv(name: str) -> list[dict]:
    with (OUTPUT / name).open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        for key, value in list(row.items()):
            if key in {
                "metric",
                "unit",
                "definition",
                "left_band_mm",
                "right_band_mm",
            }:
                continue
            try:
                row[key] = float(value)
            except (TypeError, ValueError):
                pass
    return rows


def main() -> None:
    metrics = json.loads((OUTPUT / "metrics.json").read_text(encoding="utf-8"))
    analysis_code = (OUTPUT / "analyze_crease.py").read_text(encoding="utf-8")
    profile = read_csv("median_cross_section.csv")
    along = read_csv("along_fold_metrics.csv")
    summary = read_csv("summary_metrics.csv")
    sensitivity = read_csv("baseline_sensitivity.csv")

    database_path = OUTPUT / "crease_analysis.sqlite"
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS median_cross_section (
            x_mm REAL, surface_z_mm REAL, baseline_z_mm REAL,
            half_depth_z_mm REAL, depression_mm REAL, source_points INTEGER
        );
        CREATE TABLE IF NOT EXISTS along_fold (
            y_mm REAL, center_x_mm REAL, depth_mm REAL, fwhm_mm REAL,
            left_half_width_mm REAL, right_half_width_mm REAL,
            cross_sectional_area_mm2 REAL, baseline_tilt_degrees REAL,
            source_points_in_band INTEGER
        );
        CREATE TABLE IF NOT EXISTS baseline_sensitivity (
            left_band_mm TEXT, right_band_mm TEXT, depth_mm REAL,
            fwhm_mm REAL, cross_sectional_area_mm2 REAL
        );
        DELETE FROM median_cross_section;
        DELETE FROM along_fold;
        DELETE FROM baseline_sensitivity;
        """
    )
    connection.executemany(
        "INSERT INTO median_cross_section VALUES (:x_mm, :surface_z_mm, :baseline_z_mm, :half_depth_z_mm, :depression_mm, :source_points)",
        profile,
    )
    connection.executemany(
        "INSERT INTO along_fold VALUES (:y_mm, :center_x_mm, :depth_mm, :fwhm_mm, :left_half_width_mm, :right_half_width_mm, :cross_sectional_area_mm2, :baseline_tilt_degrees, :source_points_in_band)",
        along,
    )
    connection.executemany(
        "INSERT INTO baseline_sensitivity VALUES (:left_band_mm, :right_band_mm, :depth_mm, :fwhm_mm, :cross_sectional_area_mm2)",
        sensitivity,
    )
    connection.commit()

    cross_section_sql = """
SELECT x_mm, surface_z_mm AS z_mm, 'Measured surface' AS series,
       'solid' AS line_style, depression_mm, source_points
FROM median_cross_section
UNION ALL
SELECT x_mm, baseline_z_mm AS z_mm, 'Shoulder baseline' AS series,
       'dashed' AS line_style, depression_mm, source_points
FROM median_cross_section
ORDER BY x_mm, series
""".strip()
    along_fold_sql = """
SELECT y_mm, center_x_mm, depth_mm, fwhm_mm,
       left_half_width_mm, right_half_width_mm,
       cross_sectional_area_mm2, baseline_tilt_degrees,
       source_points_in_band
FROM along_fold
ORDER BY y_mm
""".strip()
    sensitivity_sql = """
SELECT left_band_mm, right_band_mm, depth_mm, fwhm_mm,
       cross_sectional_area_mm2
FROM baseline_sensitivity
ORDER BY depth_mm DESC
""".strip()

    tidy_profile = [
        dict(row) for row in connection.execute(cross_section_sql).fetchall()
    ]
    along = [dict(row) for row in connection.execute(along_fold_sql).fetchall()]
    sensitivity = [
        dict(row) for row in connection.execute(sensitivity_sql).fetchall()
    ]
    connection.close()

    source = {
        "id": "scan-analysis",
        "label": "Supplied STL surface with ZAG calibration",
        "path": "analysis_output/analyze_crease.py",
        "query": {
            "language": "python",
            "sql": analysis_code,
            "description": "Reconstruct the stl2 top surface, read ZAG calibration, and calculate fold depth, FWHM, area, and along-fold stability.",
            "tables_used": [
                "stl2.stl",
                "stl1.stl",
                "VR-20260807_141525.zag",
            ],
            "filters": [
                "Y analysis range: 0.5-14.7 mm",
                "Primary left shoulder band: X 0.5-2.5 mm",
                "Primary right shoulder band: X 18-20 mm",
                "Profile median bins: 0.0592 mm X by 0.2369 mm Y",
            ],
            "metric_definitions": {
                "crease_depth_mm": "For each Y band, shoulder-baseline height at the maximum depression minus the measured trough minimum, in millimetres.",
                "fwhm_mm": "Contiguous X width where depression is at least 50% of the local maximum depth, in millimetres.",
                "cross_sectional_area_mm2": "Integral across X of positive shoulder-baseline depression, in square millimetres.",
                "fold_axis_x_mm": "X coordinate of maximum shoulder-baseline depression within X 3-16 mm.",
            },
            "executed_at": GENERATED_AT,
        },
    }

    def query_source(source_id: str, label: str, sql: str, tables: list[str], description: str) -> dict:
        return {
            "id": source_id,
            "label": label,
            "path": "analysis_output/crease_analysis.sqlite",
            "query": {
                "language": "sql",
                "engine": "sqlite",
                "sql": sql,
                "description": description,
                "tables_used": tables,
                "executed_at": GENERATED_AT,
                "filters": [
                    "Y analysis range: 0.5-14.7 mm",
                    "Primary left shoulder band: X 0.5-2.5 mm",
                    "Primary right shoulder band: X 18-20 mm",
                ],
                "metric_definitions": source["query"]["metric_definitions"],
            },
        }

    cross_section_source = query_source(
        "cross-section-query",
        "Median cross-section query",
        cross_section_sql,
        ["median_cross_section"],
        "Return the measured median surface and fitted shoulder baseline as tidy line-chart rows.",
    )
    along_fold_source = query_source(
        "along-fold-query",
        "Along-fold depth query",
        along_fold_sql,
        ["along_fold"],
        "Return one independently measured fold-geometry row per Y band.",
    )
    sensitivity_source = query_source(
        "sensitivity-query",
        "Baseline sensitivity query",
        sensitivity_sql,
        ["baseline_sensitivity"],
        "Compare aggregate depth, FWHM, and depression area across shoulder-baseline definitions.",
    )
    all_sources = [source, cross_section_source, along_fold_source, sensitivity_source]

    manifest = {
        "version": 1,
        "surface": "report",
        "title": "折叠屏折痕扫描分析",
        "description": "基于实验室 STL 表面网格和 ZAG 标定信息的折痕几何分析。",
        "generatedAt": GENERATED_AT,
        "sources": all_sources,
        "blocks": [
            {
                "id": "title",
                "type": "markdown",
                "body": "# 折叠屏折痕扫描分析",
            },
            {
                "id": "technical-summary",
                "type": "markdown",
                "sourceId": "scan-analysis",
                "body": "## 技术摘要\n\n- **这是一条宽而连续的 U/V 形凹槽。** 沿折痕长度方向的中位深度为 **1.829 mm**，5–95 百分位为 **1.722–1.881 mm**。\n- **半深宽度稳定。** FWHM 中位数为 **6.864 mm**，5–95 百分位为 **6.509–7.034 mm**。\n- **折痕轴线位于 X≈9.09 mm，半深处左右对称性较好。** 但左右肩部高度相差约 **0.29 mm**，不应直接把原始 Z 最大值与最小值之差当作折痕深度。\n- **主要不确定性来自基准线定义。** 不同肩部区间使聚合截面深度在 **1.646–1.861 mm** 之间变化，因此本结果更适合作为同一口径下的比较基线。",
            },
            {
                "id": "cross-section-finding",
                "type": "markdown",
                "sourceId": "scan-analysis",
                "body": "## 中位截面显示折痕底部宽平、两侧连续过渡\n\n下图把所有有效 Y 条带的横向截面取中位数，并叠加左右肩部拟合基准线。聚合截面深度为 **1.822 mm**，FWHM 为 **6.936 mm**，凹槽截面积为 **13.68 mm²**。曲线没有显示一条叠加在宽槽上的极窄尖底缺陷。",
            },
            {"id": "cross-section-chart-block", "type": "chart", "chartId": "cross-section-chart"},
            {
                "id": "along-fold-finding",
                "type": "markdown",
                "sourceId": "scan-analysis",
                "body": "## 深度沿 14.2 mm 折痕长度总体稳定\n\n每个约 0.237 mm 的 Y 条带独立计算深度。中位数为 **1.829 mm**，90% 的条带位于 **1.722–1.881 mm**。这说明凹槽不是只在局部出现；但单次扫描不能用来判断设备重复性或长期耐久性。",
            },
            {"id": "along-fold-chart-block", "type": "chart", "chartId": "along-fold-depth-chart"},
            {
                "id": "scope-definitions",
                "type": "markdown",
                "body": "## 数据范围与指标定义\n\n- `stl2.stl` 是用于分析的开放顶表面，共 **2,650,659** 个三角面。\n- `stl1.stl` 包含完全相同的顶表面，另加同样数量的底面三角形和 **17,926** 个侧壁三角形；它是闭合实体，不应重复统计。\n- ZAG 标定给出 XY 像素节距 **7.4017786 µm**，内部 Z 单位 **0.01 µm**；STL 导出的 Z 坐标量化步长为 **0.1 µm**。\n- 深度是“肩部拟合基准线在槽底位置的高度 − 槽底高度”；FWHM 是凹陷达到当地最大深度 50% 时的连续横向宽度。",
            },
            {
                "id": "methodology",
                "type": "markdown",
                "body": "## 方法保留了标定、网格质量和局部变化\n\n分析先校验二进制 STL 长度和三角面数，再按 ZAG 节距重建稀疏高度网格。横向使用约 0.059 mm 中位分箱，纵向使用约 0.237 mm 条带，排除 Y 两端 0.5 mm 边缘。主基准使用 X=0.5–2.5 mm 和 X=18–20 mm 肩部数据拟合一次线。代码、中间 CSV、完整指标 JSON 和已执行笔记均保留在 `analysis_output` 目录。",
            },
            {
                "id": "limitations",
                "type": "markdown",
                "sourceId": "scan-analysis",
                "body": "## 基准线口径是当前最大的方法不确定性\n\n扫描窗口并未同时包含两个完全平坦的肩部平台，因此向内收缩肩部区间会将聚合截面深度从 **1.861 mm** 降低到 **1.646 mm**，FWHM 从 **7.047 mm** 降低到 **6.463 mm**。这不是算法错误，而是“折痕相对于哪个基准面”的定义问题。",
            },
            {"id": "sensitivity-table-block", "type": "table", "tableId": "sensitivity-table"},
            {
                "id": "recommended-next-steps",
                "type": "markdown",
                "body": "## 建议用固定治具和固定口径建立可比较的时间序列\n\n1. 固定手机开合角、支撑位置、扫描窗口和坐标方向，以避免左右肩部高度差混入折痕指标。\n2. 对每个样品连续扫描至少 3 次，报告重复性（均值、标准差、最大差），再进行机型、折叠次数或老化前后对比。\n3. 继续使用本报告的肩部区间、Y 排除范围、分箱和 FWHM 定义；如果改口径，同时重算历史样本。",
            },
            {
                "id": "further-questions",
                "type": "markdown",
                "body": "## 还需要的信息\n\n- 实验室设备型号、扫描模式、手机型号和扫描时的开合角是什么？\n- ZAG 内有 4 个捕获记录；两个 STL 是其中哪一个记录、还是合并结果？\n- 如果目标是比较不同手机或老化前后，需要同口径的其他扫描作为对照。",
            },
        ],
        "charts": [
            {
                "id": "cross-section-chart",
                "title": "折痕中位横截面",
                "description": "X 0–20.5 mm；测量表面与肩部基准线，高度单位 mm",
                "dataset": "cross_section",
                "type": "line",
                "encodings": {
                    "x": {"field": "x_mm", "type": "quantitative", "title": "X (mm)"},
                    "y": {"field": "z_mm", "type": "quantitative", "title": "Z (mm)"},
                    "color": {"field": "series", "type": "nominal", "title": "Series"},
                    "lineStyle": {"field": "line_style"},
                },
                "options": {
                    "legend": True,
                    "palette": {"kind": "two-root", "roots": ["blue", "gold"]},
                },
                "sourceId": "cross-section-query",
                "source": cross_section_source,
            },
            {
                "id": "along-fold-depth-chart",
                "title": "折痕深度沿 Y 方向的变化",
                "description": "每个约 0.237 mm Y 条带的独立测量；已排除两端 0.5 mm",
                "dataset": "along_fold",
                "type": "line",
                "encodings": {
                    "x": {"field": "y_mm", "type": "quantitative", "title": "Y (mm)"},
                    "y": {"field": "depth_mm", "type": "quantitative", "title": "Depth (mm)"},
                },
                "options": {
                    "legend": False,
                    "palette": {"kind": "single-root", "roots": ["blue"]},
                },
                "sourceId": "along-fold-query",
                "source": along_fold_source,
            },
        ],
        "tables": [
            {
                "id": "sensitivity-table",
                "title": "肩部基准区间敏感性",
                "description": "同一中位截面，仅改变左右肩部拟合区间",
                "dataset": "sensitivity",
                "columns": [
                    {"field": "left_band_mm", "label": "Left band (mm)", "type": "text"},
                    {"field": "right_band_mm", "label": "Right band (mm)", "type": "text"},
                    {"field": "depth_mm", "label": "Depth (mm)", "type": "number", "format": ".3f"},
                    {"field": "fwhm_mm", "label": "FWHM (mm)", "type": "number", "format": ".3f"},
                    {"field": "cross_sectional_area_mm2", "label": "Area (mm²)", "type": "number", "format": ".2f"},
                ],
                "defaultSort": {"field": "depth_mm", "direction": "desc"},
                "sourceId": "sensitivity-query",
                "source": sensitivity_source,
            }
        ],
    }

    artifact = {
        "surface": "report",
        "manifest": manifest,
        "snapshot": {
            "version": 1,
            "status": "ready",
            "generatedAt": GENERATED_AT,
            "datasets": {
                "cross_section": tidy_profile,
                "along_fold": along,
                "summary_metrics": summary,
                "sensitivity": sensitivity,
            },
        },
        "sources": all_sources,
        "package_info": {
            "analysis_script": "analysis_output/analyze_crease.py",
            "notebook": "analysis_output/crease_analysis.ipynb",
            "full_metrics": "analysis_output/metrics.json",
            "source_row_counts": {
                "cross_section": len(tidy_profile),
                "along_fold": len(along),
                "summary_metrics": len(summary),
                "sensitivity": len(sensitivity),
            },
            "z_range_mm": metrics["stl2"]["extent"]["range_mm"][2],
        },
    }
    (OUTPUT / "report_artifact.json").write_text(
        json.dumps(artifact, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(OUTPUT / "report_artifact.json")


if __name__ == "__main__":
    main()
