class RealtimeVideoTranslatorAudioWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.sourceSampleRate = sampleRate;
    this.targetSampleRate = options.processorOptions?.targetSampleRate ?? 16000;
    this.buffer = [];
    this.frameSize = Math.round(this.targetSampleRate * 0.04);
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    const output = outputs[0]?.[0];
    if (output) {
      output.set(input.subarray(0, output.length));
    }

    const resampled = this.downsample(input);
    for (let i = 0; i < resampled.length; i += 1) {
      this.buffer.push(resampled[i]);
    }

    while (this.buffer.length >= this.frameSize) {
      const frame = this.buffer.splice(0, this.frameSize);
      const pcm = new Int16Array(frame.length);
      for (let i = 0; i < frame.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, frame[i]));
        pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }

    return true;
  }

  downsample(input) {
    if (this.sourceSampleRate === this.targetSampleRate) {
      return Array.from(input);
    }

    const ratio = this.sourceSampleRate / this.targetSampleRate;
    const outputLength = Math.floor(input.length / ratio);
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(Math.floor((i + 1) * ratio), input.length);
      let sum = 0;
      for (let j = start; j < end; j += 1) sum += input[j];
      output[i] = sum / Math.max(1, end - start);
    }

    return Array.from(output);
  }
}

registerProcessor("rvt-audio-worklet", RealtimeVideoTranslatorAudioWorklet);
