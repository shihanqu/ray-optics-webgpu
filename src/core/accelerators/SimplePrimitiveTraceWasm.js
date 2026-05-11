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

import wasmDataUrl from './simplePrimitiveTrace.wasm';

let wasmExports = null;
let wasmUnavailable = false;

export function getSimplePrimitiveTraceWasmExports() {
  if (wasmExports || wasmUnavailable) {
    return wasmExports;
  }

  if (typeof WebAssembly === 'undefined') {
    wasmUnavailable = true;
    return null;
  }

  try {
    const bytes = decodeWasmDataUrl(wasmDataUrl);
    const wasmModule = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(wasmModule, {
      env: {
        abort() {
          throw new Error('WebAssembly accelerator aborted');
        }
      }
    });
    wasmExports = instance.exports;
    return wasmExports;
  } catch (_error) {
    wasmUnavailable = true;
    return null;
  }
}

function decodeWasmDataUrl(dataUrl) {
  const commaIndex = dataUrl.indexOf(',');
  const base64 = commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);

  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }

  throw new Error('No base64 decoder available for WebAssembly accelerator');
}
