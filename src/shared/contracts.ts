import { z } from 'zod';
export const scopes = ['content:read','posts:write','interactions:write','events:rsvp','events:manage'] as const;
export const scopeLabels: Record<string,string> = { 'content:read':'读取内容', 'posts:write':'发布帖子', 'interactions:write':'评论、转发和收藏', 'events:rsvp':'报名和取消报名', 'events:manage':'创建和管理活动' };
const id = z.string().min(1).max(128);
const text = z.string().trim().min(1).max(10000);
const page = { limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().optional() };
const webUrl=z.string().url('请输入有效的 HTTP 或 HTTPS 网页链接').max(2048).refine(value=>{try{return ['http:','https:'].includes(new URL(value).protocol);}catch{return false;}},'仅支持 HTTP 或 HTTPS 网页链接');
export const contracts = {
  posts_list: z.object({ ...page, feed:z.enum(['latest','following','bookmarks']).default('latest'), communityId:id.optional(), authorId:id.optional(), tag:z.string().optional() }),
  posts_get: z.object({ id }),
  posts_create: z.object({ body:z.string().trim().max(10000).default(''), communityId:id.optional(), originalId:id.optional(), mediaIds:z.array(id).max(9).default([]), imageAnalysisConsent:z.boolean().default(false).describe('仅在本人同意将图片交给配置的AI服务提取文字后设为true；不影响正常发图'), links:z.array(webUrl).max(5).default([]), idempotencyKey:z.string().max(128).optional() }),
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
  events_rsvp: z.object({
    id, attending:z.boolean(),
    contactConsent:z.boolean().optional().describe('预约时必须为 true，确认本人同意姓名和手机号仅用于活动联系与签到，活动结束30天后清除'),
    attendeeName:z.string().trim().min(1,'请输入报名姓名').max(60,'报名姓名最多 60 个字符').describe('报名时必填的联系人姓名；取消报名无需填写').optional(),
    phoneNumber:z.string().trim().regex(/^(?:\+86)?1[3-9]\d{9}$/,'请输入有效的中国大陆手机号').describe('报名时必填的中国大陆手机号，可带 +86 前缀；取消报名无需填写').optional()
  }).superRefine((input,ctx)=>{
    if(!input.attending)return;
    if(input.contactConsent!==true)ctx.addIssue({code:'custom',path:['contactConsent'],message:'请确认同意将姓名和手机号用于本次活动联系与签到'});
    if(input.attendeeName===undefined)ctx.addIssue({code:'custom',path:['attendeeName'],message:'请输入报名姓名'});
    if(input.phoneNumber===undefined)ctx.addIssue({code:'custom',path:['phoneNumber'],message:'请输入联系电话'});
  }),
  events_attendees: z.object({ id }),
  events_checkin: z.object({ id, userId:id }),
  events_update: z.object({ id, recap:z.string().max(10000).optional(), cancelled:z.boolean().optional() }),
  search: z.object({ q:z.string().trim().min(1).max(200), type:z.enum(['all','posts','github','communities','events']).default('all'), city:z.string().optional(), tag:z.string().optional(), ...page }),
  profile_get: z.object({ id }),
  profile_update: z.object({ name:z.string().trim().min(1).max(40), bio:z.string().max(500), city:z.string().max(60), avatarMediaId:id.nullable().optional().describe('本人上传的头像图片 ID；null 移除头像，省略保留当前头像。资料和头像审核通过前仍展示原版本。') }),
  follows_set: z.object({ id, active:z.boolean() }),
  blocks_set: z.object({ id, active:z.boolean() }),
  grants_list: z.object({}),
  grants_create: z.object({ name:z.string().min(1).max(60), scopes:z.array(z.enum(scopes)).min(1), communityIds:z.array(id).max(100).default([]), days:z.coerce.number().int().min(1).max(90).default(30), oauthClientId:z.string().optional() }),
  grants_revoke: z.object({ id }),
  notifications_list: z.object({}),
  notifications_read: z.object({}),
  reports_create: z.object({ id, reason:z.string().min(2).max(1000) }),
  admin_overview: z.object({}),
  admin_stats: z.object({}),
  moderation_list: z.object({mine:z.preprocess(value=>value==='true'?true:value==='false'?false:value,z.boolean().default(false)),status:z.enum(['pending','review','rejected','approved','deleted','actionable']).optional()}),
  moderation_decide: z.object({id,decision:z.enum(['approve','delete']),reason:z.string().trim().min(2,'请填写处理原因').max(1000)}),
  moderation_appeal: z.object({id,reason:z.string().trim().min(2,'请说明申诉理由').max(1000)}),
  moderation_retry: z.object({id}),
  moderation_withdraw: z.object({id}),
  invitations_list: z.object({}),
  invitations_create: z.object({count:z.coerce.number().int().min(1).max(20).default(1),days:z.coerce.number().int().min(1).max(30).default(7),label:z.string().trim().max(120).default('')}),
  invitations_revoke: z.object({id}),
  admin_moderate: z.object({ reportId:id.optional(), postId:id.optional(), userId:id.optional(), banned:z.boolean().optional() }),
  jobs_retry: z.object({ id })
};
export type Action = keyof typeof contracts;
export type Actor = { userId?: string; agentName?: string; grantId?:string; scopes?:string[]; tokenScopes?:string[]; communityIds?:string[] };
export type Item = Record<string, any>;
export class AppError extends Error { constructor(public status:number, message:string, public code='REQUEST_FAILED') { super(message); } }
export function fail(status:number, message:string, code?:string): never { throw new AppError(status,message,code); }
