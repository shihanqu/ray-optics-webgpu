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

let hitX: f64 = 0.0;
let hitY: f64 = 0.0;
let tmpX: f64 = 0.0;
let tmpY: f64 = 0.0;
let lastProcessedRayCount: i32 = 0;
let lastSegmentCount: i32 = 0;

export function getLastProcessedRayCount(): i32 {
  return lastProcessedRayCount;
}

export function getLastSegmentCount(): i32 {
  return lastSegmentCount;
}

export function traceCausticPrimitiveScene(
  rayDensity: f64,
  sourceX: f64,
  sourceY: f64,
  maxRayDepth: f64,
  rayCountLimit: f64,
  minRaySegmentLengthSquared: f64,
  arcP1X: f64,
  arcP1Y: f64,
  arcP2X: f64,
  arcP2Y: f64,
  arcP3X: f64,
  arcP3Y: f64,
  arcCenterX: f64,
  arcCenterY: f64,
  arcRadiusSquared: f64,
  blockerX1: f64,
  blockerY1: f64,
  blockerX2: f64,
  blockerY2: f64,
  circleCenterX: f64,
  circleCenterY: f64,
  circleRadiusSquared: f64
): i32 {
  const rayCount = <i32>(rayDensity * 500.0);
  lastProcessedRayCount = 0;
  lastSegmentCount = 0;
  if (rayCount <= 0) return 0;

  const step = Math.PI * 2.0 / <f64>rayCount;
  let processed = 0;

  for (let k = 0; k < rayCount; k++) {
    let angle = <f64>k * step;
    let rayP1X = sourceX;
    let rayP1Y = sourceY;
    let rayP2X = sourceX + Math.sin(angle);
    let rayP2Y = sourceY + Math.cos(angle);
    let depth = 0.0;

    while (true) {
      if (<f64>processed > rayCountLimit) {
        lastProcessedRayCount = processed;
        return processed;
      }

      let bestKind = 0;
      let bestX = 0.0;
      let bestY = 0.0;
      let bestDistanceSq = Infinity;

      let distanceSq = intersectArcMirror(
        rayP1X,
        rayP1Y,
        rayP2X,
        rayP2Y,
        minRaySegmentLengthSquared,
        arcP1X,
        arcP1Y,
        arcP2X,
        arcP2Y,
        arcP3X,
        arcP3Y,
        arcCenterX,
        arcCenterY,
        arcRadiusSquared
      );
      if (distanceSq > minRaySegmentLengthSquared && distanceSq < bestDistanceSq) {
        bestKind = 1;
        bestDistanceSq = distanceSq;
        bestX = hitX;
        bestY = hitY;
      }

      distanceSq = intersectLineSegment(rayP1X, rayP1Y, rayP2X, rayP2Y, blockerX1, blockerY1, blockerX2, blockerY2);
      if (distanceSq > minRaySegmentLengthSquared && distanceSq < bestDistanceSq) {
        bestKind = 2;
        bestDistanceSq = distanceSq;
        bestX = hitX;
        bestY = hitY;
      }

      distanceSq = intersectCircle(rayP1X, rayP1Y, rayP2X, rayP2Y, circleCenterX, circleCenterY, circleRadiusSquared, minRaySegmentLengthSquared);
      if (distanceSq > minRaySegmentLengthSquared && distanceSq < bestDistanceSq) {
        bestKind = 3;
        bestDistanceSq = distanceSq;
        bestX = hitX;
        bestY = hitY;
      }

      processed += 1;

      if (bestKind == 0 || bestKind == 2 || bestKind == 3) {
        break;
      }

      depth += 1.0;
      if (depth > maxRayDepth) {
        break;
      }

      const incomingX = rayP1X - bestX;
      const incomingY = rayP1Y - bestY;
      const normalX = arcCenterX - bestX;
      const normalY = arcCenterY - bestY;
      const normalSq = normalX * normalX + normalY * normalY;
      const incomingDotNormal = incomingX * normalX + incomingY * normalY;

      rayP1X = bestX;
      rayP1Y = bestY;
      rayP2X = bestX - normalSq * incomingX + 2.0 * incomingDotNormal * normalX;
      rayP2Y = bestY - normalSq * incomingY + 2.0 * incomingDotNormal * normalY;
    }
  }

  lastProcessedRayCount = processed;
  return processed;
}

