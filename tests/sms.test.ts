import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const environmentKeys = [
  'SMS_PROVIDER', 'SMS_ACCESS_KEY_ID', 'SMS_ACCESS_KEY_SECRET',
  'ALI_ACCESS_KEY_ID', 'ALI_ACCESS_KEY_SECRET', 'SMS_SIGN_NAME', 'SMS_TEMPLATE_CODE',
] as const;
const savedEnvironment = new Map(environmentKeys.map(name => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const phone = '+8613812345678';
const code = '001234';
const defaults = {
  SMS_ACCESS_KEY_ID: 'test-sms-key',
  SMS_ACCESS_KEY_SECRET: 'test-sms-secret',
  ALI_ACCESS_KEY_ID: 'test-general-key',
  ALI_ACCESS_KEY_SECRET: 'test-general-secret',
  SMS_SIGN_NAME: "测试签名 + & = / ' * ! ~ 😀",
  SMS_TEMPLATE_CODE: 'SMS_TEST_123',
};
let sendSmsMessage: typeof import('../src/server/sms').sendSmsMessage;
let otpLength: number;
let otpTtl: number;
let safeErrorMessage: string | undefined;

function configure(overrides: Partial<Record<typeof environmentKeys[number], string | undefined>> = {}) {
  for (const name of environmentKeys) delete process.env[name];
  Object.assign(process.env, defaults);
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function safeError(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.match(error.message, /[\u3400-\u9fff]/, 'The public error should explain failure in Chinese');
  if (safeErrorMessage === undefined) safeErrorMessage = error.message;
  assert.equal(error.message, safeErrorMessage, 'Configuration, input and provider failures must use the same safe error');
  assert.equal('cause' in error, false);
  const exposed = `${error.message} ${JSON.stringify(error)}`;
  for (const secret of [phone, phone.slice(3), code, 'PRIVATE-SMS-RESPONSE', 'private-response-request-id', defaults.SMS_ACCESS_KEY_ID, defaults.SMS_ACCESS_KEY_SECRET, defaults.ALI_ACCESS_KEY_ID, defaults.ALI_ACCESS_KEY_SECRET]) {
    assert.ok(!exposed.includes(secret), `Error must not expose ${secret}`);
  }
  return true;
}

function escapeRpc(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function checkRequest(url: string | URL | Request, init: RequestInit | undefined, provider: 'aliyun-pnvs' | 'aliyun-sms', key = defaults.SMS_ACCESS_KEY_ID, secret = defaults.SMS_ACCESS_KEY_SECRET) {
  assert.equal(String(url), provider === 'aliyun-pnvs' ? 'https://dypnsapi.aliyuncs.com/' : 'https://dysmsapi.aliyuncs.com/');
  assert.equal(init?.method, 'POST');
  assert.equal(init?.redirect, 'error', 'A provider redirect must never forward credentials or the OTP');
  assert.match(new Headers(init?.headers).get('content-type') || '', /^application\/x-www-form-urlencoded\b/i);
  assert.ok(init?.signal instanceof AbortSignal);
  const form = new URLSearchParams(String(init?.body));
  assert.equal([...form.keys()].length, new Set(form.keys()).size, 'Signed form keys must not be repeated');
  assert.equal(form.get('AccessKeyId'), key);
  assert.equal(form.get('Action'), provider === 'aliyun-pnvs' ? 'SendSmsVerifyCode' : 'SendSms');
  assert.equal(form.get(provider === 'aliyun-pnvs' ? 'PhoneNumber' : 'PhoneNumbers'), phone.slice(3));
  assert.equal(form.get('Version'), '2017-05-25');
  assert.equal(form.get('Format'), 'JSON');
  assert.equal(form.get('SignatureMethod'), 'HMAC-SHA1');
  assert.equal(form.get('SignatureVersion'), '1.0');
  assert.match(form.get('SignatureNonce') || '', /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i);
  assert.match(form.get('Timestamp') || '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(form.get('SignName'), defaults.SMS_SIGN_NAME);
  assert.equal(form.get('TemplateCode'), defaults.SMS_TEMPLATE_CODE);
  const signature = form.get('Signature');
  assert.ok(signature);
  form.delete('Signature');
  const canonical = [...form.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => `${escapeRpc(name)}=${escapeRpc(value)}`).join('&');
  const expected = createHmac('sha1', `${secret}&`).update(`POST&%2F&${escapeRpc(canonical)}`).digest('base64');
  assert.equal(signature, expected, 'Signature must bind every UTF-8 business parameter using RPC percent encoding');
  assert.ok(!String(init?.body).includes(secret), 'The access secret must only participate in signing');
  return form;
}

before(async () => {
  configure();
  globalThis.fetch = async () => { throw new Error('Unexpected fetch: real network is disabled in SMS tests'); };
  const sms = await import('../src/server/sms');
  sendSmsMessage = sms.sendSmsMessage;
  otpLength = sms.SMS_OTP_LENGTH;
  otpTtl = sms.SMS_OTP_TTL_SECONDS;
});

beforeEach(() => {
  configure();
  globalThis.fetch = async () => { throw new Error('Unexpected fetch: real network is disabled in SMS tests'); };
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('PNVS sends the existing six-digit OTP with a five-minute lifetime and a signed private POST', async t => {
  configure({ SMS_PROVIDER: 'aliyun-pnvs' });
  assert.equal(otpLength, 6);
  assert.equal(otpTtl, 300);
  const controller = new AbortController();
  const timeout = t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 15_000);
    return controller.signal;
  });
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    const form = checkRequest(url, init, 'aliyun-pnvs');
    assert.equal(init?.signal, controller.signal);
    assert.equal(form.get('PhoneNumber'), '13812345678');
    assert.equal(form.has('PhoneNumbers'), false);
    assert.equal(form.get('CountryCode'), '86');
    assert.deepEqual(JSON.parse(form.get('TemplateParam')!), { code: '001234', min: '5' });
    assert.equal(form.get('ReturnVerifyCode'), 'false');
    assert.equal(form.get('AutoRetry'), '0');
    assert.equal(form.get('Interval'), '60');
    assert.equal(form.get('ValidTime'), '300');
    assert.equal(form.get('CodeLength'), '6');
    return Response.json({ Code: 'OK', Success: true, RequestId: 'fake-request', Model: { VerifyCode: 'ignored-cloud-code' } });
  };
  assert.equal(await sendSmsMessage(phone, code), undefined);
  assert.equal(calls, 1);
  assert.equal(timeout.mock.callCount(), 1);
});

test('legacy SendSms remains the default for missing or empty SMS_PROVIDER and preserves leading zeroes', async () => {
  for (const provider of [undefined, '', 'aliyun-sms']) {
    configure({ SMS_PROVIDER: provider });
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      const form = checkRequest(url, init, 'aliyun-sms');
      assert.equal(form.get('PhoneNumbers'), '13812345678');
      assert.deepEqual(JSON.parse(form.get('TemplateParam')!), { code: '001234' });
      for (const name of ['PhoneNumber', 'CountryCode', 'ReturnVerifyCode', 'AutoRetry', 'Interval', 'ValidTime', 'CodeLength']) assert.equal(form.has(name), false, name);
      return Response.json({ Code: 'OK' });
    };
    assert.equal(await sendSmsMessage(phone, code), undefined);
    assert.equal(calls, 1);
  }
});

test('a complete dedicated credential pair takes priority; an absent or empty pair uses legacy credentials', async () => {
  for (const provider of ['aliyun-pnvs', 'aliyun-sms'] as const) {
    for (const mode of ['dedicated', 'absent', 'empty'] as const) {
      const overrides: Parameters<typeof configure>[0] = { SMS_PROVIDER: provider };
      if (mode !== 'dedicated') {
        overrides.SMS_ACCESS_KEY_ID = mode === 'empty' ? '' : undefined;
        overrides.SMS_ACCESS_KEY_SECRET = mode === 'empty' ? '' : undefined;
      }
      configure(overrides);
      let calls = 0;
      globalThis.fetch = async (url, init) => {
        calls++;
        checkRequest(url, init, provider,
          mode === 'dedicated' ? defaults.SMS_ACCESS_KEY_ID : defaults.ALI_ACCESS_KEY_ID,
          mode === 'dedicated' ? defaults.SMS_ACCESS_KEY_SECRET : defaults.ALI_ACCESS_KEY_SECRET);
        return Response.json({ Code: 'OK', Success: true });
      };
      await sendSmsMessage(mode === 'empty' ? phone.slice(3) : phone, code);
      assert.equal(calls, 1);
    }
  }
});

test('partial credentials, missing configuration and unknown providers fail before any network request', async () => {
  const invalid: Array<Parameters<typeof configure>[0]> = [
    { SMS_ACCESS_KEY_ID: undefined }, { SMS_ACCESS_KEY_SECRET: undefined },
    { SMS_ACCESS_KEY_ID: '' }, { SMS_ACCESS_KEY_SECRET: '' },
    { SMS_ACCESS_KEY_ID: undefined, SMS_ACCESS_KEY_SECRET: undefined, ALI_ACCESS_KEY_ID: undefined },
    { SMS_ACCESS_KEY_ID: undefined, SMS_ACCESS_KEY_SECRET: undefined, ALI_ACCESS_KEY_SECRET: undefined },
    { SMS_ACCESS_KEY_ID: '', SMS_ACCESS_KEY_SECRET: '', ALI_ACCESS_KEY_ID: '', ALI_ACCESS_KEY_SECRET: '' },
    { SMS_SIGN_NAME: undefined }, { SMS_SIGN_NAME: '' },
    { SMS_TEMPLATE_CODE: undefined }, { SMS_TEMPLATE_CODE: '' },
    { SMS_PROVIDER: 'unknown-provider' }, { SMS_PROVIDER: 'https://untrusted.example/' },
  ];
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ Code: 'OK', Success: true }); };
  for (const provider of ['aliyun-pnvs', 'aliyun-sms']) {
    for (const overrides of invalid) {
      configure({ SMS_PROVIDER: provider, ...overrides });
      await assert.rejects(sendSmsMessage(phone, code), safeError);
    }
  }
  assert.equal(calls, 0, 'A partial dedicated pair must never silently fall back to ALI credentials');
});

