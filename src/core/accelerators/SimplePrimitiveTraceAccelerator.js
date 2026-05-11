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

/**
 * Fast path for simple ray-mode scenes made of primitive mirrors/blockers.
 *
 * The simulator's generic loop is intentionally object-polymorphic. That is
 * the right default, but it costs heavily on dense scenes whose optical objects
 * are just a point source, a circular mirror, and blockers. This accelerator is
 * deliberately narrow: it proves the scene shape before running and otherwise
 * returns false so the generic simulator remains the source of truth.
 */

import { getSimplePrimitiveTraceWasmExports } from './SimplePrimitiveTraceWasm.js';
import WebGpuRaySegmentRenderer from './WebGpuRaySegmentRenderer.js';
import WebGpuSimplePrimitiveTracer from './WebGpuSimplePrimitiveTracer.js';

const SUPPORTED_TYPES = new Set(['ArcMirror', 'Blocker', 'CircleBlocker', 'PointSource']);
const WEBGPU_INITIAL_SEGMENT_CAPACITY_MULTIPLIER = 4;
const WEBGPU_COMPUTE_SEGMENT_CAPACITY_MULTIPLIER = 128;
const WEBGPU_COMPUTE_UNLIMITED_MAX_BOUNCES_PER_RAY = 65535;
const WEBGPU_COMPUTE_MIN_SEGMENT_LENGTH = 1e-2;
const WEBGPU_SCREEN_COVERAGE_SCALE = 0.94;
const WEBGPU_VALIDATION_RAY_COUNT_TOLERANCE_FRACTION = 0.005;
const WEBGPU_VALIDATION_RAY_COUNT_MIN_TOLERANCE = 128;

export function tryPrepareSimplePrimitiveTrace(simulator) {
  const plan = buildTracePlan(simulator);
  if (!plan) {
    simulator.simplePrimitiveTracePrepared = null;
    simulator.simplePrimitiveTracePrepareFallbackReasons = getTracePlanFallbackReasons(simulator);
    return false;
  }

  if (webGpuAndWasmDisabled(simulator)) {
    simulator.simplePrimitiveTracePrepared = null;
    simulator.simplePrimitiveTracePrepareFallbackReasons = ['WebGPU/WASM disabled by setting'];
    return false;
  }

  const fallbackReasons = getWebGpuComputeFallbackReasons(simulator, plan);
  simulator.simplePrimitiveTracePrepareFallbackReasons = fallbackReasons;
  if (fallbackReasons.length > 0) {
    simulator.simplePrimitiveTracePrepared = null;
    return false;
  }

  const rayState = getPointSourceRayState(simulator, plan.pointSources[0]);
  if (!rayState) {
    simulator.simplePrimitiveTracePrepared = null;
    return false;
  }

  const computeSceneKey = getWebGpuComputeSceneKey(simulator, plan, rayState);
  if (simulator.simplePrimitiveWebGpuComputeDisabledKey === computeSceneKey) {
    simulator.simplePrimitiveTracePrepared = null;
    simulator.simplePrimitiveTracePrepareFallbackReasons = [
      simulator.simplePrimitiveWebGpuComputeDisabledReason || 'Pure WebGPU trace rejected by validation; using WASM trace with WebGPU rendering'
    ];
    return false;
  }

  simulator.simplePrimitiveTracePrepared = {
    backend: 'simple-primitive-webgpu-compute',
    plan,
    rayState
  };
  simulator.simplePrimitiveTracePrepareFallbackReasons = [];
  simulator.pendingRays = [];
  simulator.brightnessScale = rayState.brightnessScale;
  return true;
}

export function tryProcessSimplePrimitiveTrace(simulator) {
  const prepared = simulator.simplePrimitiveTracePrepared;
  const plan = prepared?.plan || buildTracePlan(simulator);
  if (!plan) {
    simulator.accelerationStats = {
      backend: 'generic-js',
      fallbackReasons: getTracePlanFallbackReasons(simulator)
    };
    return false;
  }

  const scene = simulator.scene;
  let activeRays = simulator.pendingRays.filter(Boolean);
  const colorCache = new Map();
  const rayDash = simulator.getThemeRayDash('colorRay');
  const showRayArrows = scene.showRayArrows;
  const renderer = simulator.canvasRendererMain;
  const shouldDraw = Boolean(renderer);
  const transformColor = !simulator.isSVG && scene.colorMode === 'default';
  const minRaySegmentLengthSquared = simulator.constructor.MIN_RAY_SEGMENT_LENGTH_SQUARED * scene.lengthScale * scene.lengthScale;
  let maxRayDepth = scene.maxRayDepth;
  const webGpuWasmDisabled = webGpuAndWasmDisabled(simulator);
  let webGpuFallbackReasons = webGpuWasmDisabled ? ['WebGPU/WASM disabled by setting'] : [];

  if (shouldDraw && !webGpuWasmDisabled) {
    if (prepared?.backend === 'simple-primitive-webgpu-compute') {
      const computeResult = tryProcessSimplePrimitiveTraceWebGpuCompute(
        simulator,
        plan,
        prepared.rayState,
        minRaySegmentLengthSquared
      );
      if (computeResult) {
        return computeResult;
      }
      simulator.simplePrimitiveTracePrepared = null;
      simulator.seedSimulationRays?.();
      activeRays = simulator.pendingRays.filter(Boolean);
      simulator.simplePrimitiveTracePrepareFallbackReasons = getWebGpuRuntimeFallbackReasons(simulator);
    }

    const computeFallbackReasons = simulator.simplePrimitiveTracePrepareFallbackReasons || [];
    const wasmWebGpuFallbackReasons = getWasmWebGpuFallbackReasons(simulator, plan, activeRays);
    if (wasmWebGpuFallbackReasons.length === 0) {
      if (tryProcessSimplePrimitiveTraceWasmWebGpu(simulator, plan, activeRays, minRaySegmentLengthSquared)) {
        return true;
      }
      webGpuFallbackReasons = [
        ...computeFallbackReasons,
        ...getWebGpuRuntimeFallbackReasons(simulator)
      ];
    } else {
      webGpuFallbackReasons = [
        ...computeFallbackReasons,
        ...wasmWebGpuFallbackReasons
      ];
    }
  }

  if (shouldDraw) {
    simulator.webGpuRayRenderer?.setVisible(false);
  }

  if (!shouldDraw && !webGpuWasmDisabled && tryProcessSimplePrimitiveTraceWasm(simulator, plan, minRaySegmentLengthSquared, webGpuFallbackReasons)) {
    return true;
  }

  if (!Number.isFinite(maxRayDepth)) {
    maxRayDepth = Infinity;
  } else if (maxRayDepth < 0) {
    maxRayDepth = 0;
  }

  simulator.accelerationStats = {
    backend: 'simple-primitive-js',
    supportedObjects: plan.primitives.map((primitive) => primitive.type),
    fallbackReasons: webGpuFallbackReasons,
    webGpuFallbackReasons,
    processedRayCountBefore: simulator.processedRayCount
  };

  let currentWave = activeRays;
  let lastObjIndex = -1;

  while (currentWave.length > 0) {
    const nextWave = [];

    for (let i = 0; i < currentWave.length; i++) {
      const ray = currentWave[i];
      if (!ray) {
        continue;
      }

      if (simulator.processedRayCount > simulator.rayCountLimit) {
        simulator.shouldSimulatorStop = true;
        currentWave = [];
        nextWave.length = 0;
        break;
      }

      const hit = findNearestIntersection(plan, ray, minRaySegmentLengthSquared);
      if (hit?.undefinedBehaviorObjs) {
        simulator.declareUndefinedBehavior(ray, hit.undefinedBehaviorObjs);
      }

      if (shouldDraw) {
        drawRaySegment(simulator, renderer, ray, hit, colorCache, transformColor, showRayArrows, rayDash);
      }

      const hitObjIndex = hit ? hit.objIndex : -1;
      if (lastObjIndex !== hitObjIndex) {
        ray.gap = true;
      }
      ray.isNew = false;
      lastObjIndex = hitObjIndex;

      if (hit) {
        if (ray.depth == null) {
          ray.depth = 0;
        }
        ray.depth += 1;
        const incidentDepth = ray.depth;

        if (ray.depth > maxRayDepth) {
          simulator.totalTruncation += (ray.brightness_s || 0) + (ray.brightness_p || 0);
          simulator.processedRayCount += 1;
          continue;
        }

        if (hit.primitive.kind === 'arcMirror') {
          reflectArcRay(ray, hit, hit.primitive);
          if (ray.depth == null) {
            ray.depth = incidentDepth;
          }
          simulator.processedRayCount += 1;
          nextWave.push(ray);
        } else {
          simulator.processedRayCount += 1;
        }
      } else {
        simulator.processedRayCount += 1;
      }
    }

    currentWave = nextWave;
  }

  simulator.pendingRays = [];
  simulator.pendingRaysIndex = 0;
  simulator.leftRayCount = 0;
  simulator.last_s_obj_index = -1;
  simulator.last_ray = null;
  simulator.last_intersection = null;
  simulator.accelerationStats.processedRayCountAfter = simulator.processedRayCount;

  return true;
}

