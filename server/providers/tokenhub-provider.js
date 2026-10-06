const { createLocalProvider } = require('./local-provider')
const { downloadImage, STYLE_PROMPTS } = require('./hunyuan-provider')

const ENDPOINT = 'https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v35-generation'
const MODEL = 'hy-image-v3.5-preview'

function fail(code, message) {
  return Object.assign(new Error(message), { code, publicMessage: message })
}

function safeCode(value) {
  const code = String(value || '')
  return /^[a-zA-Z0-9_.-]{1,100}$/.test(code) ? code : ''
}

function responseFailure(status, upstreamCode) {
  if (status === 401 || status === 403) return fail('TOKENHUB_ACCESS_DENIED', 'TokenHub API Key 无效或没有模型权限，请检查后端 TOKENHUB_API_KEY。')
  if (status === 402 || /balance|quota|arrears|billing/i.test(upstreamCode)) return fail('TOKENHUB_BILLING', '请在 TokenHub 开启 Hy-Image-3.5-preview 后付费，并检查账户余额与额度。')
  if (status === 422 || /content_filter|moderation/i.test(upstreamCode)) return fail('TOKENHUB_MODERATION', '图片生成未通过内容审核，请更换照片或风格后重试。')
  if (status === 429) return fail('TOKENHUB_RATE_LIMITED', 'TokenHub 当前并发或调用次数达到上限，请稍后重试。')
  if (status === 400) return fail('TOKENHUB_INVALID_PARAMETER', 'TokenHub 拒绝了生图参数，请检查模型配置或照片格式。')
  if (status === 404) return fail('TOKENHUB_MODEL_UNAVAILABLE', 'TokenHub 生图模型不可用，请确认已开启 Hy-Image-3.5-preview。')
  return fail('TOKENHUB_FAILED', `TokenHub 图片生成失败${upstreamCode ? `（${upstreamCode}）` : `（HTTP ${status}）`}，请稍后重试。`)
}

async function readResult(response) {
  if (!response.body) return {}
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 2 * 1024 * 1024) throw fail('TOKENHUB_INVALID_RESPONSE', 'TokenHub 返回的数据超过大小限制。')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    if (!response.ok) return {}
    throw fail('TOKENHUB_INVALID_RESPONSE', 'TokenHub 返回的数据格式无效。')
  }
}

function createTokenHubProvider(config, dependencies = {}) {
  const fetchImpl = dependencies.fetch || fetch
  const local = createLocalProvider()
  return {
    name: 'tokenhub',
    configured: Boolean(config.tokenhubApiKey),
    capabilities: { stylization: 'tokenhub', model: MODEL, nutrition: 'local-poc', moderation: 'local-poc' },
    moderateImage: local.moderateImage,
    analyzeNutrition: local.analyzeNutrition,
    async stylize({ meal, originalAsset, task = {}, onSubmitted = async () => {}, isCurrent = () => true }) {
      let stage = 'validate'
      let status
      let upstreamCode
      let requestId
      const checkCurrent = () => {
        if (!isCurrent()) throw fail('TASK_CANCELLED', '任务已被替换或删除。')
      }
      try {
        checkCurrent()
        if (!config.tokenhubApiKey) throw fail('TOKENHUB_NOT_CONFIGURED', '请在 Render 后端配置 TOKENHUB_API_KEY，并开通 TokenHub 生图模型。')
        if (!STYLE_PROMPTS[meal.style]) throw fail('TOKENHUB_INVALID_STYLE', '不支持该图片风格。')
        // Synchronous generation cannot resume by job ID. Do not pay for a second
        // request automatically when a persisted in-flight task is restored.
        if (task.providerJobId) throw fail('TOKENHUB_INTERRUPTED', '上次生成因服务重启而中断，可能已计费；如需重新生成，请点击重试。')
        if (originalAsset.buffer.length > 20 * 1024 * 1024) throw fail('TOKENHUB_IMAGE_TOO_LARGE', '参考照片不能超过 20MB。')
        stage = 'persist-start'
        await onSubmitted('tokenhub:in-flight', Date.now())
        checkCurrent()
        stage = 'generate'
        const response = await fetchImpl(ENDPOINT, {
          method: 'POST', redirect: 'error',
          signal: AbortSignal.timeout(config.tokenhubGenerationTimeoutMs),
          headers: { Authorization: `Bearer ${config.tokenhubApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: MODEL,
            generate_max_pixels: 1048576,
            resize_max_pixels: 1048576,
            footnote: 'AI生成',
            messages: [{ role: 'user', content: [
              { type: 'text', text: `将参考照片转换为${STYLE_PROMPTS[meal.style]}。保持原图食物种类、数量、餐具和构图，不增加食物，不添加文字。` },
              { type: 'image_url', image_url: { url: `data:${originalAsset.mimeType};base64,${originalAsset.buffer.toString('base64')}` } }
            ] }]
          })
        })
        status = response.status
        const result = await readResult(response)
        requestId = safeCode(result.request_id || (result.error && result.error.request_id))
        upstreamCode = safeCode(result.error && result.error.code)
        if (!response.ok || result.error) throw responseFailure(status, upstreamCode)
        checkCurrent()
        const url = result.choices && result.choices[0] && result.choices[0].delta &&
          result.choices[0].delta.image && result.choices[0].delta.image.url
        if (!url) throw fail('TOKENHUB_NO_IMAGE', 'TokenHub 未返回生成图片，请查看后端日志或更换照片重试。')
        stage = 'download'
        const output = await downloadImage(url, config, fetchImpl)
        checkCurrent()
        return output
      } catch (error) {
        let failure = error
        if (!error.publicMessage) {
          failure = error.name === 'TimeoutError'
            ? fail('TOKENHUB_TIMEOUT', 'TokenHub 生图或结果下载超时，可能已计费；请稍后再决定是否重试。')
            : fail('TOKENHUB_CONNECTION_FAILED', '后端连接 TokenHub 或下载图片失败，请稍后重试。')
        }
        if (failure.code !== 'TASK_CANCELLED') console.error('tokenhub_failed', { stage, code: failure.code, status, upstreamCode, requestId })
        throw failure
      }
    }
  }
}

module.exports = { createTokenHubProvider }
