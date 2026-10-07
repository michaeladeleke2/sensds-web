// Copies the microphone's samples (first channel) to the page in 128-sample blocks
class MicTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('sensav-mic-tap', MicTap);
