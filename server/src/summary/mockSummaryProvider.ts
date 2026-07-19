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
    const actionItems = mergeActionItems(
      input.liveSummary?.actionItems ?? [],
      input.sentences.flatMap((sentence) => {
        const task = explicitTodo(sentence.text);
        return task ? [{ task, assignee: null, dueDate: null, evidenceSentenceIds: [sentence.id] }] : [];
      }),
    );
    return {
      version: (input.liveSummary?.version ?? 0) + 1,
      overview: input.sentences.length === 0 ? '発言はありません。' : `${input.sentences.length}文の会議記録です。`,
      agenda: items.slice(0, 3),
      keyPoints: items,
      decisions: input.liveSummary?.decisions ?? [],
      unresolvedItems: input.liveSummary?.openQuestions ?? [],
      actionItems,
      nextChecks: input.liveSummary?.openQuestions ?? [],
    };
  }
}

function explicitTodo(text: string): string | null {
  const match = text.trim().match(/^(?:\[TODO\]|TODO)\s*[:：]\s*(.+)$/iu);
  return match?.[1]?.trim() || null;
}

function mergeActionItems(
  existing: FinalMeetingSummary['actionItems'],
  additions: FinalMeetingSummary['actionItems'],
): FinalMeetingSummary['actionItems'] {
  const tasks = new Set(existing.map((item) => item.task));
  return [
    ...existing.map((item) => ({ ...item, evidenceSentenceIds: [...item.evidenceSentenceIds] })),
    ...additions.filter((item) => {
      if (tasks.has(item.task)) return false;
      tasks.add(item.task);
      return true;
    }),
  ];
}
