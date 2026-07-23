import React, { useRef, useEffect, useState, useMemo } from 'react';
import type { Slide } from '../utils/markdownParser';
import { resolveAssetUrl } from '../utils/markdownParser';
import { drawSlideFrame } from '../utils/canvasDrawer';
import { splitTextByLanguage, splitTextByPunctuation } from '../utils/audioAnalyzer';
import { Play, Pause, RotateCcw, Volume2 } from 'lucide-react';

interface VideoPreviewProps {
  videoFile: File | null;
  imageFile: File | null;
  uploadedAssets: Record<string, string>;
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
  imageFile,
  uploadedAssets,
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
  const slideVideoRef = useRef<HTMLVideoElement | null>(null);
  const [videoLoaded, setVideoLoaded] = useState(false);
  const [slideVideoUrl, setSlideVideoUrl] = useState<string>('');
  const [globalBgImageElement, setGlobalBgImageElement] = useState<HTMLImageElement | null>(null);
  const [imageCache, setImageCache] = useState<Record<string, HTMLImageElement>>({});

  // Keep a local video URL for global background
  const videoUrl = useMemo(() => {
    if (!videoFile) return '';
    return URL.createObjectURL(videoFile);
  }, [videoFile]);

  // Load global background image
  useEffect(() => {
    if (!imageFile) {
      setGlobalBgImageElement(null);
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(imageFile);
    img.src = url;
    img.onload = () => setGlobalBgImageElement(img);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [imageFile]);

  // Load slide-specific images (backgrounds & overlay PNGs)
  useEffect(() => {
    const newCache: Record<string, HTMLImageElement> = {};
    let loadedCount = 0;
    let totalCount = 0;

    slides.forEach(slide => {
      if (slide.images) {
        slide.images.forEach(img => {
          totalCount++;
          const resolved = resolveAssetUrl(img.src, uploadedAssets);
          const imageObj = new Image();
          imageObj.src = resolved;
          imageObj.onload = () => {
            newCache[img.src] = imageObj;
            loadedCount++;
            if (loadedCount === totalCount) {
              setImageCache({ ...newCache });
            }
          };
          imageObj.onerror = () => {
            loadedCount++;
            if (loadedCount === totalCount) {
              setImageCache({ ...newCache });
            }
          };
        });
      }
    });

    if (totalCount === 0) {
      setImageCache({});
    }
  }, [slides, uploadedAssets]);

  // Sync background video element currentTime with the global currentTime (looping modulo duration)
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const duration = video.duration && !isNaN(video.duration) && video.duration > 0 ? video.duration : 1;
    const targetTime = currentTime % duration;

    if (Math.abs(video.currentTime - targetTime) > 0.25) {
      video.currentTime = targetTime;
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

  // Sync slide-specific video URL whenever active slide changes
  const activeSlideIdx = useMemo(() => {
    if (slides.length === 0) return 0;
    let activeIdx = 0;
    for (let i = 0; i < slides.length; i++) {
      if (timestamps[i] <= currentTime) {
        activeIdx = i;
      } else {
        break;
      }
    }
    return activeIdx;
  }, [slides, timestamps, currentTime]);

  const activeSlide = slides[activeSlideIdx];

  useEffect(() => {
    if (activeSlide && activeSlide.video) {
      const resolved = resolveAssetUrl(activeSlide.video.src, uploadedAssets);
      setSlideVideoUrl(resolved);
    } else {
      setSlideVideoUrl('');
    }
  }, [activeSlide, uploadedAssets]);

  // Sync slide-specific video element currentTime with the slide elapsed time (looping modulo duration)
  useEffect(() => {
    const sVideo = slideVideoRef.current;
    if (!sVideo) return;

    const slideStart = timestamps[activeSlideIdx] || 0;
    const rawTarget = currentTime - slideStart;
    const duration = sVideo.duration && !isNaN(sVideo.duration) && sVideo.duration > 0 ? sVideo.duration : 1;
    const targetTime = rawTarget % duration;

    if (Math.abs(sVideo.currentTime - targetTime) > 0.25) {
      sVideo.currentTime = targetTime;
    }
  }, [currentTime, activeSlideIdx, timestamps, slideVideoUrl]);

  // Play/pause slide-specific video based on isPlaying state
  useEffect(() => {
    const sVideo = slideVideoRef.current;
    if (!sVideo) return;

    if (isPlaying) {
      sVideo.play().catch(e => console.warn("Slide video play failed:", e));
    } else {
      sVideo.pause();
    }
  }, [isPlaying, slideVideoUrl]);

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

    const slide = slides[activeSlideIdx];
    const tStart = timestamps[activeSlideIdx];
    const totalDuration = narrationBuffer?.duration || Math.max(slides.length * 3.0, 10.0);
    const tEnd = activeSlideIdx < slides.length - 1 ? timestamps[activeSlideIdx + 1] : totalDuration;

    if (slide.layout !== 'quiz_question') {
      return { activeIdx: activeSlideIdx, isThinking: false, progress: 0 };
    }

    if (!narrationBuffer) {
      const totalSlideDuration = tEnd - tStart;
      const thinkingDuration = Math.min(1.5, totalSlideDuration * 0.5);
      const tVoiceEnd = tEnd - thinkingDuration;
      const isThinking = currentTime >= tVoiceEnd;
      let progress = 0;
      if (isThinking) {
        progress = Math.max(0, Math.min(1, (tEnd - currentTime) / thinkingDuration));
      }
      return { activeIdx: activeSlideIdx, isThinking, progress };
    }

    const sampleRate = narrationBuffer.sampleRate;
    const channelData = narrationBuffer.getChannelData(0);
    const thresholdAmp = Math.pow(10, thresholdDb / 20);

    const startSample = Math.floor(tStart * sampleRate);
    const endSample = Math.floor(tEnd * sampleRate);

    let lastVoiceSample = startSample;
    const step = Math.floor(sampleRate * 0.05);

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

    const tVoiceEnd = lastVoiceSample / sampleRate + holdTime;
    const isThinking = currentTime >= tVoiceEnd;
    let progress = 0;

    if (isThinking) {
      const totalThinking = tEnd - tVoiceEnd;
      const currentThinking = tEnd - currentTime;
      progress = Math.max(0, Math.min(1, currentThinking / totalThinking));
    }

    return {
      activeIdx: activeSlideIdx,
      isThinking,
      progress
    };
  }, [slides, timestamps, currentTime, narrationBuffer, thresholdDb, holdTime, activeSlideIdx]);

  // Real-time canvas render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;

    const render = () => {
      if (slides.length > 0) {
        const activeSlideIdx = thinkingStatus.activeIdx;
        const activeSlide = slides[activeSlideIdx];
        
        const activeVideoElement = activeSlide.video ? slideVideoRef.current : videoRef.current;

        drawSlideFrame(
          ctx,
          canvas.width,
          canvas.height,
          activeVideoElement,
          activeSlide,
          thinkingStatus.isThinking,
          thinkingStatus.progress,
          title,
          hook,
          currentTime - (timestamps[activeSlideIdx] || 0),
          imageCache,
          globalBgImageElement
        );
      } else {
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#475569';
        ctx.font = '20px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No Slides Available', canvas.width / 2, canvas.height / 2);
      }

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [slides, thinkingStatus, title, hook, videoLoaded, imageCache, globalBgImageElement, currentTime]);

