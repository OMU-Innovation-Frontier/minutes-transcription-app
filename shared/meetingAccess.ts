/** Input must come from verified identity and current server-side membership records. */
export interface MeetingAccessContext {
  userId: string | null;
  ownerId: string;
  sharedCircleId: string | null;
  memberships: readonly { circleId: string; role: 'admin' | 'member' }[];
}

export type MeetingAccessAction = 'read' | 'update' | 'delete' | 'share';

export function canAccessMeeting(context: MeetingAccessContext, action: MeetingAccessAction): boolean {
  if (!context.userId || !context.ownerId) return false;
  if (context.userId === context.ownerId) return true;
  if (!context.sharedCircleId) return false;
  const membership = context.memberships.find((item) => item.circleId === context.sharedCircleId);
  if (!membership) return false;
  return action === 'read' || (action === 'delete' && membership.role === 'admin');
}
