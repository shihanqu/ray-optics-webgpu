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

const WORKGROUP_SIZE = 128;
const PARAM_BUFFER_SIZE = 128;
const STATS_BUFFER_SIZE = 16;
const INDIRECT_BUFFER_SIZE = 16;

const TRACE_SHADER_SOURCE = `
struct TraceParams {
  rayCount: u32,
  maxDepth: u32,
  maxSegments: u32,
  flags: u32,

  source: vec2<f32>,
  minSegmentLengthSq: f32,
  rayLengthLimit: f32,

  arcP1: vec2<f32>,
  arcP2: vec2<f32>,
  arcP3: vec2<f32>,
  arcCenter: vec2<f32>,

  arcRadiusSq: f32,
  circleRadiusSq: f32,
  epsilon: f32,
  _pad0: f32,

  blockerP1: vec2<f32>,
  blockerP2: vec2<f32>,
  circleCenter: vec2<f32>,
  renderOrigin: vec2<f32>,
  renderViewport: vec2<f32>,
  renderScale: f32,
  _pad1: f32,
}

struct TraceStats {
  segmentCount: atomic<u32>,
  processedRayCount: atomic<u32>,
  overflowed: atomic<u32>,
  maxDepthReached: atomic<u32>,
}

struct DrawIndirectArgs {
  vertexCount: u32,
  instanceCount: u32,
  firstVertex: u32,
  firstInstance: u32,
}

struct Hit {
  ok: bool,
  kind: u32,
  point: vec2<f32>,
  distanceSq: f32,
}

struct LineHit {
  ok: bool,
  point: vec2<f32>,
}

@group(0) @binding(0) var<uniform> params: TraceParams;
@group(0) @binding(1) var<storage, read_write> stats: TraceStats;
@group(0) @binding(2) var<storage, read_write> segments: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> drawArgs: DrawIndirectArgs;

fn distanceSquared(a: vec2<f32>, b: vec2<f32>) -> f32 {
  let d = a - b;
  return dot(d, d);
}

fn intersectionIsOnRay(p: vec2<f32>, rayP1: vec2<f32>, rayP2: vec2<f32>) -> bool {
  return dot(p - rayP1, rayP2 - rayP1) >= 0.0;
}

fn intersectionIsOnSegment(p: vec2<f32>, segmentP1: vec2<f32>, segmentP2: vec2<f32>) -> bool {
  return dot(p - segmentP1, segmentP2 - segmentP1) >= 0.0 &&
    dot(p - segmentP2, segmentP1 - segmentP2) >= 0.0;
}

fn linesIntersection(a1: vec2<f32>, a2: vec2<f32>, b1: vec2<f32>, b2: vec2<f32>) -> LineHit {
  let a = a2.x * a1.y - a1.x * a2.y;
  let b = b2.x * b1.y - b1.x * b2.y;
  let xa = a2.x - a1.x;
  let xb = b2.x - b1.x;
  let ya = a2.y - a1.y;
  let yb = b2.y - b1.y;
  let denominator = xa * yb - xb * ya;

  if (abs(denominator) <= params.epsilon) {
    return LineHit(false, vec2<f32>(0.0, 0.0));
  }

  return LineHit(true, vec2<f32>(
    (a * xb - b * xa) / denominator,
    (a * yb - b * ya) / denominator
  ));
}

fn pointIsOnArc(point: vec2<f32>) -> bool {
  let intersection = linesIntersection(params.arcP1, params.arcP2, params.arcP3, point);
  if (!intersection.ok) {
    return true;
  }

  return !intersectionIsOnSegment(intersection.point, params.arcP3, point);
}

fn emptyHit() -> Hit {
  return Hit(false, 0u, vec2<f32>(0.0, 0.0), -1.0);
}

fn intersectCircle(
  rayP1: vec2<f32>,
  rayP2: vec2<f32>,
  center: vec2<f32>,
  radiusSq: f32,
  kind: u32
) -> Hit {
  let direction = rayP2 - rayP1;
  let rayLength = length(direction);
  if (!(rayLength > 0.0)) {
    return emptyHit();
  }

  let unit = direction / rayLength;
  let centerProjection = dot(center - rayP1, unit);
  let closest = rayP1 + centerProjection * unit;
  let discriminant = radiusSq - distanceSquared(closest, center);
  if (discriminant < -params.epsilon) {
    return emptyHit();
  }

  let offset = sqrt(max(discriminant, 0.0));
  var best = emptyHit();

  let candidateA = closest + unit * offset;
  if (intersectionIsOnRay(candidateA, rayP1, rayP2)) {
    let distanceSq = distanceSquared(rayP1, candidateA);
    if (distanceSq > params.minSegmentLengthSq) {
      best = Hit(true, kind, candidateA, distanceSq);
    }
  }

  let candidateB = closest - unit * offset;
  if (intersectionIsOnRay(candidateB, rayP1, rayP2)) {
    let distanceSq = distanceSquared(rayP1, candidateB);
    if (distanceSq > params.minSegmentLengthSq && (!best.ok || distanceSq < best.distanceSq)) {
      best = Hit(true, kind, candidateB, distanceSq);
    }
  }

  return best;
}

fn intersectArcMirror(rayP1: vec2<f32>, rayP2: vec2<f32>) -> Hit {
  let direction = rayP2 - rayP1;
  let rayLength = length(direction);
  if (!(rayLength > 0.0)) {
    return emptyHit();
  }
  let unit = direction / rayLength;

  let relativeStart = rayP1 - params.arcCenter;
  let radialError = abs(dot(relativeStart, relativeStart) - params.arcRadiusSq);
  if (radialError <= max(params.epsilon, params.arcRadiusSq * 0.00001)) {
    let distanceAlongRay = -2.0 * dot(relativeStart, unit);
    let distanceSq = distanceAlongRay * distanceAlongRay;
    if (distanceAlongRay > 0.0 && distanceSq > params.minSegmentLengthSq) {
      let candidate = rayP1 + unit * distanceAlongRay;
      if (pointIsOnArc(candidate)) {
        return Hit(true, 1u, candidate, distanceSq);
      }
    }
  }

  let centerProjection = dot(params.arcCenter - rayP1, unit);
  let closest = rayP1 + centerProjection * unit;
  let discriminant = params.arcRadiusSq - distanceSquared(closest, params.arcCenter);
  if (discriminant < -params.epsilon) {
    return emptyHit();
  }

  let offset = sqrt(max(discriminant, 0.0));
  var best = emptyHit();
  let candidateA = closest + unit * offset;
  if (pointIsOnArc(candidateA) && intersectionIsOnRay(candidateA, rayP1, rayP2)) {
    let distanceSq = distanceSquared(rayP1, candidateA);
    if (distanceSq > params.minSegmentLengthSq) {
      best = Hit(true, 1u, candidateA, distanceSq);
    }
  }

  let candidateB = closest - unit * offset;
  if (pointIsOnArc(candidateB) && intersectionIsOnRay(candidateB, rayP1, rayP2)) {
    let distanceSq = distanceSquared(rayP1, candidateB);
    if (distanceSq > params.minSegmentLengthSq && (!best.ok || distanceSq < best.distanceSq)) {
      best = Hit(true, 1u, candidateB, distanceSq);
    }
  }

  return best;
}

fn intersectLineSegment(rayP1: vec2<f32>, rayP2: vec2<f32>, segmentP1: vec2<f32>, segmentP2: vec2<f32>) -> Hit {
  let intersection = linesIntersection(rayP1, rayP2, segmentP1, segmentP2);
  if (!intersection.ok) {
    return emptyHit();
  }
  if (!intersectionIsOnSegment(intersection.point, segmentP1, segmentP2)) {
    return emptyHit();
  }
  if (!intersectionIsOnRay(intersection.point, rayP1, rayP2)) {
    return emptyHit();
  }

  let distanceSq = distanceSquared(rayP1, intersection.point);
  if (distanceSq <= params.minSegmentLengthSq) {
    return emptyHit();
  }

  return Hit(true, 2u, intersection.point, distanceSq);
}

fn nearestHit(rayP1: vec2<f32>, rayP2: vec2<f32>) -> Hit {
  var best = emptyHit();
  var bestDistanceSq = 3.4028234663852886e38;

  let arcHit = intersectArcMirror(rayP1, rayP2);
  if (arcHit.ok && arcHit.distanceSq > params.minSegmentLengthSq && arcHit.distanceSq < bestDistanceSq) {
    best = arcHit;
    bestDistanceSq = arcHit.distanceSq;
  }

  let blockerHit = intersectLineSegment(rayP1, rayP2, params.blockerP1, params.blockerP2);
  if (blockerHit.ok && blockerHit.distanceSq > params.minSegmentLengthSq && blockerHit.distanceSq < bestDistanceSq) {
    best = blockerHit;
    bestDistanceSq = blockerHit.distanceSq;
  }

  let circleHit = intersectCircle(rayP1, rayP2, params.circleCenter, params.circleRadiusSq, 3u);
  if (circleHit.ok && circleHit.distanceSq > params.minSegmentLengthSq && circleHit.distanceSq < bestDistanceSq) {
    best = circleHit;
  }

  return best;
}

fn appendSegment(a: vec2<f32>, b: vec2<f32>) -> bool {
  let index = atomicAdd(&stats.segmentCount, 1u);
  if (index >= params.maxSegments) {
    atomicStore(&stats.overflowed, 1u);
    return false;
  }

  segments[index] = vec4<f32>(a.x, a.y, b.x, b.y);
  return true;
}

fn rayRenderLimit(rayP1: vec2<f32>) -> f32 {
  return (
    abs(rayP1.x + params.renderOrigin.x) +
    abs(rayP1.y + params.renderOrigin.y) +
    params.renderViewport.x +
    params.renderViewport.y
  ) / min(1.0, max(params.renderScale, 0.001));
}

fn reflectArc(rayP1: vec2<f32>, hitPoint: vec2<f32>) -> vec2<f32> {
  let incoming = rayP1 - hitPoint;
  let normal = params.arcCenter - hitPoint;
  let normalSq = dot(normal, normal);
  if (!(normalSq > 0.0)) {
    return hitPoint + hitPoint - rayP1;
  }
  return hitPoint - normalSq * incoming + 2.0 * dot(incoming, normal) * normal;
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn traceMain(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let rayIndex = globalId.x;
  if (rayIndex >= params.rayCount) {
    return;
  }

  let angle = f32(rayIndex) * 6.28318530717958647692 / f32(params.rayCount);
  var rayP1 = params.source;
  var rayP2 = params.source + vec2<f32>(sin(angle), cos(angle));
  var depth = 0u;

  loop {
    let hit = nearestHit(rayP1, rayP2);

    if (!hit.ok) {
      let direction = rayP2 - rayP1;
      let rayLength = length(direction);
      if (rayLength > 0.0) {
        _ = appendSegment(rayP1, rayP1 + direction / rayLength * rayRenderLimit(rayP1));
      }
      atomicAdd(&stats.processedRayCount, 1u);
      break;
    }

    let segmentWritten = appendSegment(rayP1, hit.point);
    atomicAdd(&stats.processedRayCount, 1u);
    if (!segmentWritten) {
      break;
    }

    if (hit.kind == 2u || hit.kind == 3u) {
      break;
    }

    depth += 1u;
    if (depth > params.maxDepth) {
      atomicStore(&stats.maxDepthReached, 1u);
      break;
    }

    rayP2 = reflectArc(rayP1, hit.point);
    rayP1 = hit.point;
  }
}

@compute @workgroup_size(1)
fn finalizeMain() {
  drawArgs.vertexCount = 6u;
  drawArgs.instanceCount = min(atomicLoad(&stats.segmentCount), params.maxSegments);
  drawArgs.firstVertex = 0u;
  drawArgs.firstInstance = 0u;
}
`;