  // Real-time Web Speech API Synthesis & SFX when narrationBuffer is null
  useEffect(() => {
    if (!isPlaying) {
      window.speechSynthesis.cancel();
      return;
    }
    if (narrationBuffer) return;

    const activeIdx = thinkingStatus.activeIdx;
    if (activeIdx < 0 || activeIdx >= slides.length) return;

    const slide = slides[activeIdx];

    const resolveAudioUrl = (src: string): string => {
      if (src.startsWith('http://') || src.startsWith('https://')) return src;
      return resolveAssetUrl(src, uploadedAssets);
    };

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
        } catch (e) { console.warn("Real-time SFX creation failed:", e); }
      });
    }

    window.speechSynthesis.cancel();

    if (slide.header) {
      const chunks = splitTextByPunctuation(slide.header);
      chunks.forEach(chunk => {
        if (!chunk.isPause && chunk.text) {
          const headerSegments = splitTextByLanguage(chunk.text);
          headerSegments.forEach(seg => {
            const cleanText = seg.text.replace(/[「」『』"'\(\)\[\]\{\}（）<>＜＞《》【】]/g, ' ').trim();
            if (!cleanText) return;
            const utterance = new SpeechSynthesisUtterance(cleanText);
            utterance.lang = seg.lang === 'en' ? 'en-US' : 'ja-JP';
            utterance.rate = seg.lang === 'en' ? 1.0 : 1.1;
            window.speechSynthesis.speak(utterance);
          });
        }
      });
    }

    if (slide.sub_header) {
      const chunks = splitTextByPunctuation(slide.sub_header);
      chunks.forEach(chunk => {
        if (!chunk.isPause && chunk.text) {
          const subSegments = splitTextByLanguage(chunk.text);
          subSegments.forEach(seg => {
            const cleanText = seg.text.replace(/[「」『』"'\(\)\[\]\{\}（）<>＜＞《》【】]/g, ' ').trim();
            if (!cleanText) return;
            const utterance = new SpeechSynthesisUtterance(cleanText);
            utterance.lang = seg.lang === 'en' ? 'en-US' : 'ja-JP';
            utterance.rate = seg.lang === 'en' ? 1.0 : 1.1;
            window.speechSynthesis.speak(utterance);
          });
        }
      });
    }
    
    return () => {
      window.speechSynthesis.cancel();
      activeAudios.forEach(sfx => { try { sfx.pause(); } catch (e) {} });
      timeouts.forEach(tId => clearTimeout(tId));
    };
  }, [isPlaying, thinkingStatus.activeIdx, slides, narrationBuffer, uploadedAssets]);

  return (
    <div className="preview-container">
      <div className="preview-frame">
        <canvas
          ref={canvasRef}
          width={720}
          height={1280}
          className="preview-canvas"
        />

        {videoUrl && (
          <video
            ref={videoRef}
            src={videoUrl}
            className="hidden"
            playsInline
            muted
            loop
            preload="auto"
            autoPlay
            onLoadedData={() => setVideoLoaded(true)}
            onLoadedMetadata={() => setVideoLoaded(true)}
            onCanPlay={() => setVideoLoaded(true)}
          />
        )}

        {slideVideoUrl && (
          <video
            ref={slideVideoRef}
            src={slideVideoUrl}
            className="hidden"
            playsInline
            muted
            loop
            preload="auto"
            autoPlay
          />
        )}
      </div>

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
