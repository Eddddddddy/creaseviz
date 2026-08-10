# Release checklist

Use this checklist before publishing CreaseViz or enabling GitHub Pages.

- [ ] Run `pnpm install --frozen-lockfile` with Node 24.x and pnpm 11.16.x.
- [ ] Run `pnpm check` and retain the successful output.
- [ ] Confirm no `.zag`, `.stl`, video, SQLite, generated analysis output, or private screenshot is tracked.
- [ ] Open a bounded synthetic ZAG and STL, then verify view controls, section plane, markers, texture, and error handling.
- [ ] Privately open the approved real compatibility samples and confirm dimensions, CRC validation, mesh generation, and texture loading.
- [ ] Verify the film export page at 720p and 1080p, including play, automatic stop, manual stop, and WebM download.
- [ ] Review dependency and GitHub Actions update pull requests; keep workflow actions pinned to full commit SHAs.
- [ ] Confirm the Pages artifact contains only the expected static site files.
- [ ] Decide and add an explicit software license before describing the repository as open source.
- [ ] Tag the tested commit and record browser/GPU limitations in the release notes.