export function traceCausticPrimitiveSceneSegments(
  rayDensity: f64,
  sourceX: f64,
  sourceY: f64,
  maxRayDepth: f64,
  rayCountLimit: f64,
  minRaySegmentLengthSquared: f64,
  rayLengthLimit: f64,
  segmentBufferPtr: usize,
  maxSegments: i32,
  arcP1X: f64,
  arcP1Y: f64,
  arcP2X: f64,
  arcP2Y: f64,
  arcP3X: f64,
  arcP3Y: f64,
  arcCenterX: f64,
  arcCenterY: f64,
  arcRadiusSquared: f64,
  blockerX1: f64,
  blockerY1: f64,
  blockerX2: f64,
  blockerY2: f64,
  circleCenterX: f64,
  circleCenterY: f64,
  circleRadiusSquared: f64,
  renderOriginX: f64,
  renderOriginY: f64,
  renderViewportWidth: f64,
  renderViewportHeight: f64,
  renderScale: f64
): i32 {
  const rayCount = <i32>(rayDensity * 500.0);
  lastProcessedRayCount = 0;
  lastSegmentCount = 0;
  if (rayCount <= 0) return 0;

  const step = Math.PI * 2.0 / <f64>rayCount;
  let processed = 0;
  let segmentCount = 0;

  for (let k = 0; k < rayCount; k++) {
    let angle = <f64>k * step;
    let rayP1X = sourceX;
    let rayP1Y = sourceY;
    let rayP2X = sourceX + Math.sin(angle);
    let rayP2Y = sourceY + Math.cos(angle);
    let depth = 0.0;

    while (true) {
      if (<f64>processed > rayCountLimit) {
        lastProcessedRayCount = processed;
        lastSegmentCount = segmentCount;
        return segmentCount;
      }

      let bestKind = 0;
      let bestX = 0.0;
      let bestY = 0.0;
      let bestDistanceSq = Infinity;

      let distanceSq = intersectArcMirror(
        rayP1X,
        rayP1Y,
        rayP2X,
        rayP2Y,
        minRaySegmentLengthSquared,
        arcP1X,
        arcP1Y,
        arcP2X,
        arcP2Y,
        arcP3X,
        arcP3Y,
        arcCenterX,
        arcCenterY,
        arcRadiusSquared
      );
      if (distanceSq > minRaySegmentLengthSquared && distanceSq < bestDistanceSq) {
        bestKind = 1;
        bestDistanceSq = distanceSq;
        bestX = hitX;
        bestY = hitY;
      }

      distanceSq = intersectLineSegment(rayP1X, rayP1Y, rayP2X, rayP2Y, blockerX1, blockerY1, blockerX2, blockerY2);
      if (distanceSq > minRaySegmentLengthSquared && distanceSq < bestDistanceSq) {
        bestKind = 2;
        bestDistanceSq = distanceSq;
        bestX = hitX;
        bestY = hitY;
      }

      distanceSq = intersectCircle(rayP1X, rayP1Y, rayP2X, rayP2Y, circleCenterX, circleCenterY, circleRadiusSquared, minRaySegmentLengthSquared);
      if (distanceSq > minRaySegmentLengthSquared && distanceSq < bestDistanceSq) {
        bestKind = 3;
        bestDistanceSq = distanceSq;
        bestX = hitX;
        bestY = hitY;
      }

      if (bestKind == 0) {
        const rayDX = rayP2X - rayP1X;
        const rayDY = rayP2Y - rayP1Y;
        const rayLength = Math.sqrt(rayDX * rayDX + rayDY * rayDY);
        if (rayLength > 0.0 && segmentCount < maxSegments) {
          const renderLimit = getRayRenderLimit(
            rayP1X,
            rayP1Y,
            renderOriginX,
            renderOriginY,
            renderViewportWidth,
            renderViewportHeight,
            renderScale
          );
          writeSegment(
            segmentBufferPtr,
            segmentCount,
            rayP1X,
            rayP1Y,
            rayP1X + rayDX / rayLength * renderLimit,
            rayP1Y + rayDY / rayLength * renderLimit
          );
          segmentCount += 1;
        }
      } else if (segmentCount < maxSegments) {
        writeSegment(segmentBufferPtr, segmentCount, rayP1X, rayP1Y, bestX, bestY);
        segmentCount += 1;
      }

      processed += 1;

      if (bestKind == 0 || bestKind == 2 || bestKind == 3) {
        break;
      }

      depth += 1.0;
      if (depth > maxRayDepth) {
        break;
      }

      const incomingX = rayP1X - bestX;
      const incomingY = rayP1Y - bestY;
      const normalX = arcCenterX - bestX;
      const normalY = arcCenterY - bestY;
      const normalSq = normalX * normalX + normalY * normalY;
      const incomingDotNormal = incomingX * normalX + incomingY * normalY;

      rayP1X = bestX;
      rayP1Y = bestY;
      rayP2X = bestX - normalSq * incomingX + 2.0 * incomingDotNormal * normalX;
      rayP2Y = bestY - normalSq * incomingY + 2.0 * incomingDotNormal * normalY;
    }
  }

  lastProcessedRayCount = processed;
  lastSegmentCount = segmentCount;
  return segmentCount;
}

