import { Worker } from 'node:worker_threads'
import type { SpectrumFrame } from '../core/types.js'

const workerSource = String.raw`
const { parentPort } = require('node:worker_threads')

const size = 2048
const hop = 1024
const sampleRate = 48000
const bandCount = 64
let samples = []
let processed = 0
let offset = 0

const reverseBits = (value, bits) => {
  let result = 0
  for (let i = 0; i < bits; i += 1) {
    result = (result << 1) | (value & 1)
    value >>= 1
  }
  return result
}

const fft = (input) => {
  const real = new Float64Array(size)
  const imag = new Float64Array(size)
  const bits = Math.log2(size)
  for (let i = 0; i < size; i += 1) {
    const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)))
    real[reverseBits(i, bits)] = input[i] * window
  }
  for (let length = 2; length <= size; length *= 2) {
    const angle = (-2 * Math.PI) / length
    for (let start = 0; start < size; start += length) {
      for (let i = 0; i < length / 2; i += 1) {
        const cos = Math.cos(angle * i)
        const sin = Math.sin(angle * i)
        const even = start + i
        const odd = even + length / 2
        const oddReal = real[odd] * cos - imag[odd] * sin
        const oddImag = real[odd] * sin + imag[odd] * cos
        const evenReal = real[even]
        const evenImag = imag[even]
        real[even] = evenReal + oddReal
        imag[even] = evenImag + oddImag
        real[odd] = evenReal - oddReal
        imag[odd] = evenImag - oddImag
      }
    }
  }
  return { real, imag }
}

const makeBands = (real, imag) => {
  const bins = new Array(bandCount).fill(0)
  let peak = 0
  for (let band = 0; band < bandCount; band += 1) {
    const low = 40 * Math.pow(18000 / 40, band / bandCount)
    const high = 40 * Math.pow(18000 / 40, (band + 1) / bandCount)
    const from = Math.max(1, Math.floor((low * size) / sampleRate))
    const to = Math.min(size / 2, Math.ceil((high * size) / sampleRate))
    let energy = 0
    let count = 0
    for (let index = from; index < to; index += 1) {
      const magnitude = Math.hypot(real[index], imag[index]) / (size / 2)
      energy += magnitude * magnitude
      count += 1
    }
    const rms = Math.sqrt(energy / Math.max(1, count))
    const db = 20 * Math.log10(Math.max(rms, 1e-8))
    const normalized = Math.max(0, Math.min(1, (db + 72) / 72))
    bins[band] = normalized
    peak = Math.max(peak, normalized)
  }
  return { bins, peak }
}

const processFrames = () => {
  while (samples.length >= size) {
    const frame = samples.slice(0, size)
    const { real, imag } = fft(frame)
    const data = makeBands(real, imag)
    parentPort.postMessage({
      position: offset + processed / sampleRate,
      bins: data.bins,
      peak: data.peak,
    })
    samples = samples.slice(hop)
    processed += hop
  }
}

parentPort.on('message', (message) => {
  if (message.type === 'reset') {
    samples = []
    processed = 0
    offset = message.offset || 0
    return
  }
  const pcm = new Int16Array(message.buffer)
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    samples.push(((pcm[i] || 0) + (pcm[i + 1] || 0)) / 65536)
  }
  processFrames()
})
`

export class SpectrumAnalyzer {
  private readonly worker = new Worker(workerSource, { eval: true })
  private frames: SpectrumFrame[] = []

  constructor(offset = 0) {
    this.worker.postMessage({ type: 'reset', offset })
    this.worker.on('message', (frame: SpectrumFrame) => {
      this.frames.push(frame)
      if (this.frames.length > 900) this.frames.splice(0, this.frames.length - 900)
    })
  }

  push(buffer: Buffer) {
    const copy = Buffer.from(buffer)
    const arrayBuffer = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength)
    this.worker.postMessage({ type: 'pcm', buffer: arrayBuffer }, [arrayBuffer])
  }

  frameAt(position: number): SpectrumFrame {
    let result = this.frames[0]
    for (const frame of this.frames) {
      if (frame.position > position + 0.08) break
      result = frame
    }
    return result || { position, bins: new Array(64).fill(0), peak: 0 }
  }

  async destroy() {
    this.frames = []
    await this.worker.terminate()
  }
}
