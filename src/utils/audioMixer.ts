export interface DuckingParams {
  bgmVolume: number;      // Normal BGM volume (0 to 1)
  duckedVolume: number;   // Ducked BGM volume (0 to 1)
  thresholdDb: number;    // Threshold in dB above which we duck (e.g. -35dB)
  duckSpeed: number;      // Fade-out time in seconds (e.g. 0.15s)
  restoreSpeed: number;   // Fade-in time in seconds (e.g. 0.35s)
  holdTime: number;       // Duration in seconds to hold ducking after speech ends (e.g. 0.4s)
}

export interface AudioPlaybackState {
  audioCtx: AudioContext;
  narrationSource: AudioBufferSourceNode | null;
  bgmSource: AudioBufferSourceNode | null;
  narrationGain: GainNode;
  bgmGain: GainNode;
  masterGain: GainNode;
  startTime: number;
  pauseTime: number;
  isPlaying: boolean;
}

/**
 * Calculates the BGM volume envelope for smart ducking.
 * Uses a hold-time hangover filter to keep BGM ducked during short speech pauses.
 */
export function calculateDuckingEnvelope(
  narrationBuffer: AudioBuffer,
  params: DuckingParams
): { time: number; volume: number }[] {
  const sampleRate = narrationBuffer.sampleRate;
  const channelData = narrationBuffer.getChannelData(0);
  const totalSamples = channelData.length;
  const duration = narrationBuffer.duration;

  const thresholdAmp = Math.pow(10, params.thresholdDb / 20);
  const stepTime = 0.05; // 50ms step size
  const stepSamples = Math.floor(sampleRate * stepTime);

  // 1. Detect raw active voice states
  const stepsCount = Math.ceil(totalSamples / stepSamples);
  const voiceActive = new Array<boolean>(stepsCount).fill(false);

  for (let s = 0; s < stepsCount; s++) {
    const startIdx = s * stepSamples;
    const endIdx = Math.min(startIdx + stepSamples, totalSamples);
    if (endIdx <= startIdx) break;

    let sumSquares = 0;
    for (let j = startIdx; j < endIdx; j++) {
      sumSquares += channelData[j] * channelData[j];
    }
    const rms = Math.sqrt(sumSquares / (endIdx - startIdx));
    if (rms > thresholdAmp) {
      voiceActive[s] = true;
    }
  }

  // 2. Apply holdTime hangover (smooth out short gaps in speaking)
  const holdSteps = Math.ceil(params.holdTime / stepTime);
  const smoothedActive = [...voiceActive];

  for (let s = 0; s < stepsCount; s++) {
    if (voiceActive[s]) {
      // Extend active state forward by holdSteps
      const limit = Math.min(s + holdSteps, stepsCount);
      for (let k = s + 1; k < limit; k++) {
        smoothedActive[k] = true;
      }
    }
  }

  // 3. Generate keyframes for gain scheduling
  const envelope: { time: number; volume: number }[] = [];
  
  // Starting state
  envelope.push({ time: 0, volume: smoothedActive[0] ? params.duckedVolume : params.bgmVolume });

  let currentVolumeState = smoothedActive[0] ? params.duckedVolume : params.bgmVolume;

  for (let s = 1; s < stepsCount; s++) {
    const time = s * stepTime;
    const isVoice = smoothedActive[s];
    const targetVolume = isVoice ? params.duckedVolume : params.bgmVolume;

    if (targetVolume !== currentVolumeState) {
      if (isVoice) {
        // Voice starts: duck BGM
        envelope.push({ time, volume: params.duckedVolume });
      } else {
        // Voice ends: restore BGM
        envelope.push({ time, volume: params.bgmVolume });
      }
      currentVolumeState = targetVolume;
    }
  }

  // Cap at the end
  envelope.push({ time: duration, volume: currentVolumeState });

  return envelope;
}

/**
 * Schedules the calculated volume envelope on a GainNode.
 */
export function scheduleDucking(
  gainNode: GainNode,
  envelope: { time: number; volume: number }[],
  startTime: number,
  offset: number,
  params: DuckingParams
) {
  const gainProp = gainNode.gain;
  gainProp.cancelScheduledValues(0);

  // Set initial value based on active state at offset
  let initialVolume = params.bgmVolume;
  for (let i = 0; i < envelope.length; i++) {
    if (envelope[i].time <= offset) {
      initialVolume = envelope[i].volume;
    } else {
      break;
    }
  }
  gainProp.setValueAtTime(initialVolume, 0);

  // Schedule future changes
  for (const point of envelope) {
    if (point.time <= offset) continue;

    const targetTime = startTime + (point.time - offset);
    const currentTargetVolume = point.volume;

    if (currentTargetVolume === params.duckedVolume) {
      // Ducking: ramp down quickly
      gainProp.linearRampToValueAtTime(params.duckedVolume, targetTime + params.duckSpeed);
    } else {
      // Restoring: ramp up slowly
      gainProp.linearRampToValueAtTime(params.bgmVolume, targetTime + params.restoreSpeed);
    }
  }
}
