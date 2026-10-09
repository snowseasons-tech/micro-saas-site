# ScaleKit Storefront

## Build

Install the local development dependency and generate the production Tailwind stylesheet:

```sh
npm install
npm run build
```

The build scans `index.html` and writes a clean, deployable site to `dist/`, including the minified stylesheet. The storefront no longer loads Tailwind from a CDN.

For Cloudflare Pages, use `npm run build` as the build command and `dist` as the build output directory. The project is static and needs no framework preset.

For local preview after building, serve the `dist/` directory with any static web server.

## Launch status

The storefront is a preview: checkout is disabled, and the site does not process payments or deliver purchased products. Connect a real payment provider and fulfillment flow before enabling sales.
