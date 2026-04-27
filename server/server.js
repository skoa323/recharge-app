/**
 * 中间代理服务
 * - 浏览器调用本服务,本服务再调 chongzhi.pro,API_KEY 仅存在于服务端环境变量
 * - 暴露给前端的端点:
 *    POST /api/validate-code  仅做格式 & 前缀校验(纯本地,不打远端)
 *    POST /api/validate-json  校验 user_data 里关键字段是否齐全
 *    POST /api/recharge       充值(自动处理首次失败 → 复用)
 *    POST /api/query          查询激活码当前充值状态(走复用接口的幂等响应)
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// ====== 配置(从环境变量读取,前端永远碰不到)======
const PORT = process.env.PORT || 3000;
const API_BASE = process.env.UPSTREAM_BASE || 'https://chongzhi.pro';
const API_KEY = process.env.UPSTREAM_API_KEY || '';   // ★ 唯一密钥来源
const UA = process.env.UPSTREAM_UA || 'recharge-frontend/1.0';

if (!API_KEY) {
  console.warn('[WARN] 未设置 UPSTREAM_API_KEY 环境变量,首次充值接口将会失败');
}

// ====== 中间件 ======
app.use(cors());                    // 生产环境建议改成具体的 origin 白名单
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ====== 工具函数 ======

/**
 * 卡密前缀 → 产品类型
 *   GPLUS* → plus
 *   GP20X* → pro
 *   GP5X*  → prolite
 */
function detectProduct(code) {
  if (!code || typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  if (c.startsWith('GPLUS')) return 'plus';
  if (c.startsWith('GP20X')) return 'pro';
  if (c.startsWith('GP5X')) return 'prolite';
  return null;
}

/** 校验 user_data 里的关键字段 */
function validateUserData(raw) {
  let obj;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      return { ok: false, reason: 'user_data 不是合法的 JSON 字符串' };
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw;
  } else {
    return { ok: false, reason: 'user_data 必须是 JSON 字符串或对象' };
  }

  const accountId = obj?.account?.id;
  const accessToken = obj?.accessToken;
  const email = obj?.user?.email;

  if (!accountId) return { ok: false, reason: '缺少关键字段:account.id' };
  if (!accessToken) return { ok: false, reason: '缺少关键字段:accessToken' };
  // email 不是必须的,但建议存在
  return {
    ok: true,
    parsed: obj,
    summary: {
      account_id: accountId,
      email: email || '(未提供)',
      plan_type: obj?.account?.planType || 'unknown',
      has_access_token: !!accessToken,
      access_token_preview: accessToken ? accessToken.slice(0, 24) + '...' : null,
    },
  };
}