function tryProcessSimplePrimitiveTraceWebGpuCompute(simulator, plan, rayState, minRaySegmentLengthSquared) {
  if (simulator.isSVG || !rayState || !simulator.canvasLightWebGPU || !simulator.gpuAcceleration?.webgpu?.ready) {
    return false;
  }

  const pointSource = plan.pointSources[0];
  const arcMirror = plan.primitives.find((primitive) => primitive.type === 'ArcMirror');
  const blocker = plan.primitives.find((primitive) => primitive.type === 'Blocker');
  const circleBlocker = plan.primitives.find((primitive) => primitive.type === 'CircleBlocker');
  if (!pointSource || !arcMirror?.hasFiniteCenter || !blocker || !circleBlocker) {
    return false;
  }

  const tracer = getWebGpuSimplePrimitiveTracer(simulator);
  const renderer = getWebGpuRayRenderer(simulator);
  const rayLengthLimit = getRayLengthLimit(simulator);
  const computeSceneKey = getWebGpuComputeSceneKey(simulator, plan, rayState);
  const maxBouncesPerRay = getWebGpuComputeMaxDepth(simulator);
  const segmentCapacity = Math.max(
    rayState.rayCount * WEBGPU_COMPUTE_SEGMENT_CAPACITY_MULTIPLIER,
    rayState.rayCount + 1
  );
  const renderStyle = getWebGpuRayRenderStyle(simulator, rayState.wavelength, rayState.segmentBrightness);
  const renderOptions = {
    originX: simulator.scene.origin.x * simulator.dpr,
    originY: simulator.scene.origin.y * simulator.dpr,
    viewportWidth: simulator.canvasLightWebGPU.width,
    viewportHeight: simulator.canvasLightWebGPU.height,
    scale: simulator.scene.scale * simulator.dpr,
    lineWidth: getWebGpuRayLineWidth(simulator),
    ...renderStyle
  };
  const traceOptions = {
    rayCount: rayState.rayCount,
    maxDepth: maxBouncesPerRay,
    segmentCapacity,
    sourceX: pointSource.x,
    sourceY: pointSource.y,
    minRaySegmentLengthSquared: Math.max(
      minRaySegmentLengthSquared,
      WEBGPU_COMPUTE_MIN_SEGMENT_LENGTH * WEBGPU_COMPUTE_MIN_SEGMENT_LENGTH * simulator.scene.lengthScale * simulator.scene.lengthScale
    ),
    rayLengthLimit,
    renderOriginX: renderOptions.originX,
    renderOriginY: renderOptions.originY,
    renderViewportWidth: renderOptions.viewportWidth,
    renderViewportHeight: renderOptions.viewportHeight,
    renderScale: renderOptions.scale,
    arcMirror,
    blocker,
    circleBlocker
  };

  try {
    const commandEncoder = simulator.gpuAcceleration.webgpu.device.createCommandEncoder();
    const encodeStart = now();
    const traceResult = tracer.trace(commandEncoder, traceOptions);
    if (!traceResult) {
      return false;
    }

    const submitStart = now();
    simulator.gpuAcceleration.webgpu.device.queue.submit([commandEncoder.finish()]);

    simulator.pendingRays = [];
    simulator.pendingRaysIndex = 0;
    simulator.leftRayCount = 0;
    simulator.last_s_obj_index = -1;
    simulator.last_ray = null;
    simulator.last_intersection = null;
    simulator.accelerationStats = {
      backend: 'simple-primitive-webgpu-compute',
      supportedObjects: plan.primitives.map((primitive) => primitive.type),
      processedRayCountBefore: 0,
      processedRayCountAfter: 0,
      rayCount: rayState.rayCount,
      segmentCapacity,
      maxBouncesPerRay,
      workgroupSize: traceResult.workgroupSize,
      dispatchWorkgroupCount: traceResult.dispatchWorkgroupCount,
      computeDispatchElapsedMs: submitStart - encodeStart,
      gpuSubmitElapsedMs: now() - submitStart,
      cpuUploadBytesSaved: segmentCapacity * 4 * Float32Array.BYTES_PER_ELEMENT,
      fallbackReasons: [],
      webGpuFallbackReasons: []
    };

    return {
      pending: true,
      promise: traceResult.readStats().then((stats) => {
        if (stats.overflowed) {
          throw new Error('WebGPU segment buffer overflow');
        }
        if (stats.maxDepthReached) {
          throw new Error('WebGPU max bounce guard reached');
        }
        if (stats.processedRayCount < rayState.rayCount) {
          throw new Error(`WebGPU incomplete ray trace (${stats.processedRayCount}/${rayState.rayCount} rays)`);
        }
        let validationStats = null;
        let displayedProcessedRayCount = stats.processedRayCount;
        if (simulator.simplePrimitiveWebGpuComputeValidatedKey === computeSceneKey) {
          validationStats = simulator.simplePrimitiveWebGpuComputeValidationStats || null;
          if (Number.isFinite(validationStats?.expectedProcessedRayCount)) {
            displayedProcessedRayCount = validationStats.expectedProcessedRayCount;
          }
        } else {
          const expectedProcessedRayCount = getWasmPrimitiveProcessedRayCount(
            simulator,
            pointSource,
            arcMirror,
            blocker,
            circleBlocker,
            minRaySegmentLengthSquared
          );
          if (Number.isFinite(expectedProcessedRayCount)) {
            const rayCountDelta = Math.abs(stats.processedRayCount - expectedProcessedRayCount);
            const rayCountTolerance = getWebGpuValidationRayCountTolerance(expectedProcessedRayCount);
            if (rayCountDelta > rayCountTolerance) {
              throw new Error(`WebGPU/WASM ray count mismatch (${stats.processedRayCount}/${expectedProcessedRayCount})`);
            }
            displayedProcessedRayCount = expectedProcessedRayCount;
            validationStats = {
              webGpuProcessedRayCount: stats.processedRayCount,
              expectedProcessedRayCount,
              rayCountDelta,
              rayCountTolerance
            };
          } else {
            validationStats = null;
          }
          simulator.simplePrimitiveWebGpuComputeValidatedKey = computeSceneKey;
          simulator.simplePrimitiveWebGpuComputeValidationStats = validationStats;
        }

        const renderStart = now();
        const rendered = renderer.renderGpuSegments(
          traceResult.segmentBuffer,
          traceResult.segmentBufferSize,
          traceResult.indirectBuffer,
          renderOptions
        );
        if (!rendered) {
          throw new Error(renderer.lastError ? `WebGPU renderer failed: ${renderer.lastError.message || renderer.lastError}` : 'WebGPU renderer failed');
        }

        simulator.processedRayCount = displayedProcessedRayCount;
        simulator.accelerationStats = {
          ...simulator.accelerationStats,
          processedRayCountAfter: simulator.processedRayCount,
          segmentCount: stats.segmentCount,
          webGpuProcessedRayCount: stats.processedRayCount,
          validationStats,
          overflowCount: stats.overflowed,
          maxDepthReached: stats.maxDepthReached,
          statsReadbackElapsedMs: stats.statsReadbackElapsedMs,
          wasmTraceElapsedMs: undefined,
          traceElapsedMs: undefined,
          segmentBufferElapsedMs: 0,
          renderElapsedMs: now() - renderStart
        };
        return simulator.accelerationStats;
      }).catch((error) => {
        renderer.setVisible(false);
        tracer.lastError = error;
        simulator.simplePrimitiveWebGpuComputeDisabledKey = getWebGpuComputeSceneKey(simulator, plan, rayState);
        simulator.simplePrimitiveWebGpuComputeDisabledReason = `Pure WebGPU trace rejected by validation; using WASM trace with WebGPU rendering: ${error?.message || error}`;
        throw error;
      })
    };
  } catch (error) {
    tracer.lastError = error;
    renderer.setVisible(false);
    return false;
  }
}

