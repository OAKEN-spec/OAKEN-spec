# Frontend source notes

`frontend/app` contains the site's static pages and client-side modules. The
production build also needs:

- `/app/*` → `frontend/app/*` (pages import `/app/oaken.js` etc.)
- `/oaken/*` → `frontend/brand/oaken/*` (logo, display font)
- `/favicon.png`, `/logo512.png` → `frontend/brand/`
- an HTTP API/indexer for cross-chain lock lists, launches, activity, and
  name-registry indexing. Without it the client-side chain reads still work, but
  list pages will show their read-failure/empty states.

No API keys, wallet keys, user data, captured mirror pages, or build artifacts
are included. Pages may be served by any static file server with the mappings
above; the production site uses a custom static build and a Cloudflare Worker.