function writeSegment(bufferPtr: usize, index: i32, x1: f64, y1: f64, x2: f64, y2: f64): void {
  const offset = bufferPtr + <usize>index * 16;
  store<f32>(offset, <f32>x1);
  store<f32>(offset + 4, <f32>y1);
  store<f32>(offset + 8, <f32>x2);
  store<f32>(offset + 12, <f32>y2);
}

function getRayRenderLimit(
  rayP1X: f64,
  rayP1Y: f64,
  renderOriginX: f64,
  renderOriginY: f64,
  renderViewportWidth: f64,
  renderViewportHeight: f64,
  renderScale: f64
): f64 {
  const scale = renderScale > 0.001 ? renderScale : 0.001;
  const denominator = scale < 1.0 ? scale : 1.0;
  return (
    Math.abs(rayP1X + renderOriginX) +
    Math.abs(rayP1Y + renderOriginY) +
    renderViewportHeight +
    renderViewportWidth
  ) / denominator;
}

function intersectArcMirror(
  rayP1X: f64,
  rayP1Y: f64,
  rayP2X: f64,
  rayP2Y: f64,
  minRaySegmentLengthSquared: f64,
  arcP1X: f64,
  arcP1Y: f64,
  arcP2X: f64,
  arcP2Y: f64,
  arcP3X: f64,
  arcP3Y: f64,
  arcCenterX: f64,
  arcCenterY: f64,
  arcRadiusSquared: f64
): f64 {
  const dx = rayP2X - rayP1X;
  const dy = rayP2Y - rayP1Y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (!(length > 0.0)) return -1.0;

  const ux = dx / length;
  const uy = dy / length;
  const centerProjection = (arcCenterX - rayP1X) * ux + (arcCenterY - rayP1Y) * uy;
  const closestX = rayP1X + centerProjection * ux;
  const closestY = rayP1Y + centerProjection * uy;
  const discriminant = arcRadiusSquared - distanceSquared(closestX, closestY, arcCenterX, arcCenterY);
  if (!(discriminant >= 0.0)) return -1.0;

  const offset = Math.sqrt(discriminant);
  let bestDistanceSq = -1.0;

  let candidateX = closestX + ux * offset;
  let candidateY = closestY + uy * offset;
  if (
    pointIsOnArc(candidateX, candidateY, arcP1X, arcP1Y, arcP2X, arcP2Y, arcP3X, arcP3Y) &&
    intersectionIsOnRay(candidateX, candidateY, rayP1X, rayP1Y, rayP2X, rayP2Y)
  ) {
    const distanceSq = distanceSquared(rayP1X, rayP1Y, candidateX, candidateY);
    if (distanceSq > minRaySegmentLengthSquared) {
      bestDistanceSq = distanceSq;
      hitX = candidateX;
      hitY = candidateY;
    }
  }

  candidateX = closestX - ux * offset;
  candidateY = closestY - uy * offset;
  if (
    pointIsOnArc(candidateX, candidateY, arcP1X, arcP1Y, arcP2X, arcP2Y, arcP3X, arcP3Y) &&
    intersectionIsOnRay(candidateX, candidateY, rayP1X, rayP1Y, rayP2X, rayP2Y)
  ) {
    const distanceSq = distanceSquared(rayP1X, rayP1Y, candidateX, candidateY);
    if (distanceSq > minRaySegmentLengthSquared && (bestDistanceSq < 0.0 || distanceSq < bestDistanceSq)) {
      bestDistanceSq = distanceSq;
      hitX = candidateX;
      hitY = candidateY;
    }
  }

  return bestDistanceSq;
}