class WebGpuSimplePrimitiveTracer {
  constructor(gpuState) {
    this.gpuState = gpuState;
    this.device = null;
    this.bindGroupLayout = null;
    this.tracePipeline = null;
    this.finalizePipeline = null;
    this.bindGroup = null;
    this.paramBuffer = null;
    this.statsBuffer = null;
    this.segmentBuffer = null;
    this.segmentBufferSize = 0;
    this.indirectBuffer = null;
    this.lastError = null;
  }

  canTrace() {
    return Boolean(
      this.gpuState?.webgpu?.ready &&
      this.gpuState.webgpu.device &&
      typeof globalThis.GPUBufferUsage !== 'undefined' &&
      typeof globalThis.GPUShaderStage !== 'undefined' &&
      typeof globalThis.GPUMapMode !== 'undefined'
    );
  }

  ensureResources(segmentCapacity) {
    if (!this.canTrace()) {
      return false;
    }

    const device = this.gpuState.webgpu.device;
    if (this.device !== device) {
      this.device = device;
      this.bindGroupLayout = null;
      this.tracePipeline = null;
      this.finalizePipeline = null;
      this.bindGroup = null;
      this.paramBuffer = null;
      this.statsBuffer = null;
      this.segmentBuffer = null;
      this.segmentBufferSize = 0;
      this.indirectBuffer = null;
    }

    this.ensurePipelines();

    if (!this.paramBuffer) {
      this.paramBuffer = this.device.createBuffer({
        size: PARAM_BUFFER_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this.bindGroup = null;
    }

    if (!this.statsBuffer) {
      this.statsBuffer = this.device.createBuffer({
        size: STATS_BUFFER_SIZE,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
      });
      this.bindGroup = null;
    }

    const requiredSegmentBytes = segmentCapacity * 4 * Float32Array.BYTES_PER_ELEMENT;
    if (!this.segmentBuffer || this.segmentBufferSize < requiredSegmentBytes) {
      this.segmentBuffer?.destroy?.();
      this.segmentBufferSize = roundUpToPowerOfTwo(requiredSegmentBytes);
      this.segmentBuffer = this.device.createBuffer({
        size: this.segmentBufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      });
      this.bindGroup = null;
    }

    if (!this.indirectBuffer) {
      this.indirectBuffer = this.device.createBuffer({
        size: INDIRECT_BUFFER_SIZE,
        usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
      });
      this.bindGroup = null;
    }

    if (!this.bindGroup) {
      this.bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.paramBuffer } },
          { binding: 1, resource: { buffer: this.statsBuffer } },
          { binding: 2, resource: { buffer: this.segmentBuffer, size: this.segmentBufferSize } },
          { binding: 3, resource: { buffer: this.indirectBuffer } }
        ]
      });
    }

    return true;
  }

  ensurePipelines() {
    if (this.tracePipeline && this.finalizePipeline) {
      return;
    }

    const shaderModule = this.device.createShaderModule({ code: TRACE_SHADER_SOURCE });
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' }
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' }
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' }
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' }
        }
      ]
    });
    const layout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout]
    });
    this.tracePipeline = this.device.createComputePipeline({
      layout,
      compute: {
        module: shaderModule,
        entryPoint: 'traceMain'
      }
    });
    this.finalizePipeline = this.device.createComputePipeline({
      layout,
      compute: {
        module: shaderModule,
        entryPoint: 'finalizeMain'
      }
    });
    this.bindGroup = null;
  }

  trace(commandEncoder, traceOptions) {
    const segmentCapacity = traceOptions.segmentCapacity;
    if (!this.ensureResources(segmentCapacity)) {
      return null;
    }

    const rayCount = traceOptions.rayCount;
    const workgroupCount = Math.ceil(rayCount / WORKGROUP_SIZE);
    const params = createParamBufferData(traceOptions);

    this.device.queue.writeBuffer(this.paramBuffer, 0, params);
    this.device.queue.writeBuffer(this.statsBuffer, 0, new Uint32Array([0, 0, 0, 0]));
    this.device.queue.writeBuffer(this.indirectBuffer, 0, new Uint32Array([6, 0, 0, 0]));

    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(this.tracePipeline);
    computePass.setBindGroup(0, this.bindGroup);
    computePass.dispatchWorkgroups(workgroupCount);
    computePass.setPipeline(this.finalizePipeline);
    computePass.setBindGroup(0, this.bindGroup);
    computePass.dispatchWorkgroups(1);
    computePass.end();

    const statsReadBuffer = this.device.createBuffer({
      size: STATS_BUFFER_SIZE,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    commandEncoder.copyBufferToBuffer(this.statsBuffer, 0, statsReadBuffer, 0, STATS_BUFFER_SIZE);

    return {
      segmentBuffer: this.segmentBuffer,
      segmentBufferSize: this.segmentBufferSize,
      indirectBuffer: this.indirectBuffer,
      segmentCapacity,
      rayCount,
      workgroupSize: WORKGROUP_SIZE,
      dispatchWorkgroupCount: workgroupCount,
      readStats: () => this.readStats(statsReadBuffer)
    };
  }

  async readStats(statsReadBuffer) {
    const readbackStart = now();
    await statsReadBuffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint32Array(statsReadBuffer.getMappedRange());
    const stats = {
      segmentCount: mapped[0],
      processedRayCount: mapped[1],
      overflowed: mapped[2],
      maxDepthReached: mapped[3],
      statsReadbackElapsedMs: now() - readbackStart
    };
    statsReadBuffer.unmap();
    statsReadBuffer.destroy?.();
    return stats;
  }
}

function createParamBufferData(options) {
  const buffer = new ArrayBuffer(PARAM_BUFFER_SIZE);
  const view = new DataView(buffer);

  setU32(view, 0, options.rayCount);
  setU32(view, 4, options.maxDepth);
  setU32(view, 8, options.segmentCapacity);
  setU32(view, 12, 0);

  setF32(view, 16, options.sourceX);
  setF32(view, 20, options.sourceY);
  setF32(view, 24, options.minRaySegmentLengthSquared);
  setF32(view, 28, options.rayLengthLimit);

  setF32(view, 32, options.arcMirror.p1x);
  setF32(view, 36, options.arcMirror.p1y);
  setF32(view, 40, options.arcMirror.p2x);
  setF32(view, 44, options.arcMirror.p2y);
  setF32(view, 48, options.arcMirror.p3x);
  setF32(view, 52, options.arcMirror.p3y);
  setF32(view, 56, options.arcMirror.cx);
  setF32(view, 60, options.arcMirror.cy);

  setF32(view, 64, options.arcMirror.radiusSq);
  setF32(view, 68, options.circleBlocker.radiusSq);
  setF32(view, 72, options.epsilon || 1e-7);
  setF32(view, 76, 0);

  setF32(view, 80, options.blocker.x1);
  setF32(view, 84, options.blocker.y1);
  setF32(view, 88, options.blocker.x2);
  setF32(view, 92, options.blocker.y2);
  setF32(view, 96, options.circleBlocker.cx);
  setF32(view, 100, options.circleBlocker.cy);
  setF32(view, 104, options.renderOriginX);
  setF32(view, 108, options.renderOriginY);
  setF32(view, 112, options.renderViewportWidth);
  setF32(view, 116, options.renderViewportHeight);
  setF32(view, 120, options.renderScale);
  setF32(view, 124, 0);

  return buffer;
}

function setU32(view, byteOffset, value) {
  view.setUint32(byteOffset, value >>> 0, true);
}

function setF32(view, byteOffset, value) {
  view.setFloat32(byteOffset, Number(value) || 0, true);
}

function roundUpToPowerOfTwo(value) {
  let result = 1;
  while (result < value) {
    result *= 2;
  }
  return result;
}

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export default WebGpuSimplePrimitiveTracer;