function getWebGpuValidationRayCountTolerance(expectedProcessedRayCount) {
  return Math.max(
    WEBGPU_VALIDATION_RAY_COUNT_MIN_TOLERANCE,
    Math.ceil(Math.abs(expectedProcessedRayCount) * WEBGPU_VALIDATION_RAY_COUNT_TOLERANCE_FRACTION)
  );
}

function getWebGpuComputeMaxDepth(simulator) {
  const maxRayDepth = simulator.scene.maxRayDepth;
  if (Number.isFinite(maxRayDepth)) {
    return Math.max(0, Math.min(0xffffffff, Math.floor(maxRayDepth)));
  }
  return WEBGPU_COMPUTE_UNLIMITED_MAX_BOUNCES_PER_RAY;
}

function getWasmPrimitiveProcessedRayCount(
  simulator,
  pointSource,
  arcMirror,
  blocker,
  circleBlocker,
  minRaySegmentLengthSquared
) {
  const wasmExports = getSimplePrimitiveTraceWasmExports();
  if (!wasmExports?.traceCausticPrimitiveScene) {
    return NaN;
  }

  return wasmExports.traceCausticPrimitiveScene(
    simulator.scene.rayDensity,
    pointSource.x,
    pointSource.y,
    Infinity,
    simulator.rayCountLimit,
    minRaySegmentLengthSquared,
    arcMirror.p1x,
    arcMirror.p1y,
    arcMirror.p2x,
    arcMirror.p2y,
    arcMirror.p3x,
    arcMirror.p3y,
    arcMirror.cx,
    arcMirror.cy,
    arcMirror.radiusSq,
    blocker.x1,
    blocker.y1,
    blocker.x2,
    blocker.y2,
    circleBlocker.cx,
    circleBlocker.cy,
    circleBlocker.radiusSq
  );
}

