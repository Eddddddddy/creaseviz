import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'

const prohibitedExtensions = new Set([
  '.zag',
  '.stl',
  '.obj',
  '.sqlite',
  '.webm',
  '.mp4',
  '.mov',
])

const sensitivePatterns = [
  { label: 'macOS 用户绝对路径', pattern: /\/Users\/[A-Za-z0-9._-]+\// },
  { label: 'Linux 用户绝对路径', pattern: /\/home\/[A-Za-z0-9._-]+\// },
  { label: 'Windows 用户绝对路径', pattern: /[A-Za-z]:\\Users\\[^\\]+\\/ },
  { label: 'Codex 私有目录', pattern: /(?:^|[\\/])\.codex[\\/]/ },
  { label: '真实扫描命名模式', pattern: /\bVR-\d{8}_\d{6}\b/ },
  { label: '本机任务标识', pattern: /\b019[a-f0-9]{5,}-[a-f0-9-]{20,}\b/i },
]

const trackedFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' },
)
  .split('\n')
  .filter(Boolean)
const violations = []

for (const file of trackedFiles) {
  if (!existsSync(file)) continue
  const extension = extname(file).toLowerCase()
  if (prohibitedExtensions.has(extension)) {
    violations.push(`${file}: 禁止提交 ${extension} 文件`)
    continue
  }
  if (file === 'scripts/check-publication.mjs' || file === 'pnpm-lock.yaml') continue
  const bytes = readFileSync(file)
  if (bytes.includes(0)) continue
  const text = bytes.toString('utf8')
  for (const { label, pattern } of sensitivePatterns) {
    if (pattern.test(text)) violations.push(`${file}: 检测到${label}`)
  }
}

if (violations.length) {
  console.error('公开内容检查失败：')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exitCode = 1
} else {
  console.log(`公开内容检查通过：已检查 ${trackedFiles.length} 个待发布文件。`)
}
