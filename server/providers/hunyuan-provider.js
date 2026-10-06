const { setTimeout: sleep } = require('node:timers/promises')
const { validateAndSanitizeImage } = require('../image-safety')
const { createLocalProvider } = require('./local-provider')

const STYLE_PROMPTS = {
  插画: '温暖细腻的手绘美食插画，柔和色彩，清晰的食材轮廓',
  漫画: '美食漫画风格，清晰线稿，赛璐璐上色，鲜明的色彩',
  黏土: '可爱的立体黏土模型风格，柔软圆润的手工黏土质感'
}

function providerError(code, message) {
  return Object.assign(new Error(message), { code, publicMessage: message })
}

function diagnosticCode(value) {
  const code = String(value || '')
  return /^[A-Za-z][A-Za-z0-9_.]{0,100}$/.test(code) ? code : ''
}

function safeFailure(error) {
  if (error.publicMessage) return error
  const code = diagnosticCode(error.code || (error.cause && error.cause.code))
  if (/AuthFailure|UnauthorizedOperation/.test(code)) {
    return providerError('HUNYUAN_ACCESS_DENIED', '混元调用权限或凭证无效，请检查后端腾讯云配置。')
  }
  if (/ResourceInsufficient|AccountBalance|Arrears/.test(code)) {
    return providerError('HUNYUAN_BALANCE', '混元账户余额或额度不足，请检查腾讯云计费。')
  }
  if (/LimitExceeded|RequestLimitExceeded/.test(code)) {
    return providerError('HUNYUAN_RATE_LIMITED', '混元当前繁忙，请稍后重试。')
  }
  if (/InvalidParameter|MissingParameter/.test(code)) {
    return providerError('HUNYUAN_INVALID_PARAMETER', `混元拒绝了生成参数（${code}），请检查后端配置或图片格式。`)
  }
  if (/ResourceUnavailable|UnsupportedOperation|OperationDenied/.test(code)) {
    return providerError('HUNYUAN_UNAVAILABLE', `混元服务暂不可用（${code}），请检查生图服务开通状态与地域。`)
  }
  if (error.name === 'TimeoutError' || /TIMEOUT|TIMEDOUT/.test(code)) {
    return providerError('HUNYUAN_REQUEST_TIMEOUT', '连接混元或下载结果超时，请稍后重试。')
  }
  if (/^E(CONN|NET|HOST)|^UND_ERR_|ENOTFOUND/.test(code)) {
    return providerError('HUNYUAN_CONNECTION_FAILED', '后端连接混元或结果存储失败，请稍后重试。')
  }
  if (/^(FailedOperation|InternalError|ResourceNotFound)\b/.test(code)) {
    return providerError('HUNYUAN_FAILED', `混元图片生成失败（${code}），请根据错误码检查服务状态。`)
  }
  return providerError('HUNYUAN_FAILED', '混元图片生成失败，请稍后重试。')
}

async function downloadImage(url, config, fetchImpl) {
  const parsed = new URL(url)
  // Only download Tencent COS results, never arbitrary URLs or redirects.
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      (parsed.port && parsed.port !== '443') ||
      !/\.(myqcloud\.com|tencentcos\.cn)$/.test(parsed.hostname)) {
    throw providerError('HUNYUAN_INVALID_RESULT', '混元返回的图片地址无效。')
  }
  const response = await fetchImpl(parsed.href, {
    signal: AbortSignal.timeout(config.hunyuanRequestTimeoutMs), redirect: 'error'
  })
  if (!response.ok || !response.body) throw providerError('HUNYUAN_DOWNLOAD_FAILED', '混元结果图片下载失败，请稍后重试。')
  const limit = config.maxUploadBytes
  const chunks = []
  let size = 0
  try {
    if (Number(response.headers.get('content-length')) > limit) throw new Error('Result too large')
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > limit) throw new Error('Result too large')
      chunks.push(chunk)
    }
    return validateAndSanitizeImage(Buffer.concat(chunks), response.headers.get('content-type'), config)
  } catch (error) {
    if (!response.body.locked) await response.body.cancel().catch(() => {})
    throw providerError('HUNYUAN_INVALID_RESULT', '混元返回的图片无效或超过大小限制。')
  }
}