function tryProcessSimplePrimitiveTraceWasmWebGpu(simulator, plan, activeRays, minRaySegmentLengthSquared) {
  if (simulator.isSVG) {
    return false;
  }
  if (simulator.scene.colorMode !== 'default' || simulator.scene.showRayArrows) {
    return false;
  }
  if (simulator.getThemeRayDash('ray')?.length) {
    return false;
  }
  if (!simulator.canvasLightWebGPU || !simulator.gpuAcceleration?.webgpu?.ready) {
    return false;
  }
  if (plan.pointSources.length !== 1 || activeRays.length === 0) {
    return false;
  }
  if (Number.isFinite(simulator.scene.maxRayDepth) || Number.isFinite(simulator.rayCountLimit)) {
    return false;
  }

  const arcMirror = plan.primitives.find((primitive) => primitive.type === 'ArcMirror');
  const blocker = plan.primitives.find((primitive) => primitive.type === 'Blocker');
  const circleBlocker = plan.primitives.find((primitive) => primitive.type === 'CircleBlocker');

  if (!arcMirror?.hasFiniteCenter || !blocker || !circleBlocker) {
    return false;
  }
  if (plan.primitives.length !== 3) {
    return false;
  }
  if (plan.primitives.some((primitive) => primitive.filter.enabled)) {
    return false;
  }

  const wasmExports = getSimplePrimitiveTraceWasmExports();
  if (
    !wasmExports?.traceCausticPrimitiveScene ||
    !wasmExports?.traceCausticPrimitiveSceneSegments ||
    !wasmExports?.getLastProcessedRayCount ||
    !wasmExports?.__new
  ) {
    return false;
  }

  const pointSource = plan.pointSources[0];
  const initialRayCount = Math.max(1, Math.ceil(simulator.scene.rayDensity * 500));
  const initialSegmentCapacity = initialRayCount * WEBGPU_INITIAL_SEGMENT_CAPACITY_MULTIPLIER;
  const rayLengthLimit = getRayLengthLimit(simulator);
  let traceResult = traceCausticSegmentsWithCapacity(
    simulator,
    wasmExports,
    pointSource,
    arcMirror,
    blocker,
    circleBlocker,
    minRaySegmentLengthSquared,
    rayLengthLimit,
    simulator.scene.origin.x * simulator.dpr,
    simulator.scene.origin.y * simulator.dpr,
    simulator.canvasLightWebGPU.width,
    simulator.canvasLightWebGPU.height,
    simulator.scene.scale * simulator.dpr,
    initialSegmentCapacity
  );

  if (traceResult.segmentCount < traceResult.tracedRayCount) {
    traceResult = traceCausticSegmentsWithCapacity(
      simulator,
      wasmExports,
      pointSource,
      arcMirror,
      blocker,
      circleBlocker,
      minRaySegmentLengthSquared,
      rayLengthLimit,
      simulator.scene.origin.x * simulator.dpr,
      simulator.scene.origin.y * simulator.dpr,
      simulator.canvasLightWebGPU.width,
      simulator.canvasLightWebGPU.height,
      simulator.scene.scale * simulator.dpr,
      traceResult.tracedRayCount
    );
  }

  if (traceResult.tracedRayCount <= 0 || traceResult.segmentCount < traceResult.tracedRayCount) {
    return false;
  }

  const renderer = getWebGpuRayRenderer(simulator);
  const firstRay = activeRays[0];
  const alpha = (firstRay.brightness_s || 0) + (firstRay.brightness_p || 0);
  const renderStyle = getWebGpuRayRenderStyle(
    simulator,
    firstRay.wavelength || pointSource.wavelength || simulator.constructor.GREEN_WAVELENGTH,
    alpha
  );
  const segments = new Float32Array(wasmExports.memory.buffer, traceResult.segmentBufferPtr, traceResult.segmentCount * 4);
  const renderStart = now();
  const rendered = renderer.renderSegments(segments, traceResult.segmentCount, {
    originX: simulator.scene.origin.x * simulator.dpr,
    originY: simulator.scene.origin.y * simulator.dpr,
    viewportWidth: simulator.canvasLightWebGPU.width,
    viewportHeight: simulator.canvasLightWebGPU.height,
    scale: simulator.scene.scale * simulator.dpr,
    lineWidth: getWebGpuRayLineWidth(simulator),
    ...renderStyle
  });

  if (!rendered) {
    return false;
  }

  simulator.processedRayCount = traceResult.tracedRayCount;
  simulator.pendingRays = [];
  simulator.pendingRaysIndex = 0;
  simulator.leftRayCount = 0;
  simulator.last_s_obj_index = -1;
  simulator.last_ray = null;
  simulator.last_intersection = null;
  simulator.accelerationStats = {
    backend: 'simple-primitive-wasm-webgpu',
    supportedObjects: plan.primitives.map((primitive) => primitive.type),
    fallbackReasons: simulator.simplePrimitiveTracePrepareFallbackReasons || [],
    webGpuFallbackReasons: simulator.simplePrimitiveTracePrepareFallbackReasons || [],
    processedRayCountBefore: 0,
    processedRayCountAfter: simulator.processedRayCount,
    segmentCount: traceResult.segmentCount,
    segmentCapacity: traceResult.segmentCapacity,
    traceElapsedMs: traceResult.wasmTraceElapsedMs,
    wasmTraceElapsedMs: traceResult.wasmTraceElapsedMs,
    segmentBufferElapsedMs: traceResult.segmentBufferElapsedMs,
    renderElapsedMs: now() - renderStart
  };

  return true;
}

function traceCausticSegmentsWithCapacity(
  simulator,
  wasmExports,
  pointSource,
  arcMirror,
  blocker,
  circleBlocker,
  minRaySegmentLengthSquared,
  rayLengthLimit,
  renderOriginX,
  renderOriginY,
  renderViewportWidth,
  renderViewportHeight,
  renderScale,
  segmentCapacity
) {
  const segmentBufferStart = now();
  const segmentBufferPtr = ensureWasmSegmentBuffer(simulator, wasmExports, segmentCapacity);
  const segmentBufferElapsedMs = now() - segmentBufferStart;
  const traceStart = now();
  const segmentCount = wasmExports.traceCausticPrimitiveSceneSegments(
    simulator.scene.rayDensity,
    pointSource.x,
    pointSource.y,
    Infinity,
    simulator.rayCountLimit,
    minRaySegmentLengthSquared,
    rayLengthLimit,
    segmentBufferPtr,
    segmentCapacity,
    arcMirror.p1x,
    arcMirror.p1y,
    arcMirror.p2x,
    arcMirror.p2y,
    arcMirror.p3x,
    arcMirror.p3y,
    arcMirror.cx,
    arcMirror.cy,
    arcMirror.radiusSq,
    blocker.x1,
    blocker.y1,
    blocker.x2,
    blocker.y2,
    circleBlocker.cx,
    circleBlocker.cy,
    circleBlocker.radiusSq,
    renderOriginX,
    renderOriginY,
    renderViewportWidth,
    renderViewportHeight,
    renderScale
  );

  return {
    segmentBufferPtr,
    segmentCapacity,
    segmentCount,
    tracedRayCount: wasmExports.getLastProcessedRayCount(),
    segmentBufferElapsedMs,
    wasmTraceElapsedMs: now() - traceStart
  };
}

function ensureWasmSegmentBuffer(simulator, wasmExports, segmentCapacity) {
  const byteLength = segmentCapacity * 4 * Float32Array.BYTES_PER_ELEMENT;
  const existing = simulator.simplePrimitiveWasmSegmentBuffer;
  if (existing && existing.byteLength >= byteLength) {
    return existing.ptr;
  }

  if (existing && wasmExports.__unpin) {
    wasmExports.__unpin(existing.ptr);
    wasmExports.__collect?.();
  }

  const rawPtr = wasmExports.__new(byteLength, 0);
  const ptr = wasmExports.__pin ? wasmExports.__pin(rawPtr) : rawPtr;
  simulator.simplePrimitiveWasmSegmentBuffer = {
    ptr,
    byteLength,
    segmentCapacity
  };
  return ptr;
}

function getTracePlanFallbackReasons(simulator) {
  const scene = simulator.scene;
  const reasons = [];

  if (acceleratorsDisabled(simulator)) {
    reasons.push('Accelerators disabled');
  }
  if (scene.mode !== 'rays') {
    reasons.push(`Scene mode is ${scene.mode}`);
  }
  if (scene.observer) {
    reasons.push('Observer mode is active');
  }
  if (simulator.pendingRaysIndex !== -1 || simulator.processedRayCount !== 0) {
    reasons.push('Simulation already in progress');
  }

  const opticalObjs = scene.opticalObjs || [];
  if (opticalObjs.length === 0) {
    reasons.push('No optical objects');
  }

  const unsupportedTypes = [];
  let hasArcMirror = false;
  for (const obj of opticalObjs) {
    const type = obj.constructor.type;
    if (!SUPPORTED_TYPES.has(type)) {
      unsupportedTypes.push(type);
    }
    if (type === 'ArcMirror') {
      hasArcMirror = true;
    }
  }

  if (unsupportedTypes.length > 0) {
    reasons.push(`Scene has unsupported object types: ${[...new Set(unsupportedTypes)].join(', ')}`);
  }
  if (!hasArcMirror && opticalObjs.length > 0) {
    reasons.push('Scene is not the primitive caustics shape');
  }

  return reasons.length > 0 ? reasons : ['Scene is not eligible for the primitive fast path'];
}

