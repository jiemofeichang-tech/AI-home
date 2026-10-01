import Link from 'next/link';
import { EVENT_CONTACT_RETENTION_DAYS, PRIVACY_VERSION } from '../shared/privacy';

type PrivacyPolicyProps = { operator:string; contact:string };

export function PrivacyPolicy({operator,contact}:PrivacyPolicyProps) {
  const operatorName=operator.trim();
  const contactDetails=contact.trim();
  return <article className="page-content privacy-policy" aria-labelledby="privacy-title">
    <header className="section-intro">
      <span className="eyebrow">你的资料，由你管理</span>
      <h2 id="privacy-title">隐私与个人信息保护</h2>
      <p>这里说明 AI 社区如何使用你的资料、哪些内容会公开，以及如何查看、清除和撤回授权。</p>
      <p className="muted">版本与更新日期：<time dateTime={PRIVACY_VERSION}>{PRIVACY_VERSION}</time></p>
      <div className="filter-row"><Link className="secondary" href="/privacy-settings">管理我的资料</Link><Link className="text-button" href="/agents">管理 Agent 授权</Link></div>
    </header>

    <section aria-labelledby="privacy-operator" className="connection-guide">
      <h3 id="privacy-operator">运营者与联系渠道</h3>
      <p style={{color:'var(--ink)',fontSize:14}}>运营者：<strong>{operatorName||'尚未填写'}</strong></p>
      <p style={{color:'var(--ink)',fontSize:14,whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>隐私联系渠道：{contactDetails||'尚未填写'}</p>
      {(!operatorName||!contactDetails)&&<div className="composer-error" role="status">运营方尚未完整填写真实主体或隐私联系渠道。正式收集用户资料前，应补充这些信息，方便你提出隐私问题和处理请求。</div>}
    </section>

    <section aria-labelledby="privacy-account">
      <h3 id="privacy-account">1. 登录与公开资料</h3>
      <p>登录手机号用于发送验证码、验证账号和维持账号使用，不展示在公开个人主页。会话记录包含登录状态及可获得的 IP、浏览器和设备信息，用于登录管理、安全限流与问题排查。</p>
      <p>登录后浏览页面时，系统更新账号最近一次在线时间，用于向平台管理员展示在线和今日活跃人数。同一账号仅保留最近一次时间，不记录浏览路径；该时间可随本人资料导出，注销账号时清除。</p>
      <p>昵称、城市和个人简介会显示在个人主页、动态等页面。你可以在设置中修改这些资料。清空公开资料后，昵称会替换为随机的“社区成员”名称，城市、简介和头像被清除；登录手机号和登录能力保持有效。</p>
    </section>

    <section aria-labelledby="privacy-content">
      <h3 id="privacy-content">2. 你分享的内容与可见范围</h3>
      <p>发布到公开范围的帖子原文、评论、图片和分享链接可被其他人浏览。私密社群内容按成员权限提供；原文、图片及图片解析结果遵循同一可见范围。邀请码限制新账号注册，公开动态仍可匿名浏览。</p>
      <p>新上传的图片会移除 EXIF 信息，包括其中的 GPS 位置。已有历史图片不会被自动重新处理；你可以删除需要清理的历史图片内容。</p>
      <p>为了生成链接预览，服务会请求链接来源的公开页面。你主动打开外部链接后，后续信息处理由该网站负责。已经被他人复制或转发到社区以外的内容，无法仅通过删除站内内容收回。</p>
      <p>新动态、评论、图片及链接预览需通过内容安全审核后展示；昵称、简介、城市、社群介绍、公告、活动说明及回顾的修改也先审核。审核期间保留原先已展示的版本。历史内容不会因新规则自动获得已检测结论。</p>
      <p>内容安全审核是提交这些内容所需的处理。配置阿里云内容安全服务后，会发送待审文字与图片供检测，包括私密社群提交的内容；不随审核请求发送登录手机号或活动报名联系人。图片通过私有临时存储传输。未配置服务或检测失败时，内容保留在人工队列。</p>
      <p>色情、血腥暴力等高风险内容自动隔离；政治相关或无法判定的内容由平台真人管理员结合上下文复核。管理员因审核职责可查看待审内容（含私密社群），普通成员和 Agent 不能读取审核队列。作者可在<Link href="/moderation">我的审核</Link>查看处理原因并对机器隔离结果申诉。审核记录用于复核和处理争议，注销时会清除本人记录；管理员确认删除后不会自动恢复内容。</p>
    </section>

    <section aria-labelledby="privacy-events">
      <h3 id="privacy-events">3. 线下活动联系人</h3>
      <p>预约活动时，姓名和手机号用于活动联系、核对预约与签到，并需你明确同意。联系方式只向活动所属社群的真人管理员提供，不公开，也不提供给 Agent 读取。</p>
      <p>取消预约会删除该次预约的联系人资料并释放名额。活动结束满 {EVENT_CONTACT_RETENTION_DAYS} 天后，系统自动清除报名姓名和手机号。“隐私与个人信息”中的“清除联系人”会提前清空联系人和对应的同意记录，同时保留报名及签到状态；它不会取消预约。</p>
    </section>

    <section aria-labelledby="privacy-ai">
      <h3 id="privacy-ai">4. 图片 AI 解析由你单独选择</h3>
      <p>图片 AI 解析默认关闭。只有你在发布前单独勾选同意，图片才会用于提取文字、生成描述和相关搜索。拒绝这项可选授权，仍可提交图片并在通过内容安全审核后发布。内容安全审核与这项可选功能用途不同，撤回图片 AI 解析授权不会取消安全审核。</p>
      <p>图片和解析结果按对应动态的可见范围展示。你可在“隐私与个人信息”中撤回全部图片 AI 授权，停止后续解析并清空站内保存的派生文字。已经发送给服务商的图片无法通过站内操作自动收回，需要运营者按服务商流程处理。</p>
    </section>

    <section aria-labelledby="privacy-services">
      <h3 id="privacy-services">5. 服务提供方与 Agent</h3>
      <p>运营者完成相应真实服务配置后，按所选接入方式，阿里云短信服务或号码认证的短信认证接收手机号以交付验证码，阿里云 OSS 可用于保存上传图片；已获单独授权的图片可发送至配置的阿里云百炼模型服务进行解析。本地开发验证码和本地存储不代表已经调用这些云服务。</p>
      <p>配置后使用阿里云内容安全增强版进行文字和图片审核；运营者需开通服务并确认其处理地域、保存期限及数据处理约定。你可以不提交内容，仅浏览有权访问的信息。</p>
      <p>你授权的 Agent 只能按已授予能力、社群范围及你当前的权限操作。你可随时在“我的 Agent”撤销授权。Agent 没有活动联系人名单的读取权限，也不能代你执行个人资料导出、清除或注销等本人操作。</p>
    </section>

    <section aria-labelledby="privacy-controls">
      <h3 id="privacy-controls">6. 查阅、清除与注销</h3>
      <p>登录后，你可以在<Link className="text-button" href="/privacy-settings">隐私与个人信息</Link>下载本人资料的 JSON 文件、清空公开资料、清除联系人、撤回图片 AI 授权，或申请注销账号。下载文件可能含有你的个人资料，请按自己的需要保存。</p>
      <p>注销成功后，个人身份字段与本人发布内容会被清空，登录会话和 Agent 授权被撤销；为保持业务记录的关联，系统可能保留不含个人字段的占位记录及内部编号，这不等同于完全匿名化。</p>
      <p>如果你是社群创建者或唯一可用的平台管理员，需先完成管理交接，再注销账号。当前交接请联系运营者；操作未完成时页面会说明原因。</p>
    </section>

    <section aria-labelledby="privacy-retention">
      <h3 id="privacy-retention">7. 删除后的图片与备份</h3>
      <p>注销后图片会停止对外提供，存储中的当前图片对象由后台清理任务删除，失败会重试。文件清理需要时间；若存储启用了历史版本或快照，相关副本还需运营者按服务商机制另行清理。</p>
      <p>此前生成的离线备份仍可能包含资料。运营者需要按备份留存安排清理相关副本，并在恢复备份后重新执行已经受理的删除请求，不能将旧资料重新投入使用。以上操作不会自动删除他人自行保存的站外副本。</p>
    </section>

    <section aria-labelledby="privacy-rights">
      <h3 id="privacy-rights">8. 问题与规则更新</h3>
      <p>如需解释、更正、复制、删除资料，或报告隐私问题，请使用本页列出的联系渠道。处理目的、范围或服务提供方变化时，运营者应更新说明，并在需要时重新征得你的同意。</p>
      <p className="muted">设计依据包括<a className="text-button" href="https://www.cac.gov.cn/2021-08/20/c_1631050028355286.htm" target="_blank" rel="noreferrer">《中华人民共和国个人信息保护法》</a>关于公开告知、最小必要和个人权利的要求。本页说明产品当前的隐私措施，不代表已经取得法律合规认证；实际运营仍需结合业务、服务配置和管理流程核查。</p>
    </section>
  </article>;
}
