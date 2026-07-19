import React, { useRef, useEffect, useState, useMemo } from 'react';
import type { Slide } from '../utils/markdownParser';
import { drawSlideFrame } from '../utils/canvasDrawer';
import { splitTextByLanguage } from '../utils/audioAnalyzer';
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

  // Real-time Web Speech API Synthesis & SFX when narrationBuffer is null (works offline & serverless)
  useEffect(() => {
    if (!isPlaying) {
      window.speechSynthesis.cancel();
      return;
    }
    if (narrationBuffer) {
      // If we have an uploaded narration file, don't use Web Speech API
      return;
    }

    const activeIdx = thinkingStatus.activeIdx;
    if (activeIdx < 0 || activeIdx >= slides.length) return;

    const slide = slides[activeIdx];
    const isLast = activeIdx === slides.length - 1;

    // Helper to resolve relative asset URLs
    const resolveAudioUrl = (src: string): string => {
      if (src.startsWith('http://') || src.startsWith('https://')) {
        return src;
      }
      const basePath = window.location.origin + window.location.pathname.replace(/\/(index\.html)?$/, '');
      return `${basePath}/audio/${src}?v=3`;
    };

    // Play slide specific sound effects in real-time preview (offline fallback)
    const activeAudios: HTMLAudioElement[] = [];
    const timeouts: number[] = [];

    if (slide.audios) {
      slide.audios.forEach(audio => {
        try {
          const resolvedUrl = resolveAudioUrl(audio.src);
          const sfx = new Audio(resolvedUrl);
          sfx.volume = audio.volume;
          
          if (audio.offset > 0) {
            const tId = window.setTimeout(() => {
              sfx.play().catch(e => console.warn("Real-time SFX play block:", e));
            }, audio.offset * 1000);
            timeouts.push(tId);
          } else {
            sfx.play().catch(e => console.warn("Real-time SFX play block:", e));
          }
          activeAudios.push(sfx);
        } catch (e) {
          console.warn("Real-time SFX creation failed:", e);
        }
      });
    }

    // Speak slide text
    window.speechSynthesis.cancel(); // Stop any current speech immediately

    // Speak English / Japanese segments in Slide Header:
    if (slide.header) {
      const cleanHeader = slide.header.replace(/<\/?[a-zA-Z]+>/g, ' ');
      const headerSegments = splitTextByLanguage(cleanHeader);
      
      headerSegments.forEach(seg => {
        const cleanText = seg.text.replace(/[「」『』"'\(\)\[\]\{\}（）<>＜＞《》【】]/g, ' ').trim();
        if (!cleanText) return;
        
        const utterance = new SpeechSynthesisUtterance(cleanText);
        if (seg.lang === 'en') {
          utterance.lang = 'en-US';
          utterance.rate = 1.0;
        } else {
          utterance.lang = 'ja-JP';
          utterance.rate = 1.1;
        }
        window.speechSynthesis.speak(utterance);
      });
    }

    // Speak English / Japanese segments in Subtitle (unless it's the last slide):
    if (!isLast && slide.sub_header) {
      const cleanSubHeader = slide.sub_header.replace(/<\/?[a-zA-Z]+>/g, ' ');
      const subSegments = splitTextByLanguage(cleanSubHeader);
      
      subSegments.forEach(seg => {
        const cleanText = seg.text.replace(/[「」『』"'\(\)\[\]\{\}（）<>＜＞《》【】]/g, ' ').trim();
        if (!cleanText) return;
        
        const utterance = new SpeechSynthesisUtterance(cleanText);
        if (seg.lang === 'en') {
          utterance.lang = 'en-US';
          utterance.rate = 1.0;
        } else {
          utterance.lang = 'ja-JP';
          utterance.rate = 1.1; // Slightly faster Japanese
        }
        window.speechSynthesis.speak(utterance);
      });
    }
    
    return () => {
      window.speechSynthesis.cancel();
      activeAudios.forEach(sfx => {
        try {
          sfx.pause();
        } catch (e) {}
      });
      timeouts.forEach(tId => clearTimeout(tId));
    };
  }, [isPlaying, thinkingStatus.activeIdx, slides, narrationBuffer]);

  return (
    <div className="preview-container">
      {/* 9:16 aspect preview frame */}
      <div className="preview-frame">
        <canvas
          ref={canvasRef}
          width={720}
          height={1280}
          className="preview-canvas"
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


      </div>

      {/* Control buttons */}
      <div className="preview-controls">
        <button
          onClick={onRestart}
          title="Restart Playback"
          className="preview-btn-icon"
        >
          <RotateCcw size={20} />
        </button>

        <button
          onClick={onTogglePlay}
          className="preview-btn-play"
        >
          {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" className="ml-1" />}
        </button>

        <div className="preview-audio-status" title="Audio Output Status">
          <Volume2 size={20} />
          <span className="preview-audio-label">STEREO</span>
        </div>
      </div>
    </div>
  );
};
export default VideoPreview;
