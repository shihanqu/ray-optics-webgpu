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

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';

const require = createRequire(import.meta.url);
const rayOpticsModule = require('../dist-node/rayOptics.js');
const rayOptics = rayOpticsModule.default || rayOpticsModule;
let createCanvas = null;

try {
  ({ createCanvas } = require('canvas'));
} catch (_error) {
  // A light simulator install may omit the optional native canvas package.
  // In that case benchmarks still run CPU-only, without render contexts.
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const DEFAULT_SCENES = [
  'data/galleryScenes/caustics-from-a-reflective-sphere.json',
  'test/scenes/general/maxRayDepth.json',
  'test/scenes/blocker/Blocker/default.json',
  'test/scenes/glass/Glass/equiv_merge.json',
  'test/scenes/glass/GrinGlass/equiv_body_merge.json',
  'test/scenes/glass/IdealLens/positive.json',
  'test/scenes/glass/SphericalLens/equiv_plano_convex.json',
  'test/scenes/mirror/CustomMirror/default.json',
  'test/scenes/mirror/ParabolicMirror/default.json'
];

const usage = `Usage: node scripts/benchmarkScenes.mjs [options]

Options:
  --scene <path>       Scene JSON to benchmark. May be repeated.
  --all                Benchmark every scene JSON under test/scenes.
  --iterations <n>     Number of times to run each scene. Default: 1.
  --ray-limit <n>      Override simulator ray count limit for all scenes.
  --json               Print machine-readable JSON instead of a table.
  --list-defaults      Print the default scene list and exit.
  --help               Show this help message.

Run via "npm run benchmark:scenes" so dist-node/rayOptics.js is rebuilt first.`;

function parseArgs(argv) {
  const options = {
    scenes: [],
    all: false,
    iterations: 1,
    rayLimit: null,
    json: false,
    listDefaults: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') {
      console.log(usage);
      process.exit(0);
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--list-defaults') {
      options.listDefaults = true;
      continue;
    }
    if (arg === '--all') {
      options.all = true;
      continue;
    }
    if (arg === '--scene') {
      const value = argv[++i];
      if (!value) throw new Error('--scene requires a path');
      options.scenes.push(value);
      continue;
    }
    if (arg === '--iterations') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--iterations must be a positive integer');
      }
      options.iterations = value;
      continue;
    }
    if (arg === '--ray-limit') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--ray-limit must be a positive number');
      }
      options.rayLimit = value;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (options.all && options.scenes.length > 0) {
    throw new Error('--all cannot be combined with --scene');
  }

  if (options.all) {
    options.scenes = listSceneFiles(path.resolve(rootDir, 'test/scenes'));
  } else if (options.scenes.length === 0) {
    options.scenes = DEFAULT_SCENES;
  }

  return options;
}

function resolveScenePath(scenePath) {
  return path.isAbsolute(scenePath) ? scenePath : path.resolve(rootDir, scenePath);
}

function listSceneFiles(dir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSceneFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(path.relative(rootDir, entryPath));
    }
  }

  return files.sort();
}

function loadScene(scene, scenePath) {
  const sceneJson = JSON.parse(fs.readFileSync(scenePath, 'utf8'));

  return new Promise((resolve) => {
    scene.loadJSON(JSON.stringify(sceneJson), function (_needFullUpdate, completed) {
      if (completed) resolve();
    });
  });
}

function applyCropBoxViewport(scene, cropBox) {
  scene.scale = cropBox.width / (cropBox.p4.x - cropBox.p1.x);
  scene.origin = { x: -cropBox.p1.x * scene.scale, y: -cropBox.p1.y * scene.scale };

  if (
    cropBox.transparent &&
    scene.theme.background.color.r === 0 &&
    scene.theme.background.color.g === 0 &&
    scene.theme.background.color.b === 0
  ) {
    scene.theme.background.color = { r: 0.01, g: 0.01, b: 0.01 };
  }
}

function createSimulator(scene, cropBox, rayLimitOverride) {
  if (!cropBox || !createCanvas) {
    if (cropBox) {
      applyCropBoxViewport(scene, cropBox);
    }

    return new rayOptics.Simulator(
      scene,
      null,
      null,
      null,
      null,
      null,
      false,
      rayLimitOverride || cropBox?.rayCountLimit || Infinity,
      null,
      null,
      null
    );
  }

  const canvasLight = createCanvas();
  const canvasBelowLight = createCanvas();
  const canvasAboveLight = createCanvas();
  const canvasGrid = createCanvas();
  const canvasVirtual = createCanvas();

  const imageWidth = cropBox.width;
  const imageHeight = cropBox.width * (cropBox.p4.y - cropBox.p1.y) / (cropBox.p4.x - cropBox.p1.x);

  [canvasLight, canvasBelowLight, canvasAboveLight, canvasGrid, canvasVirtual].forEach((canvas) => {
    canvas.width = imageWidth;
    canvas.height = imageHeight;
  });

  applyCropBoxViewport(scene, cropBox);

  return new rayOptics.Simulator(
    scene,
    canvasLight.getContext('2d'),
    canvasBelowLight.getContext('2d'),
    canvasAboveLight.getContext('2d'),
    canvasGrid.getContext('2d'),
    canvasVirtual.getContext('2d'),
    false,
    rayLimitOverride || cropBox.rayCountLimit || 1e7,
    null,
    null,
    (width, height) => createCanvas(width, height)
  );
}

