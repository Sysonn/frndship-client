const { DeepFilterNet3Processor } = require('deepfilternet3-noise-filter');

class VoiceIsolationEngine {
  constructor() {
    this.audioCtx = null;
    this.processor = null;
    this.workletNode = null;
  }

  async init() {
    console.log('[Electron VoiceIsolation] 🎙️ Initializing DeepFilterNet 3 WASM engine (48kHz)...');
    // 1. Create a dedicated AudioContext forced to 48kHz (WebRTC standard)
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
    });

    // 2. Initialize DeepFilterNet processor (loads WASM/ONNX binary)
    this.processor = new DeepFilterNet3Processor({
      sampleRate: 48000,
      noiseReductionLevel: 80, // Default suppression strength
    });

    await this.processor.initialize();

    // 3. Create the AudioWorklet node
    this.workletNode = await this.processor.createAudioWorkletNode(this.audioCtx);
    console.log('[Electron VoiceIsolation] ✅ DeepFilterNet 3 AudioWorklet ready!');
  }

  // Set noise reduction level dynamically (0 to 100)
  setSuppression(level) {
    if (this.processor && typeof this.processor.setSuppressionLevel === 'function') {
      this.processor.setSuppressionLevel(level);
      console.log(`[Electron VoiceIsolation] 🎚️ Suppression level set to ${level}%`);
    }
  }

  destroy() {
    if (this.audioCtx) {
      try {
        this.audioCtx.close();
      } catch (e) {
        console.warn('Error closing AudioContext in VoiceIsolationEngine:', e);
      }
    }
    this.audioCtx = null;
    this.processor = null;
    this.workletNode = null;
    console.log('[Electron VoiceIsolation] 🛑 Destroyed AudioContext and WorkletNode');
  }
}

async function getCleanMicrophoneStream(rawStream, filterEngine) {
  if (!filterEngine || !filterEngine.workletNode || !filterEngine.audioCtx) {
    console.warn('[Electron VoiceIsolation] ⚠️ Filter engine unavailable, returning raw microphone stream');
    return rawStream; // Fallback to raw stream if filter is unavailable
  }

  console.log('[Electron VoiceIsolation] 🔊 Piping raw microphone stream through DeepFilterNet 3 AudioWorklet...');
  const audioCtx = filterEngine.audioCtx;

  // 1. Convert raw MediaStream into an AudioNode source
  const sourceNode = audioCtx.createMediaStreamSource(rawStream);

  // 2. Create a destination node that outputs a NEW MediaStream
  const destinationNode = audioCtx.createMediaStreamDestination();

  // 3. Chain: Raw Mic -> DeepFilter Worklet -> Destination Node
  sourceNode
    .connect(filterEngine.workletNode)
    .connect(destinationNode);

  // 4. Extract processed audio track
  const cleanTrack = destinationNode.stream.getAudioTracks()[0];
  console.log('[Electron VoiceIsolation] 🌟 Extracted sanitized audio track:', cleanTrack.label || cleanTrack.id);

  // 5. Reconstruct stream maintaining any original video tracks
  return new MediaStream([cleanTrack, ...rawStream.getVideoTracks()]);
}

module.exports = {
  VoiceIsolationEngine,
  getCleanMicrophoneStream,
};