function getWebGpuComputeFallbackReasons(simulator, plan) {
  const scene = simulator.scene;
  const reasons = [];

  if (simulator.isSVG) {
    reasons.push('SVG render mode');
  }
  if (scene.mode !== 'rays') {
    reasons.push(`Scene mode is ${scene.mode}`);
  }
  if (scene.colorMode !== 'default') {
    reasons.push('Color mode is not default');
  }
  if (scene.showRayArrows) {
    reasons.push('Ray arrows are enabled');
  }
  if (getActiveRayDash(simulator)?.length) {
    reasons.push('Ray dash pattern is enabled');
  }
  if (!simulator.canvasLightWebGPU) {
    reasons.push('WebGPU canvas is unavailable');
  }
  if (!simulator.gpuAcceleration?.webgpu?.supported) {
    reasons.push('WebGPU unavailable');
  } else if (!simulator.gpuAcceleration?.webgpu?.ready) {
    reasons.push(simulator.gpuAcceleration.webgpu.error ? `WebGPU not ready: ${simulator.gpuAcceleration.webgpu.error}` : 'WebGPU not ready');
  }
  if (
    typeof globalThis.GPUBufferUsage === 'undefined' ||
    typeof globalThis.GPUMapMode === 'undefined' ||
    typeof globalThis.GPUShaderStage === 'undefined'
  ) {
    reasons.push('WebGPU compute constants unavailable');
  }
  if (plan.pointSources.length !== 1) {
    reasons.push(`Expected 1 point source, found ${plan.pointSources.length}`);
  }
  if (!getPointSourceRayState(simulator, plan.pointSources[0])) {
    reasons.push('Point source ray state is not finite');
  }
  if (Number.isFinite(scene.maxRayDepth)) {
    reasons.push('Finite maximum ray depth');
  }
  if (Number.isFinite(simulator.rayCountLimit)) {
    reasons.push('Finite ray count limit');
  }

  const arcMirror = plan.primitives.find((primitive) => primitive.type === 'ArcMirror');
  const blocker = plan.primitives.find((primitive) => primitive.type === 'Blocker');
  const circleBlocker = plan.primitives.find((primitive) => primitive.type === 'CircleBlocker');
  if (!arcMirror?.hasFiniteCenter || !blocker || !circleBlocker || plan.primitives.length !== 3) {
    reasons.push('Scene is not the reflective sphere caustics primitive shape');
  }
  if (plan.primitives.some((primitive) => primitive.filter.enabled)) {
    reasons.push('Optical filters are enabled');
  }

  return reasons;
}

function getWasmWebGpuFallbackReasons(simulator, plan, activeRays) {
  const scene = simulator.scene;
  const reasons = [];

  if (simulator.isSVG) {
    reasons.push('SVG render mode');
  }
  if (scene.colorMode !== 'default') {
    reasons.push('Color mode is not default');
  }
  if (scene.showRayArrows) {
    reasons.push('Ray arrows are enabled');
  }
  if (getActiveRayDash(simulator)?.length) {
    reasons.push('Ray dash pattern is enabled');
  }
  if (!simulator.canvasLightWebGPU) {
    reasons.push('WebGPU canvas is unavailable');
  }
  if (!simulator.gpuAcceleration?.webgpu?.supported) {
    reasons.push('WebGPU unavailable');
  } else if (!simulator.gpuAcceleration?.webgpu?.ready) {
    reasons.push(simulator.gpuAcceleration.webgpu.error ? `WebGPU not ready: ${simulator.gpuAcceleration.webgpu.error}` : 'WebGPU not ready');
  }
  if (plan.pointSources.length !== 1) {
    reasons.push(`Expected 1 point source, found ${plan.pointSources.length}`);
  }
  if (scene.simulateColors && plan.pointSources.length === 1 && plan.primitives.some((primitive) => primitive.filter.enabled)) {
    reasons.push('Simulate Colors has optical filters enabled');
  }
  if (activeRays.length === 0) {
    reasons.push('No active rays');
  }
  if (Number.isFinite(scene.maxRayDepth)) {
    reasons.push('Finite maximum ray depth');
  }
  if (Number.isFinite(simulator.rayCountLimit)) {
    reasons.push('Finite ray count limit');
  }

  const arcMirror = plan.primitives.find((primitive) => primitive.type === 'ArcMirror');
  const blocker = plan.primitives.find((primitive) => primitive.type === 'Blocker');
  const circleBlocker = plan.primitives.find((primitive) => primitive.type === 'CircleBlocker');
  if (!arcMirror?.hasFiniteCenter || !blocker || !circleBlocker || plan.primitives.length !== 3) {
    reasons.push('Scene is not the reflective sphere caustics primitive shape');
  }
  if (plan.primitives.some((primitive) => primitive.filter.enabled)) {
    reasons.push('Optical filters are enabled');
  }

  const wasmExports = getSimplePrimitiveTraceWasmExports();
  if (
    !wasmExports?.traceCausticPrimitiveScene ||
    !wasmExports?.traceCausticPrimitiveSceneSegments ||
    !wasmExports?.getLastProcessedRayCount ||
    !wasmExports?.__new
  ) {
    reasons.push('WASM segment kernel unavailable');
  }

  return reasons;
}

function getWebGpuRuntimeFallbackReasons(simulator) {
  const reasons = [];
  const computeError = simulator.webGpuSimplePrimitiveTracer?.lastError;
  const renderError = simulator.webGpuRayRenderer?.lastError;

  if (computeError) {
    reasons.push(`WebGPU compute failed: ${computeError.message || computeError}`);
  }
  if (renderError) {
    reasons.push(`WebGPU renderer failed: ${renderError.message || renderError}`);
  }
  if (reasons.length === 0) {
    reasons.push('WebGPU renderer failed or was rejected by GPU validation');
  }

  return reasons;
}

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function buildTracePlan(simulator) {
  const scene = simulator.scene;

  if (acceleratorsDisabled(simulator)) {
    return null;
  }
  if (scene.mode !== 'rays') {
    return null;
  }
  if (scene.observer) {
    return null;
  }
  if (simulator.pendingRaysIndex !== -1 || simulator.processedRayCount !== 0) {
    return null;
  }

  const opticalObjs = scene.opticalObjs;
  if (opticalObjs.length === 0) {
    return null;
  }

  const primitives = [];
  const pointSources = [];
  for (let i = 0; i < opticalObjs.length; i++) {
    const obj = opticalObjs[i];
    const type = obj.constructor.type;

    if (!SUPPORTED_TYPES.has(type)) {
      return null;
    }

    if (type === 'PointSource') {
      if (!Number.isFinite(obj.x) || !Number.isFinite(obj.y)) {
        return null;
      }
      pointSources.push(obj);
      continue;
    }

    if (type === 'ArcMirror') {
      const primitive = buildArcMirrorPrimitive(obj, i, scene);
      if (!primitive) {
        return null;
      }
      primitives.push(primitive);
      continue;
    }

    if (type === 'Blocker') {
      const primitive = buildLineBlockerPrimitive(obj, i, scene);
      if (!primitive) {
        return null;
      }
      primitives.push(primitive);
      continue;
    }

    if (type === 'CircleBlocker') {
      const primitive = buildCircleBlockerPrimitive(obj, i, scene);
      if (!primitive) {
        return null;
      }
      primitives.push(primitive);
    }
  }

  if (!primitives.some((primitive) => primitive.kind === 'arcMirror')) {
    return null;
  }

  return { primitives, pointSources, simulateColors: scene.simulateColors };
}

