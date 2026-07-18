import type {
  FinalMeetingSummary,
  FinalSummaryInput,
  IncrementalSummaryInput,
  LiveMeetingSummary,
  SummaryProvider,
} from '../../../shared/summary.js';

export class MockSummaryProvider implements SummaryProvider {
  async updateSummary(input: IncrementalSummaryInput): Promise<LiveMeetingSummary> {
    const previous = input.previousSummary;
    const additions = input.newSentences.map((sentence) => ({ text: sentence.text, evidenceSentenceIds: [sentence.id] }));
    return {
      version: (previous?.version ?? 0) + 1,
      topic: previous?.topic ?? input.newSentences[0]?.text.slice(0, 80) ?? null,
      keyPoints: [...(previous?.keyPoints ?? []), ...additions],
      decisions: previous?.decisions ?? [],
      actionItems: previous?.actionItems ?? [],
      openQuestions: previous?.openQuestions ?? [],
    };
  }

  async createFinalSummary(input: FinalSummaryInput): Promise<FinalMeetingSummary> {
    const items = input.sentences.map((sentence) => ({ text: sentence.text, evidenceSentenceIds: [sentence.id] }));
    return {
      version: (input.liveSummary?.version ?? 0) + 1,
      overview: input.sentences.length === 0 ? '発言はありません。' : `${input.sentences.length}文の会議記録です。`,
      agenda: items.slice(0, 3),
      keyPoints: items,
      decisions: input.liveSummary?.decisions ?? [],
      unresolvedItems: input.liveSummary?.openQuestions ?? [],
      actionItems: input.liveSummary?.actionItems ?? [],
      nextChecks: input.liveSummary?.openQuestions ?? [],
    };
  }
}
