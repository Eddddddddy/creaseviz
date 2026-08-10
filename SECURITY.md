# Security policy

## Supported version

Security fixes are applied to the current `main` branch. This project has not yet published a stable versioned release.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature for the repository. Do not include real scan archives, device serial numbers, acquisition names, access tokens, or other personal or laboratory data in a public issue.

Include a minimal synthetic reproduction, the affected browser and version, the expected behavior, and the observed impact. If a real file is essential to reproduce the issue, first agree on a private transfer method with the repository owner.

## Data boundary

CreaseViz processes ZAG and STL files locally in the browser. The application does not require a server-side upload endpoint. Repository checks reject common raw-scan and recorded-video file types as well as known local metadata patterns.
