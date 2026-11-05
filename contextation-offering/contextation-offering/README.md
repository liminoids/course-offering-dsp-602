# Offering application

This is the canonical Cloudflare Worker and frontend. See the [repository guide](../../README.md) for the experience and deployment details.

- Presenter: https://offering.contextation.com/
- Participants: https://offering.contextation.com/join
- Check: `npm run check`
- Deploy: `npm run deploy` (requires your Cloudflare account)

`SITE_PASSWORD` is a Cloudflare runtime Secret. No production password belongs in source control. The existing `ROOM` Durable Object persists the shared room under `room:v2`; deployment does not clear contributions or legacy pins.

Changes pushed to the connected `main` branch trigger Cloudflare's build. Repository-root, outer-folder, and this folder's configurations all point at this same app.
