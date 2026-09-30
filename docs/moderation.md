# 内容审核与内测运营

新提交的内容先保存在站内审核队列，通过后才按原来的公开 / 私密社群权限展示。现在默认是**人工审核模式**，没有真实云凭据时不会将“未检测”误当成“通过”。管理员在 `/admin` 的“内容审核”中处理，作者在 `/moderation` 查看结果和申诉。

## 覆盖内容

- 动态正文、标签、引用内容、图片原图、附带的链接地址，以及后续生成的链接预览和可选图片文字 / 描述。
- 评论。
- 昵称、城市、简介、社群名称和介绍、公告、活动文字及回顾。采用独立草稿：批准前保留原公开版本；新社群和新活动批准前不能被加入或预约。
- 网页、REST、通用 actions、CLI 和 MCP 使用同一个入口；Agent 不能绕过审核或执行管理员审核动作。

历史内容迁移时保持当前可见状态，**不代表已经接受云检测**。本地种子演示内容也不作为云审核验收样本。外部视频目前只分享链接：站内审核覆盖链接和获得的预览文字，不下载或审核外站整段视频；外部页面后续变化也不能保证持续检测。

## 处理规则

| 状态 | 可见范围与后续处理 |
|---|---|
| pending / 等待自动审核 | 普通列表、直链、搜索、转发和媒体接口均不展示。 |
| approved / 审核通过 | 按原有社群、屏蔽和 Agent 授权规则展示。 |
| rejected / 已自动隔离 | 云服务明确高风险色情、血腥暴力等结果触发隔离，作者可申诉。 |
| review / 等待人工复核 | 政治相关、含义不明、未知标签、服务异常、未配置、动画未完整覆盖等情况由真人复核。 |
| deleted / 已删除 | 管理员填写原因并确认删除后停止展示，不会被自动重试或旧任务恢复。不是存储介质的即时物理销毁。 |

正常新闻、知识讨论和政治相关内容不依据单个关键词永久删除。管理员必须结合上下文给出理由；作者对机器隔离的申诉回到人工复核，不会自动放行。审核只作用于内容，不据此推断用户政治立场或自动封禁账号。

文字分块检测并在边界保留重叠，所有图片均纳入判定；失败、响应不完整、超时或无法覆盖的动画进入人工复核。任务具有版本检查，旧的自动结果不能覆盖后来的管理员决定或恢复作者已删除 / 注销的内容。外链预览与可选 OCR 出现新文字时需要重新审核，不能直接把未经检查的派生文字加入已公开的帖子。

## 接入真实阿里云内容安全

本节是接入准备说明，不代表云服务已经开通或真实检测已经验收。默认仍为 `CONTENT_MODERATION_PROVIDER=manual`，只有完成开通、专用凭据配置和联调后才能切换。

### 开通增强版与选择地域