function getWebGpuRayRenderer(simulator) {
  if (!simulator.webGpuRayRenderer) {
    simulator.webGpuRayRenderer = new WebGpuRaySegmentRenderer(simulator.canvasLightWebGPU, simulator.gpuAcceleration);
  }
  simulator.webGpuRayRenderer.canvas = simulator.canvasLightWebGPU;
  simulator.webGpuRayRenderer.gpuState = simulator.gpuAcceleration;
  return simulator.webGpuRayRenderer;
}

function getWebGpuSimplePrimitiveTracer(simulator) {
  if (!simulator.webGpuSimplePrimitiveTracer) {
    simulator.webGpuSimplePrimitiveTracer = new WebGpuSimplePrimitiveTracer(simulator.gpuAcceleration);
  }
  simulator.webGpuSimplePrimitiveTracer.gpuState = simulator.gpuAcceleration;
  return simulator.webGpuSimplePrimitiveTracer;
}

function getActiveRayDash(simulator) {
  return simulator.scene.simulateColors
    ? simulator.getThemeRayDash('colorRay')
    : simulator.getThemeRayDash('ray');
}

function getWebGpuRayLineWidth(simulator) {
  return simulator.scene.lengthScale * simulator.scene.scale * simulator.dpr;
}

function getWebGpuRayRenderStyle(simulator, wavelength, brightness) {
  if (!simulator.scene.simulateColors) {
    return {
      color: simulator.getThemeRayColor('ray', brightness),
      blendMode: 'source-over',
      premultipliedColor: false,
      coverageScale: 1,
      postProcessColorTransform: false
    };
  }

  return {
    color: simulator.wavelengthToColor(wavelength, brightness, true),
    blendMode: 'screen',
    premultipliedColor: true,
    coverageScale: WEBGPU_SCREEN_COVERAGE_SCALE,
    postProcessColorTransform: true
  };
}

function getPointSourceRayState(simulator, pointSource) {
  if (!pointSource || !Number.isFinite(pointSource.x) || !Number.isFinite(pointSource.y)) {
    return null;
  }

  let rayDensity = simulator.scene.rayDensity;
  if (!(rayDensity > 0)) {
    return null;
  }

  let expectBrightness = pointSource.brightness / rayDensity;
  while (simulator.scene.colorMode !== 'default' && expectBrightness > 1) {
    rayDensity += 1 / 500;
    expectBrightness = pointSource.brightness / rayDensity;
  }

  const rayCount = Math.trunc(rayDensity * 500);
  if (rayCount <= 0) {
    return null;
  }

  const segmentBrightness = Math.min(expectBrightness, 1);
  return {
    rayDensity,
    rayCount,
    segmentBrightness,
    brightnessScale: segmentBrightness / expectBrightness,
    wavelength: pointSource.wavelength || simulator.constructor.GREEN_WAVELENGTH
  };
}

function getWebGpuComputeSceneKey(simulator, plan, rayState) {
  const rayLengthLimit = getRayLengthLimit(simulator);
  const primitiveKey = plan.primitives
    .map((primitive) => [
      primitive.type,
      primitive.p1x,
      primitive.p1y,
      primitive.p2x,
      primitive.p2y,
      primitive.p3x,
      primitive.p3y,
      primitive.cx,
      primitive.cy,
      primitive.radiusSq,
      primitive.x1,
      primitive.y1,
      primitive.x2,
      primitive.y2,
      primitive.filter.enabled,
      primitive.filter.invert,
      primitive.filter.wavelength,
      primitive.filter.bandwidth
    ].map(stableKeyNumber).join(':'))
    .join('|');
  return [
    stableKeyNumber(rayState.rayDensity),
    rayState.rayCount,
    stableKeyNumber(rayState.segmentBrightness),
    stableKeyNumber(rayState.wavelength),
    stableKeyNumber(rayLengthLimit),
    stableKeyNumber(simulator.scene.origin.x * simulator.dpr),
    stableKeyNumber(simulator.scene.origin.y * simulator.dpr),
    stableKeyNumber((simulator.canvasLightWebGPU || simulator.ctxMain?.canvas)?.width),
    stableKeyNumber((simulator.canvasLightWebGPU || simulator.ctxMain?.canvas)?.height),
    stableKeyNumber(simulator.scene.scale * simulator.dpr),
    stableKeyNumber(simulator.scene.lengthScale),
    primitiveKey
  ].join('|');
}

function stableKeyNumber(value) {
  return Number.isFinite(value) ? Number(value).toPrecision(12) : String(value);
}

function getRayLengthLimit(simulator) {
  const canvas = simulator.canvasLightWebGPU || simulator.ctxMain?.canvas;
  const viewportWidth = canvas?.width || simulator.scene.width * simulator.dpr;
  const viewportHeight = canvas?.height || simulator.scene.height * simulator.dpr;
  const scale = Math.max(simulator.scene.scale * simulator.dpr, 0.001);
  const originX = Math.abs(simulator.scene.origin.x * simulator.dpr);
  const originY = Math.abs(simulator.scene.origin.y * simulator.dpr);
  return (viewportWidth + viewportHeight + originX + originY) / scale * 2;
}

function tryProcessSimplePrimitiveTraceWasm(simulator, plan, minRaySegmentLengthSquared, webGpuFallbackReasons = []) {
  if (plan.pointSources.length !== 1) {
    return false;
  }
  // The WASM kernel currently covers the default unlimited-depth case. Finite
  // depth limits use the JS path so truncation accounting stays exact.
  if (Number.isFinite(simulator.scene.maxRayDepth)) {
    return false;
  }
  if (Number.isFinite(simulator.rayCountLimit)) {
    return false;
  }

  const arcMirror = plan.primitives.find((primitive) => primitive.type === 'ArcMirror');
  const blocker = plan.primitives.find((primitive) => primitive.type === 'Blocker');
  const circleBlocker = plan.primitives.find((primitive) => primitive.type === 'CircleBlocker');

  if (!arcMirror?.hasFiniteCenter || !blocker || !circleBlocker) {
    return false;
  }
  if (plan.primitives.length !== 3) {
    return false;
  }
  if (plan.primitives.some((primitive) => primitive.filter.enabled)) {
    return false;
  }

  const wasmExports = getSimplePrimitiveTraceWasmExports();
  if (!wasmExports?.traceCausticPrimitiveScene) {
    return false;
  }

  const pointSource = plan.pointSources[0];
  const traceStart = now();
  const processedRayCount = wasmExports.traceCausticPrimitiveScene(
    simulator.scene.rayDensity,
    pointSource.x,
    pointSource.y,
    Infinity,
    simulator.rayCountLimit,
    minRaySegmentLengthSquared,
    arcMirror.p1x,
    arcMirror.p1y,
    arcMirror.p2x,
    arcMirror.p2y,
    arcMirror.p3x,
    arcMirror.p3y,
    arcMirror.cx,
    arcMirror.cy,
    arcMirror.radiusSq,
    blocker.x1,
    blocker.y1,
    blocker.x2,
    blocker.y2,
    circleBlocker.cx,
    circleBlocker.cy,
    circleBlocker.radiusSq
  );
  const wasmTraceElapsedMs = now() - traceStart;

  simulator.processedRayCount = processedRayCount;
  simulator.pendingRays = [];
  simulator.pendingRaysIndex = 0;
  simulator.leftRayCount = 0;
  simulator.last_s_obj_index = -1;
  simulator.last_ray = null;
  simulator.last_intersection = null;
  simulator.accelerationStats = {
    backend: 'simple-primitive-wasm',
    supportedObjects: plan.primitives.map((primitive) => primitive.type),
    fallbackReasons: webGpuFallbackReasons,
    webGpuFallbackReasons,
    processedRayCountBefore: 0,
    processedRayCountAfter: simulator.processedRayCount,
    traceElapsedMs: wasmTraceElapsedMs,
    wasmTraceElapsedMs
  };

  return true;
}