test('invalid phone numbers and OTPs fail locally without attempting delivery', async () => {
  const invalidInputs: Array<[string, string]> = [
    ['', code], ['+12025550123', code], ['+861381234567', code], ['+86138123456789', code],
    ['+8610012345678', code], ['+8613812345678,13912345678', code], ['+8613812345678\n', code],
    [phone, ''], [phone, '12345'], [phone, '1234567'], [phone, 'abcdef'],
    [phone, '１２３４５６'], [phone, '123456\n'], [phone, ' 123456'], [phone, '123 45'],
    [undefined as unknown as string, code], [phone, 123456 as unknown as string],
  ];
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ Code: 'OK', Success: true }); };
  for (const provider of ['aliyun-pnvs', 'aliyun-sms']) {
    configure({ SMS_PROVIDER: provider });
    for (const [candidatePhone, candidateCode] of invalidInputs) await assert.rejects(sendSmsMessage(candidatePhone, candidateCode), safeError);
  }
  assert.equal(calls, 0);
});

test('malformed responses, HTTP failures and transport errors are sanitized and never retried or sent to another provider', async () => {
  const privateDetails = `PRIVATE-SMS-RESPONSE ${phone} ${code} ${defaults.SMS_ACCESS_KEY_SECRET}`;
  const responses: Array<() => Response | Promise<Response>> = [
    () => Response.json(null), () => Response.json([]), () => Response.json([{ Code: 'OK', Success: true }]),
    () => Response.json('OK'), () => Response.json(true), () => Response.json(200),
    () => Response.json({}), () => Response.json({ Code: 'ok', Success: true }),
    () => Response.json({ Code: 200, Success: true }),
    () => Response.json({ Code: 'ISV.BUSINESS_LIMIT_CONTROL', Success: false, Message: privateDetails, RequestId: 'private-response-request-id' }),
    () => new Response(privateDetails),
    () => new Response(null, { status: 204 }),
    () => Response.json({ Code: 'OK', Success: true, Message: privateDetails }, { status: 302 }),
    () => Response.json({ Code: 'OK', Success: true, Message: privateDetails }, { status: 403 }),
    () => Response.json({ Code: 'OK', Success: true, Message: privateDetails }, { status: 503 }),
    () => { throw new TypeError(privateDetails); },
    () => { throw new DOMException(privateDetails, 'AbortError'); },
    () => { throw new DOMException(privateDetails, 'TimeoutError'); },
    () => {
      const response = Response.json({ Code: 'OK', Success: true });
      response.json = async () => { throw new Error(privateDetails); };
      return response;
    },
  ];
  for (const provider of ['aliyun-pnvs', 'aliyun-sms'] as const) {
    configure({ SMS_PROVIDER: provider });
    for (const response of responses) {
      let calls = 0;
      globalThis.fetch = async (url, init) => { calls++; checkRequest(url, init, provider); return response(); };
      await assert.rejects(sendSmsMessage(phone, code), safeError);
      assert.equal(calls, 1, 'Delivery failure must not retry or switch providers');
    }
  }
});

test('PNVS requires the boolean Success flag as well as Code OK', async () => {
  configure({ SMS_PROVIDER: 'aliyun-pnvs' });
  for (const success of [undefined, null, false, 'true', 1, {}, []]) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ Code: 'OK', Success: success }); };
    await assert.rejects(sendSmsMessage(phone, code), safeError);
    assert.equal(calls, 1);
  }
});

test('the fifteen-second abort signal terminates a pending request with one safe failure', async t => {
  let timeoutCalls = 0;
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    timeoutCalls++;
    assert.equal(milliseconds, 15_000);
    const controller = new AbortController();
    queueMicrotask(() => controller.abort(new DOMException('PRIVATE-SMS-RESPONSE', 'TimeoutError')));
    return controller.signal;
  });
  for (const provider of ['aliyun-pnvs', 'aliyun-sms'] as const) {
    configure({ SMS_PROVIDER: provider });
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      checkRequest(url, init, provider);
      const signal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    await assert.rejects(sendSmsMessage(phone, code), safeError);
    assert.equal(calls, 1);
  }
  assert.equal(timeoutCalls, 2);
});
