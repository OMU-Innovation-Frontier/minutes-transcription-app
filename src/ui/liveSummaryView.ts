import type { FinalMeetingSummary, LiveMeetingSummary } from '../../shared/summary';

export interface SummarySectionPresentation {
  label: string;
  items: string[];
}

export interface LiveSummaryPresentation {
  empty: boolean;
  topic: string;
  sections: SummarySectionPresentation[];
}

export function presentLiveSummary(summary: LiveMeetingSummary | null): LiveSummaryPresentation {
  if (!summary) {
    return {
      empty: true,
      topic: '会議内容が増えると、ここに簡易要約が表示されます',
      sections: [],
    };
  }
  const sections: SummarySectionPresentation[] = [
    { label: '要点', items: summary.keyPoints.map((item) => item.text) },
    { label: '決まったこと', items: summary.decisions.map((item) => item.text) },
    { label: '次に行うこと', items: summary.actionItems.map((item) => item.task) },
    { label: '確認が必要なこと', items: summary.openQuestions.map((item) => item.text) },
  ].filter((section) => section.items.length > 0);
  return {
    empty: !summary.topic && sections.length === 0,
    topic: summary.topic ?? '議題はまだ確定していません',
    sections,
  };
}

export function presentFinalSummary(summary: FinalMeetingSummary | null): string {
  return summary?.overview.trim() || '会議内容が増えると、ここに簡易要約が表示されます';
}
