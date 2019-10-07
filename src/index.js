const fetch = require('cross-fetch')
const postMethods = require('./postMethods')
const JsonRpcError = require('json-rpc-error')
const createAsyncMiddleware = require('json-rpc-engine/src/createAsyncMiddleware')

const RETRIABLE_ERRORS = [
  'Gateway timeout',
  'ETIMEDOUT',
  'ECONNRESET',
  'SyntaxError',
]

let BRAVE_INFURA_PROJECT_ID = ''

const createInfuraMiddleware = (opts = {}) => {
  const network = opts.network || 'mainnet'
  const maxAttempts = opts.maxAttempts || 5
  const source = opts.source

  chrome.braveWallet.getProjectID((projectId) => {
    BRAVE_INFURA_PROJECT_ID = projectId
  })

  if (!maxAttempts) {
    throw new Error(`Invalid value for 'maxAttempts': "${maxAttempts}" (${typeof maxAttempts})`)
  }

  return createAsyncMiddleware(async (req, res, _next) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await performFetch(network, req, res, source)
        break
      } catch (err) {
        const canRetry = RETRIABLE_ERRORS.some(phrase => err.toString().includes(phrase))

        if (!canRetry) {
          throw err
        }

        const remainingAttempts = maxAttempts - attempt
        if (!remainingAttempts) {
          const errMsg = `InfuraProvider - cannot complete request, all retries have been exhausted.\nOriginal Error:\n${err.toString()}\n\n`
          const retriesExhaustedErr = new Error(errMsg)
          throw retriesExhaustedErr
        }

        await function () {
          return new Promise((resolve) => {
            setTimeout(resolve, 1000)
          })
        }
      }
    }
  })
}

const performFetch = async (network, req, res, source) => {
  const { fetchUrl, fetchParams } = fetchConfigFromReq({ network, req, source })
  const response = await fetch(fetchUrl, fetchParams)
  const rawData = await response.text()

  if (!response.ok) {
    switch (response.status) {
      case 405:
        throw new JsonRpcError.MethodNotFound()

      case 418:
        throw createInternalError(`Request is being rate limited.`)

      case 503:
      case 504:
        throw createInternalError(`Gateway timeout, request took too long to process.`)

      default:
        throw createInternalError(rawData)
    }
  }

  if (req.method === 'eth_getBlockByNumber' && rawData === 'Not Found') {
    res.result = null
    return
  }

  const data = JSON.parse(rawData)
  res.result = data.result
  res.error = data.error
}

const createInternalError = (msg) => new JsonRpcError.InternalError(new Error(msg))

const getCacheHeader = (method) => {
  switch (method) {
    case 'eth_getBlockByNumber':
      return 'X-Eth-Get-Block'
    case 'eth_blockNumber':
      return 'X-Eth-Block'
    default:
      return null
  }
}

const fetchConfigFromReq = ({ network, req, source }) => {
  const fetchParams = {}
  const requestOrigin = req.origin || 'internal'

  const cleanReq = {
    id: req.id,
    jsonrpc: req.jsonrpc,
    method: req.method,
    params: req.params,
  }

  const { method, params } = cleanReq
  const isPostMethod = postMethods.includes(method)
  let fetchUrl = `https://${network}.infura.io/v3/${BRAVE_INFURA_PROJECT_ID}`

  if (isPostMethod) {
    fetchParams.method = 'POST'
    fetchParams.headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(source ? {'Infura-Source': `${source}/${requestOrigin}`} : {}),
    }

    const cacheHeader = getCacheHeader(method)
    if (cacheHeader) {
      fetchParams.headers[cacheHeader] = 'true'
    }

    fetchParams.body = JSON.stringify(cleanReq)
  } else {
    fetchParams.method = 'GET'
    if (source) {
      fetchParams.headers = {
        'Infura-Source': `${source}/${requestOrigin}`,
      }
    }
    const paramsString = encodeURIComponent(JSON.stringify(params))
    fetchUrl += `/${method}?params=${paramsString}`
  }

  return { fetchUrl, fetchParams }
}

module.exports = createInfuraMiddleware
module.exports.fetchConfigFromReq = fetchConfigFromReq
