export interface SilenceGap {
  start: number;
  end: number;
}

/**
 * Decodes a narration or BGM file into an AudioBuffer using the provided AudioContext.
 */
export async function decodeAudio(file: File, audioCtx: AudioContext): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();
  // Use modern decodeAudioData (promise-based)
  return await audioCtx.decodeAudioData(arrayBuffer);
}

/**
 * Detects silent regions in an AudioBuffer.
 * @param audioBuffer The narration AudioBuffer.
 * @param thresholdDb The volume threshold in dB below which we consider it silence (e.g. -45dB).
 * @param minSilenceDuration The minimum duration of a silence gap in seconds (e.g. 0.5s).
 */
export function detectSilenceGaps(
  audioBuffer: AudioBuffer,
  thresholdDb: number = -40,
  minSilenceDuration: number = 0.5
): SilenceGap[] {
  const sampleRate = audioBuffer.sampleRate;
  const channelData = audioBuffer.getChannelData(0); // Analyze mono or left channel
  const totalSamples = channelData.length;

  const thresholdAmp = Math.pow(10, thresholdDb / 20); // Convert dB to amplitude
  const windowSize = Math.floor(sampleRate * 0.05); // 50ms window size

  const silenceGaps: SilenceGap[] = [];
  let isSilent = false;
  let silenceStart = 0;

  for (let i = 0; i < totalSamples; i += windowSize) {
    const endWindow = Math.min(i + windowSize, totalSamples);
    let sumSquares = 0;

    for (let j = i; j < endWindow; j++) {
      sumSquares += channelData[j] * channelData[j];
    }

    const rms = Math.sqrt(sumSquares / (endWindow - i));
    const time = i / sampleRate;

    if (rms < thresholdAmp) {
      if (!isSilent) {
        isSilent = true;
        silenceStart = time;
      }
    } else {
      if (isSilent) {
        isSilent = false;
        const duration = time - silenceStart;
        if (duration >= minSilenceDuration) {
          silenceGaps.push({ start: silenceStart, end: time });
        }
      }
    }
  }

  // Handle trailing silence
  if (isSilent) {
    const duration = (totalSamples / sampleRate) - silenceStart;
    if (duration >= minSilenceDuration) {
      silenceGaps.push({ start: silenceStart, end: totalSamples / sampleRate });
    }
  }

  return silenceGaps;
}

interface TextSlide {
  header: string;
  sub_header: string;
}

/**
 * Estimates slide boundaries by character count proportion and snaps them to the nearest silence gaps.
 * @param slides The parsed slides.
 * @param audioDuration Total duration of the audio in seconds.
 * @param silenceGaps Detected silence gaps.
 */
export function alignSlidesHeuristically(
  slides: TextSlide[],
  audioDuration: number,
  silenceGaps: SilenceGap[]
): number[] {
  if (slides.length <= 1) return [0];

  // 1. Calculate weights (character lengths) of each slide
  const slideWeights = slides.map(slide => {
    const headerLen = (slide.header || '').length;
    const subHeaderLen = (slide.sub_header || '').length;
    // Provide a small baseline weight so empty slides don't get 0 duration
    return Math.max(headerLen + subHeaderLen, 5);
  });

  const totalWeight = slideWeights.reduce((a, b) => a + b, 0);

  // 2. Compute cumulative proportion thresholds (ideal transition ratios)
  const idealTransitions: number[] = [];
  let cumulativeWeight = 0;
  for (let i = 0; i < slides.length - 1; i++) {
    cumulativeWeight += slideWeights[i];
    idealTransitions.push((cumulativeWeight / totalWeight) * audioDuration);
  }

  // 3. For each ideal transition, find the nearest silence gap and snap to its center/start
  const transitionTimestamps: number[] = [0]; // First slide always starts at 0

  for (const idealTime of idealTransitions) {
    if (silenceGaps.length === 0) {
      // Fallback: simple linear proportion if no silence gaps
      transitionTimestamps.push(idealTime);
      continue;
    }

    // Find the silence gap whose center is closest to the ideal transition time
    let bestGap: SilenceGap | null = null;
    let minDistance = Infinity;

    for (const gap of silenceGaps) {
      const gapCenter = (gap.start + gap.end) / 2;
      const dist = Math.abs(gapCenter - idealTime);
      if (dist < minDistance) {
        minDistance = dist;
        bestGap = gap;
      }
    }

    if (bestGap && minDistance < 5.0) {
      // Snap to the center of the silence gap
      const snapTime = (bestGap.start + bestGap.end) / 2;
      transitionTimestamps.push(snapTime);
    } else {
      // If no gap is nearby (within 5 seconds), use the ideal proportional time
      transitionTimestamps.push(idealTime);
    }
  }

  // Ensure timestamps are strictly increasing and within bounds
  for (let i = 1; i < transitionTimestamps.length; i++) {
    if (transitionTimestamps[i] <= transitionTimestamps[i - 1]) {
      transitionTimestamps[i] = transitionTimestamps[i - 1] + 0.1;
    }
  }

  // Ensure last transition doesn't exceed duration
  for (let i = 1; i < transitionTimestamps.length; i++) {
    if (transitionTimestamps[i] >= audioDuration) {
      transitionTimestamps[i] = audioDuration - (transitionTimestamps.length - i) * 0.1;
    }
  }

  return transitionTimestamps;
}

