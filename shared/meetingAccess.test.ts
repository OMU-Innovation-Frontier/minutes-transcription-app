import { describe, expect, it } from 'vitest';
import { canAccessMeeting, type MeetingAccessContext } from './meetingAccess';

const base: MeetingAccessContext = {
  userId: 'viewer', ownerId: 'creator', sharedCircleId: 'circle-a', memberships: [],
};
const actions = ['read', 'update', 'delete', 'share'] as const;

describe('meeting access rules for verified server data', () => {
  it.each(actions)('denies unauthenticated %s even when the owner identifier is empty', (action) => {
    expect(canAccessMeeting({ ...base, userId: null }, action)).toBe(false);
    expect(canAccessMeeting({ ...base, userId: '', ownerId: '' }, action)).toBe(false);
  });
  it.each(actions)('allows an owner to %s their personal meeting', (action) => {
    expect(canAccessMeeting({ ...base, userId: base.ownerId, sharedCircleId: null }, action)).toBe(true);
  });
  it.each(actions)('denies %s to a member of a different circle', (action) => {
    expect(canAccessMeeting({ ...base, memberships: [{ circleId: 'circle-b', role: 'admin' }] }, action)).toBe(false);
  });
  it.each(actions)('keeps personal meetings private from circle admins: %s', (action) => {
    expect(canAccessMeeting({ ...base, sharedCircleId: null, memberships: [{ circleId: 'circle-a', role: 'admin' }] }, action)).toBe(false);
  });
  it('allows members to read shared meetings but denies edits, deletion, and re-sharing', () => {
    const member = { ...base, memberships: [{ circleId: 'circle-a', role: 'member' as const }] };
    expect(actions.map((action) => canAccessMeeting(member, action))).toEqual([true, false, false, false]);
  });
  it('allows admins to delete shared meetings without changing their content or visibility', () => {
    const admin = { ...base, memberships: [{ circleId: 'circle-a', role: 'admin' as const }] };
    expect(actions.map((action) => canAccessMeeting(admin, action))).toEqual([true, false, true, false]);
  });
  it('revokes access immediately when membership is removed', () => {
    expect(canAccessMeeting({ ...base, memberships: [{ circleId: 'circle-a', role: 'member' }] }, 'read')).toBe(true);
    expect(canAccessMeeting(base, 'read')).toBe(false);
  });
});
