import { describe, expect, it } from 'vitest';
import type { LiveMeetingSummary } from '../../shared/summary';
import { presentFinalSummary, presentLiveSummary } from './liveSummaryView';

const summary: LiveMeetingSummary = {
  version: 1,
  topic: '画面設計の確認',
  keyPoints: [{ text: '文字を中心にする', evidenceSentenceIds: ['sentence-1'] }],
  decisions: [],
  actionItems: [{ task: '余白を確認する', assignee: null, dueDate: null, evidenceSentenceIds: ['sentence-1'] }],
  openQuestions: [],
};

describe('live summary presentation', () => {
  it('shows a truthful empty state when no summary exists', () => {
    expect(presentLiveSummary(null)).toMatchObject({
      empty: true,
      topic: '会議内容が増えると、ここに簡易要約が表示されます',
    });
  });

  it('presents only sections backed by summary data', () => {
    const result = presentLiveSummary(summary);
    expect(result.empty).toBe(false);
    expect(result.topic).toBe('画面設計の確認');
    expect(result.sections.map((section) => section.label)).toEqual(['要点', '次に行うこと']);
  });

  it('does not mutate transcript data while presenting a summary update', () => {
    const transcript = [{ id: 'sentence-1', text: '原文' }];
    const before = structuredClone(transcript);
    presentLiveSummary(summary);
    expect(transcript).toEqual(before);
  });

  it('uses the empty message until a final summary exists', () => {
    expect(presentFinalSummary(null)).toContain('簡易要約が表示されます');
  });
});
