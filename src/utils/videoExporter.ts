import type { Slide } from './markdownParser';
import { resolveAssetUrl } from './markdownParser';
import { calculateDuckingEnvelope, scheduleDucking } from './audioMixer';
import type { DuckingParams } from './audioMixer';
import { drawSlideFrame } from './canvasDrawer';

export interface ExportParams {
  videoFile: File | null;
  imageFile: File | null;
  uploadedAssets: Record<string, string>;
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
    imageFile,
    uploadedAssets,
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

  // 1. Preload all image assets
  const imageCache: Record<string, HTMLImageElement> = {};
  
  // Load global background image if present
  let globalBgImageElement: HTMLImageElement | null = null;
  if (imageFile) {
    globalBgImageElement = new Image();
    globalBgImageElement.src = URL.createObjectURL(imageFile);
    await new Promise<void>((resolve) => {
      globalBgImageElement!.onload = () => resolve();
      globalBgImageElement!.onerror = () => resolve();
    });
  }
  
  // Load slide-specific images
  const imagePromises: Promise<void>[] = [];
  for (const slide of slides) {
    if (slide.images) {
      for (const img of slide.images) {
        const resolved = resolveAssetUrl(img.src, uploadedAssets);
        if (!imageCache[img.src]) {
          const imageObj = new Image();
          imageObj.src = resolved;
          imageCache[img.src] = imageObj;
          const p = new Promise<void>((resolve) => {
            imageObj.onload = () => resolve();
            imageObj.onerror = () => resolve();
          });
          imagePromises.push(p);
        }
      }
    }
  }
  await Promise.all(imagePromises);

  // Helper to create and attach hidden video elements to the DOM
  // Browsers require video elements to be attached to the DOM tree for active hardware frame decoding & canvas updating!
  const createAttachedVideoElement = (src: string): HTMLVideoElement => {
    const v = document.createElement('video');
    v.src = src;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.style.position = 'fixed';
    v.style.top = '-9999px';
    v.style.left = '-9999px';
    v.style.width = '1px';
    v.style.height = '1px';
    v.style.opacity = '0.01';
    v.style.pointerEvents = 'none';
    document.body.appendChild(v);
    v.load();
    return v;
  };

  // 1c. Load slide-specific video elements
  const slideVideoElements: Record<number, HTMLVideoElement> = {};
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    if (slide.video) {
      const resolved = resolveAssetUrl(slide.video.src, uploadedAssets);
      slideVideoElements[i] = createAttachedVideoElement(resolved);
    }
  }

  // 1. Create video player for background rendering
  let videoEl: HTMLVideoElement | null = null;
  if (videoFile) {
    videoEl = createAttachedVideoElement(URL.createObjectURL(videoFile));

    // Wait for video metadata & initial frame to be ready
    await new Promise<void>((resolve) => {
      if (videoEl && (videoEl.readyState >= 1 || videoEl.videoWidth > 0)) {
        videoEl.currentTime = 0;
        resolve();
      } else if (videoEl) {
        const onReady = () => {
          if (videoEl) videoEl.currentTime = 0;
          resolve();
        };
        videoEl.onloadedmetadata = onReady;
        videoEl.onloadeddata = onReady;
        videoEl.oncanplay = onReady;
        videoEl.onerror = () => resolve();
        setTimeout(resolve, 1500);
      } else {
        resolve();
      }
    });
  }

  const cleanupVideos = () => {
    if (videoEl) {
      try { videoEl.pause(); } catch (e) {}
      try { document.body.removeChild(videoEl); } catch (e) {}
    }
    Object.values(slideVideoElements).forEach(sVideo => {
      try { sVideo.pause(); } catch (e) {}
      try { document.body.removeChild(sVideo); } catch (e) {}
    });
  };

  // 2. Setup Web Audio API destination for recording
  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  const audioCtx = new AudioContextClass();
  await audioCtx.resume(); // Enforce activation so currentTime advances
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
  if (!ctx) {
    cleanupVideos();
    throw new Error('Could not get 2D context');
  }

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
  let lastActiveVideoEl: HTMLVideoElement | null = null;

  if (videoEl) {
    try {
      videoEl.currentTime = 0;
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
    async function renderFrame() {
      const elapsed = audioCtx.currentTime - startTime;

      if (elapsed >= totalDuration) {
        // Stop recording
        mediaRecorder.stop();
        narrationSource.stop();
        if (bgmSource) bgmSource.stop();
        cleanupVideos();
        audioCtx.close();
        cancelAnimationFrame(animationId);
        clearTimeout(animationId);
        onProgress(100);

        mediaRecorder.onstop = () => {
          const finalBlob = new Blob(chunks, { type: selectedMimeType });
          resolve(finalBlob);
        };
        return;
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

      // Determine which video element to use (slide-specific or global)
      const slideVideoEl = slideVideoElements[activeSlideIdx];
      const activeVideoEl = slideVideoEl || videoEl;

      // Handle video switching, seek, and looping playback in export rendering
      if (activeVideoEl) {
        const duration = activeVideoEl.duration && !isNaN(activeVideoEl.duration) && activeVideoEl.duration > 0 ? activeVideoEl.duration : 1;
        const rawTarget = elapsed - (slideVideoEl ? timestamps[activeSlideIdx] : 0);
        const targetTime = rawTarget % duration;

        if (activeVideoEl !== lastActiveVideoEl) {
          if (lastActiveVideoEl) {
            try { lastActiveVideoEl.pause(); } catch (e) {}
          }
          try {
            activeVideoEl.currentTime = targetTime;
            await activeVideoEl.play();
          } catch (e) {}
          lastActiveVideoEl = activeVideoEl;
        } else {
          if (activeVideoEl.paused) {
            try { await activeVideoEl.play(); } catch (e) {}
          }
          if (Math.abs(activeVideoEl.currentTime - targetTime) > 0.2) {
            activeVideoEl.currentTime = targetTime;
          }
        }
      }

      // Draw onto canvas
      drawSlideFrame(
        ctx!,
        canvas.width,
        canvas.height,
        activeVideoEl,
        activeSlide,
        isThinkingTime,
        thinkingProgress,
        title,
        hook,
        elapsed - timestamps[activeSlideIdx],
        imageCache,
        globalBgImageElement
      );

      // Report progress
      const progressPercent = Math.floor((elapsed / totalDuration) * 100);
      onProgress(Math.min(99, progressPercent));

      // Use requestAnimationFrame for active tabs, fallback to setTimeout for hidden/background tabs
      if (document.hidden) {
        animationId = window.setTimeout(renderFrame, 33) as any;
      } else {
        animationId = requestAnimationFrame(renderFrame);
      }
    }

    // Start loop
    if (document.hidden) {
      animationId = window.setTimeout(renderFrame, 33) as any;
    } else {
      animationId = requestAnimationFrame(renderFrame);
    }
  });

  return renderPromise;
}

