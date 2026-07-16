export interface Slide {
  id: number;
  layout: string;
  header: string;
  sub_header: string;
  duration_seconds?: number;
  // Extra options for quiz layout
  choices?: string[];
  answer?: string;
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

    result.slides.push(slide);
  }

  return result;
}

export const DEFAULT_MARKDOWN = `<title>Stop VERY!</title>
<hook>『とても（very）』ばかり言うのを今すぐやめるべき理由！</hook>

<slide1>
<layout>hook_layout</layout>
<header>Stop Saying VERY!</header>
<sub_header>こればかり使うと初心者っぽい？</sub_header>
</slide1>

<slide2>
<layout>list_layout</layout>
<header>1. Freezing</header>
<sub_header>very cold の代わりに使うネイティブ表現</sub_header>
</slide2>

<slide3>
<layout>quiz_question</layout>
<header>2. Starving</header>
<sub_header>very hungry より『極限의 飢え』を表す表現はどっち？</sub_header>
<choices>["Starving", "Dying"]</choices>
<answer>Starving</answer>
</slide3>

<slide4>
<layout>quiz_answer</layout>
<header>正解は Starving!</header>
<sub_header>I am starving! で「お腹ペコペコ！」と使えます</sub_header>
</slide4>

<slide5>
<layout>list_layout</layout>
<header>関連動画をチェック！</header>
<sub_header>本編の絵本は関連動画からすぐに見られます！英語クイズの続きを楽しもう！</sub_header>
</slide5>
`;