function buildFilterState(obj, scene) {
  return {
    enabled: Boolean(scene.simulateColors && obj.filter && obj.wavelength),
    invert: Boolean(obj.invert),
    wavelength: obj.wavelength,
    bandwidth: obj.bandwidth || 0
  };
}

function buildArcMirrorPrimitive(obj, objIndex, scene) {
  if (!isPoint(obj.p1) || !isPoint(obj.p2) || !isPoint(obj.p3)) {
    return null;
  }

  const center = getCircleCenter(obj.p1.x, obj.p1.y, obj.p2.x, obj.p2.y, obj.p3.x, obj.p3.y);
  const primitive = {
    kind: 'arcMirror',
    type: 'ArcMirror',
    obj,
    objIndex,
    filter: buildFilterState(obj, scene),
    p1x: obj.p1.x,
    p1y: obj.p1.y,
    p2x: obj.p2.x,
    p2y: obj.p2.y,
    p3x: obj.p3.x,
    p3y: obj.p3.y
  };

  if (center) {
    primitive.hasFiniteCenter = true;
    primitive.cx = center.x;
    primitive.cy = center.y;
    primitive.radiusSq = distanceSquared(center.x, center.y, obj.p2.x, obj.p2.y);
  } else {
    primitive.hasFiniteCenter = false;
  }

  return primitive;
}

function buildLineBlockerPrimitive(obj, objIndex, scene) {
  if (!isPoint(obj.p1) || !isPoint(obj.p2)) {
    return null;
  }

  return {
    kind: 'blocker',
    type: 'Blocker',
    obj,
    objIndex,
    filter: buildFilterState(obj, scene),
    x1: obj.p1.x,
    y1: obj.p1.y,
    x2: obj.p2.x,
    y2: obj.p2.y
  };
}

function buildCircleBlockerPrimitive(obj, objIndex, scene) {
  if (!isPoint(obj.p1) || !isPoint(obj.p2)) {
    return null;
  }

  return {
    kind: 'blocker',
    type: 'CircleBlocker',
    obj,
    objIndex,
    filter: buildFilterState(obj, scene),
    cx: obj.p1.x,
    cy: obj.p1.y,
    radiusSq: distanceSquared(obj.p1.x, obj.p1.y, obj.p2.x, obj.p2.y)
  };
}

function findNearestIntersection(plan, ray, minRaySegmentLengthSquared) {
  let bestHit = null;
  let bestDistanceSq = Infinity;
  let undefinedBehaviorObjs = null;

  for (let i = 0; i < plan.primitives.length; i++) {
    const primitive = plan.primitives[i];
    if (!filterAllowsRay(primitive.filter, ray, plan.simulateColors)) {
      continue;
    }

    const hit = intersectPrimitive(primitive, ray, minRaySegmentLengthSquared);
    if (!hit) {
      continue;
    }

    if (bestHit && distanceSquared(bestHit.x, bestHit.y, hit.x, hit.y) < minRaySegmentLengthSquared) {
      undefinedBehaviorObjs = [bestHit.primitive.obj, primitive.obj];
      continue;
    }

    if (hit.distanceSq < bestDistanceSq && hit.distanceSq > minRaySegmentLengthSquared) {
      bestHit = hit;
      bestDistanceSq = hit.distanceSq;
    }
  }

  if (bestHit && undefinedBehaviorObjs) {
    bestHit.undefinedBehaviorObjs = undefinedBehaviorObjs;
  }

  return bestHit;
}

function intersectPrimitive(primitive, ray, minRaySegmentLengthSquared) {
  if (primitive.type === 'ArcMirror') {
    return intersectArcMirror(primitive, ray, minRaySegmentLengthSquared);
  }
  if (primitive.type === 'Blocker') {
    return intersectLineBlocker(primitive, ray);
  }
  if (primitive.type === 'CircleBlocker') {
    return intersectCircleBlocker(primitive, ray, minRaySegmentLengthSquared);
  }
  return null;
}

function intersectArcMirror(primitive, ray, minRaySegmentLengthSquared) {
  if (!primitive.hasFiniteCenter) {
    const hit = intersectLineSegment(primitive.p1x, primitive.p1y, primitive.p2x, primitive.p2y, ray);
    if (!hit || hit.distanceSq <= minRaySegmentLengthSquared) {
      return null;
    }
    hit.primitive = primitive;
    hit.objIndex = primitive.objIndex;
    return hit;
  }

  const intersections = lineCircleIntersections(ray, primitive.cx, primitive.cy, primitive.radiusSq);
  let bestHit = null;
  let bestDistanceSq = Infinity;

  for (let i = 0; i < intersections.length; i++) {
    const point = intersections[i];
    if (!point) {
      continue;
    }
    if (!pointIsOnArc(primitive, point.x, point.y)) {
      continue;
    }
    if (!intersectionIsOnRay(point.x, point.y, ray)) {
      continue;
    }

    const distanceSq = distanceSquared(ray.p1.x, ray.p1.y, point.x, point.y);
    if (distanceSq > minRaySegmentLengthSquared && distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      bestHit = {
        primitive,
        objIndex: primitive.objIndex,
        x: point.x,
        y: point.y,
        distanceSq
      };
    }
  }

  return bestHit;
}

function intersectLineBlocker(primitive, ray) {
  const hit = intersectLineSegment(primitive.x1, primitive.y1, primitive.x2, primitive.y2, ray);
  if (!hit) {
    return null;
  }
  hit.primitive = primitive;
  hit.objIndex = primitive.objIndex;
  return hit;
}

function intersectCircleBlocker(primitive, ray, minRaySegmentLengthSquared) {
  const intersections = lineCircleIntersections(ray, primitive.cx, primitive.cy, primitive.radiusSq);
  let bestHit = null;
  let bestDistanceSq = Infinity;

  for (let i = 0; i < intersections.length; i++) {
    const point = intersections[i];
    if (!point || !intersectionIsOnRay(point.x, point.y, ray)) {
      continue;
    }

    const distanceSq = distanceSquared(ray.p1.x, ray.p1.y, point.x, point.y);
    if (distanceSq > minRaySegmentLengthSquared && distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      bestHit = {
        primitive,
        objIndex: primitive.objIndex,
        x: point.x,
        y: point.y,
        distanceSq
      };
    }
  }

  return bestHit;
}