/** 调首次充值接口 */
async function callFirstSubmit(activationCode, userDataObj) {
  const res = await fetch(`${API_BASE}/simple-submit-rechargezeroapi.php`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify({
      activation_code: activationCode,
      user_data: JSON.stringify(userDataObj),
    }),
    // Node 18+ 内置 fetch,长任务用 AbortSignal 设置 180s 超时
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  try {
    return { httpStatus: res.status, body: JSON.parse(text) };
  } catch {
    return { httpStatus: res.status, body: { success: false, message: '上游返回非 JSON: ' + text.slice(0, 200) } };
  }
}

/** 调复用接口 */
async function callReuse(activationCode, accessToken) {
  const payload = { activation_code: activationCode };
  if (accessToken) payload.accessToken = accessToken;

  const res = await fetch(`${API_BASE}/api-recharge-reuse-android.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  try {
    return { httpStatus: res.status, body: JSON.parse(text) };
  } catch {
    return { httpStatus: res.status, body: { success: false, message: '上游返回非 JSON: ' + text.slice(0, 200) } };
  }
}

// ====== 路由 ======

/** 1. 校验激活码(本地校验,不打远端) */
app.post('/api/validate-code', (req, res) => {
  const code = (req.body?.activation_code || '').trim();
  if (!code) return res.json({ ok: false, reason: '请填写激活码' });

  const product = detectProduct(code);
  if (!product) {
    return res.json({
      ok: false,
      reason: '激活码前缀无法识别,仅支持 GPLUS / GP20X / GP5X',
    });
  }

  // 长度做个软提示
  if (code.length < 10) {
    return res.json({ ok: false, reason: '激活码长度过短,请检查是否完整' });
  }

  return res.json({
    ok: true,
    activation_code: code.toUpperCase(),
    product,
    product_label: { plus: 'ChatGPT Plus', pro: 'ChatGPT Pro', prolite: 'ChatGPT Pro Lite' }[product],
  });
});

/** 2. 校验 user_data JSON */
app.post('/api/validate-json', (req, res) => {
  const raw = req.body?.user_data;
  const result = validateUserData(raw);
  if (!result.ok) {
    return res.json({ ok: false, reason: result.reason });
  }
  return res.json({ ok: true, summary: result.summary });
});

/** 3. 充值(自动首次→复用切换) */
app.post('/api/recharge', async (req, res) => {
  const code = (req.body?.activation_code || '').trim();
  const userData = req.body?.user_data;

  // 前置校验
  const product = detectProduct(code);
  if (!product) {
    return res.status(400).json({ success: false, message: '激活码前缀无法识别' });
  }

  const v = validateUserData(userData);
  if (!v.ok) {
    return res.status(400).json({ success: false, message: v.reason });
  }

  const userDataObj = v.parsed;
  const accessToken = userDataObj.accessToken;

  try {
    // Step 1: 首次提交
    const first = await callFirstSubmit(code, userDataObj);
    if (first.body?.success) {
      return res.json({
        ...first.body,
        _stage: 'first_submit',
      });
    }

    // Step 2: 命中 reuse_only → 切复用
    if (first.body?.reuse_only) {
      const reused = await callReuse(code, accessToken);
      return res.json({
        ...reused.body,
        _stage: 'reuse_after_first',
        _first_message: first.body?.message,
      });
    }

    // 其他失败原样回传
    return res.status(first.httpStatus || 400).json({
      ...first.body,
      _stage: 'first_submit_failed',
    });
  } catch (err) {
    console.error('[recharge] 异常:', err);
    return res.status(500).json({
      success: false,
      message: '代理服务异常: ' + (err?.message || String(err)),
    });
  }
});

/** 4. 查询激活码当前状态(借助复用接口的幂等响应) */
app.post('/api/query', async (req, res) => {
  const code = (req.body?.activation_code || '').trim();
  const accessToken = req.body?.accessToken;   // 可选

  if (!detectProduct(code)) {
    return res.status(400).json({ success: false, message: '激活码前缀无法识别' });
  }

  try {
    const r = await callReuse(code, accessToken);
    const body = r.body || {};

    // 标准化解释:把上游回复翻译成「状态」
    let status = 'unknown';
    let interpreted = '';

    if (body.success && body?.data?.already_success) {
      status = 'success';
      interpreted = '此卡密已成功充值,无需再操作。';
    } else if (body.success && body?.data?.new_status === 'success') {
      status = 'success';
      interpreted = '本次复用调用已激活成功。';
    } else if (!body.success && /没有可复用/.test(body.message || '')) {
      status = 'not_used';
      interpreted = '此卡密尚未走过首次充值,可直接充值。';
    } else if (!body.success && /激活码不存在/.test(body.message || '')) {
      status = 'not_found';
      interpreted = '查无此激活码,请检查输入。';
    } else if (!body.success) {
      status = 'failed_or_pending';
      interpreted = body.message || '上游返回失败';
    }

    return res.json({
      query_ok: true,
      status,
      interpreted,
      raw: body,
    });
  } catch (err) {
    console.error('[query] 异常:', err);
    return res.status(500).json({ query_ok: false, message: err?.message || String(err) });
  }
});

// ====== 启动 ======
app.listen(PORT, () => {
  console.log(`✓ 充值代理服务已启动: http://localhost:${PORT}`);
  console.log(`  上游:${API_BASE}`);
  console.log(`  API Key 状态:${API_KEY ? '已配置' : '未配置(首次充值会失败)'}`);
});
