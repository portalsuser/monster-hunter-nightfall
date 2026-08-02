# _portals/

Portals injects a managed `sdk.js` into this folder when it processes or
publishes the project, and replaces it on every build.

Do **not** download, commit or edit `_portals/sdk.js` — see
https://portals.to/documentation/advanced-tooling/portals-sdk

`index.html` references `./_portals/sdk.js` with an `onerror` guard, so the
404 you see when running locally is expected. `src/portals.js` detects the
missing SDK and falls back to `localStorage` for saved progress.