function createHunyuanProvider(config, dependencies = {}) {
  const Client = dependencies.client ? null
    : require('tencentcloud-sdk-nodejs/tencentcloud/services/hunyuan/v20230901/hunyuan_client').Client
  const client = dependencies.client || new Client({
    credential: { secretId: config.hunyuanSecretId, secretKey: config.hunyuanSecretKey },
    region: config.hunyuanRegion,
    profile: { httpProfile: { reqTimeout: config.hunyuanRequestTimeoutMs / 1000 } }
  })
  const wait = dependencies.sleep || sleep
  const now = dependencies.now || Date.now
  const fetchImpl = dependencies.fetch || fetch
  // Nutrition and the upload moderation hook remain POC implementations.
  const local = createLocalProvider()
  return {
    name: 'hunyuan',
    capabilities: { stylization: 'hunyuan', nutrition: 'local-poc', moderation: 'local-poc' },
    moderateImage: local.moderateImage,
    analyzeNutrition: local.analyzeNutrition,
    async stylize({ meal, originalAsset, task = {}, onSubmitted = async () => {}, isCurrent = () => true }) {
      let stage = 'validate'
      let upstreamRequestId
      const checkCurrent = () => {
        if (!isCurrent()) throw providerError('TASK_CANCELLED', '任务已被替换或删除。')
      }
      try {
        checkCurrent()
        const stylePrompt = STYLE_PROMPTS[meal.style]
        if (!stylePrompt) throw providerError('HUNYUAN_INVALID_STYLE', '不支持该图片风格。')
        let jobId = task.providerJobId
        let submittedAt = task.providerSubmittedAt || now()
        if (!jobId) {
          const imageBase64 = originalAsset.buffer.toString('base64')
          // Tencent limits the encoded image to <8 MiB and each side to <5000px.
          if (imageBase64.length >= 8 * 1024 * 1024 || originalAsset.width >= 5000 || originalAsset.height >= 5000) {
            throw providerError('HUNYUAN_IMAGE_TOO_LARGE', '照片过大，请选择小于 6MB、边长小于 5000 像素的图片。')
          }
          stage = 'submit'
          const submitted = await client.SubmitHunyuanImageJob({
            Prompt: `将参考照片转换为${stylePrompt}。保持原图中的食物种类、数量、餐具和构图，不增加食物，不添加文字。`,
            NegativePrompt: '新增食物，改变食物种类，人物，文字，模糊，变形',
            ContentImage: { ImageBase64: imageBase64 },
            Num: 1,
            LogoAdd: 1
          })
          upstreamRequestId = submitted.RequestId
          if (!submitted.JobId) throw providerError('HUNYUAN_INVALID_JOB', '混元没有返回生成任务标识。')
          jobId = submitted.JobId
          submittedAt = now()
          stage = 'persist-job'
          await onSubmitted(jobId, submittedAt)
        }
        const deadline = submittedAt + config.hunyuanTaskTimeoutMs
        while (now() < deadline) {
          checkCurrent()
          stage = 'query'
          const result = await client.QueryHunyuanImageJob({ JobId: jobId })
          upstreamRequestId = result.RequestId
          checkCurrent()
          const status = String(result.JobStatusCode)
          if (status === '5') {
            if (!result.ResultImage || !result.ResultImage[0] ||
                (result.ResultDetails && result.ResultDetails[0] !== 'Success')) {
              throw providerError('HUNYUAN_INVALID_RESULT', '混元未返回可用的生成图片，请稍后重试。')
            }
            stage = 'download'
            return await downloadImage(result.ResultImage[0], config, fetchImpl)
          }
          if (status === '4') {
            const jobCode = diagnosticCode(result.JobErrorCode)
            const failure = providerError('HUNYUAN_JOB_FAILED', `混元未能生成该图片${jobCode ? `（${jobCode}）` : ''}，请更换照片或稍后重试。`)
            failure.upstreamCode = jobCode
            throw failure
          }
          if (!['1', '2'].includes(status)) throw providerError('HUNYUAN_INVALID_STATUS', '混元返回的任务状态无效。')
          await wait(Math.min(config.hunyuanPollIntervalMs, Math.max(1, deadline - now())))
        }
        throw providerError('HUNYUAN_TIMEOUT', '混元生成超时，请稍后重试。')
      } catch (error) {
        const failure = safeFailure(error)
        if (failure.code !== 'TASK_CANCELLED') {
          const requestId = String(error.requestId || upstreamRequestId || '')
          console.error('hunyuan_failed', {
            stage,
            code: failure.code,
            upstreamCode: diagnosticCode(error.upstreamCode || error.code || (error.cause && error.cause.code)),
            requestId: /^[a-fA-F0-9-]{1,64}$/.test(requestId) ? requestId : undefined
          })
        }
        throw failure
      }
    }
  }
}

module.exports = { createHunyuanProvider, downloadImage, STYLE_PROMPTS }
