import { z } from 'zod';
export const scopes = ['content:read','posts:write','interactions:write','events:rsvp','events:manage'] as const;
export const scopeLabels: Record<string,string> = { 'content:read':'读取内容', 'posts:write':'发布帖子', 'interactions:write':'评论、转发和收藏', 'events:rsvp':'报名和取消报名', 'events:manage':'创建和管理活动' };
const id = z.string().min(1).max(128);
const text = z.string().trim().min(1).max(10000);
const page = { limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().optional() };
const webUrl=z.string().url().max(2048).refine(value=>['http:','https:'].includes(new URL(value).protocol),'仅支持 HTTP 或 HTTPS 网页链接');
export const contracts = {
  posts_list: z.object({ ...page, feed:z.enum(['latest','following','bookmarks']).default('latest'), communityId:id.optional(), authorId:id.optional(), tag:z.string().optional() }),
  posts_get: z.object({ id }),
  posts_create: z.object({ body:z.string().trim().max(10000).default(''), communityId:id.optional(), originalId:id.optional(), mediaIds:z.array(id).max(9).default([]), links:z.array(webUrl).max(5).default([]), idempotencyKey:z.string().max(128).optional() }),
  posts_delete: z.object({ id }),
  comments_create: z.object({ id, body:text, idempotencyKey:z.string().max(128).optional() }),
  reactions_set: z.object({ id, kind:z.enum(['like','bookmark']), active:z.boolean() }),
  communities_list: z.object({ city:z.string().optional() }),
  communities_get: z.object({ id }),
  communities_create: z.object({ name:z.string().trim().min(2).max(60), description:text, city:z.string().trim().min(1).max(60), visibility:z.enum(['public','private']) }),
  communities_join: z.object({ id }),
  communities_leave: z.object({ id }),
  communities_members: z.object({ id }),
  communities_approve: z.object({ id, userId:id, approved:z.boolean() }),
  communities_remove: z.object({ id, userId:id }),
  communities_announcement: z.object({ id, announcement:z.string().max(5000) }),
  events_list: z.object({ city:z.string().optional(), communityId:id.optional() }),
  events_get: z.object({ id }),
  events_create: z.object({ communityId:id, title:z.string().trim().min(2).max(120), description:text, city:z.string().min(1).max(60), address:z.string().min(1).max(500), startsAt:z.string().datetime({offset:true}), endsAt:z.string().datetime({offset:true}), capacity:z.coerce.number().int().min(1).max(1000), idempotencyKey:z.string().max(128).optional() }),
  events_rsvp: z.object({ id, attending:z.boolean() }),
  events_attendees: z.object({ id }),
  events_checkin: z.object({ id, userId:id }),
  events_update: z.object({ id, recap:z.string().max(10000).optional(), cancelled:z.boolean().optional() }),
  search: z.object({ q:z.string().trim().min(1).max(200), type:z.enum(['all','posts','github','communities','events']).default('all'), city:z.string().optional(), tag:z.string().optional(), ...page }),
  profile_get: z.object({ id }),
  profile_update: z.object({ name:z.string().trim().min(1).max(40), bio:z.string().max(500), city:z.string().max(60) }),
  follows_set: z.object({ id, active:z.boolean() }),
  blocks_set: z.object({ id, active:z.boolean() }),
  grants_list: z.object({}),
  grants_create: z.object({ name:z.string().min(1).max(60), scopes:z.array(z.enum(scopes)).min(1), communityIds:z.array(id).max(100).default([]), days:z.coerce.number().int().min(1).max(90).default(30), oauthClientId:z.string().optional() }),
  grants_revoke: z.object({ id }),
  notifications_list: z.object({}),
  notifications_read: z.object({}),
  reports_create: z.object({ id, reason:z.string().min(2).max(1000) }),
  admin_overview: z.object({}),
  admin_moderate: z.object({ reportId:id.optional(), postId:id.optional(), userId:id.optional(), banned:z.boolean().optional() }),
  jobs_retry: z.object({ id })
};
export type Action = keyof typeof contracts;
export type Actor = { userId?: string; agentName?: string; grantId?:string; scopes?:string[]; tokenScopes?:string[]; communityIds?:string[] };
export type Item = Record<string, any>;
export class AppError extends Error { constructor(public status:number, message:string, public code='REQUEST_FAILED') { super(message); } }
export function fail(status:number, message:string, code?:string): never { throw new AppError(status,message,code); }
