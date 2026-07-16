import type { Slide } from './markdownParser';
import { calculateDuckingEnvelope, scheduleDucking } from './audioMixer';
import type { DuckingParams } from './audioMixer';
import { drawSlideFrame } from './canvasDrawer';

export interface ExportParams {
  videoFile: File | null;
  narrationBuffer: AudioBuffer;
  bgmBuffer: AudioBuffer | null;
  slides: Slide[];
  timestamps: number[]; // Start times of each slide
  duckingParams: DuckingParams;
  title: string;
  hook: string;
  onProgress: (progress: number) => void;
}

/**
 * Pre-calculates the voice ending time for each slide to determine the quiz thinking countdown start.
 */
function calculateSlideThinkingTimes(
  slides: Slide[],
  timestamps: number[],
  totalDuration: number,
  narrationBuffer: AudioBuffer,
  duckingParams: DuckingParams
): { start: number; voiceEnd: number; end: number }[] {
  const sampleRate = narrationBuffer.sampleRate;
  const channelData = narrationBuffer.getChannelData(0);
  const thresholdAmp = Math.pow(10, duckingParams.thresholdDb / 20);

  return slides.map((slide, idx) => {
    const tStart = timestamps[idx];
    const tEnd = idx < slides.length - 1 ? timestamps[idx + 1] : totalDuration;

    if (slide.layout !== 'quiz_question') {
      return { start: tStart, voiceEnd: tEnd, end: tEnd };
    }

    // Inside a quiz question, find the last voice sample
    const startSample = Math.floor(tStart * sampleRate);
    const endSample = Math.floor(tEnd * sampleRate);

    let lastVoiceSample = startSample;
    const step = Math.floor(sampleRate * 0.05); // 50ms steps

    for (let i = startSample; i < endSample; i += step) {
      const windowEnd = Math.min(i + step, endSample);
      let sumSquares = 0;
      for (let j = i; j < windowEnd; j++) {
        sumSquares += channelData[j] * channelData[j];
      }
      const rms = Math.sqrt(sumSquares / (windowEnd - i));
      if (rms > thresholdAmp) {
        lastVoiceSample = windowEnd;
      }
    }

    let tVoiceEnd = lastVoiceSample / sampleRate + duckingParams.holdTime;

    // Boundary conditions:
    // If voice extends to the very end of the slide, or there is less than 1 second of silence,
    // default to giving the last 30% of the slide as thinking time.
    if (tVoiceEnd >= tEnd - 1.0) {
      tVoiceEnd = tStart + (tEnd - tStart) * 0.7;
    }

    // Ensure it's inside the bounds
    tVoiceEnd = Math.max(tStart, Math.min(tVoiceEnd, tEnd - 0.5));

    return {
      start: tStart,
      voiceEnd: tVoiceEnd,
      end: tEnd
    };
  });
}

/**
 * Exports the slide project to a video file.
 */
