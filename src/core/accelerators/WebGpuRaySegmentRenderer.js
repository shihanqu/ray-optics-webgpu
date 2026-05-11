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

const SHADER_SOURCE = `
struct Uniforms {
  origin: vec2<f32>,
  viewport: vec2<f32>,
  scale: f32,
  lineWidth: f32,
  premultipliedColor: f32,
  coverageScale: f32,
  color: vec4<f32>,
}

@group(0) @binding(0) var<storage, read> segments: array<vec4<f32>>;
@group(0) @binding(1) var<uniform> uniforms: Uniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) sideOffset: f32,
}

@vertex
fn vertexMain(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32
) -> VertexOut {
  let segment = segments[instanceIndex];
  let p1 = vec2<f32>(segment.x, segment.y) * uniforms.scale + uniforms.origin;
  let p2 = vec2<f32>(segment.z, segment.w) * uniforms.scale + uniforms.origin;
  let delta = p2 - p1;
  let segmentLength = max(length(delta), 0.0001);
  let normal = vec2<f32>(-delta.y, delta.x) / segmentLength;
  let halfWidth = max(uniforms.lineWidth, 0.0) * 0.5;
  let geometryHalfWidth = max(halfWidth + 1.0, 1.0);

  var along = 0.0;
  var side = -1.0;
  switch (vertexIndex) {
    case 0u: {
      along = 0.0;
      side = -1.0;
    }
    case 1u: {
      along = 0.0;
      side = 1.0;
    }
    case 2u: {
      along = 1.0;
      side = -1.0;
    }
    case 3u: {
      along = 1.0;
      side = -1.0;
    }
    case 4u: {
      along = 0.0;
      side = 1.0;
    }
    default: {
      along = 1.0;
      side = 1.0;
    }
  }

  let sideOffset = side * geometryHalfWidth;
  let pixelPos = mix(p1, p2, along) + normal * sideOffset;
  var out: VertexOut;
  out.position = vec4<f32>(
    pixelPos.x / uniforms.viewport.x * 2.0 - 1.0,
    1.0 - pixelPos.y / uniforms.viewport.y * 2.0,
    0.0,
    1.0
  );
  out.color = uniforms.color;
  out.sideOffset = sideOffset;
  return out;
}

@fragment
fn fragmentMain(input: VertexOut) -> @location(0) vec4<f32> {
  let lineWidth = max(uniforms.lineWidth, 0.0);
  let halfWidth = lineWidth * 0.5;
  let coverage = min(lineWidth, clamp(halfWidth + 0.5 - abs(input.sideOffset), 0.0, 1.0)) * max(uniforms.coverageScale, 0.0);
  let alpha = input.color.a * coverage;
  if (uniforms.premultipliedColor > 0.5) {
    return vec4<f32>(input.color.rgb * alpha, alpha);
  }
  return vec4<f32>(input.color.rgb, alpha);
}
`;

const POST_PROCESS_SHADER_SOURCE = `
@group(0) @binding(0) var accumulationTexture: texture_2d<f32>;
@group(0) @binding(1) var accumulationSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  var pos = vec2<f32>(-1.0, -1.0);
  switch (vertexIndex) {
    case 0u: {
      pos = vec2<f32>(-1.0, -1.0);
    }
    case 1u: {
      pos = vec2<f32>(1.0, -1.0);
    }
    case 2u: {
      pos = vec2<f32>(-1.0, 1.0);
    }
    case 3u: {
      pos = vec2<f32>(-1.0, 1.0);
    }
    case 4u: {
      pos = vec2<f32>(1.0, -1.0);
    }
    default: {
      pos = vec2<f32>(1.0, 1.0);
    }
  }

  var out: VertexOut;
  out.position = vec4<f32>(pos, 0.0, 1.0);
  out.uv = vec2<f32>(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  return out;
}

@fragment
fn fragmentMain(input: VertexOut) -> @location(0) vec4<f32> {
  let accumulated = textureSample(accumulationTexture, accumulationSampler, input.uv);
  if (accumulated.a <= 0.0) {
    return vec4<f32>(0.0);
  }

  let byteScale = 255.0 / 256.0;
  let straightRgb = min(accumulated.rgb / accumulated.a, vec3<f32>(1.0));
  let sampledRgb = min(straightRgb * byteScale, vec3<f32>(255.0 / 256.0));
  let sampledAlpha = min(accumulated.a * byteScale, 1.0);
  let linearRgb = -log(vec3<f32>(1.0) - sampledRgb) * sampledAlpha;
  let factor = max(max(linearRgb.r, linearRgb.g), linearRgb.b);
  if (factor <= 0.0) {
    return vec4<f32>(0.0);
  }

  let alpha = min(factor, 1.0);
  let rgb = linearRgb / factor;
  return vec4<f32>(rgb * alpha, alpha);
}
`;

