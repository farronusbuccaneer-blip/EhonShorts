export interface SlideAudio {
  src: string;
  offset: number;
  volume: number;
}

export interface SlideImage {
  src: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  isBackground: boolean;
}

export interface SlideVideo {
  src: string;
}

export interface Slide {
  id: number;
  layout: string;
  header: string;
  sub_header: string;
  duration_seconds?: number;
  // Extra options for quiz layout
  choices?: string[];
  answer?: string;
  audios?: SlideAudio[];
  images?: SlideImage[];
  video?: SlideVideo;
}

export interface MarkdownData {
  title: string;
  hook: string;
  slides: Slide[];
}

export function parseMarkdown(mdText: string): MarkdownData {
  const result: MarkdownData = {
    title: 'Untitled Video',
    hook: '',
    slides: []
  };

  // 1. Parse Title
  const titleMatch = mdText.match(/<title>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    result.title = titleMatch[1].trim();
  }

  // 2. Parse Hook
  const hookMatch = mdText.match(/<hook>([\s\S]*?)<\/hook>/i);
  if (hookMatch) {
    result.hook = hookMatch[1].trim();
  }

  // 3. Parse Slide Blocks dynamically (<slide(\d+)>...</slide\1>)
  const slideRegex = /<slide(\d+)>([\s\S]*?)<\/slide\1>/gi;
  let match;

  while ((match = slideRegex.exec(mdText)) !== null) {
    const slideId = parseInt(match[1], 10);
    const slideBody = match[2];

    const slide: Slide = {
      id: slideId,
      layout: 'hook_layout',
      header: '',
      sub_header: ''
    };

    // Parse layout
    const layoutMatch = slideBody.match(/<layout>([\s\S]*?)<\/layout>/i);
    if (layoutMatch) slide.layout = layoutMatch[1].trim();

    // Parse header
    const headerMatch = slideBody.match(/<header>([\s\S]*?)<\/header>/i);
    if (headerMatch) slide.header = headerMatch[1].trim();

    // Parse sub_header
    const subHeaderMatch = slideBody.match(/<sub_header>([\s\S]*?)<\/sub_header>/i);
    if (subHeaderMatch) slide.sub_header = subHeaderMatch[1].trim();

    // Parse duration_seconds (optional)
    const durationMatch = slideBody.match(/<duration_seconds>([\s\S]*?)<\/duration_seconds>/i);
    if (durationMatch) slide.duration_seconds = parseFloat(durationMatch[1].trim());

    // Parse answer
    const answerMatch = slideBody.match(/<answer>([\s\S]*?)<\/answer>/i);
    if (answerMatch) slide.answer = answerMatch[1].trim();

    // Parse choices
    const choicesMatch = slideBody.match(/<choices>([\s\S]*?)<\/choices>/i);
    if (choicesMatch) {
      const choicesStr = choicesMatch[1].trim();
      try {
        slide.choices = JSON.parse(choicesStr);
      } catch {
        // Fallback to splitting by comma or quotes
        slide.choices = choicesStr.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
      }
    }

    // Parse audios (supporting attributes: src, offset, volume)
    const audios: SlideAudio[] = [];
    const audioTagRegex = /<audio\s+([^>]*?)\/?>|<audio>([\s\S]*?)<\/audio>/gi;
    let audioMatch;
    while ((audioMatch = audioTagRegex.exec(slideBody)) !== null) {
      if (audioMatch[1]) {
        const attrStr = audioMatch[1];
        const srcAttr = attrStr.match(/src=["']([\s\S]*?)["']/i);
        const offsetAttr = attrStr.match(/offset=["']([\s\S]*?)["']/i);
        const volumeAttr = attrStr.match(/volume=["']([\s\S]*?)["']/i);
        
        if (srcAttr) {
          audios.push({
            src: srcAttr[1].trim(),
            offset: offsetAttr ? parseFloat(offsetAttr[1]) : 0,
            volume: volumeAttr ? parseFloat(volumeAttr[1]) : 1.0
          });
        }
      } else if (audioMatch[2]) {
        audios.push({
          src: audioMatch[2].trim(),
          offset: 0,
          volume: 1.0
        });
      }
    }
    if (audios.length > 0) {
      slide.audios = audios;
    }

    // Parse slide-specific background video
    let video: SlideVideo | undefined = undefined;
    const videoTagRegex = /<video\s+([^>]*?)\/?>|<video>([\s\S]*?)<\/video>/i;
    const videoMatch = slideBody.match(videoTagRegex);
    if (videoMatch) {
      if (videoMatch[1]) {
        const srcAttr = videoMatch[1].match(/src=["']([\s\S]*?)["']/i);
        if (srcAttr) {
          video = { src: srcAttr[1].trim() };
        }
      } else if (videoMatch[2]) {
        video = { src: videoMatch[2].trim() };
      }
    }
    if (video) slide.video = video;

    // Parse slide-specific background and overlay images
    const images: SlideImage[] = [];

    // Parse <bg_image> background image tag
    const bgImageTagRegex = /<bg_image\s+([^>]*?)\/?>|<bg_image>([\s\S]*?)<\/bg_image>/i;
    const bgImageMatch = slideBody.match(bgImageTagRegex);
    if (bgImageMatch) {
      if (bgImageMatch[1]) {
        const srcAttr = bgImageMatch[1].match(/src=["']([\s\S]*?)["']/i);
        if (srcAttr) {
          images.push({
            src: srcAttr[1].trim(),
            isBackground: true
          });
        }
      } else if (bgImageMatch[2]) {
        images.push({
          src: bgImageMatch[2].trim(),
          isBackground: true
        });
      }
    }

    // Parse <image> tags (which can be overlays with x,y,w,h coordinates, or backgrounds if no coords are given)
    const imageTagRegex = /<image\s+([^>]*?)\/?>|<image>([\s\S]*?)<\/image>/gi;
    let imageMatch;
    while ((imageMatch = imageTagRegex.exec(slideBody)) !== null) {
      if (imageMatch[1]) {
        const attrStr = imageMatch[1];
        const srcAttr = attrStr.match(/src=["']([\s\S]*?)["']/i);
        const xAttr = attrStr.match(/x=["']([\s\S]*?)["']/i);
        const yAttr = attrStr.match(/y=["']([\s\S]*?)["']/i);
        const wAttr = attrStr.match(/w=["']([\s\S]*?)["']/i);
        const hAttr = attrStr.match(/h=["']([\s\S]*?)["']/i);
        
        if (srcAttr) {
          const hasCoords = xAttr || yAttr || wAttr || hAttr;
          images.push({
            src: srcAttr[1].trim(),
            x: xAttr ? parseFloat(xAttr[1]) : undefined,
            y: yAttr ? parseFloat(yAttr[1]) : undefined,
            w: wAttr ? parseFloat(wAttr[1]) : undefined,
            h: hAttr ? parseFloat(hAttr[1]) : undefined,
            isBackground: !hasCoords // Treat as background if no coords are specified at all
          });
        }
      } else if (imageMatch[2]) {
        images.push({
          src: imageMatch[2].trim(),
          isBackground: true
        });
      }
    }
    if (images.length > 0) {
      slide.images = images;
    }

    result.slides.push(slide);
  }

  return result;
}

export const DEFAULT_MARKDOWN = `<title>Stop VERY!</title>
<hook>『とても（very）』ばかり言うのを今すぐやめるべき理由！</hook>

<slide1>
<layout>hook_layout</layout>
<header>Stop Saying <yellow>VERY!</yellow></header>
<sub_header>こればかり使うと初心者っぽく聞こえるので…</sub_header>
<audio src="swoosh.mp3" volume="0.8" />
</slide1>

<slide2>
<layout>quiz_question</layout>
<header>1. <yellow>Starving</yellow></header>
<sub_header>very hungry より「極限の飢え」を表すのはどっち？</sub_header>
<choices>["Starving", "Dying"]</choices>
<answer>Starving</answer>
<audio src="tictoc.mp3" volume="0.6" />
</slide2>

<slide3>
<layout>quiz_answer</layout>
<header>正解は <yellow>Starving!</yellow></header>
<sub_header>I am starving! で「お腹ペコペコ！」と表現できます</sub_header>
<audio src="tada.mp3" volume="0.7" />
</slide3>

<slide4>
<layout>hook_layout</layout>
<header>忘れないように、今すぐ…</header>
<sub_header></sub_header>
</slide4>
`;

export function resolveAssetUrl(src: string, uploadedAssets?: Record<string, string>): string {
  if (uploadedAssets && uploadedAssets[src]) {
    return uploadedAssets[src];
  }
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('blob:')) {
    return src;
  }
  const basePath = window.location.origin + window.location.pathname.replace(/\/(index\.html)?$/, '');
  return `${basePath}/${src}`;
}
