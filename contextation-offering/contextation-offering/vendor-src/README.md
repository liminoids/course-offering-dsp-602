# Compatible map dependencies

`dist/vendor/vector-map.js` is a browser ESM bundle of the imports in
`vector-map-entry.js`. It uses OpenLayers 10.11.0, ol-mapbox-style 13.9.0,
and esbuild 0.25.12. The entry imports the libraries together so their internal
dependencies are present, including the image-state enum used by map icons.
The standalone UMD versions do not expose all those dependencies.

From this application directory, reproduce the bundle without changing the
application's package manifest:

```sh
map_vendor_dir="$(mktemp -d)"
npm install --prefix "$map_vendor_dir" --no-audit --no-fund --save-exact ol@10.11.0 ol-mapbox-style@13.9.0 esbuild@0.25.12
NODE_PATH="$map_vendor_dir/node_modules" "$map_vendor_dir/node_modules/.bin/esbuild" vendor-src/vector-map-entry.js --bundle --format=esm --target=es2020 --minify --legal-comments=inline --outfile=dist/vendor/vector-map.js
cp "$map_vendor_dir/node_modules/ol/ol.css" dist/vendor/ol.css
cp "$map_vendor_dir/node_modules/ol/LICENSE.md" dist/vendor/ol.LICENSE
cp "$map_vendor_dir/node_modules/ol-mapbox-style/LICENSE" dist/vendor/olms.LICENSE
```

Leaflet 1.9.4 provides the controls and SVG offering overlays. Its JS, CSS,
and license are copied unchanged from the official npm package. All vendor
files are loaded only when the 3D renderer cannot run. Both renderers use
OpenFreeMap; the fallback uses ordinary Canvas and does not require WebGL.
