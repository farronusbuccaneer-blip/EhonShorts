import React, { useRef, useEffect, useState, useMemo } from 'react';
import type { Slide } from '../utils/markdownParser';
import { drawSlideFrame } from '../utils/canvasDrawer';
import { Play, Pause, RotateCcw, Volume2 } from 'lucide-react';

interface VideoPreviewProps {
  videoFile: File | null;
  slides: Slide[];
  timestamps: number[];
  currentTime: number;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onRestart: () => void;
  narrationBuffer: AudioBuffer | null;
  thresholdDb: number;
  holdTime: number;
  title: string;
  hook: string;
}

export const VideoPreview: React.FC<VideoPreviewProps> = ({
  videoFile,
  slides,
  timestamps,
  currentTime,
  isPlaying,
  onTogglePlay,
  onRestart,
  narrationBuffer,
  thresholdDb,
  holdTime,
  title,
  hook
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoLoaded, setVideoLoaded] = useState(false);

  // Keep a local video URL
  const videoUrl = useMemo(() => {
    if (!videoFile) return '';
    return URL.createObjectURL(videoFile);
  }, [videoFile]);

  // Sync background video element currentTime with the global currentTime
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (Math.abs(video.currentTime - currentTime) > 0.25) {
      video.currentTime = currentTime;
    }
  }, [currentTime]);

  // Play/pause background video based on isPlaying state
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      video.play().catch(e => console.warn("Video play failed:", e));
    } else {
      video.pause();
    }
  }, [isPlaying]);

  // Clean up videoUrl object URLs
  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  // Calculate thinking status for the active slide
  const thinkingStatus = useMemo(() => {
    if (slides.length === 0) {
      return { activeIdx: 0, isThinking: false, progress: 0 };
    }

    // 1. Find active slide index
    let activeIdx = 0;
    for (let i = 0; i < slides.length; i++) {
      if (timestamps[i] <= currentTime) {
        activeIdx = i;
      } else {
        break;
      }
    }

    const slide = slides[activeIdx];
    const tStart = timestamps[activeIdx];
    const totalDuration = narrationBuffer?.duration || Math.max(slides.length * 3.0, 10.0);
    const tEnd = activeIdx < slides.length - 1 ? timestamps[activeIdx + 1] : totalDuration;

    if (slide.layout !== 'quiz_question') {
      return { activeIdx, isThinking: false, progress: 0 };
    }

    if (!narrationBuffer) {
      // Fallback without narration audio: last 1.5 seconds of the slide is the quiz thinking countdown
      const totalSlideDuration = tEnd - tStart;
      const thinkingDuration = Math.min(1.5, totalSlideDuration * 0.5);
      const tVoiceEnd = tEnd - thinkingDuration;
      const isThinking = currentTime >= tVoiceEnd;
      let progress = 0;
      if (isThinking) {
        progress = Math.max(0, Math.min(1, (tEnd - currentTime) / thinkingDuration));
      }
      return { activeIdx, isThinking, progress };
    }

    const sampleRate = narrationBuffer.sampleRate;
    const channelData = narrationBuffer.getChannelData(0);
    const thresholdAmp = Math.pow(10, thresholdDb / 20);

    // 2. Find last voice sample in this slide's time window
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

    let tVoiceEnd = lastVoiceSample / sampleRate + holdTime;

    // Check if voice extends too far
    if (tVoiceEnd >= tEnd - 1.0) {
      tVoiceEnd = tStart + (tEnd - tStart) * 0.7; // default last 30% thinking time
    }
    tVoiceEnd = Math.max(tStart, Math.min(tVoiceEnd, tEnd - 0.5));

    // 3. Determine if thinking and progress
    const isThinking = currentTime >= tVoiceEnd;
    let progress = 0;
    if (isThinking) {
      const totalThinking = tEnd - tVoiceEnd;
      const currentThinking = tEnd - currentTime;
      progress = Math.max(0, Math.min(1, currentThinking / totalThinking));
    }

    return {
      activeIdx,
      isThinking,
      progress
    };
  }, [slides, timestamps, currentTime, narrationBuffer, thresholdDb, holdTime]);

  // Real-time canvas render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;

    const render = () => {
      if (slides.length > 0) {
        const activeSlide = slides[thinkingStatus.activeIdx];
        
        drawSlideFrame(
          ctx,
          canvas.width,
          canvas.height,
          videoRef.current,
          activeSlide,
          thinkingStatus.isThinking,
          thinkingStatus.progress,
          title,
          hook,
          currentTime - timestamps[thinkingStatus.activeIdx]
        );
      } else {
        // Render simple blank loading screen
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        ctx.fillStyle = '#475569';
        ctx.font = '20px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No Slides Available', canvas.width / 2, canvas.height / 2);
      }

      animId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [slides, thinkingStatus, title, hook, videoLoaded]);

  return (
    <div className="flex flex-col items-center gap-4">
      {/* 9:16 aspect preview frame */}
      <div className="relative w-[300px] h-[533px] sm:w-[324px] sm:h-[576px] rounded-3xl overflow-hidden border border-slate-700 shadow-2xl bg-slate-950 flex justify-center items-center group">
        <canvas
          ref={canvasRef}
          width={720}
          height={1280}
          className="w-full h-full block object-cover"
        />

        {/* Hidden video element for canvas source */}
        {videoUrl && (
          <video
            ref={videoRef}
            src={videoUrl}
            className="hidden"
            playsInline
            muted
            onLoadedData={() => setVideoLoaded(true)}
            onEnded={() => {
              if (isPlaying) onTogglePlay();
            }}
          />
        )}

        {/* Layout indicator overlays */}
        {slides.length > 0 && (
          <div className="absolute top-4 right-4 bg-slate-900/80 backdrop-blur-md px-3 py-1 rounded-full text-[10px] font-bold text-indigo-400 border border-indigo-500/20 select-none">
            {slides[thinkingStatus.activeIdx]?.layout.toUpperCase()}
          </div>
        )}
      </div>

      {/* Control buttons */}
      <div className="flex items-center gap-4 bg-slate-900/80 backdrop-blur-md border border-slate-800 rounded-full px-6 py-2 shadow-lg">
        <button
          onClick={onRestart}
          title="Restart Playback"
          className="p-2 text-slate-400 hover:text-slate-200 transition-colors"
        >
          <RotateCcw size={20} />
        </button>

        <button
          onClick={onTogglePlay}
          className="bg-indigo-600 hover:bg-indigo-500 text-white rounded-full p-3 shadow-md hover:shadow-indigo-500/20 transition-all flex items-center justify-center transform hover:scale-105 active:scale-95"
        >
          {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" className="ml-1" />}
        </button>

        <div className="flex items-center gap-1.5 text-slate-400" title="Audio Output Status">
          <Volume2 size={20} />
          <span className="text-[10px] font-bold font-mono">STEREO</span>
        </div>
      </div>
    </div>
  );
};
export default VideoPreview;
