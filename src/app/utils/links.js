/*
 * Copyright 2025 The Ray Optics Simulation authors and contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


export function mapURL(url) {
  const localeData = window.localeData[window.lang];
  const route = (localeData.route !== undefined) ? localeData.route : '/' + window.lang;
  const rootURL = '..'
  const urlMap = {
    "/home": rootURL + (localeData.home ? route : '') + '/',
    "/gallery": rootURL + (localeData.gallery ? route : '') + '/gallery/',
    "/modules/modules": rootURL + (localeData.modules ? route : '') + '/modules/modules.html',
    "/about": rootURL + (localeData.about ? route : '') + '/about',
    "/email": "mailto:ray-optics@phydemo.app",
    "/github": "https://github.com/shihanqu/ray-optics-webgpu",
    "/github/issues": "https://github.com/shihanqu/ray-optics-webgpu/issues",
    "/github/discussions": "https://github.com/shihanqu/ray-optics-webgpu/discussions",
    "/run-locally": "https://github.com/shihanqu/ray-optics-webgpu/blob/master/run-locally/README.md",
    "/integrations": "https://github.com/shihanqu/ray-optics-webgpu/tree/dist-integrations",
    "/contributing": "https://github.com/shihanqu/ray-optics-webgpu/blob/master/CONTRIBUTING.md",
    "/contributing/gallery": "https://github.com/shihanqu/ray-optics-webgpu/blob/master/CONTRIBUTING.md#contributing-items-to-the-gallery",
    "/contributing/modules": "https://github.com/shihanqu/ray-optics-webgpu/blob/master/CONTRIBUTING.md#contributing-modules",
    "/weblate": "https://hosted.weblate.org/engage/ray-optics-simulation/",
    "/ai-tools/chatgpt": "https://chatgpt.com/g/g-6777588b53708191b66722e353e95125-ray-optics-coder",
    "/ai-tools/instructions": "https://github.com/shihanqu/ray-optics-webgpu/blob/master/ai-tools",
    "/mathjs/syntax": "https://mathjs.org/docs/expressions/syntax.html"
  };
  return urlMap[url] || url;
}

// Parse the markdown-like links in the text with mapURL and return the HTML.
export function parseLinks(text) {
  return text.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, function (match, text, url) {
    if (url === '/gallery') {
      return `<button type="button" data-bs-toggle="modal" data-bs-target="#galleryModal" class="inline-link-button">${text}</button>`;
    }
    if (text === 'ray-optics@phydemo.app') {
      // Prevent link from wrapping.
      return `<a href="${mapURL(url)}" target="_blank" style="white-space: nowrap;">${text}</a>`;
    } else {
      return `<a href="${mapURL(url)}" target="_blank">${text}</a>`;
    }
  });
}