const POST_PROCESS_ACCUMULATION_FORMAT = 'rgba16float';

class WebGpuRaySegmentRenderer {
  constructor(canvas, gpuState) {
    this.canvas = canvas;
    this.gpuState = gpuState;
    this.context = null;
    this.device = null;
    this.format = null;
    this.pipeline = null;
    this.pipelineBlendMode = null;
    this.pipelineTargetFormat = null;
    this.segmentBuffer = null;
    this.segmentBufferSize = 0;
    this.boundSegmentBuffer = null;
    this.boundSegmentBufferSize = 0;
    this.uniformBuffer = null;
    this.uniformData = new Float32Array(12);
    this.bindGroup = null;
    this.postProcessPipeline = null;
    this.postProcessTexture = null;
    this.postProcessTextureWidth = 0;
    this.postProcessTextureHeight = 0;
    this.postProcessTextureFormat = null;
    this.postProcessSampler = null;
    this.postProcessBindGroup = null;
    this.lastError = null;
  }

  canRender() {
    return Boolean(
      this.canvas &&
      this.gpuState?.webgpu?.ready &&
      this.gpuState.webgpu.device &&
      typeof navigator !== 'undefined' &&
      navigator.gpu
    );
  }

  setVisible(visible) {
    if (this.canvas?.style) {
      this.canvas.style.display = visible ? 'block' : 'none';
    }
  }