小规模内测选择**内容安全增强版按量付费**：开通本身不收费，按实际调用量结算，先不购买大额资源包或 QPS 扩容包。增强版的开通文档要求账号完成实名认证，未限定必须企业认证；个人账号是否满足当前开通资格，以增强版购买页的实际校验为准，不据此承诺一定可开通。内容安全 1.0 的开通条件明确要求企业认证，不能选错版本。[增强版开通说明](https://help.aliyun.com/zh/document_detail/477720.html)、[1.0 开通说明](https://help.aliyun.com/zh/document_detail/69806.html)。

当前 ECS 位于北京，可显式选择 `cn-beijing`，公网接入地址为 `green-cip.cn-beijing.aliyuncs.com`。北京支持当前使用的文本和图片服务，以及通过同一地域客户端获取图片上传令牌的流程。代码未配置地域时仍默认 `cn-shanghai`；以下北京示例不改变代码默认值。`comment_detection_pro` 在增强版开通后可通过 API 调用，无需另外购买或开通这个 Service；控制台“未使用”状态也不能当作尚未开通的证据。[文本 PLUS 服务](https://help.aliyun.com/zh/document_detail/2684669.html)、[图片接入地域](https://help.aliyun.com/zh/document_detail/467829.html)、[图片上传 SDK](https://help.aliyun.com/zh/document_detail/467828.html)。

### 专用 RAM 最小调用权限

为仅用于内容审核的 RAM 身份授予以下自定义策略，例如命名为 `AiHomeModerationInvokeOnly`：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "yundun-greenweb:TextModerationPlus",
        "yundun-greenweb:ImageModeration",
        "yundun-greenweb:DescribeUploadToken"
      ],
      "Resource": "*"
    }
  ]
}
```

这三个操作均不支持资源级授权，因此 `Resource` 必须为 `"*"`，不能填本站 OSS Bucket 的 ARN。权限范围由三项明确的 `Action` 限定；官方授权表未列关联操作，不需要授予内容安全全权限、RAM 管理权限或 OSS 全权限。[官方 RAM 权限元素参考](https://help.aliyun.com/zh/document_detail/2528739.html)。

### 环境配置与验收

环境变量需同时提供给 Web 与 Worker，修改后重启二者：

```dotenv
CONTENT_MODERATION_PROVIDER=aliyun
CONTENT_MODERATION_REGION=cn-beijing
CONTENT_MODERATION_ACCESS_KEY_ID=<专用访问密钥 ID>
CONTENT_MODERATION_ACCESS_KEY_SECRET=<专用访问密钥 Secret>
```

默认 `CONTENT_MODERATION_PROVIDER=manual`。只填写通用短信 / OSS 密钥不会自动启用审核。后台“已配置”仅表示所需配置存在，不能代替云端鉴权、服务开通、计费和实际检测的验收；首次接入应使用运营方批准的测试样本验证成功 / 隔离 / 复核 / 服务异常四种路径。

实现使用 `TextModerationPlus` 的 `comment_detection_pro` 与 `ImageModeration` 的 `postImageCheck`，API 版本 `2022-03-02`。图片通过 `DescribeUploadToken` 获取的临时凭据上传到内容安全专用 OSS，再引用该私有对象审核；不把站内图片改成永久公开地址。仅传送待审内容和随机内容编号，不附带登录手机号或活动报名联系人。

上传令牌返回的临时凭据、OSS 地址、Bucket 和对象前缀必须成套使用，不应把官方示例中的上海 Bucket 硬编码到北京调用。该流程使用内容安全提供的临时存储，不等于授权服务扫描本站整个 OSS Bucket。[上传令牌 API](https://help.aliyun.com/document_detail/2926827.html)。

临时上传不指定 `x-oss-object-acl`，继承服务专用桶权限。北京真实联调中，指定 `private` 会被临时令牌的会话策略拒绝；省略后上传与审核成功，无凭据 HEAD 仍返回 403。本站业务 OSS 上传继续显式使用私有权限。实际部署及验收结果见 [验证记录](verification.md#内容自动审核接入2026-09-30)。

### 费用与调用量控制

按 2026-09-30 核实的官方基础价格，当前两个服务为：

| 接口与服务 | 按量基础单价 |
|---|---|
| `TextModerationPlus` / `comment_detection_pro` | 7.5 元 / 万次 |
| `ImageModeration` / `postImageCheck` | 30 元 / 万次 |

文本分块、多张图片与重新审核都会增加调用次数。控制台额外开启“大模型审核能力”会增加计费项，不包含在上表基础价内。资源包及免费权益需按增强版当前规则核对，不能把内容安全 1.0 的“31 天每日 3,000 次”免费额度套用到增强版。[增强版计费](https://help.aliyun.com/zh/document_detail/477720.html)、[1.0 免费额度](https://help.aliyun.com/zh/document_detail/69806.html)。

**预算告警只是提醒，不是硬支出上限。**官方 FAQ 说明增强版不支持设置费用额度上限，也不支持以余额耗尽自动暂停来控制费用；资源包用完后还可能继续按量扣费。如需硬限制，必须在业务侧实现每日云审核调用量上限、请求限流及异常来源控制，达到上限后停止发起云请求并转人工复核。QPS 限制只约束调用速率，不能替代每日调用总量控制。本说明不表示业务侧费用上限已经实现。[费用上限与异常刷量说明](https://help.aliyun.com/zh/document_detail/477720.html)。

没有配置、鉴权失败、欠费或云服务限流等异常时继续保持人工待审。配置修复后管理员可在审核记录点“重新自动审核”。

审核处理和可选百炼图片文字提取用途不同；关闭可选 AI 提取不会跳过安全审核。隐私说明已更新到 `2026-09-30`，运营者必须补全真实主体、联系方式，并结合实际云服务地域和保存期限更新告知。

官方参考：[文本审核 Plus](https://help.aliyun.com/zh/document_detail/2669858.html)、[图片审核](https://help.aliyun.com/zh/document_detail/2528742.html)、[图片临时上传](https://help.aliyun.com/zh/document_detail/467828.html)。

## 管理与资料处理

审核队列只向作者本人及真人平台管理员提供，管理员为复核可以查看私密社群待审内容。图片默认折叠，需主动展开。成员不能查看其他人的队列，Agent 不能取得审核预览权限。

记录仅保存状态、类别、处理原因及操作记录，不保存云服务原始敏感响应或凭据。审核原文来自站内内容 / 草稿；账号注销会清除本人审核记录和草稿，避免隐私删除后从审核副本恢复。历史备份和服务商副本仍需按 [隐私运营说明](privacy.md) 单独管理。

内测需要安排管理员及时处理人工队列和申诉。机器检测会有误判和漏判，应保留举报入口，并定期用合规测试样本检查效果。当前没有对外部音视频进行完整审核，也没有以测试模拟响应冒充真实云端联调。
