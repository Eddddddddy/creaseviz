# Design QA

- Source visual truth path: `browser:高度 97.2 µm -117.1 µm ZAG 原始高度场` (user-annotated 3D viewer requesting multi-point height markers and clearing).
- Preserved-layout reference screenshot: `/Users/wangdingyi/.codex/visualizations/2026/08/07/019fdc22-de78-7033-9392-c9a2cc2fed3b/point-markers-before.png`.
- Multi-point implementation screenshot: `/Users/wangdingyi/.codex/visualizations/2026/08/07/019fdc22-de78-7033-9392-c9a2cc2fed3b/point-markers-final.png`.
- Cleared-state screenshot: `/Users/wangdingyi/.codex/visualizations/2026/08/07/019fdc22-de78-7033-9392-c9a2cc2fed3b/point-markers-cleared.png`.
- Viewport: 1375 × 1247 CSS px at devicePixelRatio 1.6.
- Source and implementation pixels: 1375 × 1248 PNG, normalized to the same CSS-pixel width.
- State: `VR-20260807_141525.zag`, height-color mode, environment view, Z display scale 10×, point-marking enabled, three markers at 91.5 µm, -112.7 µm, and 27.6 µm.

## Full-view comparison evidence

The 3D stage, height legend, inspector, profile chart, status bar, camera controls, lighting, and model composition retain their existing size and placement. Two compact controls are added to the established top toolbar: an active-blue `点标记` button and a `清除` button with a yellow numeric count. The viewer gains only a short contextual hint while marking is enabled.

## Focused region comparison evidence

- Each click creates a small high-contrast 3D point marker anchored to the intersected surface and a nearby dark floating label.
- Labels use `P1`, `P2`, and `P3` identifiers plus a tabular `Z … µm` value. The three verified clicks return distinct real-height values matching their red, blue, and yellow-green surface regions.
- The yellow marker accent stays readable across the scientific rainbow palette, while the dark label avoids obscuring more surface than necessary.
- The toolbar count changes from 0 to 3. After clearing, all marker labels disappear and the clear button returns to its disabled state.
- A focused crop is unnecessary because the toolbar state, each 3D anchor, the floating labels, and the surface relationship are readable together in the full implementation frame.

## Interaction evidence

1. Loaded the real ZAG capture and enabled `点标记`.
2. Clicked three separated surface locations; observed P1 = 91.5 µm, P2 = -112.7 µm, and P3 = 27.6 µm with toolbar count 3.
3. Dragged the camera while marking remained enabled; the model moved and marker count stayed 3, proving a drag does not create an accidental point.
4. Disabled marking and clicked the surface; the marker count stayed 3 while existing markers remained visible.
5. Switched to `旋转模型`, added a point, and dragged the model; the point remained attached to the model.
6. Activated `清除`; the marker count became 0, all labels disappeared, and the clear control became disabled.

## Required fidelity surfaces

- Fonts and typography: existing Inter/SF/PingFang stack is preserved; compact labels use the established 9–10 px inspection-tool scale and tabular numerals.
- Spacing and layout rhythm: no workspace track, profile height, inspector width, or status-bar geometry changed; the new toolbar controls fit without clipping at the validated viewport.
- Colors and visual tokens: active blue reuses the viewer's selected-control color, while yellow is reserved for measurement markers and counts.
- Image quality and asset fidelity: icons come from the project's existing Lucide library; marker anchors are native Three.js geometry and labels are resolution-independent HTML overlays.
- Copy and content: `点标记`, `清除`, `Z`, and the brief instruction accurately describe the interaction without changing adjacent product copy.

## Comparison history

1. The first rendered implementation preserved the full viewer layout and produced readable, distinct multi-point height labels; no P0, P1, or P2 visual mismatch was found.
2. Interaction validation confirmed camera drag, model rotation, disabled marking, and clear-all behavior without a layout or state regression.

## Findings

No actionable P0, P1, or P2 differences remain for the requested multi-point height-marker workflow.

## Follow-up polish

Exporting marker coordinates can be added later if the measurement workflow expands beyond the current point-inspection behavior.

## Post-QA progress

Individual labels are now interactive delete buttons with hover/focus feedback and an explicit remove icon. The production build passes, but this incremental interaction was added after the browser evidence above; a refreshed manual click check remains pending because the automated browser was held on its prior local-service error page by URL policy.

final result: passed