export async function exportVideo(params: ExportParams): Promise<Blob> {
  const {
    videoFile,
    narrationBuffer,
    bgmBuffer,
    slides,
    timestamps,
    duckingParams,
    title,
    hook,
    onProgress
  } = params;

  const totalDuration = narrationBuffer.duration;

  // 1. Create offline video player for background rendering
  let videoEl: HTMLVideoElement | null = null;
  if (videoFile) {
    videoEl = document.createElement('video');
    videoEl.src = URL.createObjectURL(videoFile);
    videoEl.muted = true;
    videoEl.playsInline = true;
    // Wait for video metadata to load
    await new Promise<void>((resolve) => {
      if (videoEl) {
        videoEl.onloadedmetadata = () => resolve();
      } else {
        resolve();
      }
    });
  }

  // 2. Setup Web Audio API destination for recording
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  const audioCtx = new AudioContextClass();
  const dest = audioCtx.createMediaStreamDestination();

  // Play narration source
  const narrationSource = audioCtx.createBufferSource();
  narrationSource.buffer = narrationBuffer;
  
  const narrationGain = audioCtx.createGain();
  narrationSource.connect(narrationGain);
  narrationGain.connect(dest);
  narrationGain.connect(audioCtx.destination); // also play to speakers so browser schedules correctly

  // Play BGM source if available
  let bgmSource: AudioBufferSourceNode | null = null;
  const bgmGain = audioCtx.createGain();
  
  if (bgmBuffer) {
    bgmSource = audioCtx.createBufferSource();
    bgmSource.buffer = bgmBuffer;
    bgmSource.loop = true;

    // Calculate BGM ducking envelope
    const duckingEnvelope = calculateDuckingEnvelope(narrationBuffer, duckingParams);

    // Connect and schedule
    bgmSource.connect(bgmGain);
    bgmGain.connect(dest);
    bgmGain.connect(audioCtx.destination);
    
    // Start volume at BGM volume
    bgmGain.gain.setValueAtTime(duckingParams.bgmVolume, 0);
    
    // Schedule ducking events
    scheduleDucking(bgmGain, duckingEnvelope, audioCtx.currentTime, 0, duckingParams);
  }

  // 3. Pre-calculate slide timings and quiz thinking intervals
  const slideTimings = calculateSlideThinkingTimes(
    slides,
    timestamps,
    totalDuration,
    narrationBuffer,
    duckingParams
  );

  // 4. Setup Canvas for rendering (720x1280 vertical resolution)
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 1280;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get 2D context');

  // 5. Setup MediaRecorder
  const mimeTypes = [
    'video/mp4;codecs=h264,aac',
    'video/mp4',
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm'
  ];
  let selectedMimeType = '';
  for (const type of mimeTypes) {
    if (MediaRecorder.isTypeSupported(type)) {
      selectedMimeType = type;
      break;
    }
  }

  const canvasStream = canvas.captureStream(30); // Capture at 30fps
  
  // Combine audio track and video track
  const tracks = [...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()];
  const combinedStream = new MediaStream(tracks);

  const mediaRecorder = new MediaRecorder(combinedStream, {
    mimeType: selectedMimeType,
    videoBitsPerSecond: 3500000 // 3.5 Mbps (good quality)
  });

  const chunks: Blob[] = [];
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  // 6. Define rendering loop
  let animationId: number;
  const startTime = audioCtx.currentTime;

  if (videoEl) {
    videoEl.currentTime = 0;
    try {
      await videoEl.play();
    } catch (e) {
      console.warn("Auto-play failed, video rendering fallback to static frame. Error:", e);
    }
  }

  narrationSource.start(0);
  if (bgmSource) {
    bgmSource.start(0);
  }
  mediaRecorder.start();

  const renderPromise = new Promise<Blob>((resolve) => {
    function renderFrame() {
      const elapsed = audioCtx.currentTime - startTime;

      if (elapsed >= totalDuration) {
        // Stop recording
        mediaRecorder.stop();
        narrationSource.stop();
        if (bgmSource) bgmSource.stop();
        if (videoEl) videoEl.pause();
        audioCtx.close();
        cancelAnimationFrame(animationId);
        onProgress(100);

        mediaRecorder.onstop = () => {
          const finalBlob = new Blob(chunks, { type: selectedMimeType });
          resolve(finalBlob);
        };
        return;
      }

      // Sync background video if playing
      if (videoEl && Math.abs(videoEl.currentTime - elapsed) > 0.3) {
        videoEl.currentTime = elapsed;
      }

      // Find active slide and compile details
      let activeSlideIdx = 0;
      for (let i = 0; i < slides.length; i++) {
        if (timestamps[i] <= elapsed) {
          activeSlideIdx = i;
        } else {
          break;
        }
      }

      const activeSlide = slides[activeSlideIdx];
      const timing = slideTimings[activeSlideIdx];

      let isThinkingTime = false;
      let thinkingProgress = 0;

      if (activeSlide.layout === 'quiz_question' && timing) {
        if (elapsed >= timing.voiceEnd) {
          isThinkingTime = true;
          const totalThinking = timing.end - timing.voiceEnd;
          const currentThinking = timing.end - elapsed;
          thinkingProgress = Math.max(0, Math.min(1, currentThinking / totalThinking));
        }
      }

      // Draw onto canvas
      drawSlideFrame(
        ctx!,
        canvas.width,
        canvas.height,
        videoEl,
        activeSlide,
        isThinkingTime,
        thinkingProgress,
        title,
        hook,
        elapsed - timestamps[activeSlideIdx]
      );

      // Report progress
      const progressPercent = Math.floor((elapsed / totalDuration) * 100);
      onProgress(Math.min(99, progressPercent));

      animationId = requestAnimationFrame(renderFrame);
    }

    // Start loop
    animationId = requestAnimationFrame(renderFrame);
  });

  return renderPromise;
}
