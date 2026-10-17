// Downloads the latest jdbc-adapter-server fat JAR (MIT) into resources/jdbc-adapter/.
import { mkdirSync, writeFileSync } from 'node:fs'
const api = 'https://api.github.com/repos/database-client/jdbc-adapter-server/releases/latest'
const rel = await (await fetch(api, { headers: { 'user-agent': 'stratum' } })).json()
const asset = rel.assets?.find((a) => /\.jar$/.test(a.name))
if (!asset) throw new Error('No .jar asset in latest release; build from source with `gradle fatJar`.')
mkdirSync('resources/jdbc-adapter', { recursive: true })
writeFileSync('resources/jdbc-adapter/jdbc-adapter-server.jar', Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer()))
console.log(`Fetched ${asset.name} (${rel.tag_name})`)
