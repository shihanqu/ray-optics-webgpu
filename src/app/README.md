# `src/app`

This directory contains the source code for the simulator app, which is to be built by webpack.

- `src/app/main.js` is the entry point for the simulator app.
- `src/app/index.html` is the HTML page for the simulator app. It includes an inline script tag for fast initial loading. The locale data is generated at build time by `scripts/buildInlineLocaleData.mjs` and injected into the script tag.

- `src/app/components` contains the Vue components for the simulator app.

See the [documentation](https://github.com/shihanqu/ray-optics-webgpu/tree/master/src) for more information. The documentation is generated from the jsdoc comments in the code.