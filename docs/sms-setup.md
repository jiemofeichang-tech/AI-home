# 个人内测：阿里云短信认证

个人实名认证账号可使用阿里云号码认证（PNVS）中的“短信认证”。先完成云账号实名认证，再在[号码认证功能页面](https://dypns.console.aliyun.com/functions)按控制台要求开启短信认证及融合认证。云服务器购买页用于部署网站；短信服务需要在号码认证控制台单独开通。[官方个人接入指南](https://help.aliyun.com/zh/pnvs/use-cases/sms-verify-for-individual-developers)

## 获取配置

1. 在[赠送签名](https://dypns.console.aliyun.com/smsCertParamsConfig/sign)复制选用的签名名称。
2. 在[赠送模板](https://dypns.console.aliyun.com/smsCertParamsConfig/template)选择适用注册/登录的验证码模板，复制模板编号。当前接入支持变量 `code`（验证码）和 `min`（有效分钟数）；选择使用这两个变量的模板。赠送签名和赠送模板需配套使用。[发送接口说明](https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode)
3. 在 [RAM 用户管理](https://ram.console.aliyun.com/users)创建用于服务端调用的用户及 AccessKey，赋予 `dypns:SendSmsVerifyCode` 操作权限。只保存在服务器环境变量或未提交的 `.env`，不要发到聊天、前端或仓库。

可为该 RAM 用户使用以下自定义策略，只允许网站实际调用的发送接口：

```json
{
  "Version": "1",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["dypns:SendSmsVerifyCode"],
    "Resource": ["*"]
  }]
}
```

签名和模板是系统提供的资源；实际发送短信仍会计费。短信认证可按量付费，套餐与传统短信服务不通用；请在号码认证产品中查看费用与用量。[计费和开通说明](https://help.aliyun.com/zh/pnvs/getting-started/sms-authentication-service-novice-guide)

购买套餐后还应确认阿里云账户余额大于 0。套餐剩余次数与账户现金余额是不同项目；官方排查说明要求余额大于 0，并指出欠费时套餐不能抵扣。若发送失败，应先核对账户、服务开通状态和发送记录，不能只因套餐有余量就认定接入正常。[官方套餐调用排查](https://help.aliyun.com/zh/pnvs/user-guide/sms-authentication-service/)

## 网站配置

在生产 `.env` 中填写这些字段，其他数据库、存储和 HTTPS 配置仍按[部署说明](operations.md)完成：

```dotenv
DEV_MODE=false
INVITE_ONLY=true
SMS_PROVIDER=aliyun-pnvs
SMS_ACCESS_KEY_ID=填写短信专用AccessKeyID
SMS_ACCESS_KEY_SECRET=填写对应的AccessKeySecret
SMS_SIGN_NAME=复制赠送签名名称
SMS_TEMPLATE_CODE=复制赠送模板编号
SMS_DAILY_LIMIT=100
ADMIN_PHONE=+86你的管理员手机号
```

短信密钥必须成对提供；两项均为空时才回退到旧 `ALI_ACCESS_KEY_ID` / `ALI_ACCESS_KEY_SECRET`，不会将不同密钥混配。建议使用上面的专用短信密钥，OSS 继续使用原存储配置。

已有企业短信接入保持 `SMS_PROVIDER=aliyun-sms`、原签名和 `SMS_…` 模板。没有设置 `SMS_PROVIDER` 时也保持此模式。两类服务的签名、模板和套餐不能混用；新 `.env.example` 已明确选择个人可用的 `aliyun-pnvs`。

修改生产 `.env` 后，执行 `docker compose up -d --build web worker` 重建并更新服务。仅执行 `docker compose restart` 不会应用修改后的 Compose 环境变量。

## 验收

在正式 HTTPS 网站登录页，用 `ADMIN_PHONE` 获取验证码，确认手机实际收到短信并成功登录；再用另一个受邀手机号验证邀请码注册与后续登录。检查错误验证码被拒绝、已使用或过期验证码不能再登录；验证码有效期为 5 分钟。

`npm run dev:local` 固定使用开发验证码，即使填写了云凭据也不发送真实短信。不能将开发预览公开给测试成员，也不能用它判断真实短信已经配置成功。

网站继续由 Better Auth 生成、保存和验证六位验证码，发送给 PNVS 的是实际验证码，保留开头的零；模板有效期为 5 分钟。这个自定义验证码模式不调用阿里云 `CheckSmsVerifyCode`，因为该接口不能核验自行提供的验证码。发送超时不自动重发，接口提交成功也不等于运营商已送达，最终需结合实收和云控制台回执验收。

全站每日发送尝试默认上限 100 次，每个手机号每日 10 次，并保留登录接口限流；额度含失败尝试，不是费用上限。该接入的自动测试使用模拟响应，不产生真实短信费用。