function intersectCircle(
  rayP1X: f64,
  rayP1Y: f64,
  rayP2X: f64,
  rayP2Y: f64,
  circleCenterX: f64,
  circleCenterY: f64,
  radiusSquared: f64,
  minRaySegmentLengthSquared: f64
): f64 {
  const dx = rayP2X - rayP1X;
  const dy = rayP2Y - rayP1Y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (!(length > 0.0)) return -1.0;

  const ux = dx / length;
  const uy = dy / length;
  const centerProjection = (circleCenterX - rayP1X) * ux + (circleCenterY - rayP1Y) * uy;
  const closestX = rayP1X + centerProjection * ux;
  const closestY = rayP1Y + centerProjection * uy;
  const discriminant = radiusSquared - distanceSquared(closestX, closestY, circleCenterX, circleCenterY);
  if (!(discriminant >= 0.0)) return -1.0;

  const offset = Math.sqrt(discriminant);
  let bestDistanceSq = -1.0;

  let candidateX = closestX + ux * offset;
  let candidateY = closestY + uy * offset;
  if (intersectionIsOnRay(candidateX, candidateY, rayP1X, rayP1Y, rayP2X, rayP2Y)) {
    const distanceSq = distanceSquared(rayP1X, rayP1Y, candidateX, candidateY);
    if (distanceSq > minRaySegmentLengthSquared) {
      bestDistanceSq = distanceSq;
      hitX = candidateX;
      hitY = candidateY;
    }
  }

  candidateX = closestX - ux * offset;
  candidateY = closestY - uy * offset;
  if (intersectionIsOnRay(candidateX, candidateY, rayP1X, rayP1Y, rayP2X, rayP2Y)) {
    const distanceSq = distanceSquared(rayP1X, rayP1Y, candidateX, candidateY);
    if (distanceSq > minRaySegmentLengthSquared && (bestDistanceSq < 0.0 || distanceSq < bestDistanceSq)) {
      bestDistanceSq = distanceSq;
      hitX = candidateX;
      hitY = candidateY;
    }
  }

  return bestDistanceSq;
}

function intersectLineSegment(
  rayP1X: f64,
  rayP1Y: f64,
  rayP2X: f64,
  rayP2Y: f64,
  segmentP1X: f64,
  segmentP1Y: f64,
  segmentP2X: f64,
  segmentP2Y: f64
): f64 {
  if (!linesIntersection(rayP1X, rayP1Y, rayP2X, rayP2Y, segmentP1X, segmentP1Y, segmentP2X, segmentP2Y)) {
    return -1.0;
  }

  if (!intersectionIsOnSegment(tmpX, tmpY, segmentP1X, segmentP1Y, segmentP2X, segmentP2Y)) {
    return -1.0;
  }
  if (!intersectionIsOnRay(tmpX, tmpY, rayP1X, rayP1Y, rayP2X, rayP2Y)) {
    return -1.0;
  }

  hitX = tmpX;
  hitY = tmpY;
  return distanceSquared(rayP1X, rayP1Y, tmpX, tmpY);
}

function pointIsOnArc(
  x: f64,
  y: f64,
  arcP1X: f64,
  arcP1Y: f64,
  arcP2X: f64,
  arcP2Y: f64,
  arcP3X: f64,
  arcP3Y: f64
): bool {
  if (!linesIntersection(arcP1X, arcP1Y, arcP2X, arcP2Y, arcP3X, arcP3Y, x, y)) {
    return true;
  }

  return !intersectionIsOnSegment(tmpX, tmpY, arcP3X, arcP3Y, x, y);
}

function linesIntersection(
  x1: f64,
  y1: f64,
  x2: f64,
  y2: f64,
  x3: f64,
  y3: f64,
  x4: f64,
  y4: f64
): bool {
  const a = x2 * y1 - x1 * y2;
  const b = x4 * y3 - x3 * y4;
  const xa = x2 - x1;
  const xb = x4 - x3;
  const ya = y2 - y1;
  const yb = y4 - y3;
  const denominator = xa * yb - xb * ya;
  if (denominator == 0.0) {
    return false;
  }

  tmpX = (a * xb - b * xa) / denominator;
  tmpY = (a * yb - b * ya) / denominator;
  return Number.isFinite(tmpX) && Number.isFinite(tmpY);
}

function intersectionIsOnRay(x: f64, y: f64, rayP1X: f64, rayP1Y: f64, rayP2X: f64, rayP2Y: f64): bool {
  return (x - rayP1X) * (rayP2X - rayP1X) + (y - rayP1Y) * (rayP2Y - rayP1Y) >= 0.0;
}

function intersectionIsOnSegment(x: f64, y: f64, segmentP1X: f64, segmentP1Y: f64, segmentP2X: f64, segmentP2Y: f64): bool {
  return (
    (x - segmentP1X) * (segmentP2X - segmentP1X) + (y - segmentP1Y) * (segmentP2Y - segmentP1Y) >= 0.0 &&
    (x - segmentP2X) * (segmentP1X - segmentP2X) + (y - segmentP2Y) * (segmentP1Y - segmentP2Y) >= 0.0
  );
}

function distanceSquared(x1: f64, y1: f64, x2: f64, y2: f64): f64 {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return dx * dx + dy * dy;
}
