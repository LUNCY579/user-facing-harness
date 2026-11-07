import { spawn } from 'node:child_process'

/**
 * 规范化待打开的 URL。Windows 路径把 URL 放进双引号传给 `cmd /c start`，
 * URL 里的引号会闭合引号并让后续文本成为 cmd 命令分隔符，因此打开前必须
 * 解析并重新序列化：WHATWG 解析会把 " 和控制字符百分号编码，协议只允许
 * http(s)。解析失败或协议不符直接拒绝，而不是把任意文本交给 shell。
 */
function normalizedBrowserUrl(url: string): string {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported browser URL scheme ${parsed.protocol}`)
  }
  return parsed.href
}

/** 账号渠道共用的系统浏览器打开器。 */
export function openBrowser(url: string): void {
  const warn = (error: unknown): void => {
    console.error('[channel-pack] failed to open browser; open manually:', url, error)
  }
  let target: string
  try {
    target = normalizedBrowserUrl(url)
  } catch (error) {
    warn(error)
    return
  }
  const win = process.platform === 'win32'
  if (win) {
    // Windows 下 cmd /c start 会把 URL 中每个 '&' 当作命令分隔符，导致参数被截断
    // （浏览器只收到 '?theme=2'）。必须把整个 URL 加引号作为单个参数传给 cmd，
    // 并用 windowsVerbatimArguments 关闭 Node 的二次转义。start 的窗口标题参数
    // 必须显式传 '""'——空字符串参数会被 Node 丢弃，start 会把 URL 当成标题。
    const args = ['/c', 'start', '""', `"${target}"`]
    try {
      const child = spawn('cmd', args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
      child.on('error', warn)
      child.unref()
      return
    } catch (error) {
      warn(error)
      return
    }
  }
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(cmd, [target], { detached: true, stdio: 'ignore' })
    child.on('error', warn)
    child.unref()
  } catch (error) {
    warn(error)
  }
}
