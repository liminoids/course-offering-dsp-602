# Course offering · DSP 602

The website at **https://offering.contextation.com** has two views:

- **`/`** — the password-protected projected map and presenter controls.
- **`/join`** — the public participant form, usable on a phone or computer.

The interface stays spare so the shared movement of the map, the arriving places, and the room's pauses carry the experience. Participants offer a local place, put their screens aside, then receive a hometown invitation when the presenter opens it.

## Deployment

Cloudflare is connected to this repository's `main` branch. The deploy command remains:

```sh
npx wrangler deploy
```

The canonical application is in **`contextation-offering/contextation-offering/`**. The repository-root and outer-folder Wrangler configurations now point to that same application. This supports the existing Cloudflare root-directory settings without accidentally publishing the older landing page.

The Worker name remains `contextation-offering`, its custom domain remains `offering.contextation.com`, and `assets.run_worker_first` stays enabled. Keep **`SITE_PASSWORD` as an encrypted Cloudflare runtime Secret**; its value belongs outside this repository. Existing presenter sign-in and sign-out routes are preserved.

### One production Worker

Only **`contextation-offering`** should build this repository. A second Cloudflare Worker named `course-offering-dsp-602` was also connected. Cloudflare can override the configured Worker name during a build, allowing two projects to compete for the same custom domain. The Wrangler build step now rejects that second target before deployment. Disconnect the duplicate's Git connection under **Settings → Builds** to stop its redundant build jobs; keep the original Worker's connection.

All three Wrangler configurations require the `SITE_PASSWORD` binding before deployment and preserve existing dashboard variables with `keep_vars`. This does not restore a previously deleted value. If the original Worker reports a missing password, add `SITE_PASSWORD` under **contextation-offering → Settings → Variables and Secrets**, choose **Secret**, and deploy it. A build-time environment variable is not the same as a runtime Secret. The password value must never be committed here.

Run the checks from the repository root:

```sh
npm run check
```

## What happens in class

1. Participants open `/join`, optionally give a name, and choose a local place. An empty name is anonymous.
2. After they submit, their screen confirms the place is held and invites them to look up.
3. The presenter begins the local view and can pause or resume it.
4. The presenter opens the hometown invitation. Participant screens update automatically while active.
5. The presenter begins the wider view and closes the offering when ready.

The presenter can enter a place for someone without a device. Resetting the room is a separate, explicit action.

## Shared state

The existing Cloudflare Durable Object binding, class, object name, and `v1` lifecycle migration remain in use. The new room protocol persists under **`room:v2`**. Deploying the update does not erase legacy pins. Runtime restarts and ordinary redeployments retain the new room; an explicit room reset removes its current contributions.

Participant identity uses a random browser cookie. Public state contains that browser's own contribution and aggregate counts; the complete collection and presenter controls require the presenter session. Local places are restricted to about 40 miles of the Whitman starting point. Home/private selections use a generic neighborhood label and approximate coordinates instead of retaining the submitted address.

## Editing

Within the canonical application:

- `dist/join.html`, `dist/join.js`: participant flow and short prompts.
- `dist/index.html`, `dist/host.js`: projected view and facilitator controls.
- `dist/app.css`: the restrained visual interface.
- `dist/map.js`, `dist/map.css`: map selection, breathing, threads, and globe.
- `src/worker.js`: password gate, API routing, and Durable Object integration.
- Other `src/` modules: room rules, search, and configuration.

The 3D map uses MapLibre GL JS and OpenFreeMap. If a browser cannot start that renderer, the participant and presenter maps automatically use an interactive 2D map of the same OpenFreeMap data. That fallback combines Leaflet 1.9.4 controls and overlays with OpenLayers 10.11.0 and ol-mapbox-style 13.9.0 Canvas rendering; these libraries are bundled locally with their licenses. Selection, places, threads, and the shared presentation clock remain available; the final view is a flat world map on those devices. The 3D buildings and rotating globe still require WebGL2. Provider attribution remains visible. Live place search uses Photon, and geographic resources require internet access. The map and projector should be rehearsed on the presentation computer before class.

The earlier standalone Node example is a local development reference. Its `npm run dev` server is not the deployed Cloudflare runtime.
