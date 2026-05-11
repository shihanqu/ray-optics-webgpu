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

export function initGpuAcceleration(app, simulator) {
  const state = {
    webgl: {
      supported: Boolean(simulator.glMain)
    },
    webgpu: {
      supported: false,
      ready: false,
      adapter: null,
      device: null,
      error: null
    }
  };

  app.gpuAcceleration = state;
  simulator.gpuAcceleration = state;

  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return state;
  }

  state.webgpu.supported = true;
  navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    .then((adapter) => {
      if (!adapter) {
        state.webgpu.error = 'No WebGPU adapter available';
        return null;
      }

      state.webgpu.adapter = adapter;
      return adapter.requestDevice();
    })
    .then((device) => {
      if (!device) {
        return;
      }

      state.webgpu.device = device;
      state.webgpu.ready = true;
      simulator.updateSimulation(false, true, true);
      device.lost.then((info) => {
        state.webgpu.ready = false;
        state.webgpu.error = info?.message || 'WebGPU device lost';
        simulator.webGpuRayRenderer?.setVisible(false);
      });
    })
    .catch((error) => {
      state.webgpu.ready = false;
      state.webgpu.error = error?.message || String(error);
    });

  return state;
}
