export interface SlideAudio {
  src: string;
  offset: number;
  volume: number;
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
<layout>list_layout</layout>
<header>1. <red>Freezing</red></header>
<sub_header>very cold（とても寒い）の代わりに使えます</sub_header>
</slide2>

<slide3>
<layout>quiz_question</layout>
<header>2. <yellow>Starving</yellow></header>
<sub_header>very hungry より「極限の飢え」を表すのはどっち？</sub_header>
<choices>["Starving", "Dying"]</choices>
<answer>Starving</answer>
<audio src="tictoc.mp3" volume="0.6" />
</slide3>

<slide4>
<layout>quiz_answer</layout>
<header>正解は <yellow>Starving!</yellow></header>
<sub_header>I am starving! で「お腹ペコペコ！」と表現できます</sub_header>
<audio src="tada.mp3" volume="0.7" />
</slide4>

<slide5>
<layout>list_layout</layout>
<header>ループで復習！</header>
<sub_header>これらは日常会話で本当によく使います。忘れないように、今すぐ…</sub_header>
</slide5>
`;
