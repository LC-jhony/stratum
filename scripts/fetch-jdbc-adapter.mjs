// Downloads the latest jdbc-adapter-server fat JAR (MIT) into resources/jdbc-adapter/.
import { mkdirSync, writeFileSync } from 'node:fs'

const api = 'https://api.github.com/repos/database-client/jdbc-adapter-server/releases/latest'
const apiHeaders = {
  'user-agent': 'stratum',
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28'
}
const downloadHeaders = { 'user-agent': 'stratum' }
const token = process.env.GITHUB_TOKEN
const authHeaders = token
  ? { ...apiHeaders, authorization: `Bearer ${token}` }
  : apiHeaders

async function request(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) {
    const detail = (await res.text()).replace(/\s+/g, ' ').slice(0, 300)
    const error = new Error(`GitHub API ${res.status} ${res.statusText} for ${url}: ${detail}`)
    error.status = res.status
    throw error
  }
  return res
}

async function latestRelease() {
  try {
    return await (await request(api, authHeaders)).json()
  } catch (error) {
    if (!token) throw error
    console.warn(
      `Authenticated GitHub API request failed (${error.status ?? 'network'}); retrying unauthenticated.`
    )
    return await (await request(api, apiHeaders)).json()
  }
}

const rel = await latestRelease()
const asset = rel.assets?.find((a) => /\.jar$/.test(a.name))
if (!asset) {
  throw new Error(
    `No .jar asset in ${rel.tag_name ?? 'the latest release'}; build from source with \`gradle fatJar\`.`
  )
}

const jar = Buffer.from(await (await request(asset.browser_download_url, downloadHeaders)).arrayBuffer())
if (jar.length < 1024) {
  throw new Error(`Downloaded ${asset.name} is suspiciously small (${jar.length} bytes).`)
}
mkdirSync('resources/jdbc-adapter', { recursive: true })
writeFileSync('resources/jdbc-adapter/jdbc-adapter-server.jar', jar)
console.log(
  `Fetched ${asset.name} (${rel.tag_name}, ${(jar.length / 1024 / 1024).toFixed(1)} MB)`
)