/**
 * Helper to clean brackets and quotation marks so they are not read by the TTS voice.
 * Also normalizes common typo characters like Korean particle '의' to Japanese 'の'.
 */
function cleanTextForTts(text: string): string {
  // Strip out HTML-like styling tags (e.g. <yellow>, </red>, etc.)
  let cleaned = text.replace(/<\/?[a-zA-Z]+>/g, ' ');

  // Replace punctuation, quotation marks, commas, periods, and brackets with spaces so they are silent
  cleaned = cleaned.replace(/[「」『』"'\(\)\[\]\{\}（）<>＜＞《》【】、。,\.\u2026\u22ef]/g, ' ');
  
  // Replace Korean particle '의' with Japanese 'の' to prevent voice crashes
  cleaned = cleaned.replace(/의/g, 'の');
  
  // Clean up CJK punctuation symbols
  cleaned = cleaned.replace(/[・＝★▲◆●■•·]/g, ' ');
  
  return cleaned.replace(/\s+/g, ' ').trim();
}

/**
 * Helper to split a string into separate English and Japanese segments.
 * For example: "very cold の代わりに使うネイティブ表現" ->
 *   [{ text: "very cold", lang: "en" }, { text: "の代わりに使うネイティブ表現", lang: "ja" }]
 */
export function splitTextByLanguage(text: string): { text: string; lang: 'ja' | 'en' }[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Split by CJK character runs (Japanese Kanji, Hiragana, Katakana, and CJK punctuation)
  const parts = trimmed.split(/([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]+)/g);
  
  const segments: { text: string; lang: 'ja' | 'en' }[] = [];
  for (const part of parts) {
    if (!part) continue;
    
    const isJap = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/.test(part);
    const cleanPart = part.trim();
    if (!cleanPart) continue;

    segments.push({
      text: cleanPart,
      lang: isJap ? 'ja' : 'en'
    });
  }
  return segments;
}

/**
 * Helper to fetch local VOICEVOX neural speech synthesis (speaker 2: Shikoku Metan, speaker 3: Zundamon).
 * Runs completely locally on the user's computer with zero cost and high-quality, expressive voices.
 */
async function fetchVoiceVoxClip(text: string, speakerId: number, audioCtx: AudioContext): Promise<AudioBuffer | null> {
  try {
    // 1. Generate audio query JSON
    const queryUrl = `http://localhost:5021/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`;
    const queryRes = await fetch(queryUrl, { method: 'POST' });
    if (!queryRes.ok) return null;
    const queryJson = await queryRes.json();

    // 2. Synthesize WAV audio
    const synthUrl = `http://localhost:5021/synthesis?speaker=${speakerId}`;
    const synthRes = await fetch(synthUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(queryJson)
    });
    if (!synthRes.ok) return null;

    const arrayBuffer = await synthRes.arrayBuffer();
    return await audioCtx.decodeAudioData(arrayBuffer);
  } catch (e) {
    // VOICEVOX not running, return null to fallback
    return null;
  }
}

/**
 * Resamples an AudioBuffer to increase its playback speed.
 * This changes the duration and speed of the segment.
 */
function speedUpAudioBuffer(buffer: AudioBuffer, speed: number, audioCtx: AudioContext): AudioBuffer {
  const sourceData = buffer.getChannelData(0);
  const newLength = Math.floor(sourceData.length / speed);
  const newBuffer = audioCtx.createBuffer(1, newLength, buffer.sampleRate);
  const newData = newBuffer.getChannelData(0);
  
  for (let i = 0; i < newLength; i++) {
    const pos = i * speed;
    const index = Math.floor(pos);
    const fraction = pos - index;
    
    if (index + 1 < sourceData.length) {
      newData[i] = sourceData[index] * (1 - fraction) + sourceData[index + 1] * fraction;
    } else {
      newData[i] = sourceData[index] || 0;
    }
  }
  return newBuffer;
}

/**
 * Helper to fetch cloud Google Translate TTS.
 */
async function fetchGoogleTtsClip(
  text: string, 
  lang: 'ja' | 'en', 
  audioCtx: AudioContext,
  cfWorkerUrl?: string
): Promise<AudioBuffer> {
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  let url = '';
  let headers: HeadersInit = {};
  
  if (isLocal) {
    url = `/api-tts/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encodeURIComponent(text.substring(0, 200))}`;
  } else if (cfWorkerUrl) {
    // Use user's custom Cloudflare Worker proxy to fetch Google Translate TTS directly
    const cleanWorkerUrl = cfWorkerUrl.endsWith('/') ? cfWorkerUrl : cfWorkerUrl + '/';
    const target = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encodeURIComponent(text.substring(0, 200))}`;
    url = `${cleanWorkerUrl}?url=${encodeURIComponent(target)}`;
  } else {
    // In production, bypass CORS and Google blocks by using Youdao dictvoice via proxy.cors.sh
    const le = lang === 'ja' ? 'jap' : 'eng';
    const target = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text.substring(0, 200))}&le=${le}`;
    url = `https://proxy.cors.sh/${target}`;
    headers = {
      'x-cors-gratis': 'true'
    };
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`TTS endpoint responded with status ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return await audioCtx.decodeAudioData(arrayBuffer);
}

export interface ApiKeys {
  openAiKey?: string;
  voiceRssKey?: string;
  openAiVoice?: string;
  cfWorkerUrl?: string;
}

async function fetchOpenAiTtsClip(text: string, voice: string, apiKey: string, audioCtx: AudioContext): Promise<AudioBuffer> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice: voice
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API Error: ${errText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return await audioCtx.decodeAudioData(arrayBuffer);
}

async function fetchVoiceRssTtsClip(text: string, lang: 'ja' | 'en', apiKey: string, audioCtx: AudioContext): Promise<AudioBuffer> {
  const hl = lang === 'ja' ? 'ja-jp' : 'en-us';
  const url = `https://api.voicerss.org/?key=${apiKey}&hl=${hl}&src=${encodeURIComponent(text)}&c=mp3&f=44khz_16bit_stereo`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`VoiceRSS API Error: status ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return await audioCtx.decodeAudioData(arrayBuffer);
}

/**
 * Fetches and decodes a single string clip, splitting it into CJK and English segments
 * if they are mixed, requesting local VOICEVOX neural speech (Japanese) if active,
 * otherwise falling back to Google Translate TTS, and joining them together.
 */
async function fetchTtsClip(
  text: string, 
  audioCtx: AudioContext, 
  useVoiceVox: boolean,
  apiKeys: ApiKeys = {}
): Promise<AudioBuffer | null> {
  const cleaned = cleanTextForTts(text);
  const segments = splitTextByLanguage(cleaned);
  if (segments.length === 0) return null;

  const segmentBuffers: AudioBuffer[] = [];
  const sampleRate = audioCtx.sampleRate;

  for (const seg of segments) {
    let buf: AudioBuffer | null = null;
    
    if (seg.lang === 'ja') {
      if (useVoiceVox) {
        // 1. Try local VOICEVOX (speaker 2: Shikoku Metan)
        buf = await fetchVoiceVoxClip(seg.text, 2, audioCtx);
      }
      // 2. Fallback to API keys or Google Translate Japanese
      if (!buf) {
        if (apiKeys.openAiKey) {
          buf = await fetchOpenAiTtsClip(seg.text, apiKeys.openAiVoice || 'alloy', apiKeys.openAiKey, audioCtx);
        } else if (apiKeys.voiceRssKey) {
          buf = await fetchVoiceRssTtsClip(seg.text, 'ja', apiKeys.voiceRssKey, audioCtx);
        } else {
          buf = await fetchGoogleTtsClip(seg.text, 'ja', audioCtx, apiKeys.cfWorkerUrl);
        }
      }
      
      // Speed up Japanese segments by 1.30x to sound energetic and fast-paced
      if (buf) {
        buf = speedUpAudioBuffer(buf, 1.30, audioCtx);
      }
    } else {
      // English segment
      if (apiKeys.openAiKey) {
        buf = await fetchOpenAiTtsClip(seg.text, apiKeys.openAiVoice || 'alloy', apiKeys.openAiKey, audioCtx);
      } else if (apiKeys.voiceRssKey) {
        buf = await fetchVoiceRssTtsClip(seg.text, 'en', apiKeys.voiceRssKey, audioCtx);
      } else {
        buf = await fetchGoogleTtsClip(seg.text, 'en', audioCtx, apiKeys.cfWorkerUrl);
      }
    }

    if (buf) {
      segmentBuffers.push(buf);
    }
  }

  if (segmentBuffers.length === 1) {
    return segmentBuffers[0];
  }

  // Concatenate multiple language segments for a single line with small pauses (0.15 seconds)
  let totalDuration = 0;
  const positions: number[] = [];
  
  for (let i = 0; i < segmentBuffers.length; i++) {
    positions.push(totalDuration);
    totalDuration += segmentBuffers[i].duration;
    if (i < segmentBuffers.length - 1) {
      totalDuration += 0.0; // 0ms segment pause
    }
  }

  const combinedLen = Math.max(1, Math.floor(totalDuration * sampleRate));
  const combinedBuffer = audioCtx.createBuffer(1, combinedLen, sampleRate);
  const combinedData = combinedBuffer.getChannelData(0);

  for (let i = 0; i < segmentBuffers.length; i++) {
    const buf = segmentBuffers[i];
    const startSample = Math.floor(positions[i] * sampleRate);
    const data = buf.getChannelData(0);
    
    for (let j = 0; j < data.length; j++) {
      if (startSample + j < combinedData.length) {
        combinedData[startSample + j] = data[j];
      }
    }
  }

  return combinedBuffer;
}

/**
 * Generates automated TTS narration audio and slide transition timestamps.
 * Speaks English segments with a US English voice and Japanese segments with a Japanese voice.
 */
export async function generateTtsNarration(
  slides: any[],
  audioCtx: AudioContext,
  useVoiceVox: boolean = false,
  apiKeys: ApiKeys = {}
): Promise<{ buffer: AudioBuffer; timestamps: number[] }> {
  const buffers: AudioBuffer[] = [];
  const timestamps: number[] = [0];
  const sampleRate = audioCtx.sampleRate;

  // 1. Fetch, translate, and merge segments slide-by-slide
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];

    // Fetch individual components separately for language purity
    const headerBuf = await fetchTtsClip(slide.header || '', audioCtx, useVoiceVox, apiKeys);
    const subHeaderBuf = await fetchTtsClip(slide.sub_header || '', audioCtx, useVoiceVox, apiKeys);
    
    // Calculate total duration for this slide's voice track
    let slideVoiceDuration = 0;
    const segments: { buffer: AudioBuffer; startOffset: number }[] = [];

    if (headerBuf) {
      segments.push({ buffer: headerBuf, startOffset: slideVoiceDuration });
      slideVoiceDuration += headerBuf.duration; // no pause after header
    }

    if (subHeaderBuf) {
      segments.push({ buffer: subHeaderBuf, startOffset: slideVoiceDuration });
      slideVoiceDuration += subHeaderBuf.duration; // no pause after sub-header
    }

    // Create a merged single AudioBuffer for this slide
    const slideCombinedLen = Math.max(1, Math.floor(slideVoiceDuration * sampleRate));
    const slideCombinedBuffer = audioCtx.createBuffer(1, slideCombinedLen, sampleRate);
    const slideCombinedData = slideCombinedBuffer.getChannelData(0);

    // Copy segment samples into slide buffer
    for (const seg of segments) {
      const startSample = Math.floor(seg.startOffset * sampleRate);
      const data = seg.buffer.getChannelData(0);
      for (let j = 0; j < data.length; j++) {
        if (startSample + j < slideCombinedData.length) {
          slideCombinedData[startSample + j] = data[j];
        }
      }
    }

    buffers.push(slideCombinedBuffer);
  }

  // 2. Compute transition timestamps dynamically based on merged slide voice durations
  let currentOffset = 0;
  for (let i = 0; i < slides.length - 1; i++) {
    const buffer = buffers[i];
    const isQuizQuestion = slides[i].layout === 'quiz_question';
    
    // Next slide starts immediately after voice concludes (plus 0.5s silence before answer reveal)
    if (isQuizQuestion) {
      currentOffset += buffer.duration + 0.5;
    } else {
      currentOffset += buffer.duration;
    }
    timestamps.push(currentOffset);
  }

  // Helper to resolve relative asset URLs locally and on GitHub Pages
  const resolveAudioUrl = (src: string): string => {
    if (src.startsWith('http://') || src.startsWith('https://')) {
      return src;
    }
    const basePath = window.location.origin + window.location.pathname.replace(/\/(index\.html)?$/, '');
    return `${basePath}/audio/${src}?v=4`;
  };

  // Load and decode slide sound effects in parallel
  const soundEffects: { buffer: AudioBuffer; startOffset: number; volume: number; slideIndex: number }[] = [];
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    if (slide.audios) {
      for (const audio of slide.audios) {
        try {
          const resolvedUrl = resolveAudioUrl(audio.src);
          const response = await fetch(resolvedUrl);
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          const arrayBuffer = await response.arrayBuffer();
          // Use copy of context to prevent thread block
          const effectBuf = await audioCtx.decodeAudioData(arrayBuffer);
          
          soundEffects.push({
            buffer: effectBuf,
            startOffset: timestamps[i] + audio.offset,
            volume: audio.volume,
            slideIndex: i
          });
        } catch (e) {
          console.warn(`Failed to load sound effect ${audio.src}:`, e);
        }
      }
    }
  }

  // 3. Compute total length of combined narration track
  const lastBuffer = buffers[buffers.length - 1];
  let totalDuration = currentOffset + (lastBuffer ? lastBuffer.duration : 4.0);
  
  // Extend totalDuration if any sound effect extends past it
  for (const fx of soundEffects) {
    const fxEnd = fx.startOffset + fx.buffer.duration;
    if (fxEnd > totalDuration) {
      totalDuration = fxEnd;
    }
  }
  
  // Create combined single channel AudioBuffer
  const combinedBuffer = audioCtx.createBuffer(1, Math.floor(totalDuration * sampleRate), sampleRate);
  const combinedData = combinedBuffer.getChannelData(0);

  // 4. Merge slide audio buffers into the master timeline channel
  for (let i = 0; i < slides.length; i++) {
    const buffer = buffers[i];
    const startSample = Math.floor(timestamps[i] * sampleRate);
    const channelData = buffer.getChannelData(0);
    
    for (let j = 0; j < channelData.length; j++) {
      if (startSample + j < combinedData.length) {
        combinedData[startSample + j] = channelData[j];
      }
    }
  }

  // 5. Merge sound effects into the master timeline channel additively (with slide boundary gating & fade-out)
  for (const fx of soundEffects) {
    const startSample = Math.floor(fx.startOffset * sampleRate);
    
    // Find the end time of the slide this sound effect belongs to
    const slideIndex = fx.slideIndex;
    const slideEndTime = (slideIndex < slides.length - 1) ? timestamps[slideIndex + 1] : totalDuration;
    const endSample = Math.floor(slideEndTime * sampleRate);
    
    const channelData = fx.buffer.getChannelData(0);
    const vol = fx.volume;
    const maxSamples = endSample - startSample;
    const fadeSamples = Math.floor(0.1 * sampleRate); // 0.1s linear fade-out
    
    for (let j = 0; j < channelData.length; j++) {
      if (j >= maxSamples) break; // Gate: stop writing past the slide boundary!
      
      let sampleVal = channelData[j] * vol;
      
      // Apply linear fade-out in the last 0.1 seconds of the slide
      if (maxSamples > fadeSamples && j >= maxSamples - fadeSamples) {
        const fadeRatio = (maxSamples - j) / fadeSamples; // goes from 1.0 down to 0.0
        sampleVal *= fadeRatio;
      }
      
      if (startSample + j < combinedData.length) {
        combinedData[startSample + j] += sampleVal;
      }
    }
  }

  // 6. Master peak limiter (clamp between -1.0 and 1.0)
  for (let i = 0; i < combinedData.length; i++) {
    if (combinedData[i] > 1.0) {
      combinedData[i] = 1.0;
    } else if (combinedData[i] < -1.0) {
      combinedData[i] = -1.0;
    }
  }

  return {
    buffer: combinedBuffer,
    timestamps
  };
}
