/*
 * Copyright 2026 The Ray Optics Simulation authors and contributors
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

import galleryList from '../../../data/galleryList.json';
import englishGalleryLocale from '../../../locales/en/gallery.json';

const sceneContext = require.context('../../../data/galleryScenes', false, /\.json$/);
const backgroundImageContext = require.context('../../../data/galleryScenes', false, /\.png$/);

const galleryStrings = englishGalleryLocale.galleryData || {};
const categoryStrings = englishGalleryLocale.galleryPage?.categories || {};
const sceneIds = sceneContext.keys().map((key) => key.replace('./', '').replace(/\.json$/, ''));
const sceneIdSet = new Set(sceneIds);
const backgroundImages = {};

for (const key of backgroundImageContext.keys()) {
  const fileName = key.replace('./', '');
  const imageModule = backgroundImageContext(key);
  backgroundImages[fileName] = imageModule?.default || imageModule;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function idToCamelCase(id) {
  return id.toLowerCase().replace(/-([a-z])/g, (match, char) => char.toUpperCase());
}

function getSceneLocaleStrings(id) {
  return galleryStrings[idToCamelCase(id)] || {};
}

function getSceneTitle(id) {
  return getSceneLocaleStrings(id).title || id;
}

function replaceTextLabels(value, sceneStrings) {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => replaceTextLabels(item, sceneStrings));
    return;
  }

  if (value.type === 'TextLabel' && typeof value.text === 'string' && value.text.startsWith('{{') && value.text.endsWith('}}')) {
    const stringId = value.text.substring(2, value.text.length - 2);
    value.text = sceneStrings[stringId] || galleryStrings.common?.[stringId] || value.text;
    return;
  }

  for (const key in value) {
    replaceTextLabels(value[key], sceneStrings);
  }
}

function applyPreviewCrop(sceneData) {
  let cropBoxPreview = null;
  let cropBoxThumbnail = null;

  for (const obj of sceneData.objs || []) {
    if (obj.type === 'CropBox') {
      if (Math.abs((obj.p4.x - obj.p1.x) - (obj.p4.y - obj.p1.y)) < 1e-6) {
        cropBoxThumbnail = obj;
      } else {
        cropBoxPreview = obj;
      }
    }
  }

  if (!cropBoxPreview && cropBoxThumbnail) {
    return;
  }

  if (cropBoxPreview) {
    let effectiveWidth = cropBoxPreview.p4.x - cropBoxPreview.p1.x;
    let effectiveHeight = cropBoxPreview.p4.y - cropBoxPreview.p1.y;
    let effectiveOriginX = cropBoxPreview.p1.x;
    let effectiveOriginY = cropBoxPreview.p1.y;
    const padding = effectiveWidth * 0.25;

    effectiveWidth += padding * 2;
    effectiveHeight += padding * 2;
    effectiveOriginX -= padding;
    effectiveOriginY -= padding;

    sceneData.width = effectiveWidth;
    sceneData.height = effectiveHeight;
    sceneData.origin = { x: -effectiveOriginX, y: -effectiveOriginY };
    sceneData.scale = 1;
  }
}

export function getGalleryCatalog() {
  return galleryList.map((category) => {
    const items = category.content
      .filter((item) => sceneIdSet.has(item.id))
      .map((item) => ({
        id: item.id,
        beta: Boolean(item.beta),
        contributors: item.contributors || [],
        title: getSceneTitle(item.id),
        description: getSceneLocaleStrings(item.id).description || '',
        categoryId: category.id,
        categoryTitle: categoryStrings[idToCamelCase(category.id)] || category.id
      }));

    return {
      id: category.id,
      title: categoryStrings[idToCamelCase(category.id)] || category.id,
      items
    };
  });
}

export function getGallerySceneJSON(id) {
  if (!sceneIdSet.has(id)) {
    return null;
  }

  const sceneModule = sceneContext(`./${id}.json`);
  const sceneData = cloneJson(sceneModule?.default || sceneModule);
  const sceneStrings = getSceneLocaleStrings(id);

  sceneData.name = sceneStrings.title || sceneData.name || id;
  replaceTextLabels(sceneData, sceneStrings);
  applyPreviewCrop(sceneData);

  if (sceneData.backgroundImage && backgroundImages[sceneData.backgroundImage]) {
    sceneData.backgroundImage = backgroundImages[sceneData.backgroundImage];
  }

  return JSON.stringify(sceneData);
}