async function benchmarkScene(scenePath, rayLimitOverride) {
  const scene = new rayOptics.Scene();
  await loadScene(scene, scenePath);

  const cropBox = scene.objs.find((obj) => obj.constructor.type === 'CropBox');
  const simulator = createSimulator(scene, cropBox, rayLimitOverride);
  const renderMode = cropBox && createCanvas ? 'canvas' : 'cpu-only';

  let completion = 'unknown';
  const start = performance.now();

  await new Promise((resolve) => {
    simulator.eventListeners = {};
    simulator.on('simulationComplete', () => {
      completion = 'complete';
      resolve();
    });
    simulator.on('simulationStop', () => {
      completion = 'stopped';
      resolve();
    });
    simulator.updateSimulation(false, false);
  });

  const elapsedMs = performance.now() - start;
  const processedRayCount = simulator.processedRayCount || 0;

  return {
    scene: path.relative(rootDir, scenePath),
    completion,
    renderMode,
    elapsedMs,
    processedRayCount,
    raysPerMs: elapsedMs > 0 ? processedRayCount / elapsedMs : 0,
    totalTruncation: simulator.totalTruncation,
    totalUndefinedBehavior: simulator.totalUndefinedBehavior,
    brightnessScale: simulator.brightnessScale,
    accelerator: simulator.accelerationStats?.backend || 'generic-js',
    error: simulator.error,
    warning: simulator.warning
  };
}

function summarizeRuns(scene, runs) {
  const elapsedValues = runs.map((run) => run.elapsedMs);
  const rayValues = runs.map((run) => run.processedRayCount);
  const averageElapsedMs = elapsedValues.reduce((sum, value) => sum + value, 0) / elapsedValues.length;
  const averageProcessedRayCount = rayValues.reduce((sum, value) => sum + value, 0) / rayValues.length;

  return {
    scene,
    iterations: runs.length,
    averageElapsedMs,
    minElapsedMs: Math.min(...elapsedValues),
    maxElapsedMs: Math.max(...elapsedValues),
    averageProcessedRayCount,
    averageRaysPerMs: averageElapsedMs > 0 ? averageProcessedRayCount / averageElapsedMs : 0,
    completions: [...new Set(runs.map((run) => run.completion))],
    renderModes: [...new Set(runs.map((run) => run.renderMode))],
    accelerators: [...new Set(runs.map((run) => run.accelerator))],
    errors: [...new Set(runs.map((run) => run.error).filter(Boolean))],
    warnings: [...new Set(runs.map((run) => run.warning).filter(Boolean))]
  };
}

function printTable(summaries) {
  const rows = summaries.map((summary) => ({
    Scene: summary.scene,
    Runs: summary.iterations,
    'Avg ms': summary.averageElapsedMs.toFixed(1),
    'Min ms': summary.minElapsedMs.toFixed(1),
    'Max ms': summary.maxElapsedMs.toFixed(1),
    'Avg rays': Math.round(summary.averageProcessedRayCount),
    'Rays/ms': summary.averageRaysPerMs.toFixed(1),
    Render: summary.renderModes.join(','),
    Accelerator: summary.accelerators.join(','),
    Status: summary.completions.join(','),
    Notes: [...summary.errors, ...summary.warnings].join(' | ')
  }));

  console.table(rows);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.listDefaults) {
    console.log(DEFAULT_SCENES.join('\n'));
    return;
  }

  const summaries = [];
  const allRuns = [];

  for (const sceneArg of options.scenes) {
    const scenePath = resolveScenePath(sceneArg);
    if (!fs.existsSync(scenePath)) {
      throw new Error(`Scene does not exist: ${scenePath}`);
    }

    const runs = [];
    for (let i = 0; i < options.iterations; i++) {
      runs.push(await benchmarkScene(scenePath, options.rayLimit));
    }

    allRuns.push(...runs);
    summaries.push(summarizeRuns(path.relative(rootDir, scenePath), runs));
  }

  if (options.json) {
    console.log(JSON.stringify({ summaries, runs: allRuns }, null, 2));
  } else {
    printTable(summaries);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
