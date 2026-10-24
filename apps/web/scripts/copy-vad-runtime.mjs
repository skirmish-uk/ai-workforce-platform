// Copies the ONNX Runtime WebAssembly build into public/vad/, where the call page loads it from to
// run the Silero voice detector (src/app/dashboard/agents/[id]/speech-detector.ts). Loaded at run
// time rather than bundled, so Next's bundler never touches it. Runs before dev and build.
import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const dist = dirname(require.resolve('onnxruntime-web'))
const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'vad')
mkdirSync(target, { recursive: true })
for (const file of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  copyFileSync(join(dist, file), join(target, file))
}
