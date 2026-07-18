export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export const DEFAULT_FOLLOW_THRESHOLD_PX = 96;

export function isNearScrollEnd(metrics: ScrollMetrics, threshold = DEFAULT_FOLLOW_THRESHOLD_PX): boolean {
  const distance = metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
  return distance <= threshold;
}

export function followStateAfterScroll(metrics: ScrollMetrics, threshold = DEFAULT_FOLLOW_THRESHOLD_PX): boolean {
  return isNearScrollEnd(metrics, threshold);
}

export function shouldFollowTranscriptUpdate(
  following: boolean,
  previousSentenceCount: number,
  nextSentenceCount: number,
  interimChanged: boolean,
): boolean {
  return following && (nextSentenceCount > previousSentenceCount || interimChanged);
}