  renderSegments(segments, segmentCount, options) {
    if (!this.canRender() || !segments || segmentCount <= 0 || !options) {
      this.setVisible(false);
      return false;
    }

    try {
      this.ensureConfigured();
      this.ensurePipeline(options.blendMode, this.getSegmentTargetFormat(options));
      this.ensureBuffers(segmentCount);

      const segmentBytes = segmentCount * 4 * Float32Array.BYTES_PER_ELEMENT;
      this.device.queue.writeBuffer(this.segmentBuffer, 0, segments.buffer, segments.byteOffset, segmentBytes);

      this.writeUniforms(options);

      const commandEncoder = this.device.createCommandEncoder();
      const passEncoder = this.beginSegmentRenderPass(commandEncoder, options);

      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, this.bindGroup);
      passEncoder.draw(6, segmentCount);
      passEncoder.end();
      this.encodePostProcessRenderPass(commandEncoder, options);

      this.device.queue.submit([commandEncoder.finish()]);
      this.lastError = null;
      this.setVisible(true);
      return true;
    } catch (error) {
      this.lastError = error;
      this.setVisible(false);
      return false;
    }
  }

  renderGpuSegments(segmentBuffer, segmentBufferSize, indirectBuffer, options) {
    if (!this.canRender() || !segmentBuffer || !indirectBuffer || !options) {
      this.setVisible(false);
      return false;
    }

    try {
      this.ensureConfigured();
      this.ensurePipeline(options.blendMode, this.getSegmentTargetFormat(options));
      this.ensureExternalSegmentBindGroup(segmentBuffer, segmentBufferSize);
      this.writeUniforms(options);

      const commandEncoder = this.device.createCommandEncoder();
      this.encodeGpuSegmentsRenderPass(commandEncoder, segmentBuffer, segmentBufferSize, indirectBuffer, options);
      this.device.queue.submit([commandEncoder.finish()]);
      this.lastError = null;
      this.setVisible(true);
      return true;
    } catch (error) {
      this.lastError = error;
      this.setVisible(false);
      return false;
    }
  }

  encodeGpuSegmentsRenderPass(commandEncoder, segmentBuffer, segmentBufferSize, indirectBuffer, options) {
    this.ensureConfigured();
    this.ensurePipeline(options.blendMode, this.getSegmentTargetFormat(options));
    this.ensureExternalSegmentBindGroup(segmentBuffer, segmentBufferSize);
    this.writeUniforms(options);

    const passEncoder = this.beginSegmentRenderPass(commandEncoder, options);
    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    passEncoder.drawIndirect(indirectBuffer, 0);
    passEncoder.end();
    this.encodePostProcessRenderPass(commandEncoder, options);
  }

  ensureConfigured() {
    const device = this.gpuState.webgpu.device;
    const format = navigator.gpu.getPreferredCanvasFormat();

    if (!this.context) {
      this.context = this.canvas.getContext('webgpu');
    }

    if (this.device !== device || this.format !== format) {
      this.device = device;
      this.format = format;
      this.pipeline = null;
      this.pipelineBlendMode = null;
      this.pipelineTargetFormat = null;
      this.segmentBuffer = null;
      this.segmentBufferSize = 0;
      this.boundSegmentBuffer = null;
      this.boundSegmentBufferSize = 0;
      this.uniformBuffer = null;
      this.bindGroup = null;
      this.postProcessPipeline = null;
      this.postProcessTexture?.destroy?.();
      this.postProcessTexture = null;
      this.postProcessTextureWidth = 0;
      this.postProcessTextureHeight = 0;
      this.postProcessTextureFormat = null;
      this.postProcessSampler = null;
      this.postProcessBindGroup = null;
      this.context.configure({
        device,
        format,
        alphaMode: 'premultiplied'
      });
    }
  }

  ensurePipeline(blendMode = 'source-over', targetFormat = this.format) {
    blendMode = blendMode || 'source-over';
    targetFormat = targetFormat || this.format;
    if (this.pipeline && this.pipelineBlendMode === blendMode && this.pipelineTargetFormat === targetFormat) {
      return;
    }

    const shaderModule = this.device.createShaderModule({ code: SHADER_SOURCE });
    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vertexMain'
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fragmentMain',
        targets: [
          {
            format: targetFormat,
            blend: getBlendState(blendMode)
          }
        ]
      },
      primitive: {
        topology: 'triangle-list'
      }
    });
    this.pipelineBlendMode = blendMode;
    this.pipelineTargetFormat = targetFormat;
    this.bindGroup = null;
  }

  getSegmentTargetFormat(options = {}) {
    return options.postProcessColorTransform ? POST_PROCESS_ACCUMULATION_FORMAT : this.format;
  }

  ensurePostProcessResources(options) {
    const width = Math.max(1, Math.trunc(options.viewportWidth || this.canvas.width || 1));
    const height = Math.max(1, Math.trunc(options.viewportHeight || this.canvas.height || 1));
    const textureFormat = POST_PROCESS_ACCUMULATION_FORMAT;

    if (
      !this.postProcessTexture ||
      this.postProcessTextureWidth !== width ||
      this.postProcessTextureHeight !== height ||
      this.postProcessTextureFormat !== textureFormat
    ) {
      this.postProcessTexture?.destroy?.();
      this.postProcessTextureWidth = width;
      this.postProcessTextureHeight = height;
      this.postProcessTextureFormat = textureFormat;
      this.postProcessTexture = this.device.createTexture({
        size: { width, height },
        format: textureFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      });
      this.postProcessBindGroup = null;
    }

    if (!this.postProcessSampler) {
      this.postProcessSampler = this.device.createSampler({
        minFilter: 'nearest',
        magFilter: 'nearest'
      });
      this.postProcessBindGroup = null;
    }

    this.ensurePostProcessPipeline();

    if (!this.postProcessBindGroup) {
      this.postProcessBindGroup = this.device.createBindGroup({
        layout: this.postProcessPipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: this.postProcessTexture.createView()
          },
          {
            binding: 1,
            resource: this.postProcessSampler
          }
        ]
      });
    }
  }

  ensurePostProcessPipeline() {
    if (this.postProcessPipeline) {
      return;
    }

    const shaderModule = this.device.createShaderModule({ code: POST_PROCESS_SHADER_SOURCE });
    this.postProcessPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vertexMain'
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fragmentMain',
        targets: [
          {
            format: this.format
          }
        ]
      },
      primitive: {
        topology: 'triangle-list'
      }
    });
  }

  ensureBuffers(segmentCount) {
    const requiredSegmentBytes = segmentCount * 4 * Float32Array.BYTES_PER_ELEMENT;
    if (!this.segmentBuffer || this.segmentBufferSize < requiredSegmentBytes) {
      this.segmentBuffer?.destroy?.();
      this.segmentBufferSize = roundUpToPowerOfTwo(requiredSegmentBytes);
      this.segmentBuffer = this.device.createBuffer({
        size: this.segmentBufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      this.boundSegmentBuffer = null;
      this.boundSegmentBufferSize = 0;
      this.bindGroup = null;
    }

    this.ensureUniformBuffer();
    this.ensureExternalSegmentBindGroup(this.segmentBuffer, this.segmentBufferSize);
  }

  ensureUniformBuffer() {
    if (this.uniformBuffer) {
      return;
    }

    this.uniformBuffer = this.device.createBuffer({
      size: 12 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.bindGroup = null;
  }

  ensureExternalSegmentBindGroup(segmentBuffer, segmentBufferSize) {
    this.ensureUniformBuffer();

    if (
      !this.bindGroup ||
      this.boundSegmentBuffer !== segmentBuffer ||
      this.boundSegmentBufferSize !== segmentBufferSize
    ) {
      this.boundSegmentBuffer = segmentBuffer;
      this.boundSegmentBufferSize = segmentBufferSize;
      this.bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: { buffer: segmentBuffer, size: segmentBufferSize }
          },
          {
            binding: 1,
            resource: { buffer: this.uniformBuffer }
          }
        ]
      });
    }
  }

  writeUniforms(options) {
    const uniforms = this.uniformData;
    uniforms.fill(0);
    uniforms[0] = options.originX;
    uniforms[1] = options.originY;
    uniforms[2] = options.viewportWidth;
    uniforms[3] = options.viewportHeight;
    uniforms[4] = options.scale;
    uniforms[5] = options.lineWidth;
    uniforms[6] = options.premultipliedColor ? 1 : 0;
    uniforms[7] = options.coverageScale ?? 1;
    uniforms[8] = options.color[0];
    uniforms[9] = options.color[1];
    uniforms[10] = options.color[2];
    uniforms[11] = options.color[3];
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);
  }

  beginSegmentRenderPass(commandEncoder, options = {}) {
    const view = options.postProcessColorTransform
      ? this.getPostProcessTextureView(options)
      : this.context.getCurrentTexture().createView();

    return commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    });
  }

  getPostProcessTextureView(options) {
    this.ensurePostProcessResources(options);
    return this.postProcessTexture.createView();
  }

  encodePostProcessRenderPass(commandEncoder, options = {}) {
    if (!options.postProcessColorTransform) {
      return;
    }

    this.ensurePostProcessResources(options);
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    });

    passEncoder.setPipeline(this.postProcessPipeline);
    passEncoder.setBindGroup(0, this.postProcessBindGroup);
    passEncoder.draw(6);
    passEncoder.end();
  }
}

function roundUpToPowerOfTwo(value) {
  let result = 1;
  while (result < value) {
    result *= 2;
  }
  return result;
}

function getBlendState(blendMode) {
  if (blendMode === 'linear-additive') {
    return {
      color: {
        srcFactor: 'one',
        dstFactor: 'one',
        operation: 'add'
      },
      alpha: {
        srcFactor: 'one',
        dstFactor: 'one',
        operation: 'add'
      }
    };
  }

  if (blendMode === 'screen') {
    return {
      color: {
        srcFactor: 'one',
        dstFactor: 'one-minus-src',
        operation: 'add'
      },
      alpha: {
        srcFactor: 'one',
        dstFactor: 'one-minus-src-alpha',
        operation: 'add'
      }
    };
  }

  return {
    color: {
      srcFactor: 'src-alpha',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add'
    },
    alpha: {
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add'
    }
  };
}

export default WebGpuRaySegmentRenderer;