function reflectArcRay(ray, hit, primitive) {
  const incidentX = hit.x;
  const incidentY = hit.y;
  const rx = ray.p1.x - incidentX;
  const ry = ray.p1.y - incidentY;

  if (primitive.hasFiniteCenter) {
    const cx = primitive.cx - incidentX;
    const cy = primitive.cy - incidentY;
    const cSq = cx * cx + cy * cy;
    const rDotC = rx * cx + ry * cy;

    ray.p1 = { x: incidentX, y: incidentY };
    ray.p2 = {
      x: incidentX - cSq * rx + 2 * rDotC * cx,
      y: incidentY - cSq * ry + 2 * rDotC * cy
    };
    return;
  }

  const mx = primitive.p2x - primitive.p1x;
  const my = primitive.p2y - primitive.p1y;
  ray.p1 = { x: incidentX, y: incidentY };
  ray.p2 = {
    x: incidentX + rx * (my * my - mx * mx) - 2 * ry * mx * my,
    y: incidentY + ry * (mx * mx - my * my) - 2 * rx * mx * my
  };
}

function drawRaySegment(simulator, renderer, ray, hit, colorCache, transformColor, showRayArrows, rayDash) {
  let color;
  if (simulator.scene.simulateColors) {
    const brightness = (ray.brightness_s || 0) + (ray.brightness_p || 0);
    const key = `${ray.wavelength}|${brightness}|${transformColor}`;
    color = colorCache.get(key);
    if (!color) {
      color = simulator.wavelengthToColor(ray.wavelength, brightness, transformColor);
      colorCache.set(key, color);
    }
  } else {
    const alpha = (ray.brightness_s || 0) + (ray.brightness_p || 0);
    color = simulator.getThemeRayColor('ray', alpha);
    rayDash = simulator.getThemeRayDash('ray');
  }

  if (hit) {
    renderer.drawSegment({ p1: ray.p1, p2: { x: hit.x, y: hit.y } }, color, showRayArrows, rayDash);
  } else {
    renderer.drawRay(ray, color, showRayArrows, rayDash);
  }
}

function filterAllowsRay(filter, ray, simulateColors) {
  if (!simulateColors || !filter.enabled) {
    return true;
  }

  const hueMatches = Math.abs(filter.wavelength - ray.wavelength) <= filter.bandwidth;
  return hueMatches !== filter.invert;
}

function intersectLineSegment(x1, y1, x2, y2, ray) {
  const intersection = linesIntersection(ray.p1.x, ray.p1.y, ray.p2.x, ray.p2.y, x1, y1, x2, y2);
  if (!intersection) {
    return null;
  }

  if (!intersectionIsOnSegment(intersection.x, intersection.y, x1, y1, x2, y2)) {
    return null;
  }
  if (!intersectionIsOnRay(intersection.x, intersection.y, ray)) {
    return null;
  }

  return {
    x: intersection.x,
    y: intersection.y,
    distanceSq: distanceSquared(ray.p1.x, ray.p1.y, intersection.x, intersection.y)
  };
}

function lineCircleIntersections(ray, cx, cy, radiusSq) {
  const dx = ray.p2.x - ray.p1.x;
  const dy = ray.p2.y - ray.p1.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (!(length > 0)) {
    return [];
  }

  const ux = dx / length;
  const uy = dy / length;
  const cu = (cx - ray.p1.x) * ux + (cy - ray.p1.y) * uy;
  const px = ray.p1.x + cu * ux;
  const py = ray.p1.y + cu * uy;
  const perpendicularDistanceSq = distanceSquared(px, py, cx, cy);
  const discriminant = radiusSq - perpendicularDistanceSq;
  if (!(discriminant >= 0)) {
    return [];
  }

  const distance = Math.sqrt(discriminant);
  return [
    { x: px + ux * distance, y: py + uy * distance },
    { x: px - ux * distance, y: py - uy * distance }
  ];
}

function pointIsOnArc(primitive, x, y) {
  const intersection = linesIntersection(
    primitive.p1x,
    primitive.p1y,
    primitive.p2x,
    primitive.p2y,
    primitive.p3x,
    primitive.p3y,
    x,
    y
  );

  if (!intersection) {
    return true;
  }

  return !intersectionIsOnSegment(intersection.x, intersection.y, primitive.p3x, primitive.p3y, x, y);
}

function intersectionIsOnRay(x, y, ray) {
  return (x - ray.p1.x) * (ray.p2.x - ray.p1.x) + (y - ray.p1.y) * (ray.p2.y - ray.p1.y) >= 0;
}

function intersectionIsOnSegment(x, y, x1, y1, x2, y2) {
  return (
    (x - x1) * (x2 - x1) + (y - y1) * (y2 - y1) >= 0 &&
    (x - x2) * (x1 - x2) + (y - y2) * (y1 - y2) >= 0
  );
}

function linesIntersection(x1, y1, x2, y2, x3, y3, x4, y4) {
  const a = x2 * y1 - x1 * y2;
  const b = x4 * y3 - x3 * y4;
  const xa = x2 - x1;
  const xb = x4 - x3;
  const ya = y2 - y1;
  const yb = y4 - y3;
  const denominator = xa * yb - xb * ya;
  if (denominator === 0) {
    return null;
  }

  const x = (a * xb - b * xa) / denominator;
  const y = (a * yb - b * ya) / denominator;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return { x, y };
}

function getCircleCenter(x1, y1, x2, y2, x3, y3) {
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-12) {
    return null;
  }

  const x1Sq = x1 * x1 + y1 * y1;
  const x2Sq = x2 * x2 + y2 * y2;
  const x3Sq = x3 * x3 + y3 * y3;
  const x = (x1Sq * (y2 - y3) + x2Sq * (y3 - y1) + x3Sq * (y1 - y2)) / d;
  const y = (x1Sq * (x3 - x2) + x2Sq * (x1 - x3) + x3Sq * (x2 - x1)) / d;

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return { x, y };
}

function distanceSquared(x1, y1, x2, y2) {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return dx * dx + dy * dy;
}

function isPoint(point) {
  return point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function webGpuAndWasmDisabled(simulator) {
  return Boolean(
    simulator?.useWebGpuAndWasm === false ||
    (typeof globalThis !== 'undefined' && globalThis.RAY_OPTICS_DISABLE_WEBGPU_WASM) ||
    (
      typeof process !== 'undefined' &&
      process.env &&
      process.env.RAY_OPTICS_DISABLE_WEBGPU_WASM === '1'
    )
  );
}

function acceleratorsDisabled() {
  if (globalThis.RAY_OPTICS_DISABLE_ACCELERATORS) {
    return true;
  }

  return (
    typeof process !== 'undefined' &&
    process.env &&
    process.env.RAY_OPTICS_DISABLE_ACCELERATORS === '1'
  );
}
